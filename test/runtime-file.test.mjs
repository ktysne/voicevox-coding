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
