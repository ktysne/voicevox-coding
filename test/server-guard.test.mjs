// API 要求の受け入れ判定 (AUD-01) のテスト。
// 外部 Web ページからのドライブバイ操作を拒否しつつ、
// 管理 UI・トレイ・フッククライアントの正規経路を通すこと。

import { test, mock } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { checkMutationRequest, isRejectedDuringShutdown, isLocalHostHeader, createServer } from '../src/daemon/server.js';
import * as guards from '../src/daemon/server.js';
import { sealHookBody } from '../src/daemon/hook-seal.js';
import { normalizeConfig } from '../src/daemon/config.js';

const PORT = 7591;
const TOKEN = 'a'.repeat(64);
const { SSE_MAX_CLIENTS } = guards;

function check(pathname, headers, caller = { sameUser: true }, method = 'POST') {
  return guards.authorizeRequest({ method, caller, pathname, headers: { host: `127.0.0.1:${PORT}`, ...headers }, port: PORT, token: TOKEN });
}

test('別ユーザーでも正しいトークンなら通り、CSRF 検査は残る', () => {
  for (const origin of [undefined, `http://127.0.0.1:${PORT}`]) {
    assert.equal(check('/api/config', { origin, 'x-voicevox-coding-token': TOKEN }, { sameUser: false }).ok, true);
  }
  for (const token of [undefined, '', 'short', 'b'.repeat(64), [TOKEN]]) {
    assert.equal(check('/api/config', { origin: `http://127.0.0.1:${PORT}`, 'x-voicevox-coding-token': token }, { sameUser: false }).status, 403);
  }
  assert.equal(check('/api/config', { origin: 'https://evil.example', 'x-voicevox-coding-token': TOKEN }, { sameUser: false }).status, 403);
  assert.equal(check('/api/config', {}, { sameUser: true }).status, 403);
});

test('Host、接続元、Content-Type の順で検査し GET/HEAD も接続元を確認する', () => {
  assert.match(check('/api/config', { host: 'evil', 'content-type': 'text/plain' }, { sameUser: false }).error, /Host/);
  assert.match(check('/api/config', { 'content-type': 'text/plain' }, { sameUser: false }).error, /OS/);
  assert.equal(check('/api/config', { 'content-type': 'text/plain' }, { sameUser: true }).status, 415);
  for (const method of ['GET', 'HEAD']) {
    assert.equal(check('/api/config', {}, { sameUser: false }, method).status, 403);
    assert.equal(check('/api/config', {}, { sameUser: true }, method).ok, true);
  }
  assert.equal(check('/api/state', { 'x-voicevox-coding-token': TOKEN }, { sameUser: false }, 'GET').ok, true);
  assert.equal(check('/hook', { 'content-type': 'application/json' }, { sameUser: false }).status, 403);
  assert.equal(check('/hook/sealed', { 'content-type': 'application/json' }, { sameUser: false }).ok, true);
});

test('キュー本文は 30 文字を超える場合だけ省略記号付きで切る', () => {
  for (const length of [0, 29, 30]) {
    const text = 'a'.repeat(length);
    const state = { running: true, current: { id: 1, target: 'codex', event: 'Commentary', text, chunkIndex: 0, chunkCount: 1 }, queued: [] };
    assert.deepEqual(guards.summarizeQueueState(state), state);
  }

  const text = 'b'.repeat(31);
  const state = {
    running: true,
    current: { id: 2, target: 'codex', event: 'Commentary', text, chunkIndex: 1, chunkCount: 2 },
    queued: [{ id: 3, target: 'obs', event: 'MessageDisplay', text }],
  };
  assert.deepEqual(guards.summarizeQueueState(state), {
    running: true,
    current: { ...state.current, text: `${text.slice(0, 30)}…` },
    queued: [{ ...state.queued[0], text: `${text.slice(0, 30)}…` }],
  });
});

test('キュー本文の要約は current が null で queued が空でも状態を保つ', () => {
  const state = { running: false, current: null, queued: [] };
  assert.deepEqual(guards.summarizeQueueState(state), state);
});

