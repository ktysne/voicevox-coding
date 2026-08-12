import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import readline from 'node:readline';

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RESTART_DELAY_MS = 1000;
// 一度も接続に成功しないまま、この回数だけ連続で失敗したら低頻度の再試行へ切り替える。
// codex CLI が存在しない環境で spawn → 即終了 → 再接続を短い間隔で永遠に繰り返さないための上限。
// CLI 不在と「デーモン起動時にたまたま app-server が不調だった」は外からは区別できないため、
// 恒久停止はせず、間隔を大きく広げて再試行を続ける（不調が直れば自動で復旧する）。
const MAX_CONNECT_FAILURES_BEFORE_SLOW_RETRY = 3;
// 低頻度の再試行間隔。CLI が無い環境でもこの頻度の spawn なら実害がない。
const DEFAULT_SLOW_RETRY_DELAY_MS = 10 * 60 * 1000;
// 接続は生きているのに走査（RPC）の失敗がこの回数続いたら、接続ごと取り直す。
// 壊れた・非互換の app-server へ約 2 秒間隔の要求と警告を出し続けないための上限。
const MAX_CONSECUTIVE_SCAN_FAILURES = 3;

/** 設定から、Codex の途中経過監視を動かすべきかどうかを判定する。 */
export function commentaryEnabled(cfg) {
  return cfg?.targets?.codex?.enabled !== false
    && cfg?.targets?.codex?.events?.Commentary?.enabled !== false;
}

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

// テストから spawnFn を注入して dispose の終了経路を検証できるよう export する
export class AppServerTransport extends EventEmitter {
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
    if (!child || child.killed) return;
    // app-server は stdin の EOF で自力終了する。Windows では cmd.exe 経由で
    // 起動しており、child.kill() は cmd.exe しか終了させず実体の codex が
    // 孤児化するため、まず EOF を届けて正規に終了させる。
    try {
      child.stdin?.end();
      child.stdin?.destroy();
    } catch {}
    // EOF で終わらない場合の保険。Windows はプロセスツリーごと、それ以外は kill で落とす。
    // cmd.exe は実体の終了を待って生きているので、ツリー終了は実体まで届く。
    const forceKill = setTimeout(() => {
      if (child.exitCode !== null || child.killed) return;
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
          // 失敗を黙らせない（プロセスが既に終了していた場合も err になるが、
          // その場合は実害がないので debug 相当の扱いでよい）
          if (err) this.log?.debug?.(`Codex app-server の強制終了に失敗しました: ${err.message}`);
        });
      } else {
        child.kill();
      }
    }, 2000);
    forceKill.unref?.();
    child.once('exit', () => clearTimeout(forceKill));
  }
}

export class CodexCommentaryMonitor extends EventEmitter {
  constructor({
    pollMs = DEFAULT_POLL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    slowRetryDelayMs = DEFAULT_SLOW_RETRY_DELAY_MS,
    log,
    transportFactory,
  } = {}) {
    super();
    this.pollMs = pollMs;
    this.restartDelayMs = restartDelayMs;
    this.slowRetryDelayMs = slowRetryDelayMs;
    this.log = log;
    this.transportFactory = transportFactory ?? (() => new AppServerTransport({ timeoutMs, log }));
    this.transport = null;
    this.timer = null;
    this.restartTimer = null;
    this.running = false;
    this.polling = false;
    this.baselineComplete = false;
    this.seenItems = new Set();
    this.backoffMs = restartDelayMs;
    // 一度でも initialize + 初回 scan まで到達したか。true になった後の切断は
    // 一時的な app-server の不調とみなし、従来どおり無限にバックオフ再接続する。
    this.everConnected = false;
    // everConnected に達しないまま連続した接続失敗の回数。低頻度再試行への切替判定に使う。
    this.consecutiveFailures = 0;
    // 低頻度の再試行モード。切替時に 1 回だけ warn を出すためのフラグを兼ねる。
    this.slowRetry = false;
    // 接続が生きたまま走査（RPC）だけが連続で失敗している回数。完走でリセットする。
    this.scanFailures = 0;
  }

