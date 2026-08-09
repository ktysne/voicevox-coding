// 発話キュー。
// 長文を文単位のチャンクに割って合成することで、
//   ・最初の音が出るまでの待ち時間を短くする
//   ・読み上げ中のスキップを即座に効かせる
// を両立する。再生中に次チャンクを先読み合成してギャップを詰める。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CACHE_DIR } from './config.js';
import { wavDurationMs } from './player.js';

const SENTENCE_SPLIT = /(?<=[。．！？!?\n])/;

/** 文の切れ目を優先しつつ、maxChars 以下のチャンクに割る。 */
export function chunkText(text, maxChars = 100) {
  if (!text) return [];
  if (maxChars <= 0 || text.length <= maxChars) return [text];

  const sentences = text.split(SENTENCE_SPLIT).filter((s) => s.length > 0);
  const chunks = [];
  let cur = '';

  const pushCur = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = '';
  };

  for (const s of sentences) {
    if (s.length > maxChars) {
      pushCur();
      // 1 文が長すぎる場合は読点、それも無ければ強制分割
      let rest = s;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf('、', maxChars);
        if (cut < maxChars * 0.4) cut = maxChars;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      cur = rest;
      continue;
    }
    if (cur.length + s.length > maxChars) pushCur();
    cur += s;
  }
  pushCur();
  return chunks.filter(Boolean);
}

export class SpeechQueue extends EventEmitter {
  /**
   * @param {import('./voicevox.js').VoicevoxEngine} engine
   * @param {import('./player.js').Player} player
   * @param {() => object} getConfig
   * @param {object} logger
   */
  constructor(engine, player, getConfig, logger) {
    super();
    this.engine = engine;
    this.player = player;
    this.getConfig = getConfig;
    this.log = logger;
    this.queue = [];
    this.current = null;
    this.running = false;
    this.skipRequested = false;
    this.recent = new Map(); // dedupe 用: key -> timestamp
    this.seq = 0;
  }

  get state() {
    return {
      running: this.running,
      current: this.current
        ? {
            id: this.current.id,
            target: this.current.target,
            event: this.current.event,
            text: this.current.text,
            chunkIndex: this.current.chunkIndex,
            chunkCount: this.current.chunks.length,
          }
        : null,
      queued: this.queue.map((u) => ({ id: u.id, target: u.target, event: u.event, text: u.text })),
    };
  }