test('キュー本文の要約は文字列でない本文を空文字にする', () => {
  const state = { running: true, current: { id: 1, text: null }, queued: [{ id: 2, text: 42 }] };
  assert.deepEqual(guards.summarizeQueueState(state), { running: true, current: { id: 1, text: '' }, queued: [{ id: 2, text: '' }] });
});

test('実サーバーは平文 /hook も接続元を確認し、起動と終了で verifier を管理する', async () => {
  const calls = [];
  const verifier = { start() { calls.push('start'); }, dispose() { calls.push('dispose'); },
    async verifySocket(socket, port) { assert.equal(socket.remoteAddress, '127.0.0.1'); assert.ok(port > 0); calls.push('verify'); return { sameUser: true }; } };
  const { server, port } = await startServer(verifier);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'HEAD' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":"MessageDisplay"}' })).status, 200);
    assert.deepEqual(calls, ['start', 'verify', 'verify', 'verify']);
    // トークンを持つ要求は接続元を引かない
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-voicevox-coding-token': TOKEN }, body: '{}' })).status, 200);
    assert.deepEqual(calls, ['start', 'verify', 'verify', 'verify']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(calls, ['start', 'verify', 'verify', 'verify', 'dispose']);
});

test('静的 UI は許可されたパスだけを対応する Content-Type で返す', async () => {
  const { server, port } = await startServer();
  try {
    for (const [pathname, contentType] of [
      ['/', 'text/html; charset=utf-8'],
      ['/index.html', 'text/html; charset=utf-8'],
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/style.css', 'text/css; charset=utf-8'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers.get('content-type'), contentType, pathname);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('許可されていない静的パスは readFile を呼ばず 404 を返す', async (t) => {
  const originalReadFile = fs.readFile;
  const readPaths = [];
  const readFile = mock.method(fs, 'readFile', (...args) => {
    readPaths.push(args[0]);
    return originalReadFile(...args);
  });
  t.after(() => readFile.mock.restore());
  const { server, port } = await startServer();
  try {
    for (const pathname of ['/CON', '/nul', '/COM1', '/con.txt', '/APP.JS', '/app.js/', '/package.json', '/..%2fpackage.json']) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      assert.equal(response.status, 404, pathname);
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8', pathname);
      assert.equal(await response.text(), 'not found', pathname);
    }
    assert.equal(readPaths.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('設定 API は変更した不正な enginePath を保存せず、同じ値と空文字は通す', async (t) => {
  const stat = mock.method(fs, 'statSync', () => { throw new Error('missing'); });
  t.after(() => stat.mock.restore());
  const { server, port, store } = await startServer();
  store.config = normalizeConfig({ engine: { enginePath: 'C:\\legacy.exe' } });
  const send = (method, body) => fetch(`http://127.0.0.1:${port}/api/config`, {
    method, headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    for (const method of ['PUT', 'POST']) {
      for (const enginePath of ['C:\\bad.exe', 'C:\\missing\\run.exe', '//host/share/run.exe', false, 42, {}]) {
        const before = structuredClone(store.config);
        const revision = store.revision;
        const result = await send(method, { engine: { enginePath }, daemon: { port: 9999 } });
        assert.equal(result.status, 400, `${method}: ${JSON.stringify(enginePath)}`);
        assert.deepEqual(store.config, before);
        assert.equal(store.revision, revision);
      }
      assert.equal((await send(method, { engine: { enginePath: 'C:\\legacy.exe' } })).status, 200);
    }
    const calls = stat.mock.callCount();
    assert.equal((await send('POST', { daemon: { port: 8000 } })).status, 200);
    assert.equal(store.config.engine.enginePath, 'C:\\legacy.exe');
    assert.equal((await send('PUT', { engine: { enginePath: '' } })).status, 200);
    assert.equal(stat.mock.callCount(), calls);
    stat.mock.restore();
    const validStat = mock.method(fs, 'statSync', () => ({ isFile: () => true }));
    t.after(() => validStat.mock.restore());
    for (const method of ['PUT', 'POST']) {
      const enginePath = `C:\\${method}\\run.exe`;
      assert.equal((await send(method, { engine: { enginePath } })).status, 200);
      assert.equal(store.config.engine.enginePath, enginePath);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('悪意ある Origin の text/plain 単純リクエストを拒否する', () => {
  const r = check('/api/config', { origin: 'https://evil.example', 'content-type': 'text/plain' });
  assert.equal(r.ok, false);
});

test('悪意ある Origin は application/json でも拒否する', () => {
  const r = check('/api/shutdown', { origin: 'https://evil.example', 'content-type': 'application/json' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Origin "null" (サンドボックス iframe 等) を拒否する', () => {
  const r = check('/api/skip', { origin: 'null' });
  assert.equal(r.ok, false);
});

test('ホスト名が一致してもポートが違う Origin は拒否する', () => {
  const r = check('/api/skip', { origin: 'http://127.0.0.1:8000' });
  assert.equal(r.ok, false);
});

test('同じ OS ユーザーの管理 UI は同一オリジンならトークン無しで通る (sendBeacon 互換)', () => {
  const r = check('/api/config', { origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/json' });
  assert.equal(r.ok, true);
});

test('localhost でアクセスしている管理 UI も通る', () => {
  const r = check('/api/mute', { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, 'content-type': 'application/json' });
  assert.equal(r.ok, true);
});

test('DNS リバインディング (外部 Host ヘッダー) を拒否する', () => {
  const r = check('/api/config', { host: `evil.example:${PORT}`, 'content-type': 'application/json' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('同じ OS ユーザーの平文フックは Origin なし・JSON で届く', () => {
  const r = check('/hook', { 'content-type': 'application/json' });
  assert.equal(r.ok, true);
});

test('/hook でも application/json 以外の Content-Type は拒否する', () => {
  const r = check('/hook', { 'content-type': 'text/plain' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 415);
});

test('Origin なしの /api/* はトークンが無ければ拒否する', () => {
  const r = check('/api/skip', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Origin なしの /api/* は誤ったトークンを拒否する', () => {
  const r = check('/api/shutdown', { 'x-voicevox-coding-token': 'b'.repeat(64) });
  assert.equal(r.ok, false);
});

test('トレイ (Origin なし・正しいトークン) は通る', () => {
  const r = check('/api/shutdown', { 'x-voicevox-coding-token': TOKEN });
  assert.equal(r.ok, true);
});

test('トークン未設定のサーバーは Origin なし /api/* を全部拒否する', () => {
  const r = checkMutationRequest({
    pathname: '/api/skip',
    headers: { host: `127.0.0.1:${PORT}`, 'x-voicevox-coding-token': '' },
    port: PORT,
    token: '',
  });
  assert.equal(r.ok, false);
});

test('ホスト名がローカルでもポートが違う Host は拒否する', () => {
  const r = check('/api/skip', { host: '127.0.0.1:8000', 'x-voicevox-coding-token': TOKEN });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Host ヘッダーが無い要求を拒否する', () => {
  const r = checkMutationRequest({ pathname: '/api/skip', headers: {}, port: PORT, token: TOKEN });
  assert.equal(r.ok, false);
});

test('charset 付き application/json は許容する', () => {
  const r = check('/hook', { 'content-type': 'application/json; charset=utf-8' });
  assert.equal(r.ok, true);
});

test('application/jsonp など JSON 風 MIME は拒否する', () => {
  const r = check('/hook', { 'content-type': 'application/jsonp' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 415);
});

test('/hook は Content-Type の省略を認めない', () => {
  const r = check('/hook', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 415);
});

test('/api/* はトークンがあれば Content-Type 省略の POST を認める', () => {
  const r = check('/api/skip', { 'x-voicevox-coding-token': TOKEN });
  assert.equal(r.ok, true);
});

// PowerShell は本文を省いた POST にこの Content-Type を付ける。
// トークンがあっても通らないので、ps1 側は空 JSON を明示して送る必要がある (#31)。
test('/api/* は application/x-www-form-urlencoded をトークンがあっても拒否する', () => {
  const r = check('/api/shutdown', {
    'content-type': 'application/x-www-form-urlencoded',
    'x-voicevox-coding-token': TOKEN,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 415);
});

// ---------------------------------------------------------------- 全要求に掛ける Host の検証

test('Host は 127.0.0.1 と localhost の自ポートだけを許す', () => {
  assert.equal(isLocalHostHeader(`127.0.0.1:${PORT}`, PORT), true);
  assert.equal(isLocalHostHeader(`LOCALHOST:${PORT}`, PORT), true);
  assert.equal(isLocalHostHeader(`evil.example:${PORT}`, PORT), false);
  assert.equal(isLocalHostHeader('127.0.0.1', PORT), false);
  assert.equal(isLocalHostHeader('127.0.0.1:8000', PORT), false);
  assert.equal(isLocalHostHeader(`[::1]:${PORT}`, PORT), false);
  assert.equal(isLocalHostHeader(undefined, PORT), false);
});

async function startServer(callerVerifier = { start() {}, dispose() {}, verifySocket: async () => ({ sameUser: true }) }, extra = {}) {
  const store = Object.assign(new EventEmitter(), { config: { targets: {} }, revision: 1, bootId: 'boot', profile: () => null,
    save(next) { this.config = normalizeConfig(next); this.revision++; return this.config; },
    patch(next) { return this.save(normalizeConfig(next, this.config)); },
  });
  const queue = Object.assign(new EventEmitter(), { state: { running: false, current: null, queued: [] } });
  const log = { subscribe() {}, warn() {}, info() {}, debug() {}, error() {}, recent: () => [] };
  const engine = { status: async () => ({}) };
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const server = createServer({ store, engine, queue, log, runtime: {}, port, token: TOKEN, callerVerifier, ...extra });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port, store, queue };
}

test('別ユーザーの自 Origin 偽装を判定関数で拒否する', () => {
  const result = guards.authorizeRequest({ method: 'PUT', pathname: '/api/config', port: PORT, token: TOKEN,
    caller: { sameUser: false }, headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/json' } });
  assert.equal(result.status, 403);
});

test('別ユーザーの自 Origin 偽装 PUT を実サーバーで拒否する', async () => {
  const { server, port } = await startServer({ start() {}, dispose() {}, verifySocket: async () => ({ sameUser: false }) });
  try {
    const result = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ targets: {} }),
    });
    assert.equal(result.status, 403);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('トークンを持つ変更系の要求は接続元を引かずに通し、Origin の検査は残す', async () => {
  let calls = 0;
  const { server, port } = await startServer({ start() {}, dispose() {}, verifySocket: async () => { calls++; return { sameUser: false }; } });
  try {
    const post = (headers) => fetch(`http://127.0.0.1:${port}/api/engine/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-voicevox-coding-token': TOKEN, ...headers }, body: '{}',
    });
    // engineProcess を渡していないので、受け入れ判定を通れば 501 になる
    assert.equal((await post({})).status, 501);
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
    assert.equal(calls, 0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('接続元の確認を待つ間に終了処理が始まったら、エンジンを起動せず 503 を返す', async () => {
  const runtime = { shuttingDown: false };
  let started = false;
  const engineProcess = { status: {}, start: async () => { started = true; return { started: true }; } };
  const verifier = { start() {}, dispose() {}, verifySocket: async () => { runtime.shuttingDown = true; return { sameUser: true }; } };
  const { server, port } = await startServer(verifier, { runtime, engineProcess });
  try {
    const result = await fetch(`http://127.0.0.1:${port}/api/engine/start`, {
      method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(result.status, 503);
    assert.equal(started, false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('接続元の確認を待つ間に切れた SSE の要求は購読に登録しない', async (t) => {
  const intervals = [];
  const original = globalThis.setInterval;
  const spy = mock.method(globalThis, 'setInterval', (fn, ms, ...rest) => {
    intervals.push(ms);
    return original(fn, ms, ...rest);
  });
  t.after(() => spy.mock.restore());
  let settled;
  const verified = new Promise((resolve) => { settled = resolve; });
  const verifier = { start() {}, dispose() {}, verifySocket: (socket) => new Promise((resolve) => {
    socket.once('close', () => setImmediate(() => { resolve({ sameUser: true }); setImmediate(settled); }));
  }) };
  const { server, port } = await startServer(verifier);
  try {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/stream', headers: { host: `127.0.0.1:${port}` } });
    req.on('error', () => {});
    req.end();
    await new Promise((resolve) => server.once('connection', resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    req.destroy();
    await verified;
    assert.equal(intervals.filter((ms) => ms === 20000).length, 0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

function get(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function getStatus(port, pathname, host, headers = {}) {
  return new Promise((resolve, reject) => {
    let receivedResponse = false;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { host, ...headers } }, (res) => {
      receivedResponse = true;
      const { statusCode } = res;
      res.on('error', () => {});
      res.destroy();
      resolve(statusCode);
    });
    req.on('error', (error) => {
      if (!receivedResponse) reject(error);
    });
    req.end();
  });
}

function getQueueEvent(port, onConnected) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let receivedEvent = false;
    let buffer = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/api/stream', method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        if (!connected && buffer.includes(': connected\n\n')) {
          connected = true;
          onConnected();
        }
        const match = buffer.match(/event: queue\ndata: ([^\n]+)/);
        if (match) {
          receivedEvent = true;
          resolve(JSON.parse(match[1]));
          req.destroy();
        }
      });
    });
    req.on('error', (error) => {
      if (!receivedEvent) reject(error);
    });
    req.end();
  });
}

function openSse(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/api/stream',
      agent: false,
      headers: { Host: `127.0.0.1:${port}` },
    }, (res) => resolve({ req, res }));
    req.on('error', reject);
  });
}

test('SSE 購読者数の上限を守り、切断後に新しい接続を受け入れる', async () => {
  const { server, port } = await startServer();
  const connections = [];
  try {
    for (let i = 0; i < SSE_MAX_CLIENTS; i++) {
      const connection = await openSse(port);
      connections.push(connection);
      assert.equal(connection.res.statusCode, 200);
    }

    const rejected = await openSse(port);
    rejected.res.resume();
    assert.equal(rejected.res.statusCode, 503);
    await new Promise((resolve) => rejected.res.on('end', resolve));

    connections[0].res.destroy();
    connections[0].req.destroy();
    let replacement;
    const deadline = Date.now() + 2000;
    while (!replacement && Date.now() < deadline) {
      const candidate = await openSse(port);
      if (candidate.res.statusCode === 200) replacement = candidate;
      else {
        candidate.res.resume();
        await new Promise((resolve) => candidate.res.on('end', resolve));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(replacement, '切断した購読者の枠が再利用される');
    connections.push(replacement);
  } finally {
    for (const { req, res } of connections) {
      res.destroy();
      req.destroy();
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('読まない SSE 購読者だけを送信待ち上限で切断する', async () => {
  const { server, port, store } = await startServer();
  const serverSockets = new Map();
  server.on('connection', (socket) => serverSockets.set(socket.remotePort, socket));
  // http.get の応答は pause() しても下のソケットが読み続けるので、要求だけ送って読まない生ソケットを使う。
  const slow = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => slow.once('connect', resolve));
  slow.pause();
  slow.on('error', () => {});
  slow.write(`GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  let reader;
  try {
    reader = await openSse(port);
    let pending = 0;
    let notifyReader;
    reader.res.on('data', (chunk) => {
      pending -= chunk.length;
      if (pending <= 0) notifyReader?.();
    });
    const slowServerSocket = serverSockets.get(slow.localPort);
    assert.ok(slowServerSocket);
    const slowClosed = new Promise((resolve) => slowServerSocket.once('close', resolve));
    let closed = false;
    slowClosed.then(() => { closed = true; });
    const frameBytes = 256 * 1024;
    for (let n = 0; n < 400 && !closed; n++) {
      const received = new Promise((resolve) => { notifyReader = resolve; });
      pending += frameBytes;
      store.emit('change', { pad: 'x'.repeat(frameBytes) }, n, 'boot', null);
      await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('読む購読者がフレームを受け取れない')), 3000))]);
    }
    await Promise.race([slowClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('読まない購読者が切られない')), 1000))]);
    assert.equal(reader.res.destroyed, false);
  } finally {
    slow.destroy();
    reader?.res.destroy();
    reader?.req.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('状態 API と SSE はキュー本文を要約する', async () => {
  const { server, port, queue } = await startServer();
  const text = '読み上げる本文を秘匿するために三十文字を超えるテスト文です。';
  const state = {
    running: true,
    current: { id: 1, target: 'codex', event: 'Commentary', text, chunkIndex: 2, chunkCount: 3 },
    queued: [{ id: 2, target: 'obs', event: 'MessageDisplay', text }],
  };
  queue.state = state;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    const body = await response.json();
    assert.deepEqual(body.queue, guards.summarizeQueueState(state));

    const queueEvent = await getQueueEvent(port, () => queue.emit('update', state));
    assert.deepEqual(queueEvent, guards.summarizeQueueState(state));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('別ユーザーの GET は読み取り API と SSE を 403 にする', async () => {
  const verifier = { start() {}, dispose() {}, verifySocket: async () => ({ sameUser: false }) };
  const { server, port } = await startServer(verifier);
  try {
    const paths = ['/api/state', '/api/config', '/api/logs', '/api/stream', '/', '/app.js'];
    const statuses = await Promise.all(paths.map((pathname) => getStatus(port, pathname, `127.0.0.1:${port}`)));
    assert.deepEqual(statuses, [403, 403, 403, 403, 403, 403], paths.join(', '));
    assert.equal(await getStatus(port, '/api/state', `127.0.0.1:${port}`, { 'x-voicevox-coding-token': TOKEN }), 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('DNS リバインディングの GET は読み取り API も UI も 403 にする', async () => {
  const { server, port } = await startServer();
  try {
    for (const pathname of ['/api/state', '/api/config', '/api/logs', '/api/stream', '/']) {
      const r = await get(port, pathname, `evil.example:${port}`);
      assert.equal(r.status, 403, pathname);
    }
  } finally {
    server.close();
  }
});

test('自ホストの GET は通り、UI は iframe への埋め込みを禁じる', async () => {
  const { server, port } = await startServer();
  try {
    assert.equal((await get(port, '/api/config', `127.0.0.1:${port}`)).status, 200);
    assert.equal((await get(port, '/api/config', `localhost:${port}`)).status, 200);
    const ui = await get(port, '/', `127.0.0.1:${port}`);
    assert.equal(ui.status, 200);
    assert.equal(ui.headers['x-frame-options'], 'DENY');
    assert.equal(ui.headers['content-security-policy'], "frame-ancestors 'none'");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- 終了処理中のガード

test('終了処理中は状態変更 API を拒否する', () => {
  assert.equal(isRejectedDuringShutdown({ shuttingDown: true }, 'POST', '/api/engine/start'), true);
  assert.equal(isRejectedDuringShutdown({ shuttingDown: true }, 'POST', '/api/skip'), true);
});

test('終了処理中でも /api/shutdown と GET は通す（安全性の検証は従来どおり後段が行う）', () => {
  assert.equal(isRejectedDuringShutdown({ shuttingDown: true }, 'POST', '/api/shutdown'), false);
  assert.equal(isRejectedDuringShutdown({ shuttingDown: true }, 'GET', '/api/state'), false);
  // /api/shutdown がガードを素通りしても、悪意ある Origin は checkMutationRequest が拒否する
  const r = check('/api/shutdown', { origin: 'https://evil.example', 'content-type': 'application/json' });
  assert.equal(r.ok, false);
});

test('終了処理中でなければ拒否しない', () => {
  assert.equal(isRejectedDuringShutdown({ shuttingDown: false }, 'POST', '/api/engine/start'), false);
  assert.equal(isRejectedDuringShutdown(undefined, 'POST', '/api/engine/start'), false);
});

test('暗号化フックは接続元照会を省き、同じ封筒の再送ではキューへ追加しない', async () => {
  let calls = 0;
  const { server, port, store, queue } = await startServer({ start() {}, dispose() {}, async verifySocket() { calls++; return { sameUser: false }; } });
  const config = normalizeConfig({ targets: { claudeCode: { events: { Stop: { enabled: true, mode: 'fullText' } } } } });
  store.config = config;
  store.profile = (target) => config.targets[target];
  const items = [];
  queue.enqueue = (item) => { items.push(item); return { accepted: true }; };
  try {
    const sealed = sealHookBody(TOKEN, { target: 'claudeCode', payload: { hook_event_name: 'Stop', last_assistant_message: '秘密です。' } });
    for (let i = 0; i < 2; i++) {
      const result = await fetch(`http://127.0.0.1:${port}/hook/sealed`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sealed),
      });
      assert.equal(result.status, i === 0 ? 200 : 403);
      assert.deepEqual(await result.json(), i === 0 ? { ok: true } : { error: 'replayed sealed hook' });
    }
    assert.equal(items.length, 1);
    assert.equal(items[0].text, '秘密です。');
    assert.equal(calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('暗号化フックの拒否警告を 60 秒ごとにまとめ、抑制件数を次の行へ添える', async (t) => {
  let now = 1_000_000;
  const dateNow = mock.method(Date, 'now', () => now);
  t.after(() => dateNow.mock.restore());
  const warnings = [];
  const log = { subscribe() {}, warn(message) { warnings.push(message); }, info() {}, debug() {}, error() {} };
  const { server, port } = await startServer(undefined, { log });
  try {
    for (const body of ['{}', 'bad-json', JSON.stringify(sealHookBody('wrong', { target: 'claudeCode', payload: {} }))]) {
      const result = await fetch(`http://127.0.0.1:${port}/hook/sealed`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      assert.equal(result.status, 403);
    }
    assert.equal(warnings.length, 1);
    now += 60_000;
    const next = await fetch(`http://127.0.0.1:${port}/hook/sealed`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(next.status, 403);
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /\(ほか 2 件\)$/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('暗号化フックは復号した平文の UTF-8 バイト長が 4 MiB を超えると 413 を返す', async () => {
  const { server, port } = await startServer();
  const now = Date.now();
  const base = { target: 'claudeCode', payload: '', ts: now };
  const overhead = Buffer.byteLength(JSON.stringify(base));
  try {
    for (const extra of [0, 1]) {
      const payload = 'あ'.repeat(Math.floor((4 * 1024 * 1024 - overhead) / 3))
        + 'a'.repeat((4 * 1024 * 1024 - overhead) % 3 + extra);
      const result = await fetch(`http://127.0.0.1:${port}/hook/sealed`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sealHookBody(TOKEN, { target: 'claudeCode', payload }, now)),
      });
      assert.equal(result.status, extra ? 413 : 200);
      assert.deepEqual(await result.json(), extra ? { error: 'payload too large' } : { ok: true });
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('暗号化フックの受信上限超過は payload too large を返す', async () => {
  const { server, port } = await startServer();
  try {
    const result = await fetch(`http://127.0.0.1:${port}/hook/sealed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: 'a'.repeat(Math.ceil(4 * 1024 * 1024 * 4 / 3) + 64 * 1024 + 1),
    });
    assert.equal(result.status, 413);
    assert.deepEqual(await result.json(), { error: 'payload too large' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('平文フックは同じユーザーか正しいトークンを要求する', async () => {
  const { server, port } = await startServer({ start() {}, dispose() {}, verifySocket: async () => ({ sameUser: false }) });
  try {
    for (const token of [undefined, 'wrong', TOKEN]) {
      const headers = { 'content-type': 'application/json' };
      if (token) headers['x-voicevox-coding-token'] = token;
      const result = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', headers, body: '{}' });
      assert.equal(result.status, token === TOKEN ? 200 : 403);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('暗号化フックは JSON の Content-Type を必須とし、外部 Origin を拒否する', () => {
  assert.equal(check('/hook/sealed', {}, { sameUser: false }).status, 415);
  assert.equal(check('/hook/sealed', { 'content-type': 'text/plain' }, { sameUser: false }).status, 415);
  assert.equal(check('/hook/sealed', { 'content-type': 'application/json', origin: 'https://evil.example' }, { sameUser: false }).status, 403);
});
