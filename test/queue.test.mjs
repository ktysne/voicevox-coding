import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { beforeEach, afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_DIR } from '../src/daemon/config.js';
import { SpeechQueue } from '../src/daemon/queue.js';

// SpeechQueue は再生対象をキャッシュへ書くため、テストでは I/O だけ抑止する。
// FakePlayer はパスを読む必要がないので、キューの状態遷移をそのまま検証できる。
beforeEach(() => {
  mock.method(fs, 'mkdirSync', () => undefined);
  mock.method(fs, 'writeFileSync', () => undefined);
  mock.method(fs, 'renameSync', () => undefined);
});

afterEach(() => {
  mock.restoreAll();
});

// 1 サンプルの無音 WAV。duration は 0ms に丸められるのでテストを速く保てる。
const WAV = (() => {
  const dataSize = 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
})();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakePlayer {
  constructor() {
    this.calls = [];
  }

  async play(file) {
    this.calls.push(['play', file]);
  }

  async hold() {
    this.calls.push(['hold']);
  }

  async stop() {
    this.calls.push(['stop']);
  }
}

function makeQueue(player, { chunkChars = 100, cacheEnabled = false } = {}) {
  const engine = { synthesize: async () => ({ wav: WAV }) };
  const config = () => ({ daemon: { chunkChars, cacheEnabled, cacheMaxEntries: 1000 } });
  const queue = new SpeechQueue(engine, player, config, { warn() {} });
  return queue;
}

async function waitIdle(queue) {
  for (let i = 0; i < 100; i += 1) {
    if (!queue.running) return;
    await sleep(5);
  }
  assert.fail('SpeechQueue did not become idle');
}

function cacheFilesFor(texts, speaker = 1, voice = {}) {
  return texts.map((text) => path.join(
    CACHE_DIR,
    `${crypto.createHash('sha1').update(`${speaker}|${JSON.stringify(voice)}|${text}`).digest('hex')}.wav`,
  ));
}

function cleanupCache(files, existing) {
  for (const file of files) {
    if (existing.has(file)) continue;
    try { fs.unlinkSync(file); } catch {}
  }
}

test('連続チャンクではチャンク間に HOLD を入れる', async () => {
  const player = new FakePlayer();
  const queue = makeQueue(player, { chunkChars: 100 });
  const firstChunk = `${'あ'.repeat(99)}。`;
  const text = `${firstChunk}い。`;
  const files = cacheFilesFor([firstChunk, 'い。']);
  const existing = new Set(files.filter((file) => fs.existsSync(file)));
  try {
    queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    await waitIdle(queue);
    assert.deepEqual(player.calls.map(([kind]) => kind), ['play', 'hold', 'play']);
  } finally {
    cleanupCache(files, existing);
  }
});

test('単発発話の末尾では HOLD を入れない', async () => {
  const player = new FakePlayer();
  const queue = makeQueue(player);
  const text = '単発のテスト。';
  const files = cacheFilesFor([text]);
  const existing = new Set(files.filter((file) => fs.existsSync(file)));
  try {
    queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    await waitIdle(queue);
    assert.deepEqual(player.calls.map(([kind]) => kind), ['play']);
  } finally {
    cleanupCache(files, existing);
  }
});

test('連続発話では発話間に HOLD を入れる', async () => {
  const player = new FakePlayer();
  const queue = makeQueue(player);
  const first = '最初の発話。';
  const second = '次の発話。';
  const files = cacheFilesFor([first, second]);
  const existing = new Set(files.filter((file) => fs.existsSync(file)));
  try {
    queue.enqueue({ target: 'test', event: 'test', text: first, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    // #drain は最初の合成で一度 yield するため、同じターンで次発話を積める。
    queue.enqueue({ target: 'test', event: 'test', text: second, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    await waitIdle(queue);
    assert.deepEqual(player.calls.map(([kind]) => kind), ['play', 'hold', 'play']);
  } finally {
    cleanupCache(files, existing);
  }
});

test('skip と clear は STOP を送る', async () => {
  const player = new FakePlayer();
  const queue = makeQueue(player);
  const first = '停止対象の発話。';
  const second = '待機中の発話。';
  const files = cacheFilesFor([first, second]);
  const existing = new Set(files.filter((file) => fs.existsSync(file)));
  try {
    queue.enqueue({ target: 'test', event: 'test', text: first, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    queue.enqueue({ target: 'test', event: 'test', text: second, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    queue.skip();
    queue.clear();
    await waitIdle(queue);
    assert.equal(player.calls.filter(([kind]) => kind === 'stop').length, 2);
  } finally {
    cleanupCache(files, existing);
  }
});
