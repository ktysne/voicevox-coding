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
import { VOICE_PARAMS } from './catalog.js';
import { wavDurationMs } from './player.js';
import { LIST_BOUNDARY, DEFAULT_LIST_PAUSE_SEC, stripListBoundaries } from './textfilter.js';

const SENTENCE_SPLIT = /(?<=[。．！？!?\n])/;

// 項目の切れ目に置ける間の上限（秒）。設定ファイルを手編集して極端な値を入れても、
// 読み上げが止まったように見えるほどキューを詰まらせない。
// 管理コンソールの入力欄の上限（src/ui/app.js の listPauseSec）と同じ値にしてある。
const MAX_LIST_PAUSE_SEC = 10;

/** 既定値のときはキャッシュキーから外すパラメータ（key -> 既定値）。catalog.js の解説を参照。 */
const CACHE_KEY_OMITTABLE = new Map(
  VOICE_PARAMS.filter((p) => p.omitFromCacheKeyWhenDefault).map((p) => [p.key, p.default]),
);

/**
 * キャッシュキー用に voice を整える。
 * 後から追加したパラメータが既定値のままなら取り除き、そのパラメータを知らなかった
 * 頃に作られたキャッシュと同じキーになるようにする。
 */
function voiceForCacheKey(voice) {
  if (!voice || typeof voice !== 'object' || Array.isArray(voice)) return voice;
  const out = {};
  for (const [key, value] of Object.entries(voice)) {
    // スライダー経由の値は浮動小数の誤差を含みうるので、厳密比較にはしない
    if (CACHE_KEY_OMITTABLE.has(key) && typeof value === 'number'
      && Math.abs(value - CACHE_KEY_OMITTABLE.get(key)) < 1e-9) continue;
    out[key] = value;
  }
  return out;
}

/** 文の切れ目を優先しつつ、maxChars 以下の断片に割る。 */
function splitBySentence(text, maxChars) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (maxChars <= 0 || trimmed.length <= maxChars) return [trimmed];

  const sentences = trimmed.split(SENTENCE_SPLIT).filter((s) => s.length > 0);
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

/**
 * 文の切れ目を優先しつつ、maxChars 以下のチャンクに割る。
 * 箇条書き項目の切れ目 (LIST_BOUNDARY) をまたぐチャンクは作らず、切れ目の手前の
 * チャンクへ pauseAfter を立てる。読み上げ側はそこで無音の間を置く。
 * マーカーはチャンクのテキストには残さない（合成にも表示にも渡らない）。
 * @returns {{ text: string, pauseAfter: boolean }[]}
 */
export function chunkText(text, maxChars = 100) {
  if (!text) return [];

  const items = text.split(LIST_BOUNDARY);
  const chunks = [];
  for (let i = 0; i < items.length; i += 1) {
    for (const s of splitBySentence(items[i], maxChars)) chunks.push({ text: s, pauseAfter: false });
    // 最後の断片の後ろに切れ目は無い。中身が空の項目では直前の印をそのまま残す。
    if (i < items.length - 1 && chunks.length) chunks[chunks.length - 1].pauseAfter = true;
  }
  // 発話の末尾で間を置いても意味が無いので落とす。
  if (chunks.length) chunks[chunks.length - 1].pauseAfter = false;
  return chunks;
}

