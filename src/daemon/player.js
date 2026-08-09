// 常駐 PowerShell ワーカーを介した wav 再生。
// 毎回プロセスを起こすと 1 発話ごとに数百ミリ秒の無音が入るため、ワーカーは使い回す。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const WORKER_PS1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'player-worker.ps1');

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

export class Player extends EventEmitter {
  constructor(logger) {
    super();
    this.log = logger;
    this.child = null;
    this.ready = false;
    this.pending = [];
    this.buffer = '';
    this.restartCount = 0;
  }

  start() {
    if (this.child) return;
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER_PS1],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => this.log?.warn(`player worker stderr: ${d.trim()}`));

    this.child.on('exit', (code) => {
      this.log?.warn(`再生ワーカーが終了しました (code=${code})`);
      this.child = null;
      this.ready = false;
      for (const p of this.pending.splice(0)) p.reject(new Error('再生ワーカーが終了しました'));
      // 落ちたら自動復旧する。ただし無限リトライはしない
      if (this.restartCount < 5) {
        this.restartCount += 1;
        setTimeout(() => this.start(), 1000);
      }
    });

    this.child.on('error', (err) => {
      this.log?.error(`再生ワーカーを起動できません: ${err.message}`);
      this.child = null;
      this.ready = false;
    });
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
      if (!this.child?.stdin?.writable) {
        reject(new Error('再生ワーカーが利用できません'));
        return;
      }
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${command}\n`);
      // ワーカーが応答を返さない事故で発話キューが止まらないようにする
      setTimeout(() => {
        const i = this.pending.findIndex((x) => x.resolve === resolve);
        if (i >= 0) {
          this.pending.splice(i, 1);
          reject(new Error('再生ワーカーが応答しません'));
        }
      }, 10000);
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
    if (!this.child) return;
    try {
      await this.#send('EXIT');
    } catch {}
    this.child?.kill();
    this.child = null;
  }
}
