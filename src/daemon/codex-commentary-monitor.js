import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10000;

/** app-server の turn から、読み上げ対象の途中経過だけを取り出す。 */
export function extractCommentaryItems(turn) {
  if (!turn || !Array.isArray(turn.items)) return [];
  return turn.items.flatMap((item) => {
    if (item?.type !== 'agentMessage' || item.phase !== 'commentary') return [];
    const message = typeof item.text === 'string' ? item.text.trim() : '';
    if (!item.id || !message) return [];
    return [{ itemId: item.id, message }];
  });
}

class AppServerTransport extends EventEmitter {
  constructor({ spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, log } = {}) {
    super();
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.lastStderrLogAt = 0;
  }

  start() {
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'codex';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'codex app-server'] : ['app-server'];
    this.child = this.spawnFn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.#receive(line));
    this.child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      // app-server はプラグイン同期や read-repair の診断 WARN を頻繁に出す。
      // RPC の失敗は応答/終了側で別途通知されるため、stderr はデバッグ用途に絞って間引く。
      if (text && Date.now() - this.lastStderrLogAt >= 60_000) {
        this.lastStderrLogAt = Date.now();
        this.log?.debug?.(`Codex app-server: ${text.slice(0, 500)}`);
      }
    });
    this.child.once('error', (err) => this.#closed(err));
    this.child.once('exit', (code, signal) => {
      this.#closed(new Error(`Codex app-server が終了しました (code=${code}, signal=${signal ?? 'none'})`));
    });
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('Codex app-server は起動していません'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} がタイムアウトしました`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server は起動していません');
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  #closed(error) {
    if (!this.child) return;
    this.child = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit('close', error);
  }

  dispose() {
    const child = this.child;
    this.child = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Codex app-server を終了しました'));
    }
    this.pending.clear();
    if (child && !child.killed) child.kill();
  }
}

export class CodexCommentaryMonitor extends EventEmitter {
  constructor({ pollMs = DEFAULT_POLL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, log, transportFactory } = {}) {
    super();
    this.pollMs = pollMs;
    this.log = log;
    this.transportFactory = transportFactory ?? (() => new AppServerTransport({ timeoutMs, log }));
    this.transport = null;
    this.timer = null;
    this.restartTimer = null;
    this.running = false;
    this.polling = false;
    this.baselineComplete = false;
    this.seenItems = new Set();
    this.backoffMs = 1000;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#connect();
  }

  async #connect() {
    if (!this.running) return;
    const transport = this.transportFactory();
    this.transport = transport;
    // ポーリングタイマーは接続世代ごとに所有し、その世代の close で必ず解除する。
    // this.timer だけに頼ると、世代をまたいだときに古いタイマーへの参照を失う。
    let timer = null;
    const clearOwnTimer = () => {
      if (!timer) return;
      clearInterval(timer);
      if (this.timer === timer) this.timer = null;
      timer = null;
    };
    transport.on?.('close', (err) => {
      // 既に別世代へ切り替わっていても、この世代のタイマーだけは確実に止める。
      clearOwnTimer();
      if (transport !== this.transport || !this.running) return;
      this.log?.warn?.(err?.message ?? 'Codex app-server との接続が切れました');
      this.transport = null;
      this.#scheduleRestart();
    });
    try {
      transport.start?.();
      await transport.request('initialize', {
        clientInfo: { name: 'voicevox-coding', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      transport.notify?.('initialized', {});
      if (!this.running || transport !== this.transport) return;
      await this.scan(transport);
      // 初回走査の待機中に切断や停止が起きていることがあるため、
      // タイマーを作る直前にも接続世代を確認する。古い世代はここで手を引く。
      if (!this.running || transport !== this.transport) return;
      this.backoffMs = 1000;
      timer = setInterval(() => {
        // 解除漏れへの保険。世代が古くなっていれば走査せず自分自身を止める。
        if (!this.running || transport !== this.transport) {
          clearOwnTimer();
          return;
        }
        this.scan(transport);
      }, this.pollMs);
      timer.unref?.();
      this.timer = timer;
    } catch (err) {
      if (!this.running || transport !== this.transport) return;
      this.log?.warn?.(`Codex の途中経過監視を開始できません: ${err.message}`);
      transport.dispose?.();
      this.transport = null;
      this.#scheduleRestart();
    }
  }

  #scheduleRestart() {
    if (!this.running || this.restartTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.#connect();
    }, delay);
    this.restartTimer.unref?.();
  }

  /** 引数の transport（接続世代）で走査する。省略時は現在の接続を使う。 */
  async scan(transport = this.transport) {
    if (this.polling || !transport || transport !== this.transport) return;
    this.polling = true;
    try {
      const result = await transport.request('thread/list', {
        sourceKinds: ['vscode'], limit: 20, sortKey: 'updated_at',
      });
      // 待機中に切断されていれば、古い応答は新しい接続へ持ち込まずに捨てる。
      if (transport !== this.transport) return;
      const threads = result?.data ?? result?.threads ?? [];
      for (const thread of threads) {
        const threadId = thread?.id;
        if (!threadId) continue;
        const turnsResult = await transport.request('thread/turns/list', {
          threadId, limit: 1, sortDirection: 'desc', itemsView: 'full',
        });
        if (transport !== this.transport) return;
        const turn = (turnsResult?.data ?? turnsResult?.turns ?? [])[0];
        for (const item of extractCommentaryItems(turn)) {
          const itemKey = `${threadId}:${turn?.id ?? ''}:${item.itemId}`;
          const unseen = !this.seenItems.has(itemKey);
          this.seenItems.add(itemKey);
          while (this.seenItems.size > 5000) {
            this.seenItems.delete(this.seenItems.values().next().value);
          }
          if (this.baselineComplete && unseen) {
            this.emit('commentary', { ...item, threadId, turnId: turn?.id });
          }
        }
      }
      this.baselineComplete = true;
    } catch (err) {
      this.log?.warn?.(`Codex の途中経過を取得できません: ${err.message}`);
    } finally {
      this.polling = false;
    }
  }

  dispose() {
    this.running = false;
    clearInterval(this.timer);
    clearTimeout(this.restartTimer);
    this.timer = null;
    this.restartTimer = null;
    this.transport?.dispose?.();
    this.transport = null;
  }

  stop() {
    this.dispose();
  }
}