/** 項目の切れ目に置く間（ミリ秒）。手編集で数値以外が入っても読み上げを止めない。 */
function listPauseMs(sec) {
  const v = Number(sec ?? DEFAULT_LIST_PAUSE_SEC);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(v, MAX_LIST_PAUSE_SEC) * 1000;
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
      .update(`${speaker}|${JSON.stringify(voiceForCacheKey(voice))}|${text}`)
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
  enqueue({ target, event, text, speaker, voice, queuePolicy, listPauseSec }) {
    // text には項目の切れ目のマーカーが入りうる。チャンク分割にだけ使い、
    // 重複判定・状態通知・キャッシュキーには印を外したテキストを使う。
    const marked = typeof text === 'string' ? text : '';
    const spoken = stripListBoundaries(marked);
    if (!spoken.trim()) return { accepted: false, reason: 'empty' };

    const policy = queuePolicy?.policy ?? 'replace';
    const maxQueue = queuePolicy?.maxQueue ?? 5;
    const utterance = {
      id: ++this.seq,
      target,
      event,
      text: spoken,
      speaker,
      voice,
      chunks: chunkText(marked, this.getConfig().daemon?.chunkChars ?? 100),
      chunkIndex: 0,
      prefetch: null,
      pauseMs: listPauseMs(listPauseSec),
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
    const text = utterance.chunks[index]?.text;
    if (!text) return null;
    const cfg = this.getConfig();
    const useCache = cfg.daemon?.cacheEnabled !== false;
    const key = this.#cacheKey(text, utterance.speaker, utterance.voice);
    // キャッシュ無効時は発話専用の一時ファイルにする。再生後に削除するので蓄積しない。
    // (キャッシュキーは hex なので tmp- と衝突しない)
    const file = useCache
      ? path.join(CACHE_DIR, `${key}.wav`)
      : path.join(CACHE_DIR, `tmp-${process.pid}-${utterance.id}-${index}.wav`);

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
    try {
      fs.writeFileSync(tmp, wav);
      fs.renameSync(tmp, file);
    } catch (err) {
      // 部分書き込みや rename 失敗 (EPERM/EBUSY) で書きかけを残さない
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw err;
    }
    if (useCache) this.#pruneCache(cfg.daemon?.cacheMaxEntries ?? 300);
    return { file, durationMs: wavDurationMs(wav), ephemeral: !useCache };
  }

  /** 一時 WAV を削除する。再生ワーカーは PLAY 時に全体をメモリへ読むので、再生後の削除は安全。 */
  #discardAudio(audio) {
    if (!audio?.ephemeral) return;
    fs.unlink(audio.file, (err) => {
      // 一時的な EBUSY/EPERM (ウイルス対策など) は起動時掃除が拾うが、無通知にはしない
      if (err && err.code !== 'ENOENT') this.log?.warn(`一時 WAV を削除できません: ${err.message}`);
    });
  }

  /** 消費されなかった先読みの一時 WAV も削除する。 */
  #discardPrefetch(utterance) {
    const pre = utterance.prefetch;
    utterance.prefetch = null;
    if (!pre?.promise) return;
    Promise.resolve(pre.promise).then((a) => this.#discardAudio(a), () => {});
  }

  /**
   * 前回の実行が残した一時 WAV (tmp-*.wav と書きかけの *.tmp) を掃除する。
   * デーモンはポート重複で多重起動しないので、起動時にまとめて消してよい。
   */
  cleanupEphemeral() {
    let files;
    try {
      files = fs.readdirSync(CACHE_DIR);
    } catch {
      return; // CACHE_DIR がまだ無いのは正常
    }
    for (const f of files) {
      if ((f.startsWith('tmp-') && f.endsWith('.wav')) || f.endsWith('.tmp')) {
        try {
          fs.unlinkSync(path.join(CACHE_DIR, f));
        } catch (err) {
          if (err.code !== 'ENOENT') this.log?.warn(`一時 WAV を削除できません (${f}): ${err.message}`);
        }
      }
    }
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
            // 先読みは消費と同時に手放す (後段の #discardPrefetch と二重処理しない)
            const pre = utterance.prefetch;
            if (pre?.index === i) {
              utterance.prefetch = null;
              audio = await pre.promise;
            } else {
              audio = await this.#synthesizeChunk(utterance, i);
            }
          } catch (err) {
            this.log?.warn(`合成に失敗しました: ${err.message}`);
            this.emit('error', err);
            break;
          }
          if (!audio || this.skipRequested) {
            this.#discardAudio(audio);
            break;
          }

          // 再生している間に次チャンクを先に合成しておく。
          // 失敗は rejection のまま保持し、消費時 (このループの先頭の catch) で
          // 通常の合成失敗と同じ扱い (警告ログ + error イベント) にする。
          // ここで .catch(() => {}) を付けるのは、誰にも await されないまま
          // 発話が終了・スキップされた場合の unhandledRejection を防ぐためだけで、
          // 実際の結果 (reject) は変えない。
          if (i + 1 < utterance.chunks.length) {
            const promise = this.#synthesizeChunk(utterance, i + 1);
            promise.catch(() => {});
            utterance.prefetch = { index: i + 1, promise };
          }

          try {
            await this.player.play(audio.file);
            // PLAY はワーカー側で HOLD の無音ループを差し替える。
            holding = false;
          } catch (err) {
            this.log?.warn(`再生に失敗しました: ${err.message}`);
            await stopHold();
            this.#discardAudio(audio);
            break;
          }

          await this.#wait(audio.durationMs ?? 1500);
          this.#discardAudio(audio);

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

            // 箇条書き項目の切れ目では、次のチャンクへ移る前に少しだけ待って間を作る。
            // 直前に HOLD を掛けてあるので、この間はワーカーの無音ループが流れる
            // （音声デバイスを掴んだままなので、間のあとの出だしが欠けない）。
            if (utterance.pauseMs > 0 && utterance.chunks[i].pauseAfter) {
              await this.#wait(utterance.pauseMs);
            }
          }
        }

        this.#discardPrefetch(utterance);
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

  /** 指定時間だけ待つ（再生時間ぶん、または項目の切れ目の間）。途中でスキップされたら即座に抜ける。 */
  #wait(durationMs) {
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
