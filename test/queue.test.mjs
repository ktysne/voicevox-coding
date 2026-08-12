import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { beforeEach, afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_DIR } from '../src/daemon/config.js';
import { SpeechQueue, chunkText } from '../src/daemon/queue.js';
import { LIST_BOUNDARY } from '../src/daemon/textfilter.js';

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
    // PLAY を受けた時刻。チャンク間に置く間の長さを測るのに使う。
    this.playAt = [];
  }

  async play(file) {
    this.calls.push(['play', file]);
    this.playAt.push(Date.now());
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

/**
 * WAV キャッシュ索引 (#42) のテスト専用ヘルパー。実ディスクの代わりに
 * メモリ上の Map で CACHE_DIR の中身を模し、readdirSync / statSync /
 * existsSync / readFileSync / unlinkSync / utimes をその Map だけで完結させる。
 * renameSync は beforeEach で no-op にされているため、ここでだけ実体を反映する
 * 実装に差し替える（.mock.restore() で一旦戻してから付け直す。同じメソッドへ
 * mock.method を二重に適用すると afterEach の restoreAll() 後に元へ戻らない
 * ことがあるため、必ず restore してから付け直す）。
 * 呼び出し元は Date.now を自前でモックして時刻を進めること。
 */
function mockCacheDisk() {
  const disk = new Map(); // ファイルパス -> mtimeMs
  const unlinked = [];
  const readdirCalls = [];
  const utimesCalls = [];
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });

  fs.renameSync.mock.restore();
  mock.method(fs, 'renameSync', (_tmp, file) => {
    disk.set(file, Date.now());
  });
  mock.method(fs, 'existsSync', (p) => disk.has(p));
  mock.method(fs, 'readFileSync', (p) => {
    if (!disk.has(p)) throw enoent(p);
    return WAV;
  });
  mock.method(fs, 'readdirSync', (dir) => {
    readdirCalls.push(dir);
    return [...disk.keys()].map((p) => path.basename(p));
  });
  mock.method(fs, 'statSync', (p) => {
    if (!disk.has(p)) throw enoent(p);
    return { mtimeMs: disk.get(p) };
  });
  const locked = new Set(); // EPERM で削除に失敗させたいファイル
  const utimesFail = { value: false }; // true にすると utimes を失敗させる
  mock.method(fs, 'unlinkSync', (p) => {
    if (locked.has(p)) throw Object.assign(new Error(`EPERM: ${p}`), { code: 'EPERM' });
    if (!disk.has(p)) throw enoent(p);
    unlinked.push(p);
    disk.delete(p);
  });
  mock.method(fs, 'utimes', (p, atime, mtime, cb) => {
    utimesCalls.push({ p, atime, mtime });
    if (utimesFail.value) {
      cb?.(Object.assign(new Error(`EPERM: ${p}`), { code: 'EPERM' }));
      return;
    }
    if (disk.has(p)) disk.set(p, Date.now());
    cb?.(null);
  });

  return { disk, unlinked, readdirCalls, utimesCalls, locked, utimesFail };
}

/** キャッシュ有効・上限指定ありの SpeechQueue を作る（#42 のキャッシュ索引テスト用）。 */
function makeCacheQueue(player, { maxEntries = 300, chunkChars = 100 } = {}) {
  const engine = { synthesize: async () => ({ wav: WAV }) };
  const config = () => ({ daemon: { chunkChars, cacheEnabled: true, cacheMaxEntries: maxEntries } });
  return new SpeechQueue(engine, player, config, { warn() {} });
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

// ---------------------------------------------------------------- 箇条書きの間 (#15)

test('項目の切れ目をまたいでチャンクを結合しない (#15)', () => {
  const text = `項目1${LIST_BOUNDARY}\n項目2${LIST_BOUNDARY}\n項目3${LIST_BOUNDARY}`;
  const chunks = chunkText(text, 100);
  // 3 項目が 1 つにまとまらず、印そのものはチャンクへ残らない
  assert.deepEqual(chunks.map((c) => c.text), ['項目1', '項目2', '項目3']);
  assert.ok(chunks.every((c) => !c.text.includes(LIST_BOUNDARY)));
  // 間を置くのは項目のあいだだけ。発話の末尾では置かない
  assert.deepEqual(chunks.map((c) => c.pauseAfter), [true, true, false]);
});

test('長い項目が途中で割れても切れ目の印は最後の断片に付く (#15)', () => {
  const long = 'あ'.repeat(150);
  const chunks = chunkText(`${long}${LIST_BOUNDARY}\n次の項目`, 100);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[chunks.length - 2].pauseAfter, true);
  assert.equal(chunks[chunks.length - 1].text, '次の項目');
});

