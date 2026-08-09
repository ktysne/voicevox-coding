// タスクトレイ常駐アイコンの起動と監視。
// トレイ側はデーモンと HTTP でだけやり取りするので、ここでは起動と再起動だけを見る。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRAY_PS1 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tray', 'tray-worker.ps1');

export class Tray {
  constructor(port, logger, token = '') {
    this.port = port;
    this.log = logger;
    this.token = token;
    this.child = null;
    this.stopping = false;
    this.restarts = 0;
  }

  start() {
    if (this.child || this.stopping) return;
    this.child = spawn(
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

    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (d) => {
      const msg = String(d).trim();
      if (msg) this.log?.warn(`トレイ: ${msg}`);
    });

    this.child.on('exit', (code) => {
      this.child = null;
      if (this.stopping) return;
      // ユーザーがトレイの「終了」を選んだ場合はデーモンも止まるので、
      // ここに来るのは異常終了だけ。数回までは復帰を試みる。
      if (this.restarts < 3) {
        this.restarts += 1;
        this.log?.warn(`トレイが終了しました (code=${code})。再起動します`);
        setTimeout(() => this.start(), 2000);
      } else {
        this.log?.error('トレイの再起動を諦めました');
      }
    });

    this.child.on('error', (err) => {
      this.log?.error(`トレイを起動できません: ${err.message}`);
      this.child = null;
    });

    this.log?.info('タスクトレイに常駐しました');
  }

  stop() {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
  }
}
