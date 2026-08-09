// 状態変更 API の受け入れ判定 (AUD-01) のテスト。
// 外部 Web ページからのドライブバイ操作を拒否しつつ、
// 管理 UI・トレイ・フッククライアントの正規経路を通すこと。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMutationRequest } from '../src/daemon/server.js';

const PORT = 7591;
const TOKEN = 'a'.repeat(64);

function check(pathname, headers) {
  return checkMutationRequest({ pathname, headers: { host: `127.0.0.1:${PORT}`, ...headers }, port: PORT, token: TOKEN });
}

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

test('管理 UI の同一オリジン要求はトークン無しで通る (sendBeacon 互換)', () => {
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

test('Host ヘッダーが無い要求を拒否する', () => {
  const r = checkMutationRequest({ pathname: '/api/skip', headers: {}, port: PORT, token: TOKEN });
  assert.equal(r.ok, false);
});

test('charset 付き application/json は許容する', () => {
  const r = check('/hook', { 'content-type': 'application/json; charset=utf-8' });
  assert.equal(r.ok, true);
});
