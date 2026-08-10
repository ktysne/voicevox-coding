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

test('キャッシュ無効時は再生後に一時 WAV を削除する (AUD-02)', async () => {
  const unlinked = [];
  mock.method(fs, 'unlink', (file, cb) => {
    unlinked.push(file);
    cb?.(null);
  });
  const player = new FakePlayer();
  const queue = makeQueue(player, { cacheEnabled: false });
  queue.enqueue({ target: 'test', event: 'test', text: '一時ファイルのテスト。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);
  assert.equal(unlinked.length, 1);
  assert.match(path.basename(unlinked[0]), /^tmp-\d+-\d+-\d+\.wav$/);
});

test('キャッシュ無効時は複数チャンク (先読み含む) もすべて削除する (AUD-02)', async () => {
  const unlinked = [];
  mock.method(fs, 'unlink', (file, cb) => {
    unlinked.push(file);
    cb?.(null);
  });
  const player = new FakePlayer();
  const queue = makeQueue(player, { chunkChars: 100, cacheEnabled: false });
  const text = `${'あ'.repeat(99)}。い。`;
  queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);
  await sleep(20); // 先読み分の削除は Promise 経由なので一拍待つ
  assert.equal(unlinked.length, 2);
});

test('キャッシュ有効時は WAV を削除しない', async () => {
  const unlinked = [];
  mock.method(fs, 'unlink', (file, cb) => {
    unlinked.push(file);
    cb?.(null);
  });
  const player = new FakePlayer();
  const queue = makeQueue(player, { cacheEnabled: true });
  queue.enqueue({ target: 'test', event: 'test', text: 'キャッシュされる発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);
  assert.equal(unlinked.length, 0);
});

test('書き込みに失敗したら書きかけの .tmp をその場で削除する (AUD-02)', async () => {
  mock.method(fs, 'renameSync', () => {
    const err = new Error('EBUSY: resource busy');
    err.code = 'EBUSY';
    throw err;
  });
  const unlinked = [];
  mock.method(fs, 'unlinkSync', (p) => unlinked.push(p));
  const player = new FakePlayer();
  const queue = makeQueue(player, { cacheEnabled: false });
  const errors = [];
  queue.on('error', (err) => errors.push(err));
  queue.enqueue({ target: 'test', event: 'test', text: '失敗する発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);
  assert.equal(errors.length, 1);
  assert.equal(unlinked.length, 1);
  assert.match(path.basename(unlinked[0]), /\.tmp$/);
});

test('起動時の掃除は tmp-*.wav と書きかけの *.tmp だけを消す (AUD-02)', () => {
  mock.method(fs, 'readdirSync', () => ['tmp-1-2-0.wav', 'abcdef.wav', 'abcdef.wav.tmp']);
  const unlinked = [];
  mock.method(fs, 'unlinkSync', (p) => unlinked.push(p));
  const queue = makeQueue(new FakePlayer());
  queue.cleanupEphemeral();
  assert.deepEqual(unlinked.map((p) => path.basename(p)).sort(), ['abcdef.wav.tmp', 'tmp-1-2-0.wav']);
});

test('先読み合成の失敗が通常の合成失敗と同じに扱われる (AUD-03)', async () => {
  const player = new FakePlayer();
  let callCount = 0;
  // 1 チャンク目 (通常合成) は成功、2 チャンク目 (先読み) は ENGINE 障害を模して失敗する。
  const engine = {
    synthesize: async () => {
      callCount += 1;
      if (callCount === 2) throw new Error('ENGINE が応答しません');
      return { wav: WAV };
    },
  };
  const config = () => ({ daemon: { chunkChars: 100, cacheEnabled: false, cacheMaxEntries: 1000 } });
  const warnings = [];
  const errors = [];
  const queue = new SpeechQueue(engine, player, config, { warn: (msg) => warnings.push(msg) });
  queue.on('error', (err) => errors.push(err));
  mock.method(fs, 'unlink', (file, cb) => cb?.(null));

  const firstChunk = `${'あ'.repeat(99)}。`;
  const text = `${firstChunk}い。`;
  queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  // 先読みの失敗が null に化けて発話終了扱いにならず、通常の合成失敗と同じ
  // 警告ログ + error イベントが出ること。
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ENGINE が応答しません/);
  assert.ok(warnings.some((w) => w.includes('合成に失敗しました')));
  // 1 チャンク目は無言で打ち切られず、実際に再生されている
  // (末尾の stop は #drain 終了時の HOLD 後始末)。
  assert.deepEqual(player.calls.map(([kind]) => kind), ['play', 'hold', 'stop']);
});

test('先読み失敗が消費されても process の unhandledRejection にならない (AUD-03)', async () => {
  const player = new FakePlayer();
  let callCount = 0;
  const engine = {
    synthesize: async () => {
      callCount += 1;
      if (callCount === 2) throw new Error('先読み失敗');
      return { wav: WAV };
    },
  };
  const config = () => ({ daemon: { chunkChars: 100, cacheEnabled: false, cacheMaxEntries: 1000 } });
  const queue = new SpeechQueue(engine, player, config, { warn() {} });
  queue.on('error', () => {}); // ここでは unhandledRejection の有無だけを検証する
  mock.method(fs, 'unlink', (file, cb) => cb?.(null));

  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const firstChunk = `${'あ'.repeat(99)}。`;
    const text = `${firstChunk}い。`;
    queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    await waitIdle(queue);
    // unhandledRejection はマイクロタスク完了後に発火するため一拍待って確認する。
    await sleep(50);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled.length, 0);
});

test('スキップで先読み失敗が消費されなくても unhandledRejection にならない (AUD-03)', async () => {
  const queueRef = { current: null };
  class SkippingPlayer extends FakePlayer {
    async play(file) {
      await super.play(file);
      // 1 チャンク目の再生直後にスキップし、先読み中 (2 チャンク目、失敗する) を
      // 誰にも await させずに #discardPrefetch へ回す。
      if (this.calls.filter(([kind]) => kind === 'play').length === 1) {
        queueRef.current.skip();
      }
    }
  }
  const player = new SkippingPlayer();
  let callCount = 0;
  const engine = {
    synthesize: async () => {
      callCount += 1;
      if (callCount === 2) throw new Error('先読み失敗 (未消費)');
      return { wav: WAV };
    },
  };
  const config = () => ({ daemon: { chunkChars: 100, cacheEnabled: false, cacheMaxEntries: 1000 } });
  const queue = new SpeechQueue(engine, player, config, { warn() {} });
  queueRef.current = queue;
  queue.on('error', () => {});
  mock.method(fs, 'unlink', (file, cb) => cb?.(null));

  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const firstChunk = `${'あ'.repeat(99)}。`;
    const text = `${firstChunk}い。`;
    queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    await waitIdle(queue);
    await sleep(50);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled.length, 0);
});

// pauseLengthScale を足す前（v0.1.0）の voice。この 6 つはキャッシュキーに常に含まれる。
const LEGACY_VOICE = {
  speedScale: 1.0,
  pitchScale: 0.0,
  intonationScale: 1.0,
  volumeScale: 1.0,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
};

test('後から追加した音声パラメータが既定値ならキャッシュキーは変わらない', async () => {
  // キャッシュ有効の経路は #pruneCache を通るので、実際のキャッシュディレクトリを
  // 走査・削除しないよう読み取りを空にしておく。
  mock.method(fs, 'readdirSync', () => []);
  const player = new FakePlayer();
  const queue = makeQueue(player, { cacheEnabled: true });
  const text = 'キャッシュキーの回帰テスト。';
  // パラメータ追加前のキー。既定値のままなら合成結果は同じなので、これと一致してほしい。
  const [legacyFile] = cacheFilesFor([text], 1, LEGACY_VOICE);
  const existing = new Set([legacyFile].filter((file) => fs.existsSync(file)));
  try {
    queue.enqueue({
      target: 'test',
      event: 'test',
      text,
      speaker: 1,
      voice: { ...LEGACY_VOICE, pauseLengthScale: 1.0 },
      queuePolicy: { policy: 'enqueue' },
    });
    await waitIdle(queue);
    assert.deepEqual(player.calls, [['play', legacyFile]]);
  } finally {
    cleanupCache([legacyFile], existing);
  }
});

test('後から追加した音声パラメータを動かすとキャッシュキーが変わる', async () => {
  mock.method(fs, 'readdirSync', () => []);
  const player = new FakePlayer();
  const queue = makeQueue(player, { cacheEnabled: true });
  const text = 'キャッシュキーの分岐テスト。';
  const voice = { ...LEGACY_VOICE, pauseLengthScale: 1.5 };
  // 既定値以外はキーに残るので、voice をそのまま JSON 化したキーになる。
  const [legacyFile] = cacheFilesFor([text], 1, LEGACY_VOICE);
  const [tunedFile] = cacheFilesFor([text], 1, voice);
  const files = [legacyFile, tunedFile];
  const existing = new Set(files.filter((file) => fs.existsSync(file)));
  try {
    queue.enqueue({
      target: 'test',
      event: 'test',
      text,
      speaker: 1,
      voice,
      queuePolicy: { policy: 'enqueue' },
    });
    await waitIdle(queue);
    assert.notEqual(tunedFile, legacyFile);
    assert.deepEqual(player.calls, [['play', tunedFile]]);
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
