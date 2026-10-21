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
let killed = [];

const origExecFile = childProcess.execFile;
const origSpawn = childProcess.spawn;
const origExistsSync = fs.existsSync;

childProcess.execFile = (file, args, opts, cb) => {
  if (file === 'taskkill.exe') killed.push(Number(args[1]));
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
  killed = [];
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

test('start は untrusted のとき force でも spawn しない', async () => {
  const proc = makeProcess(LOCALAPPDATA_EXE);
  existing.add(LOCALAPPDATA_EXE);
  const warnings = [];
  proc.log.warn = (message) => warnings.push(message);
  proc.engine.status = async () => ({ available: false, untrusted: true, error: '別ユーザー (PID 10)' });
  assert.deepEqual(await proc.start({ force: true }), { started: false, untrusted: true, error: '別ユーザー (PID 10)' });
  assert.deepEqual(spawned, []);
  assert.deepEqual(warnings, ['別ユーザー (PID 10)']);
});

test('ensure は untrusted のとき start せず理由が変わったときだけ warn を出す', async () => {
  const proc = makeProcess('');
  let reason = '別ユーザー (PID 10)';
  const warnings = [];
  proc.engine.status = async () => ({ available: false, untrusted: true, error: reason });
  proc.start = async () => assert.fail('起動してはいけない');
  proc.log.warn = (message) => warnings.push(message);
  assert.equal(await proc.ensure(), false);
  assert.equal(await proc.ensure(), false);
  reason = '確認できません (PID 11)';
  assert.equal(await proc.ensure(), false);
  assert.deepEqual(warnings, ['別ユーザー (PID 10)', '確認できません (PID 11)']);
});

const pidPath = path.join(tmpHome, '.voicevox-coding', 'engine.pid');
function writeLivePid() {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid));
}

test('コンストラクターは現在の子プロセスの PID を trust に登録する', () => {
  let managed;
  const proc = new EngineProcess(() => ({}), { trust: { setManagedPids(fn) { managed = fn; } } }, null);
  assert.deepEqual(managed(), []);
  proc.child = { pid: 42 };
  assert.deepEqual(managed(), [42]);
});

test('reclaimStale は PID が待受に含まれ応答するエンジンを引き継ぐ', async () => {
  writeLivePid();
  const proc = makeProcess('');
  proc.engine.baseUrl = 'http://127.0.0.1:50021';
  proc.engine.trust = { listeners: async (url) => { assert.equal(url, proc.engine.baseUrl); return [process.pid]; } };
  proc.engine.status = async () => ({ available: true });
  await proc.reclaimStale();
  assert.equal(proc.startedByUs, true);
  assert.deepEqual(killed, []);
  assert.equal(fs.readFileSync(pidPath, 'utf8'), String(process.pid));
});

test('reclaimStale は待受が無く応答しない生存 PID を終了して PID ファイルを消す', async () => {
  writeLivePid();
  const proc = makeProcess('');
  proc.engine.trust = { listeners: async () => [] };
  await proc.reclaimStale();
  assert.equal(proc.startedByUs, false);
  assert.deepEqual(killed, [process.pid]);
  assert.throws(() => fs.readFileSync(pidPath), { code: 'ENOENT' });
});

test('reclaimStale は待受に含まれない PID を終了せず PID ファイルだけ消す', async () => {
  for (const available of [true, false]) {
    writeLivePid();
    const proc = makeProcess('');
    proc.engine.trust = { listeners: async () => [process.pid + 1] };
    proc.engine.status = async () => ({ available });
    await proc.reclaimStale();
    assert.equal(proc.startedByUs, false);
    assert.deepEqual(killed, []);
    assert.throws(() => fs.readFileSync(pidPath), { code: 'ENOENT' });
  }
});

test('reclaimStale は trust が無い・外部ホスト・照会例外の場合は従来の status 判定を使う', async () => {
  for (const trust of [undefined, { listeners: async () => null }, { listeners: async () => { throw new Error('netstat failed'); } }]) {
    for (const available of [true, false]) {
      writeLivePid();
      killed = [];
      const proc = makeProcess('');
      proc.engine.trust = trust;
      proc.engine.status = async () => ({ available });
      await proc.reclaimStale();
      assert.equal(proc.startedByUs, available);
      assert.deepEqual(killed, available ? [] : [process.pid]);
    }
  }
});