test('切れ目が無ければ従来どおり 1 チャンクにまとまる (#15)', () => {
  assert.deepEqual(chunkText('一文目です。二文目です。', 100), [{ text: '一文目です。二文目です。', pauseAfter: false }]);
});

test('項目の切れ目では次のチャンクまで間を置く (#15)', async () => {
  const player = new FakePlayer();
  const queue = makeQueue(player, { chunkChars: 100, cacheEnabled: false });
  queue.enqueue({
    target: 'test',
    event: 'test',
    text: `項目1${LIST_BOUNDARY}\n項目2`,
    speaker: 1,
    voice: {},
    queuePolicy: { policy: 'enqueue' },
    listPauseSec: 0.15,
  });
  await waitIdle(queue);
  // 間は HOLD (無音ループ) を掛けたまま待つ
  assert.deepEqual(player.calls.map(([kind]) => kind), ['play', 'hold', 'play']);
  const gap = player.playAt[1] - player.playAt[0];
  assert.ok(gap >= 120, `間が短すぎます: ${gap}ms`);
});

test('listPauseSec が 0 なら間を置かない (#15)', async () => {
  const player = new FakePlayer();
  const queue = makeQueue(player, { chunkChars: 100, cacheEnabled: false });
  queue.enqueue({
    target: 'test',
    event: 'test',
    text: `項目1${LIST_BOUNDARY}\n項目2`,
    speaker: 1,
    voice: {},
    queuePolicy: { policy: 'enqueue' },
    listPauseSec: 0,
  });
  await waitIdle(queue);
  assert.deepEqual(player.calls.map(([kind]) => kind), ['play', 'hold', 'play']);
  // 間なしの実測は 10ms 未満。負荷の高い環境でも揺れないよう、余裕を持って見る。
  const gap = player.playAt[1] - player.playAt[0];
  assert.ok(gap < 120, `間が入っています: ${gap}ms`);
});

test('キューの状態と重複判定には切れ目の印を残さない (#15)', async () => {
  const player = new FakePlayer();
  const queue = makeQueue(player, { cacheEnabled: false });
  queue.enqueue({
    target: 'test',
    event: 'test',
    text: `項目1${LIST_BOUNDARY}\n項目2`,
    speaker: 1,
    voice: {},
    queuePolicy: { policy: 'enqueue', dedupeWindowSec: 10 },
  });
  const shown = queue.state.current?.text ?? queue.state.queued[0]?.text;
  assert.equal(shown, '項目1\n項目2');
  for (const key of queue.recent.keys()) assert.ok(!key.includes(LIST_BOUNDARY));
  // 読み上げが次のテストへまたいで走り続けないよう、ここで畳んでおく
  await waitIdle(queue);
});

// ---------------------------------------------------------------- 重複抑止の窓 (#39)

// #isDuplicate だけを確かめたいので、engine.synthesize は必ず失敗させて
// キャッシュディレクトリへの書き込みを避ける（AUD-03 のテストと同じやり方）。
function makeDedupeQueue(player) {
  const engine = { synthesize: async () => { throw new Error('この検証では合成しない'); } };
  const config = () => ({ daemon: { chunkChars: 100, cacheEnabled: false, cacheMaxEntries: 1000 } });
  const queue = new SpeechQueue(engine, player, config, { warn() {} });
  queue.on('error', () => {}); // 合成失敗の error イベントはここでは無視する
  return queue;
}

test('重複抑止の窓が 60 秒を超えても、窓内の重複は掃除で見逃さない (#39)', async () => {
  const player = new FakePlayer();
  const queue = makeDedupeQueue(player);
  let now = 0;
  mock.method(Date, 'now', () => now);
  const policy = { policy: 'enqueue', dedupeWindowSec: 120 };
  const text = '重複抑止の窓テスト。';

  const r1 = queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: policy });
  assert.equal(r1.accepted, true);

  now = 70_000; // 60 秒を過ぎた時点。以前の実装だとここで recent の記録が掃除されて消えていた
  const r2 = queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: policy });
  assert.equal(r2.accepted, false);
  assert.equal(r2.reason, 'duplicate');

  now = 80_000; // window (120s) 内なので引き続き重複扱いであるべき
  const r3 = queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: policy });
  assert.equal(r3.accepted, false);
  assert.equal(r3.reason, 'duplicate');

  await waitIdle(queue);
});

