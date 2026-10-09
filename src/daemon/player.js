// 常駐 PowerShell ワーカーを介した wav 再生。
// 毎回プロセスを起こすと 1 発話ごとに数百ミリ秒の無音が入るため、ワーカーは使い回す。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const WORKER_PS1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'player-worker.ps1');

// ワーカーの応答待ち上限。超えたらワーカーごと作り直す
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * WAV ヘッダから再生時間（ミリ秒）を求める。
 * ENGINE の出力は 24kHz / 16bit / モノラルだが、決め打ちせずヘッダを読む。
 */
export function wavDurationMs(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    let offset = 12;
    let byteRate = null;
    let dataSize = null;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        byteRate = buf.readUInt32LE(offset + 16);
      } else if (id === 'data') {
        dataSize = Math.min(size, buf.length - (offset + 8));
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!byteRate || !dataSize) return null;
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return null;
  }
}

/**
 * WAV データの末尾へ無音を継ぎ足した新しい Buffer を返す。
 * 項目の切れ目の間を HOLD（無音ループ）ではなく音声データ自体に持たせることで、
 * 間の最中に無音ループの開始と停止を挟まずに済む（#drain 側で使う）。
 * 元の buf は書き換えない。
 *
 * 次のいずれかに該当するときは継ぎ足さず null を返す。呼び出し側は
 * 従来どおり HOLD で間を作る経路へフォールバックする。
 *   ・buf が WAV として読めない、または fmt / data チャンクが見つからない
 *   ・data チャンクの後ろに別のチャンクが続く形式（data の終端がファイル末尾と一致しない）
 *   ・silenceMs が有限の正の数でない
 *   ・byteRate や blockAlign が 0 以下（壊れた fmt チャンク）
 *   ・継ぎ足す無音が blockAlign の倍数へ切り下げると 0 バイトになる（間が短すぎる）
 */
export function appendWavSilence(buf, silenceMs) {
  try {
    if (!Number.isFinite(silenceMs) || silenceMs <= 0) return null;
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;

    let offset = 12;
    let byteRate = null;
    let blockAlign = null;
    let bitsPerSample = null;
    let dataOffset = null;
    let dataSize = null;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        byteRate = buf.readUInt32LE(offset + 16);
        blockAlign = buf.readUInt16LE(offset + 20);
        bitsPerSample = buf.readUInt16LE(offset + 22);
      } else if (id === 'data') {
        dataOffset = offset + 8;
        dataSize = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (byteRate === null || dataOffset === null) return null;
    if (!(byteRate > 0) || !(blockAlign > 0)) return null;

    // data の後ろに別のチャンクが続く形（パディングバイトを除いてファイル末尾と一致しない）
    // は扱わない。継ぎ足す位置が data の直後で確実にファイル末尾になる場合だけ対応する。
    const pad = dataSize % 2;
    if (dataOffset + dataSize + pad !== buf.length) return null;

    // 無音のバイト数は blockAlign の倍数へ切り下げる。フレームの途中で切れたバイト列は
    // 波形として不正になるため。切り下げて 0 になるほど短い間なら継ぎ足す意味がない。
    const rawBytes = Math.round((byteRate * silenceMs) / 1000);
    const silenceBytes = Math.floor(rawBytes / blockAlign) * blockAlign;
    if (silenceBytes <= 0) return null;

    // 無音の埋め値は 16bit 以上の PCM では 0（無音 = 振幅 0）。
    // 8bit PCM だけは無符号形式で中央値 0x80 が無音に当たる。
    const fillByte = bitsPerSample <= 8 ? 0x80 : 0x00;

    const newDataSize = dataSize + silenceBytes;
    const newPad = newDataSize % 2;
    const out = Buffer.alloc(dataOffset + newDataSize + newPad);
    buf.copy(out, 0, 0, dataOffset + dataSize); // ヘッダ一式 + 元の音声データ
    out.fill(fillByte, dataOffset + dataSize, dataOffset + newDataSize);
    // data チャンクのサイズと RIFF のサイズ（オフセット 4）を継ぎ足したぶん増やして書き直す
    out.writeUInt32LE(newDataSize, dataOffset - 4);
    out.writeUInt32LE(out.length - 8, 4);
    return out;
  } catch {
    return null;
  }
}

