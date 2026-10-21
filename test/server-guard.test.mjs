// 状態変更 API の受け入れ判定 (AUD-01) のテスト。
// 外部 Web ページからのドライブバイ操作を拒否しつつ、
// 管理 UI・トレイ・フッククライアントの正規経路を通すこと。

import { test, mock } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { checkMutationRequest, isRejectedDuringShutdown, isLocalHostHeader, createServer } from '../src/daemon/server.js';
import * as guards from '../src/daemon/server.js';
import { normalizeConfig } from '../src/daemon/config.js';

const PORT = 7591;
const TOKEN = 'a'.repeat(64);

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

test('Host、接続元、Content-Type の順で検査し GET/HEAD と /hook は接続元確認を免除する', () => {
  assert.match(check('/api/config', { host: 'evil', 'content-type': 'text/plain' }, { sameUser: false }).error, /Host/);
  assert.match(check('/api/config', { 'content-type': 'text/plain' }, { sameUser: false }).error, /OS/);
  assert.equal(check('/api/config', { 'content-type': 'text/plain' }, { sameUser: true }).status, 415);
  for (const method of ['GET', 'HEAD']) assert.equal(check('/api/config', {}, { sameUser: false }, method).ok, true);
  assert.equal(check('/hook', { 'content-type': 'application/json' }, { sameUser: false }).ok, true);
});

test('実サーバーは必要な経路だけ接続元を確認し、起動と終了で verifier を管理する', async () => {
  const calls = [];
  const verifier = { start() { calls.push('start'); }, dispose() { calls.push('dispose'); },
    async verifySocket(socket, port) { assert.equal(socket.remoteAddress, '127.0.0.1'); assert.ok(port > 0); calls.push('verify'); return { sameUser: false }; } };
  const { server, port } = await startServer(verifier);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'HEAD' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":"MessageDisplay"}' })).status, 200);
    assert.deepEqual(calls, ['start']);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-voicevox-coding-token': TOKEN }, body: '{}' })).status, 200);
    assert.deepEqual(calls, ['start', 'verify']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(calls, ['start', 'verify', 'dispose']);
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

test('フッククライアント (Origin なし・JSON) は /hook にトークン無しで届く', () => {
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

async function startServer(callerVerifier = { start() {}, dispose() {}, verifySocket: async () => ({ sameUser: true }) }) {
  const store = Object.assign(new EventEmitter(), { config: { targets: {} }, revision: 1, bootId: 'boot', profile: () => null,
    save(next) { this.config = normalizeConfig(next); this.revision++; return this.config; },
    patch(next) { return this.save(normalizeConfig(next, this.config)); },
  });
  const queue = Object.assign(new EventEmitter(), { state: {} });
  const log = { subscribe() {}, warn() {}, info() {}, debug() {}, error() {}, recent: () => [] };
  const engine = { status: async () => ({}) };
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const server = createServer({ store, engine, queue, log, runtime: {}, port, token: TOKEN, callerVerifier });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port, store };
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