test('別の文が挟まっても、その enqueue の掃除で先の記録を失わない (#39)', async () => {
  const player = new FakePlayer();
  const queue = makeDedupeQueue(player);
  let now = 0;
  mock.method(Date, 'now', () => now);
  const policy = { policy: 'enqueue', dedupeWindowSec: 120 };
  const textA = '重複抑止の窓テスト A。';
  const textB = '重複抑止の窓テスト B。';

  const r1 = queue.enqueue({ target: 'test', event: 'test', text: textA, speaker: 1, voice: {}, queuePolicy: policy });
  assert.equal(r1.accepted, true);

  now = 65_000; // 60 秒を過ぎているが、別の文なので受理される
  const r2 = queue.enqueue({ target: 'test', event: 'test', text: textB, speaker: 1, voice: {}, queuePolicy: policy });
  assert.equal(r2.accepted, true);

  now = 70_000; // textA の記録がまだ window (120s) 内に残っているはず
  const r3 = queue.enqueue({ target: 'test', event: 'test', text: textA, speaker: 1, voice: {}, queuePolicy: policy });
  assert.equal(r3.accepted, false);
  assert.equal(r3.reason, 'duplicate');

  await waitIdle(queue);
});

test('掃除の後に窓を広げても、UI で設定できる範囲の記録は残っている (#39)', async () => {
  const player = new FakePlayer();
  const queue = makeDedupeQueue(player);
  let now = 0;
  mock.method(Date, 'now', () => now);
  const text = '重複抑止の窓テスト（窓の拡大）。';

  // 窓 10 秒で受理。この記録は UI 上限 (120 秒) まで保持されるべき
  const r1 = queue.enqueue({
    target: 'test', event: 'test', text, speaker: 1, voice: {},
    queuePolicy: { policy: 'enqueue', dedupeWindowSec: 10 },
  });
  assert.equal(r1.accepted, true);

  now = 61_000; // 別の文の enqueue で掃除が走っても、61 秒前の記録は消えない
  const r2 = queue.enqueue({
    target: 'test', event: 'test', text: '別の文。', speaker: 1, voice: {},
    queuePolicy: { policy: 'enqueue', dedupeWindowSec: 10 },
  });
  assert.equal(r2.accepted, true);

  now = 70_000; // 窓を 120 秒へ広げると、t=0 の記録に対して重複と判定される
  const r3 = queue.enqueue({
    target: 'test', event: 'test', text, speaker: 1, voice: {},
    queuePolicy: { policy: 'enqueue', dedupeWindowSec: 120 },
  });
  assert.equal(r3.accepted, false);
  assert.equal(r3.reason, 'duplicate');

  await waitIdle(queue);
});

test('dedupeWindowSec が数値でなくても読み上げを止めず保持期間も壊さない (#39)', async () => {
  const player = new FakePlayer();
  const queue = makeDedupeQueue(player);
  let now = 0;
  mock.method(Date, 'now', () => now);
  const text = '重複抑止の窓テスト（不正値）。';

  // 数値でない窓は「抑止なし」として扱い、連続でも受理される
  const bad = { policy: 'enqueue', dedupeWindowSec: 'abc' };
  assert.equal(queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: bad }).accepted, true);
  assert.equal(queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: bad }).accepted, true);

  // その後の正常な窓では従来どおり重複判定が効く
  const good = { policy: 'enqueue', dedupeWindowSec: 120 };
  now = 10_000;
  assert.equal(queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: good }).accepted, true);
  now = 20_000;
  const dup = queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: good });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'duplicate');

  await waitIdle(queue);
});