export class Player extends EventEmitter {
  /**
   * @param {object} [logger]
   * @param {{ spawnFn?: typeof spawn, timeoutMs?: number }} [options] テスト用の注入口
   */
  constructor(logger, { spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    this.log = logger;
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.ready = false;
    this.pending = [];
    this.buffer = '';
    this.restartCount = 0;
    this.disposed = false;
  }

  start() {
    if (this.child || this.disposed) return;
    // 前の世代の途中行を持ち越さない
    this.buffer = '';
    const child = this.spawnFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER_PS1],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child = child;

    child.stdout.setEncoding('utf8');
    // 世代交代後に届いた旧ワーカーの出力は、新しい待機処理へ混ぜずに捨てる
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      this.#onStdout(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => this.log?.warn(`player worker stderr: ${d.trim()}`));

    child.on('exit', (code) => {
      if (this.child !== child) return; // 破棄済みの世代なので後片付けは不要
      this.log?.warn(`再生ワーカーが終了しました (code=${code})`);
      this.#discard(child, '再生ワーカーが終了しました');
    });

    child.on('error', (err) => {
      if (this.child !== child) return;
      this.log?.error(`再生ワーカーを起動できません: ${err.message}`);
      this.#discard(child, `再生ワーカーを起動できません: ${err.message}`);
    });
  }

  /**
   * 指定世代のワーカーを切り離し、その世代の待機処理をすべて失敗させる。
   * 世代が一致しない呼び出しは処理済みとみなして無視するので、
   * タイムアウトによる破棄と 'exit' ハンドラが二重に走ることはない。
   */
  #discard(child, reason, { restart = true } = {}) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.buffer = '';
    for (const p of this.pending.splice(0)) p.reject(new Error(reason));
    if (!restart || this.disposed) return;
    // 落ちたら自動復旧する。ただし無限リトライはしない
    if (this.restartCount < 5) {
      this.restartCount += 1;
      setTimeout(() => this.start(), 1000).unref?.();
    }
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line === 'READY') {
        this.ready = true;
        this.restartCount = 0;
        this.emit('ready');
        continue;
      }
      const p = this.pending.shift();
      if (!p) continue;
      if (line.startsWith('ERR')) p.reject(new Error(line.slice(4).trim() || '再生に失敗しました'));
      else p.resolve(line);
    }
  }

  #send(command) {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        this.start();
      }
      const child = this.child;
      if (!child?.stdin?.writable) {
        reject(new Error('再生ワーカーが利用できません'));
        return;
      }
      const entry = {
        timer: null,
        resolve: (value) => {
          clearTimeout(entry.timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(entry.timer);
          reject(err);
        },
      };
      this.pending.push(entry);
      child.stdin.write(`${command}\n`);
      // ワーカーが応答を返さない事故で発話キューが止まらないようにする。
      // 実行中コマンドは取り消せず、応答にコマンド ID もないため、同じワーカーを使い続けると
      // 遅延応答が後続コマンドの完了として誤処理される。ワーカーごと落として世代を切り替える。
      entry.timer = setTimeout(() => {
        if (this.child !== child) return; // 既に世代交代済み
        this.log?.warn(`再生ワーカーが応答しません (${command.split(' ')[0]})。ワーカーを再起動します`);
        child.kill?.();
        this.#discard(child, '再生ワーカーが応答しません');
      }, this.timeoutMs);
    });
  }

  async play(filePath) {
    await this.#send(`PLAY ${filePath}`);
  }

  /**
   * 無音をループ再生して Windows の音声出力を keep-alive する。
   * 次の play() はワーカー側でループ再生を止めて差し替える。
   */
  async hold() {
    await this.#send('HOLD');
  }

  async stop() {
    try {
      await this.#send('STOP');
    } catch {
      // 停止に失敗しても後続の再生は試す
    }
  }

  async dispose() {
    // 意図的な終了なので、以後は自動復旧しない
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    try {
      await this.#send('EXIT');
    } catch {}
    child.kill?.();
    this.#discard(child, '再生ワーカーを終了しました', { restart: false });
  }
}