  start() {
    if (this.running) {
      // 稼働中は何もしない。ただし低頻度の再試行待ちなら、設定変更を契機に
      // 直ちに試し直す（warn の「設定を変更すると直ちに再試行します」を実態にする）。
      // 低頻度モードは一度も接続に成功していない状態なので、取り直しで失うものはない。
      if (!this.slowRetry) return;
      this.dispose();
    }
    this.running = true;
    // 無効化されていた間に溜まった途中経過を、再有効化した瞬間にまとめて読み上げないよう、
    // baseline や既知 item、バックオフ・失敗カウンタを含めて「まっさらな状態」からやり直す。
    this.baselineComplete = false;
    this.seenItems.clear();
    this.backoffMs = this.restartDelayMs;
    this.everConnected = false;
    this.consecutiveFailures = 0;
    this.slowRetry = false;
    this.scanFailures = 0;
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
      this.#handleConnectFailure();
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
      // initialize が完了し、初回 scan も完走していれば接続成功を記録する。
      // 初回 scan が失敗しても、後続のポーリングの scan が完走した時点で
      // 記録される（scan 側の #noteConnected 参照）。
      if (this.baselineComplete) this.#noteConnected();
      this.backoffMs = this.restartDelayMs;
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
      this.#handleConnectFailure();
    }
  }

  /**
   * 走査の完走 = 接続成功として記録する。これ以降の切断は「一時的な不調」として扱い、
   * 低頻度再試行への切替判定からは外す。低頻度モード中だったなら回復を 1 回だけ知らせる。
   */
  #noteConnected() {
    this.everConnected = true;
    this.consecutiveFailures = 0;
    this.scanFailures = 0;
    if (this.slowRetry) {
      this.slowRetry = false;
      this.log?.info?.('Codex の途中経過監視が接続を回復しました');
    }
  }

  /**
   * 接続失敗（close または #connect の catch）のたびに呼ぶ。
   * 一度も接続に成功していない状態が MAX_CONNECT_FAILURES_BEFORE_SLOW_RETRY 回連続したら、
   * 再試行の間隔を大きく広げる（codex CLI 不在などで短い間隔の spawn を永遠に繰り返さない）。
   * CLI 不在と起動時のたまたまの不調は外から区別できないため、恒久停止はせず
   * 低頻度で試し続ける（不調が直れば自動で復旧する）。切替を知らせる warn は 1 回だけ出す。
   * 一度でも接続に成功していれば（everConnected）、このカウンタは使わず従来どおり再接続を続ける。
   */
  #handleConnectFailure() {
    if (!this.running) return;
    if (!this.everConnected && !this.slowRetry) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= MAX_CONNECT_FAILURES_BEFORE_SLOW_RETRY) {
        this.slowRetry = true;
        this.log?.warn?.(
          'Codex の途中経過監視に接続できないため、再試行の間隔を広げます（codex CLI が'
          + '見つからないか app-server を起動できません）。設定を変更すると直ちに再試行します',
        );
      }
    }
    this.#scheduleRestart();
  }

  #scheduleRestart() {
    if (!this.running || this.restartTimer) return;
    // 低頻度モードでは固定の長い間隔で試す（倍々の 30 秒上限は使わない）
    const delay = this.slowRetry ? this.slowRetryDelayMs : this.backoffMs;
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
      // 走査が完走した = 接続に成功している。初回走査だけが失敗して後続の
      // ポーリングで回復したケースでも、ここで接続成功が記録される
      // （#connect 直後の判定だけだと、その後の切断で低頻度モードへ誤って入る）。
      this.#noteConnected();
    } catch (err) {
      // dispose() や世代交代で進行中の要求が reject されるのは正常なキャンセル。
      // 「取得できません」と騒がない
      if (!this.running || transport !== this.transport) return;
      this.scanFailures += 1;
      // 失敗が続く間は毎回は警告しない（約 2 秒ごとにログが埋まる）
      if (this.scanFailures === 1) {
        this.log?.warn?.(`Codex の途中経過を取得できません: ${err.message}`);
      }
      // 接続は生きているのに走査が失敗し続ける（壊れた・非互換の app-server など）
      // 場合は、切断と同じ扱いで接続を取り直す。everConnected でなければ
      // #handleConnectFailure が低頻度の再試行へ切り替えてくれる
      if (this.scanFailures >= MAX_CONSECUTIVE_SCAN_FAILURES) {
        this.log?.warn?.('Codex の途中経過の取得に失敗が続くため、接続をやり直します');
        this.transport = null;
        transport.dispose?.();
        this.#handleConnectFailure();
      }
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