test('極端に大きい窓は上限でクランプされ、保持期間を汚染しない (#39)', async () => {
  const player = new FakePlayer();
  const queue = makeDedupeQueue(player);
  let now = 0;
  mock.method(Date, 'now', () => now);
  const policy = { policy: 'enqueue', dedupeWindowSec: 1e12 };
  const text = '重複抑止の窓テスト（巨大値）。';

  assert.equal(queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: policy }).accepted, true);

  now = 100_000; // クランプ後の窓 (120 秒) 内なので重複
  const r2 = queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: policy });
  assert.equal(r2.reason, 'duplicate');

  now = 230_000; // クランプ後の窓を過ぎれば受理される（保持も 120 秒で頭打ち）
  const r3 = queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: policy });
  assert.equal(r3.accepted, true);

  await waitIdle(queue);
});

test('drop ポリシーで busy と見送られた文は重複履歴に載らない (#39)', async () => {
  const player = new FakePlayer();
  const queue = makeDedupeQueue(player);
  let now = 0;
  mock.method(Date, 'now', () => now);
  const text = '重複抑止の窓テスト（busy）。';

  // drain を止めた状態でキューへ 1 件積み、busy を作る
  queue.running = true;
  assert.equal(queue.enqueue({
    target: 'test', event: 'test', text: '先客。', speaker: 1, voice: {},
    queuePolicy: { policy: 'enqueue', dedupeWindowSec: 120 },
  }).accepted, true);

  const drop = { policy: 'drop', dedupeWindowSec: 120 };
  const busy = queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: drop });
  assert.equal(busy.accepted, false);
  assert.equal(busy.reason, 'busy');

  // キューが空いたら、busy で見送られただけの文は duplicate にならず受理される
  queue.queue.length = 0;
  queue.running = false;
  now = 10_000;
  const retry = queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: drop });
  assert.equal(retry.accepted, true);

  await waitIdle(queue);
});

test('実行中に窓を短くすると、判定は現在の設定ですぐ効く (#39)', async () => {
  const player = new FakePlayer();
  const queue = makeDedupeQueue(player);
  let now = 0;
  mock.method(Date, 'now', () => now);
  const text = '重複抑止の窓テスト（設定変更）。';

  const r1 = queue.enqueue({
    target: 'test', event: 'test', text, speaker: 1, voice: {},
    queuePolicy: { policy: 'enqueue', dedupeWindowSec: 120 },
  });
  assert.equal(r1.accepted, true);

  now = 70_000; // window 120s ならまだ重複扱いの時間帯だが、今回は window を 30s に変更する
  const r2 = queue.enqueue({
    target: 'test', event: 'test', text, speaker: 1, voice: {},
    queuePolicy: { policy: 'enqueue', dedupeWindowSec: 30 },
  });
  assert.equal(r2.accepted, true);

  await waitIdle(queue);
});

test('HOLD に失敗したときは間を置かずに次のチャンクへ進む (#15)', async () => {
  class NoHoldPlayer extends FakePlayer {
    async hold() {
      this.calls.push(['hold']);
      throw new Error('無音ループを開始できません');
    }
  }
  const player = new NoHoldPlayer();
  const queue = makeQueue(player, { chunkChars: 100, cacheEnabled: false });
  queue.enqueue({
    target: 'test',
    event: 'test',
    text: `項目1${LIST_BOUNDARY}\n項目2`,
    speaker: 1,
    voice: {},
    queuePolicy: { policy: 'enqueue' },
    listPauseSec: 0.3,
  });
  await waitIdle(queue);
  // 無音を掴めていない状態で待つと、間のあとの出だしが欠ける。間は諦めて先へ進む。
  // 指定の間は 300ms なので、120ms を超えなければ「待っていない」と言い切れる。
  const gap = player.playAt[1] - player.playAt[0];
  assert.ok(gap < 120, `HOLD 失敗時に間を置いています: ${gap}ms`);
});

// ---------------------------------------------------------------- WAV キャッシュの整理 (#42)

