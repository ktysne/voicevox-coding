// VOICEVOX ENGINE のプロセス管理。
// VOICEVOX アプリ（GUI）を常駐させなくても、同梱のエンジン単体を直接起動すれば
// 合成 API は使える。GUI 版が既に 50021 を掴んでいる場合は何もしない。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { CONFIG_DIR } from './config.js';

const PID_PATH = path.join(CONFIG_DIR, 'engine.pid');

/** 既知のインストール先候補。上から順に探す。 */
function candidatePaths() {
  const rel = path.join('VOICEVOX', 'vv-engine', 'run.exe');
  const list = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', rel),
    path.join(process.env.PROGRAMFILES ?? '', 'VOICEVOX', 'vv-engine', 'run.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'VOICEVOX', 'vv-engine', 'run.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', rel),
  ];
  // ドライブ直下の VOICEVOX（インストーラで場所を変えた場合によくある）
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    list.push(path.join(`${drive}:\\`, rel));
  }
  return list;
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout).trim()),
    );
  });
}

/**
 * エンジンの実行ファイルを探す。
 * 1) 起動中の run.exe / VOICEVOX.exe のパスから逆引き（最も確実）
 * 2) レジストリのアンインストール情報
 * 3) 既知のインストール先候補
 */
export async function detectEnginePath() {
  const fromProcess = await runPowerShell(
    "(Get-Process -Name 'run','VOICEVOX' -ErrorAction SilentlyContinue | " +
      'Where-Object { $_.Path } | Select-Object -ExpandProperty Path -First 5) -join "`n"',
  );
  for (const line of fromProcess.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (/\\vv-engine\\run\.exe$/i.test(line) && fs.existsSync(line)) return line;
    // VOICEVOX.exe が見つかったら同じフォルダの vv-engine を見る
    const guess = path.join(path.dirname(line), 'vv-engine', 'run.exe');
    if (fs.existsSync(guess)) return guess;
  }

  for (const p of candidatePaths()) {
    if (p && fs.existsSync(p)) return p;
  }

  const fromRegistry = await runPowerShell(
    "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', " +
      "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.DisplayName -like '*VOICEVOX*' } | " +
      'Select-Object -ExpandProperty InstallLocation -First 3) -join "`n"',
  );
  for (const dir of fromRegistry.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const p = path.join(dir, 'vv-engine', 'run.exe');
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (pid) fs.writeFileSync(PID_PATH, String(pid), 'utf8');
    else fs.rmSync(PID_PATH, { force: true });
  } catch {}
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  return new Promise((resolve) => {
    // run.exe は子プロセスを持つので、ツリーごと落とす
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

export class EngineProcess {
  /**
   * @param {() => object} getConfig
   * @param {import('./voicevox.js').VoicevoxEngine} engine
   * @param {object} logger
   */
  constructor(getConfig, engine, logger) {
    this.getConfig = getConfig;
    this.engine = engine;
    this.log = logger;
    this.child = null;
    this.startedByUs = false;
    this.starting = null;
  }

  get status() {
    return {
      managed: this.startedByUs,
      pid: this.child?.pid ?? readPid(),
      starting: Boolean(this.starting),
    };
  }

  /** 前回のデーモンが残したエンジンプロセスを片付ける。 */
  async reclaimStale() {
    const pid = readPid();
    if (!pid) return;
    if (!isAlive(pid)) {
      writePid(null);
      return;
    }
    const status = await this.engine.status();
    if (status.available) {
      // 生きていて応答もする。前回起動したものをそのまま使う
      this.startedByUs = true;
      this.log?.info(`前回起動したエンジン (PID ${pid}) を引き継ぎます`);
      return;
    }
    this.log?.warn(`応答しないエンジン (PID ${pid}) を終了します`);
    await killTree(pid);
    writePid(null);
  }

  /**
   * エンジンが応答するまで待つ。
   * モデル読み込みがあるので初回は 20〜60 秒かかることがある。
   */
  async waitUntilReady(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.engine.status();
      if (s.available) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /**
   * エンジンを起動する。既に応答していれば何もしない。
   * @returns {Promise<{started:boolean, alreadyRunning?:boolean, error?:string}>}
   */
  async start({ force = false } = {}) {
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const status = await this.engine.status();
      if (status.available && !force) {
        return { started: false, alreadyRunning: true };
      }

      const cfg = this.getConfig().engine;
      let exe = cfg.enginePath;
      if (!exe || !fs.existsSync(exe)) {
        exe = await detectEnginePath();
        if (exe) this.log?.info(`エンジンを検出しました: ${exe}`);
      }
      if (!exe) {
        return { started: false, error: 'エンジンの実行ファイルが見つかりません。管理コンソールでパスを指定してください。' };
      }

      let port = 50021;
      let host = '127.0.0.1';
      try {
        const u = new URL(cfg.baseUrl);
        port = Number(u.port) || 50021;
        host = u.hostname || '127.0.0.1';
      } catch {}

      const args = ['--host', host, '--port', String(port)];
      if (cfg.useGpu) args.push('--use_gpu');
      if (cfg.loadAllModels) args.push('--load_all_models');
      if (Number.isInteger(cfg.cpuNumThreads) && cfg.cpuNumThreads > 0) {
        args.push('--cpu_num_threads', String(cfg.cpuNumThreads));
      }

      this.log?.info(`VOICEVOX ENGINE を起動します: ${exe} ${args.join(' ')}`);
      const child = spawn(exe, args, {
        cwd: path.dirname(exe),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      child.on('error', (err) => this.log?.error(`エンジンの起動に失敗しました: ${err.message}`));

      this.child = child;
      this.startedByUs = true;
      writePid(child.pid);

      const ready = await this.waitUntilReady(cfg.startTimeoutSec ? cfg.startTimeoutSec * 1000 : 90000);
      if (!ready) {
        this.log?.error('エンジンが起動しましたが応答しません');
        return { started: true, error: 'エンジンが時間内に応答しませんでした' };
      }
      this.log?.info('VOICEVOX ENGINE が応答しました');
      return { started: true };
    })().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  /** 自分で起動したエンジンだけを止める。GUI アプリが立てたものは触らない。 */
  async stop() {
    const pid = this.child?.pid ?? readPid();
    if (!pid || !this.startedByUs) return { stopped: false, reason: 'not-managed' };
    this.log?.info(`VOICEVOX ENGINE を終了します (PID ${pid})`);
    await killTree(pid);
    writePid(null);
    this.child = null;
    this.startedByUs = false;
    return { stopped: true };
  }

  /**
   * エンジンが落ちていたら起動し直す。
   * autoStart が有効なときだけ動く。
   */
  async ensure() {
    const cfg = this.getConfig().engine;
    if (!cfg.autoStart) return false;
    const s = await this.engine.status();
    if (s.available) return true;
    const r = await this.start();
    return r.started && !r.error;
  }
}
