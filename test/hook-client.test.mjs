import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/daemon/server.js';
import { normalizeConfig } from '../src/daemon/config.js';
import { openSealedHook } from '../src/daemon/hook-seal.js';
import { spawn } from 'node:child_process';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_CLIENT = path.join(ROOT, 'src', 'hook', 'hook-client.js');

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeHome(runtime) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-hook-'));
  tmpDirs.push(home);
  if (runtime) {
    fs.mkdirSync(path.join(home, '.voicevox-coding'), { recursive: true });
    fs.writeFileSync(path.join(home, '.voicevox-coding', 'runtime.json'), JSON.stringify(runtime));
  }
  return home;
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function runHookClient({ home, port, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_CLIENT, 'claudeCode'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, VOICEVOX_CODING_PORT: String(port) },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', resolve);
    child.on('exit', (code) => resolve(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

test('トークンを持たない待受には、フックの本文を送らない', async () => {
  const received = [];
  const { server, port } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  try {
    const home = makeHome({ pid: process.pid, port, token: 'a'.repeat(64) });
    const code = await runHookClient({
      home, port, input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'secret-dummy' }),
    });
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/hook/sealed');
    assert.ok(!JSON.stringify(received[0]).includes('a'.repeat(64)));
    assert.equal(openSealedHook('b'.repeat(64), JSON.parse(received[0].body)).ok, false);
    assert.ok(!received.some((r) => r.body.includes('secret-dummy')), `本文が待受に届いた: ${JSON.stringify(received)}`);
  } finally {
    server.close();
  }
});

for (const runtime of [undefined, {}, { token: '' }, { token: 42 }]) {
  test(`runtime.json のトークンが使えなければ送信しない: ${JSON.stringify(runtime)}`, async () => {
    let requests = 0;
    const { server, port } = await listen((req, res) => { requests++; res.end('{}'); });
    try {
      assert.equal(await runHookClient({ home: makeHome(runtime), port, input: '{"hook_event_name":"Stop"}' }), 0);
      assert.equal(requests, 0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('単体コピーした hook-client の子プロセスから実サーバーの読み上げキューまで届く', async () => {
  const token = 'c'.repeat(64);
  const home = makeHome({ token });
  const standaloneClient = path.join(home, 'hook-client.mjs');
  fs.copyFileSync(HOOK_CLIENT, standaloneClient);
  const enqueued = [];
  const config = normalizeConfig({ targets: { claudeCode: { events: { Stop: { enabled: true, mode: 'fullText' } } } } });
  const store = Object.assign(new EventEmitter(), { config, profile: (target) => config.targets[target] });
  const queue = Object.assign(new EventEmitter(), { enqueue(item) { enqueued.push(item); return { accepted: true }; } });
  const log = { subscribe() {}, warn() {}, info() {}, debug() {}, error() {} };
  const probe = await listen((req, res) => res.end());
  const port = probe.port;
  await new Promise((resolve) => probe.server.close(resolve));
  let verifications = 0;
  const server = createServer({ store, queue, log, engine: {}, runtime: {}, port, token,
    callerVerifier: { start() {}, dispose() {}, async verifySocket() { verifications++; return { sameUser: false }; } },
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, [standaloneClient, 'claudeCode'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, VOICEVOX_CODING_PORT: String(port) },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: '秘密の読み上げ本文です。' }));
    assert.equal(await exited, 0);
    assert.equal(verifications, 0);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].target, 'claudeCode');
    assert.equal(enqueued[0].event, 'Stop');
    assert.equal(enqueued[0].text, '秘密の読み上げ本文です。');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
