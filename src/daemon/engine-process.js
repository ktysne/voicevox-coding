// VOICEVOX ENGINE のプロセス管理。
// VOICEVOX アプリ（GUI）を常駐させなくても、同梱のエンジン単体を直接起動すれば
// 合成 API は使える。GUI 版が既に 50021 を掴んでいる場合は何もしない。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { CONFIG_DIR } from './config.js';

const PID_PATH = path.join(CONFIG_DIR, 'engine.pid');
const ENGINE_REL_PATH = path.join('VOICEVOX', 'vv-engine', 'run.exe');

/** 利用者本人か管理者だけが書ける場所。自動起動はこの配下の実行ファイルだけを使う。 */
function trustedInstallRoots() {
  return [
    process.env.LOCALAPPDATA,
    path.join(os.homedir(), 'AppData', 'Local'),
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
  ].filter(Boolean);
}

function isUnderTrustedRoot(p) {
  return trustedInstallRoots().some((root) => {
    const rel = path.relative(root, p);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/** 既知のインストール先。どれも trustedInstallRoots() の配下にある。 */
function candidatePaths() {
  return [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', ENGINE_REL_PATH),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', ENGINE_REL_PATH),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, ENGINE_REL_PATH),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], ENGINE_REL_PATH),
  ].filter(Boolean);
}

/** 他の OS ユーザーやリムーバブルメディアが書けうるため、自動起動では使わない。 */
function driveRootCandidatePaths() {
  return ['C', 'D', 'E', 'F', 'G'].map((drive) => path.join(`${drive}:\\`, ENGINE_REL_PATH));
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

async function registryCandidatePaths() {
  const fromRegistry = await runPowerShell(
    "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', " +
      "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.DisplayName -like '*VOICEVOX*' } | " +
      'Select-Object -ExpandProperty InstallLocation -First 3) -join "`n"',
  );
  return fromRegistry
    .split('\n')
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => path.join(dir, 'vv-engine', 'run.exe'));
}

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 管理画面で利用者が確認して保存するエンジン実行ファイルを探す。
 * 起動中プロセス、レジストリ、既知の候補、ドライブ直下の順に確認する。
 * 書き込める者を限定できない場所も含むため、自動起動では使わない。
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

  const fromRegistry = firstExistingPath(await registryCandidatePaths());
  if (fromRegistry) return fromRegistry;

  const fromKnownLocation = firstExistingPath(candidatePaths());
  if (fromKnownLocation) return fromKnownLocation;

  return firstExistingPath(driveRootCandidatePaths());
}

async function detectAutoStartEnginePath() {
  // レジストリの登録先がドライブ直下などでも、その実行ファイルを書ける者は限定できない
  const fromRegistry = firstExistingPath((await registryCandidatePaths()).filter(isUnderTrustedRoot));
  if (fromRegistry) return fromRegistry;
  return firstExistingPath(candidatePaths());
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
    this.lastUntrustedReason = null;
    engine.trust?.setManagedPids?.(() => (this.child?.pid ? [this.child.pid] : []));
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
    // 所有者を確かめられない待受は応答しないとは限らないので、終了させずに次の起動へ持ち越す
    if (status.untrusted) {
      this.log?.warn(`前回のエンジン (PID ${pid}) の引き継ぎを見送ります: ${status.error}`);
      return;
    }
    let listeners = null;
    try {
      listeners = await this.engine.trust?.listeners(this.engine.baseUrl) ?? null;
    } catch {}
    // 待受が前回の PID でもその子孫でもなければ、PID ファイルの PID は再利用されたものなので終了させない
    if (listeners?.length && !listeners.includes(pid)) {
      const descendant = status.available
        && await this.#anyDescendantOf(listeners, pid);
      if (!descendant) {
        this.log?.info(`PID ${pid} はエンジンの待受ではないため、引き継がずに PID ファイルを消します`);
        writePid(null);
        return;
      }
    }
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

  async #anyDescendantOf(pids, ancestor) {
    try {
      for (const pid of pids) {
        if (await this.engine.trust?.isDescendantOf?.(pid, ancestor)) return true;
      }
    } catch {}
    return false;
  }

  /**
   * エンジンが応答するまで待つ。モデル読み込みがあるので初回は 20〜60 秒かかることがある。
   * 待受が別ユーザーのものと分かったら、待っても応答しないので理由を返して抜ける。
   * @returns {Promise<{ready:boolean, error?:string}>}
   */
  async waitUntilReady(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.engine.status();
      if (s.available) return { ready: true };
      if (s.untrusted) return { ready: false, error: s.error };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ready: false };
  }

  /**
   * エンジンを起動する。既に応答していれば何もしない。
   * @returns {Promise<{started:boolean, alreadyRunning?:boolean, error?:string}>}
   */
  async start({ force = false } = {}) {
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const status = await this.engine.status();
      // 警告は呼び出し側が error を出す (ensure は理由が変わったときだけ出す)
      if (status.untrusted) return { started: false, error: status.error };
      if (status.available && !force) {
        return { started: false, alreadyRunning: true };
      }

      const cfg = this.getConfig().engine;
      let exe = cfg.enginePath;
      if (exe && !fs.existsSync(exe)) {
        const error = `設定したエンジンのパスが見つかりません: ${exe}。管理コンソールでパスを指定し直してください。`;
        this.log?.error(error);
        return { started: false, error };
      }
      if (!exe) {
        exe = await detectAutoStartEnginePath();
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
      // 終了後の PID は再利用されうるので、所有者の照会を省く対象から外す
      child.on('exit', () => {
        if (this.child === child) this.child = null;
      });

      this.child = child;
      this.startedByUs = true;
      writePid(child.pid);

      const wait = await this.waitUntilReady(cfg.startTimeoutSec ? cfg.startTimeoutSec * 1000 : 90000);
      if (wait.error) return { started: true, error: wait.error };
      if (!wait.ready) {
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
    if (s.untrusted) {
      if (this.lastUntrustedReason !== s.error) this.log?.warn(s.error);
      this.lastUntrustedReason = s.error;
      return false;
    }
    this.lastUntrustedReason = null;
    if (s.available) return true;
    const r = await this.start();
    return r.started && !r.error;
  }
}
