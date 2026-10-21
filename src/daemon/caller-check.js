// HTTP の接続元が、デーモンと同じ OS ユーザーのプロセスかを確かめる。
// 接続元ポートから所有プロセスの SID を引く処理は、常駐 PowerShell ワーカーが行う。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER_PS1 = fileURLToPath(new URL('./caller-worker.ps1', import.meta.url));

// ワーカーは起動時に C# をコンパイルするので、ログオン直後など負荷が高いときは数秒かかる
const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_TIMEOUT_MS = 3000;

/** 判定が決まらないとき(ワーカーの不調を含む)は sameUser:false を返し、拒否側に倒す。 */
export class CallerVerifier {
  constructor(logger, {
    spawnFn = spawn,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    restartDelayMs = 1000,
    maxRestarts = 5,
  } = {}) {
    this.log = logger;
    Object.assign(this, { spawnFn, startTimeoutMs, timeoutMs, restartDelayMs, maxRestarts });
    this.child = null;
    this.pending = new Map();
    this.cache = new WeakMap();
    this.nextId = 0;
    this.restartCount = 0;
    this.disposed = false;
    this.warned = false;
  }

  start() {
    if (this.child || this.disposed || this.restartTimer) return;
    const generation = { child: null, sid: null, buffer: '', waiters: new Set() };
    this.child = generation;
    try {
      const child = this.spawnFn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER_PS1],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      generation.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (this.child !== generation) return;
        generation.buffer += chunk;
        let index;
        while ((index = generation.buffer.indexOf('\n')) >= 0) {
          const line = generation.buffer.slice(0, index).replace(/\r$/, '');
          generation.buffer = generation.buffer.slice(index + 1);
          const ready = /^READY (S-\d+(?:-\d+)+)$/.exec(line);
          if (ready && !generation.sid) {
            generation.sid = ready[1];
            this.restartCount = 0;
            clearTimeout(generation.timer);
            for (const send of generation.waiters) send();
            generation.waiters.clear();
            continue;
          }
          const response = /^(\d+) (OK (S-\d+(?:-\d+)+)|ERR (.+))$/.exec(line);
          if (!response) continue;
          const entry = this.pending.get(response[1]);
          if (!entry || entry.generation !== generation || !entry.sent) continue;
          entry.finish({ sameUser: response[3] === generation.sid, ...(response[4] ? { reason: response[4] } : {}) }, true);
        }
      });
      child.stderr.on('data', () => this.#warn('接続元確認ワーカーがエラーを出力しました'));
      child.stdin.on('error', () => this.#discard(generation, '接続元確認ワーカーに送信できません'));
      child.on('error', (err) => this.#discard(generation, `接続元確認ワーカーを起動できません: ${err.message}`));
      child.on('exit', () => this.#discard(generation, '接続元確認ワーカーが終了しました'));
      generation.timer = setTimeout(() => this.#discard(generation, '接続元確認ワーカーの起動待ちが上限を超えました'), this.startTimeoutMs);
    } catch (err) {
      this.#discard(generation, `接続元確認ワーカーを起動できません: ${err.message}`);
    }
  }

  #warn(reason) {
    if (this.warned) return;
    this.warned = true;
    this.log?.warn(reason);
  }

  #discard(generation, reason) {
    if (this.child !== generation) return;
    this.child = null;
    clearTimeout(generation.timer);
    generation.waiters.clear();
    for (const entry of [...this.pending.values()]) entry.finish({ sameUser: false, reason }, false);
    generation.child?.stdin.end();
    generation.child?.kill?.();
    if (this.disposed) return;
    this.#warn(reason);
    if (this.restartCount < this.maxRestarts) {
      this.restartCount += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, this.restartDelayMs);
      this.restartTimer.unref?.();
    }
  }

  async verifySocket(socket, serverPort) {
    if (socket.remoteFamily !== 'IPv4' || socket.remoteAddress !== '127.0.0.1') {
      return { sameUser: false, reason: 'IPv4 ループバック以外の接続です' };
    }
    if (this.cache.has(socket)) return this.cache.get(socket);
    const generation = this.child;
    if (!generation || this.disposed) {
      this.#warn('接続元確認ワーカーが利用できません');
      return { sameUser: false, reason: '接続元確認ワーカーが利用できません' };
    }
    if (![socket.remotePort, serverPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535)) {
      return { sameUser: false, reason: 'ポートが不正です' };
    }
    return new Promise((resolve) => {
      const id = String(++this.nextId);
      const entry = {
        generation, sent: false,
        finish: (result, cacheable) => {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          generation.waiters.delete(send);
          if (cacheable) this.cache.set(socket, result);
          resolve(result);
        },
      };
      const send = () => {
        if (this.child !== generation) return;
        entry.sent = true;
        try {
          generation.child.stdin.write(`${id} ${socket.remotePort} ${serverPort}\n`);
        } catch {
          this.#discard(generation, '接続元確認ワーカーに送信できません');
        }
      };
      this.pending.set(id, entry);
      entry.timer = setTimeout(() => this.#discard(generation, '接続元確認の応答待ちが上限を超えました'), this.timeoutMs);
      if (generation.sid) send();
      else generation.waiters.add(send);
    });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.child) this.#discard(this.child, '接続元確認ワーカーを終了しました');
  }
}