  #cacheKey(text, speaker, voice) {
    return crypto
      .createHash('sha1')
      .update(`${speaker}|${JSON.stringify(voice)}|${text}`)
      .digest('hex');
  }

  #isDuplicate(utterance, windowSec) {
    if (!windowSec || windowSec <= 0) return false;
    const key = `${utterance.target}:${utterance.text}`;
    const last = this.recent.get(key);
    const now = Date.now();
    // 古い記録を掃除しておく
    for (const [k, t] of this.recent) if (now - t > 60_000) this.recent.delete(k);
    if (last && now - last < windowSec * 1000) return true;
    this.recent.set(key, now);
    return false;
  }

  /**
   * 発話を投入する。
   * @returns {{accepted:boolean, reason?:string, id?:number}}
   */
  enqueue({ target, event, text, speaker, voice, queuePolicy }) {
    if (!text || !text.trim()) return { accepted: false, reason: 'empty' };

    const policy = queuePolicy?.policy ?? 'replace';
    const maxQueue = queuePolicy?.maxQueue ?? 5;
    const utterance = {
      id: ++this.seq,
      target,
      event,
      text,
      speaker,
      voice,
      chunks: chunkText(text, this.getConfig().daemon?.chunkChars ?? 100),
      chunkIndex: 0,
      prefetch: null,
    };

    if (this.#isDuplicate(utterance, queuePolicy?.dedupeWindowSec)) {
      return { accepted: false, reason: 'duplicate' };
    }

    if (policy === 'drop' && (this.current || this.queue.length > 0)) {
      return { accepted: false, reason: 'busy' };
    }

    if (policy === 'replace') {
      this.queue.length = 0;
      this.queue.push(utterance);
      if (this.current) this.skip();
    } else {
      if (this.queue.length >= maxQueue) this.queue.shift();
      this.queue.push(utterance);
    }

    this.emit('update', this.state);
    this.#drain();
    return { accepted: true, id: utterance.id };
  }

  /** 再生中の発話を打ち切る。 */
  skip() {
    this.skipRequested = true;
    this.player.stop().catch(() => {});
    this.emit('update', this.state);
  }

  /** キューごと空にする。 */
  clear() {
    this.queue.length = 0;
    this.skip();
  }

  async #synthesizeChunk(utterance, index) {
    const text = utterance.chunks[index];
    if (!text) return null;
    const cfg = this.getConfig();
    const useCache = cfg.daemon?.cacheEnabled !== false;
    const key = this.#cacheKey(text, utterance.speaker, utterance.voice);
    const file = path.join(CACHE_DIR, `${key}.wav`);

    if (useCache && fs.existsSync(file)) {
      try {
        const buf = fs.readFileSync(file);
        return { file, durationMs: wavDurationMs(buf) };
      } catch {
        // キャッシュが壊れていたら作り直す
      }
    }

    const { wav } = await this.engine.synthesize(text, utterance.speaker, utterance.voice);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, wav);
    fs.renameSync(tmp, file);
    if (useCache) this.#pruneCache(cfg.daemon?.cacheMaxEntries ?? 300);
    return { file, durationMs: wavDurationMs(wav) };
  }

  #pruneCache(maxEntries) {
    try {
      const files = fs
        .readdirSync(CACHE_DIR)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => {
          const p = path.join(CACHE_DIR, f);
          return { p, mtime: fs.statSync(p).mtimeMs };
        });
      if (files.length <= maxEntries) return;
      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files.slice(0, files.length - maxEntries)) {
        try {
          fs.unlinkSync(f.p);
        } catch {}
      }
    } catch {}
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    // HOLD が合成失敗などで次の PLAY に到達しなかった場合も、
    // ワーカーに無音ループを残さないよう、この呼び出し内で状態を追跡する。
    let holding = false;
    const stopHold = async () => {
      if (!holding) return;
      holding = false;
      try {
        await this.player.stop();
      } catch {
        // 停止に失敗してもキューの状態更新は続ける
      }
    };

    try {
      while (this.queue.length > 0) {
        const utterance = this.queue.shift();
        this.current = utterance;
        this.skipRequested = false;
        this.emit('update', this.state);

        for (let i = 0; i < utterance.chunks.length; i += 1) {
          if (this.skipRequested) break;
          utterance.chunkIndex = i;
          this.emit('update', this.state);

          let audio;
          try {
            audio = utterance.prefetch?.index === i
              ? await utterance.prefetch.promise
              : await this.#synthesizeChunk(utterance, i);
          } catch (err) {
            this.log?.warn(`合成に失敗しました: ${err.message}`);
            this.emit('error', err);
            break;
          }
          if (!audio || this.skipRequested) break;

          // 再生している間に次チャンクを先に合成しておく
          if (i + 1 < utterance.chunks.length) {
            utterance.prefetch = {
              index: i + 1,
              promise: this.#synthesizeChunk(utterance, i + 1).catch(() => null),
            };
          }

          try {
            await this.player.play(audio.file);
            // PLAY はワーカー側で HOLD の無音ループを差し替える。
            holding = false;
          } catch (err) {
            this.log?.warn(`再生に失敗しました: ${err.message}`);
            await stopHold();
            break;
          }

          await this.#waitPlayback(audio.durationMs ?? 1500);

          // 次チャンクまたは次発話がある間だけ、再生完了直後から無音をループする。
          // skip/clear 後は STOP 済みなので HOLD を開始しない。
          const hasNext = i + 1 < utterance.chunks.length || this.queue.length > 0;
          if (!this.skipRequested && hasNext) {
            try {
              await this.player.hold();
              holding = true;
            } catch (err) {
              // keep-alive は補助機能。失敗しても読み上げ自体は続ける。
              this.log?.warn(`無音 keep-alive を開始できませんでした: ${err.message}`);
              // HOLD がワーカー側で実行されてから応答に失敗した可能性もあるため、
              // 次の PLAY までの残留を防ぐ。停止待ちで読み上げを詰まらせない。
              this.player.stop().catch(() => {});
            }
          }
        }

        utterance.prefetch = null;
        // 最終チャンク後に次発話があれば HOLD を次の PLAY まで維持する。
        // キューが空になった場合や skip/clear で抜けた場合だけ停止する。
        if (this.skipRequested || this.queue.length === 0) await stopHold();
        this.current = null;
        this.emit('update', this.state);
      }
    } finally {
      await stopHold();
      this.running = false;
      this.emit('update', this.state);
    }
  }

  /** 再生時間ぶん待つ。途中でスキップされたら即座に抜ける。 */
  #waitPlayback(durationMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + durationMs;
      const tick = () => {
        if (this.skipRequested || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(tick, Math.min(80, Math.max(10, deadline - Date.now())));
      };
      tick();
    });
  }
}
