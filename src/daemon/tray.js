// タスクトレイ常駐アイコンの起動と監視。
// トレイ側はデーモンと HTTP でだけやり取りするので、ここでは起動と再起動だけを見る。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRAY_PS1 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tray', 'tray-worker.ps1');

// 短時間の連続クラッシュでは諦めるが、これ以上安定して動いていたらクラッシュ回数をリセットする。
const DEFAULT_STABLE_MS = 60000;
const DEFAULT_RESTART_DELAY_MS = 2000;

export class Tray {
  /**
   * @param {number} port
   * @param {object} [logger]
   * @param {string} [token]
   * @param {{ spawnFn?: typeof spawn, stableMs?: number, restartDelayMs?: number }} [options] テスト用の注入口
   */
  constructor(port, logger, token = '', { spawnFn = spawn, stableMs = DEFAULT_STABLE_MS, restartDelayMs = DEFAULT_RESTART_DELAY_MS } = {}) {
    this.port = port;
    this.log = logger;
    this.token = token;
    this.spawnFn = spawnFn;
    this.stableMs = stableMs;
    this.restartDelayMs = restartDelayMs;
    this.child = null;
    this.stopping = false;
    this.restarts = 0;
    this.startedAt = 0;
    this.restartTimer = null;
  }

  start() {
    if (this.child || this.stopping) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.spawnFn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', TRAY_PS1,
        '-Port', String(this.port),
        '-ParentPid', String(process.pid),
        '-Token', this.token,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    this.child = child;
    this.startedAt = Date.now();
    // この子プロセスについて再起動判定を行ったかどうか。exit と error が
    // 二重に発火しても再起動を二重にスケジュールしないためのガード。
    let handled = false;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d) => {
      const msg = String(d).trim();
      if (msg) this.log?.warn(`トレイ: ${msg}`);
    });

    child.on('exit', (code) => {
      if (this.child !== child || handled) return;
      handled = true;
      this.child = null;
      if (this.stopping) return;
      // トレイの「終了」を選んだ場合でも、デーモン側の stop()（this.stopping = true）より
      // 先に子プロセスの exit イベントが届くことがある。これは正常系であり、
      // tray-worker.ps1 は意図した終了では必ず code=0 で抜けるため、
      // code=0 は警告扱いにしない（それ以外の code や null は異常終了として警告する）。
      const label = code === 0
        ? () => this.log?.info(`トレイが終了しました (code=${code})。再起動します`)
        : () => this.log?.warn(`トレイが終了しました (code=${code})。再起動します`);
      this.#scheduleRestart(label);
    });

    child.on('error', (err) => {
      if (this.child !== child || handled) return;
      handled = true;
      this.child = null;
      this.log?.error(`トレイを起動できません: ${err.message}`);
      // spawn 自体の失敗も再起動回数として数え、上限までは再試行する。
      // これが無いと、環境要因で最初の一度も起動できなかった場合に GUI 操作手段が永久に失われる。
      this.#scheduleRestart();
    });

    this.log?.info('タスクトレイに常駐しました');
  }

  /**
   * exit / error 共通の再起動判定。安定稼働（stableMs 以上生存）していたら
   * クラッシュカウンタをリセットしてから上限判定するので、長期常駐中の
   * 単発クラッシュで再起動回数を使い切ることはない。
   */
  #scheduleRestart(beforeLog) {
    const aliveMs = this.startedAt ? Date.now() - this.startedAt : 0;
    if (aliveMs >= this.stableMs) this.restarts = 0;

    if (this.restarts < 3) {
      this.restarts += 1;
      beforeLog?.();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, this.restartDelayMs);
      this.restartTimer.unref?.();
    } else {
      this.log?.error('トレイの再起動を諦めました');
    }
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.kill();
    this.child = null;
  }
}
