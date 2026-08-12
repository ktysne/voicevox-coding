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
  // NaN で保持期間 (maxWindowMs) が汚染されると掃除が永久に効かなくなる
  assert.equal(Number.isFinite(queue.maxWindowMs), true);

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
