import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { removeOwnRuntimeFile, writeRuntimeFile } from '../src/daemon/runtime-file.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-runtime-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('runtime.json を書くと一時ファイルは残らない', () => {
  const file = path.join(dir, 'sub', 'runtime.json');
  writeRuntimeFile(file, { pid: 10, port: 7591, token: 't' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { pid: 10, port: 7591, token: 't' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['runtime.json']);
});

test('rename が数回失敗しても 50 ms 間隔で再試行する', () => {
  const file = path.join(dir, 'retry.json');
  const waits = [];
  let attempts = 0;
  const fileSystem = {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    unlinkSync: (...args) => fs.unlinkSync(...args),
    renameSync(from, to) {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      fs.renameSync(from, to);
    },
  };
  writeRuntimeFile(file, { pid: 11 }, { fs: fileSystem, sleep: (ms) => waits.push(ms) });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [50, 50]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { pid: 11 });
});

test('rename の再試行後も失敗したら既存ファイルを消して書き直す', () => {
  const file = path.join(dir, 'replace.json');
  fs.writeFileSync(file, 'old runtime');
  let attempts = 0;
  const waits = [];
  const fileSystem = {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    unlinkSync: (...args) => fs.unlinkSync(...args),
    renameSync(from, to) {
      attempts++;
      if (attempts <= 6) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      assert.equal(fs.existsSync(to), false);
      fs.renameSync(from, to);
    },
  };
  writeRuntimeFile(file, { pid: 12 }, { fs: fileSystem, sleep: (ms) => waits.push(ms) });
  assert.equal(attempts, 7);
  assert.deepEqual(waits, [50, 50, 50, 50, 50]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { pid: 12 });
});

test('rename が再試行と書き直しでも失敗したら例外を投げる', () => {
  const file = path.join(dir, 'failed.json');
  fs.writeFileSync(file, 'old runtime');
  let attempts = 0;
  const fileSystem = {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    unlinkSync: (...args) => fs.unlinkSync(...args),
    renameSync() {
      attempts++;
      throw Object.assign(new Error('blocked'), { code: 'EPERM' });
    },
  };
  assert.throws(() => writeRuntimeFile(file, { pid: 13 }, { fs: fileSystem, sleep() {} }), /blocked/);
  assert.equal(attempts, 7);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.13.tmp`), false);
});

test('別のプロセスが書いた runtime.json は消さない', () => {
  const file = path.join(dir, 'other.json');
  writeRuntimeFile(file, { pid: 10, port: 7591, token: 't' });
  removeOwnRuntimeFile(file, 20);
  assert.ok(fs.existsSync(file));
});

test('自分が書いた runtime.json は消す', () => {
  const file = path.join(dir, 'own.json');
  writeRuntimeFile(file, { pid: 10, port: 7591, token: 't' });
  removeOwnRuntimeFile(file, 10);
  assert.ok(!fs.existsSync(file));
});

test('壊れた runtime.json や無いファイルでは何もしない', () => {
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{');
  removeOwnRuntimeFile(file, 10);
  assert.ok(fs.existsSync(file));
  removeOwnRuntimeFile(path.join(dir, 'missing.json'), 10);
});