test('ヒットで利用時刻が更新された項目は残り、更新されなかった項目から削除される (#42)', async () => {
  let now = 0;
  mock.method(Date, 'now', () => now);
  const { disk, unlinked } = mockCacheDisk();
  const player = new FakePlayer();
  const queue = makeCacheQueue(player, { maxEntries: 2 });
  const [fileA, fileB, fileC] = cacheFilesFor(['Aの発話。', 'Bの発話。', 'Cの発話。']);

  now = 0;
  queue.enqueue({ target: 'test', event: 'test', text: 'Aの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  now = 100;
  queue.enqueue({ target: 'test', event: 'test', text: 'Bの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  // A をヒットさせて利用時刻を更新する（実ファイルの mtime はキャッシュヒットでは
  // 更新されないので、A が「作成が古い順」で最初に消えるのが旧実装のバグだった）。
  now = 200;
  queue.enqueue({ target: 'test', event: 'test', text: 'Aの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  // 上限 2 を超える 3 件目を書き込む。削除されるべきは、ヒットで更新されなかった B。
  now = 300;
  queue.enqueue({ target: 'test', event: 'test', text: 'Cの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  assert.deepEqual(unlinked, [fileB]);
  assert.ok(disk.has(fileA), 'ヒットした A は残るべき');
  assert.ok(!disk.has(fileB), 'ヒットしなかった B が削除されるべき');
  assert.ok(disk.has(fileC), '直近に書いた C は残るべき');
});

test('索引の構築後は書き込みのたびに CACHE_DIR を全走査しない (#42)', async () => {
  let now = 0;
  mock.method(Date, 'now', () => now);
  const { readdirCalls } = mockCacheDisk();
  const player = new FakePlayer();
  const queue = makeCacheQueue(player, { maxEntries: 1000 });

  const texts = ['1番目の発話。', '2番目の発話。', '3番目の発話。', '4番目の発話。'];
  for (const text of texts) {
    now += 10;
    queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    await waitIdle(queue);
  }

  // 索引がまだ無い最初の書き込みで 1 回だけ全走査し、以降の書き込みでは走査しない
  assert.equal(readdirCalls.length, 1);
});

test('上限を超えなければ削除されない (#42)', async () => {
  let now = 0;
  mock.method(Date, 'now', () => now);
  const { unlinked } = mockCacheDisk();
  const player = new FakePlayer();
  const queue = makeCacheQueue(player, { maxEntries: 5 });

  for (const text of ['aの発話。', 'bの発話。', 'cの発話。']) {
    now += 10;
    queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    await waitIdle(queue);
  }

  assert.deepEqual(unlinked, []);
});

test('索引の外で実ファイルが消えていても、10 分経過後の整理で再同期して追随する (#42)', async () => {
  let now = 0;
  mock.method(Date, 'now', () => now);
  const { disk, unlinked } = mockCacheDisk();
  const player = new FakePlayer();
  const queue = makeCacheQueue(player, { maxEntries: 1 });
  const [fileA] = cacheFilesFor(['Aの発話。']);
  const [fileB] = cacheFilesFor(['Bの発話。']);

  now = 0;
  queue.enqueue({ target: 'test', event: 'test', text: 'Aの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);
  assert.ok(disk.has(fileA));

  // 索引の外（他プロセスや手動操作）でファイル本体だけが消える。索引はまだ A を覚えている。
  disk.delete(fileA);

  // 10 分 (再同期の間隔) を超えてから、上限を超える書き込みを行う。
  now = 11 * 60 * 1000;
  queue.enqueue({ target: 'test', event: 'test', text: 'Bの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  // 再同期によって実体の無い A は索引からも落ち、実在する B だけで上限 (1) 以内と
  // 評価されるので、B は削除されない。ENOENT を踏んでもエラーにはならない。
  assert.deepEqual(unlinked, []);
  assert.ok(!disk.has(fileA));
  assert.ok(disk.has(fileB));
});

test('索引が実体より少なくても、時間経過後の整理が外部追加分に追随する (#42)', async () => {
  let now = 0;
  mock.method(Date, 'now', () => now);
  const { disk, unlinked } = mockCacheDisk();
  const player = new FakePlayer();
  const queue = makeCacheQueue(player, { maxEntries: 3 });

  now = 0;
  queue.enqueue({ target: 'test', event: 'test', text: 'Aの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  // 外部で WAV が 5 つ増える（索引は知らない）。索引のサイズ (2) は上限以下に
  // 見えるが、再同期をサイズ判定より先に行うので実体 (7) に追随できる
  for (let i = 0; i < 5; i += 1) disk.set(path.join(CACHE_DIR, `ext-${i}.wav`), 10 + i);

  now = 11 * 60 * 1000; // 再同期間隔 (10 分) を超える
  queue.enqueue({ target: 'test', event: 'test', text: 'Bの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  const wavs = [...disk.keys()].filter((p) => p.endsWith('.wav'));
  assert.equal(wavs.length, 3, `実ファイル数が上限まで戻っていない: ${wavs.length}`);
  assert.ok(unlinked.length >= 4);
});

test('削除に失敗したファイルは索引に残して再試行し、代わりに次の候補を消す (#42)', async () => {
  let now = 0;
  mock.method(Date, 'now', () => now);
  const { disk, unlinked, locked } = mockCacheDisk();
  const player = new FakePlayer();
  const queue = makeCacheQueue(player, { maxEntries: 2 });
  const [fileA, fileB, fileC, fileD] = cacheFilesFor(['Aの発話。', 'Bの発話。', 'Cの発話。', 'Dの発話。']);

  now = 0;
  queue.enqueue({ target: 'test', event: 'test', text: 'Aの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);
  now = 100;
  queue.enqueue({ target: 'test', event: 'test', text: 'Bの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  // 最古の A をロック（ウイルス対策の一時的な EPERM を模す）
  locked.add(fileA);
  now = 200;
  queue.enqueue({ target: 'test', event: 'test', text: 'Cの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);

  // A は消せないので索引に残し、代わりに次に古い B が消えて実ファイル数を上限へ近づける
  assert.ok(disk.has(fileA), 'ロック中の A はディスクに残る');
  assert.ok(!disk.has(fileB), '代わりに B が削除されるべき');
  assert.ok(disk.has(fileC));
  assert.deepEqual(unlinked, [fileB]);

  // ロックが解けたら、次の整理で A の削除を再試行する（索引から外れていない証拠）
  locked.delete(fileA);
  now = 300;
  queue.enqueue({ target: 'test', event: 'test', text: 'Dの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);
  assert.ok(!disk.has(fileA), 'ロック解除後の整理で A が削除されるべき');
  assert.ok(disk.has(fileD));
});

test('utimes に失敗したときは touch 時刻を確定せず、次のヒットで再試行する (#42)', async () => {
  let now = 0;
  mock.method(Date, 'now', () => now);
  const { utimesCalls, utimesFail } = mockCacheDisk();
  const player = new FakePlayer();
  const queue = makeCacheQueue(player, { maxEntries: 1000 });
  const enq = () => {
    queue.enqueue({ target: 'test', event: 'test', text: 'Aの発話。', speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
    return waitIdle(queue);
  };

  now = 0;
  await enq(); // 書き込み（touchedAt = 0）

  utimesFail.value = true;
  now = 6 * 60 * 1000; // 間引き間隔 (5 分) を超える
  await enq(); // ヒット → utimes 失敗 → touchedAt は進まない
  assert.equal(utimesCalls.length, 1);

  now += 1000;
  await enq(); // 失敗直後でも、間引きにかからず再試行される
  assert.equal(utimesCalls.length, 2);

  utimesFail.value = false;
  now += 1000;
  await enq(); // 成功 → touchedAt 確定
  assert.equal(utimesCalls.length, 3);

  now += 1000;
  await enq(); // 確定後は間引きが効いて呼ばれない
  assert.equal(utimesCalls.length, 3);
});

test('キャッシュヒットのたびに touch せず、5 分間隔で間引いて mtime を更新する (#42)', async () => {
  let now = 0;
  mock.method(Date, 'now', () => now);
  const { utimesCalls } = mockCacheDisk();
  const player = new FakePlayer();
  const queue = makeCacheQueue(player, { maxEntries: 1000 });
  const text = 'touch のテスト。';
  const [file] = cacheFilesFor([text]);

  queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue); // 書き込みは touch 対象ではない

  now = 60_000; // 1 分後: 間引き間隔 (5 分) 以内なので touch しない
  queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);
  assert.equal(utimesCalls.length, 0);

  now = 6 * 60_000; // 6 分後: 間引き間隔を超えたので touch する
  queue.enqueue({ target: 'test', event: 'test', text, speaker: 1, voice: {}, queuePolicy: { policy: 'enqueue' } });
  await waitIdle(queue);
  assert.equal(utimesCalls.length, 1);
  assert.equal(utimesCalls[0].p, file);
  // number 型の atime/mtime は「秒」単位で解釈される (fs.utimes の仕様)。
  // ミリ秒をそのまま渡すと極端に未来の日付になるバグを防ぐための確認。
  assert.equal(utimesCalls[0].atime, now / 1000);
  assert.equal(utimesCalls[0].mtime, now / 1000);
});