test('reclaimStale は所有者を確かめられない待受を終了させず PID ファイルを残す', async () => {
  for (const listeners of [async () => [process.pid], async () => { throw new Error('netstat failed'); }]) {
    writeLivePid();
    killed = [];
    const proc = makeProcess('');
    proc.engine.trust = { listeners };
    proc.engine.status = async () => ({ available: false, untrusted: true, error: '確認できません (PID 1)' });
    await proc.reclaimStale();
    assert.equal(proc.startedByUs, false);
    assert.deepEqual(killed, []);
    assert.equal(fs.readFileSync(pidPath, 'utf8'), String(process.pid));
  }
});

test('起動した子プロセスが終了したら所有者の照会を省く対象から外す', async () => {
  let managed;
  const proc = makeProcess(LOCALAPPDATA_EXE);
  existing.add(LOCALAPPDATA_EXE);
  proc.engine.trust = { setManagedPids(fn) { managed = fn; } };
  proc.engine.trust.setManagedPids(() => (proc.child?.pid ? [proc.child.pid] : []));
  await proc.start();
  assert.deepEqual(managed(), [99999]);
  proc.child.emit('exit', 0);
  assert.deepEqual(managed(), []);
});

test('reclaimStale は待受が前回の PID の子孫なら引き継ぐ', async () => {
  writeLivePid();
  killed = [];
  const proc = makeProcess('');
  const child = process.pid + 1;
  proc.engine.trust = {
    listeners: async () => [child],
    isDescendantOf: async (pid, ancestor) => pid === child && ancestor === process.pid,
  };
  proc.engine.status = async () => ({ available: true });
  await proc.reclaimStale();
  assert.equal(proc.startedByUs, true);
  assert.deepEqual(killed, []);
  assert.equal(fs.readFileSync(pidPath, 'utf8'), String(process.pid));
});

test('reclaimStale は待受が前回の PID の子孫でなければ引き継がない', async () => {
  for (const isDescendantOf of [async () => false, async () => { throw new Error('照会の失敗'); }]) {
    writeLivePid();
    killed = [];
    const proc = makeProcess('');
    proc.engine.trust = { listeners: async () => [process.pid + 1], isDescendantOf };
    proc.engine.status = async () => ({ available: true });
    await proc.reclaimStale();
    assert.equal(proc.startedByUs, false);
    assert.deepEqual(killed, []);
    assert.throws(() => fs.readFileSync(pidPath), { code: 'ENOENT' });
  }
});

test('起動後の待機は待受が別ユーザーのものと分かったら待たずに理由を返す', async () => {
  const proc = makeProcess(LOCALAPPDATA_EXE);
  existing.add(LOCALAPPDATA_EXE);
  let calls = 0;
  proc.engine.status = async () => (++calls === 1
    ? { available: false }
    : { available: false, untrusted: true, error: '別ユーザー (PID 10)' });
  const started = Date.now();
  assert.deepEqual(await proc.start(), { started: true, untrusted: true, error: '別ユーザー (PID 10)' });
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 900);
});

test('untrusted の警告は start と ensure のどの経路でも、同じ理由なら 1 回だけ出る', async () => {
  const proc = makeProcess('');
  const warnings = [];
  proc.log.warn = (message) => warnings.push(message);
  proc.engine.status = async () => ({ available: false, untrusted: true, error: '別ユーザー (PID 10)' });
  const r = await proc.start();
  assert.deepEqual(r, { started: false, untrusted: true, error: '別ユーザー (PID 10)' });
  assert.equal(await proc.ensure(), false);
  await proc.start();
  assert.deepEqual(warnings, ['別ユーザー (PID 10)']);
});

test('起動後の待機で別ユーザーと分かった理由も警告する', async () => {
  const proc = makeProcess(LOCALAPPDATA_EXE);
  existing.add(LOCALAPPDATA_EXE);
  const warnings = [];
  proc.log.warn = (message) => warnings.push(message);
  let calls = 0;
  proc.engine.status = async () => (++calls === 1 ? { available: false } : { available: false, untrusted: true, error: '別ユーザー (PID 11)' });
  assert.equal((await proc.start()).untrusted, true);
  assert.deepEqual(warnings, ['別ユーザー (PID 11)']);
});
