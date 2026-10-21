// エンジンの実行ファイルの探索と、自動起動で使うパスの選び方のテスト。
// PowerShell と spawn を差し替え、実機のインストール状況やプロセスに依存させない。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

const REL = path.join('VOICEVOX', 'vv-engine', 'run.exe');
const LOCALAPPDATA = 'X:\\fake\\LocalAppData';
const PROGRAMFILES = 'X:\\fake\\Program Files';
const DRIVE_ROOT_EXE = path.join('C:\\', REL);
const LOCALAPPDATA_EXE = path.join(LOCALAPPDATA, 'Programs', REL);
const REGISTRY_DIR = 'X:\\fake\\Program Files\\VOICEVOX Registered';
const REGISTRY_EXE = path.join(REGISTRY_DIR, 'vv-engine', 'run.exe');

// CONFIG_DIR は読み込み時に os.homedir() から決まるので、engine.pid を一時ディレクトリへ書かせる
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-engine-test-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;
process.env.LOCALAPPDATA = LOCALAPPDATA;
process.env.PROGRAMFILES = PROGRAMFILES;
process.env['PROGRAMFILES(X86)'] = 'X:\\fake\\Program Files (x86)';

let existing = new Set();
let powershell = { processes: '', registry: '' };
let spawned = [];

const origExecFile = childProcess.execFile;
const origSpawn = childProcess.spawn;
const origExistsSync = fs.existsSync;

childProcess.execFile = (file, args, opts, cb) => {
  const script = args.at(-1) ?? '';
  if (/Get-Process/.test(script)) cb(null, powershell.processes);
  else if (/Uninstall/.test(script)) cb(null, powershell.registry);
  else cb(null, '');
  return new EventEmitter();
};
childProcess.spawn = (exe, args) => {
  spawned.push({ exe, args });
  const child = new EventEmitter();
  child.pid = 99999;
  child.unref = () => {};
  return child;
};
fs.existsSync = (p) => existing.has(p);
syncBuiltinESMExports();

const { EngineProcess, detectEnginePath } = await import('../src/daemon/engine-process.js');

function makeProcess(enginePath) {
  const config = {
    engine: { enginePath, baseUrl: 'http://127.0.0.1:50021', autoStart: true, startTimeoutSec: 1 },
  };
  const engine = { status: async () => ({ available: spawned.length > 0 }) };
  const log = { info() {}, warn() {}, error() {} };
  return new EngineProcess(() => config, engine, log);
}

beforeEach(() => {
  existing = new Set();
  powershell = { processes: '', registry: '' };
  spawned = [];
});

afterEach(() => {
  fs.rmSync(path.join(tmpHome, '.voicevox-coding'), { recursive: true, force: true });
});

test.after(() => {
  childProcess.execFile = origExecFile;
  childProcess.spawn = origSpawn;
  fs.existsSync = origExistsSync;
  syncBuiltinESMExports();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('管理画面の自動検出はドライブ直下のインストールも見つける', async () => {
  existing.add(DRIVE_ROOT_EXE);
  assert.equal(await detectEnginePath(), DRIVE_ROOT_EXE);
});

test('enginePath が空の自動起動は、ドライブ直下の run.exe を起動しない', async () => {
  existing.add(DRIVE_ROOT_EXE);
  const r = await makeProcess('').start();
  assert.deepEqual(spawned, []);
  assert.equal(r.started, false);
  assert.equal(typeof r.error, 'string');
});

test('enginePath が空の自動起動は、レジストリのインストール先を LOCALAPPDATA より先に使う', async () => {
  existing.add(REGISTRY_EXE);
  existing.add(LOCALAPPDATA_EXE);
  powershell.registry = REGISTRY_DIR;
  const r = await makeProcess('').start();
  assert.equal(r.started, true);
  assert.equal(spawned[0]?.exe, REGISTRY_EXE);
});

test('enginePath が空の自動起動は、ドライブ直下を指すレジストリの登録先を使わない', async () => {
  const registryDriveRoot = 'D:\\VOICEVOX';
  existing.add(path.join(registryDriveRoot, 'vv-engine', 'run.exe'));
  existing.add(LOCALAPPDATA_EXE);
  powershell.registry = registryDriveRoot;
  const r = await makeProcess('').start();
  assert.equal(r.started, true);
  assert.equal(spawned[0]?.exe, LOCALAPPDATA_EXE);
});

test('管理画面の自動検出は、ドライブ直下を指すレジストリの登録先も見つける', async () => {
  const registryDriveRoot = 'D:\\VOICEVOX';
  const exe = path.join(registryDriveRoot, 'vv-engine', 'run.exe');
  existing.add(exe);
  powershell.registry = registryDriveRoot;
  assert.equal(await detectEnginePath(), exe);
});

test('enginePath が空の自動起動は、起動中のプロセスのパスを使わない', async () => {
  const elsewhere = 'X:\\somewhere\\vv-engine\\run.exe';
  existing.add(elsewhere);
  powershell.processes = elsewhere;
  const r = await makeProcess('').start();
  assert.deepEqual(spawned, []);
  assert.equal(r.started, false);
});

test('設定した enginePath が無くなったら、自動検出に切り替えずに失敗を返す', async () => {
  const missing = 'X:\\gone\\vv-engine\\run.exe';
  existing.add(LOCALAPPDATA_EXE);
  const r = await makeProcess(missing).start();
  assert.deepEqual(spawned, []);
  assert.equal(r.started, false);
  assert.match(r.error, /gone/);
});

test('設定した enginePath が存在すれば、そのパスを起動する', async () => {
  const configured = 'X:\\chosen\\vv-engine\\run.exe';
  existing.add(configured);
  existing.add(REGISTRY_EXE);
  powershell.registry = REGISTRY_DIR;
  const r = await makeProcess(configured).start();
  assert.equal(r.started, true);
  assert.equal(spawned[0]?.exe, configured);
});
