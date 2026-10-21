import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineError, VoicevoxEngine } from '../src/daemon/voicevox.js';
import { VOICE_PARAMS } from '../src/daemon/catalog.js';

// ENGINE を立てずに /audio_query と /synthesis の往復だけを確かめるため、
// global の fetch を差し替えて応答を模す。
async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function wavBytes() {
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(40, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(4, 40);
  return wav;
}

function binaryResponse(wav) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
  };
}

/** ENGINE 0.25 系の /audio_query 応答（上書き対象の数値だけを抜き出したもの）。 */
function audioQueryBody(overrides = {}) {
  return {
    accent_phrases: [],
    speedScale: 1.0,
    pitchScale: 0.0,
    intonationScale: 1.0,
    volumeScale: 1.0,
    prePhonemeLength: 0.1,
    postPhonemeLength: 0.1,
    pauseLength: null,
    pauseLengthScale: 1.0,
    outputSamplingRate: 24000,
    outputStereo: false,
    kana: '',
    ...overrides,
  };
}

function makeEngine() {
  return new VoicevoxEngine(() => ({ baseUrl: 'http://127.0.0.1:50021', timeoutSec: 5 }));
}

test('audioQuery は音声パラメータをクエリへ上書きする', async () => {
  const engine = makeEngine();
  const query = await withFetch(
    async () => jsonResponse(audioQueryBody()),
    () => engine.audioQuery('てすと', 3, { speedScale: 1.2, pauseLengthScale: 1.4 }),
  );
  assert.equal(query.speedScale, 1.2);
  assert.equal(query.pauseLengthScale, 1.4);
  // 指定しなかった項目は ENGINE の応答のまま残る
  assert.equal(query.volumeScale, 1.0);
});

test('pauseLengthScale を持たない古い ENGINE には送らない', async () => {
  const engine = makeEngine();
  const old = audioQueryBody();
  delete old.pauseLength;
  delete old.pauseLengthScale;
  const query = await withFetch(
    async () => jsonResponse(old),
    () => engine.audioQuery('てすと', 3, { pauseLengthScale: 0.8, speedScale: 1.2 }),
  );
  // 解釈できないフィールドを足さないので、古い ENGINE でも合成が通る。
  assert.equal('pauseLengthScale' in query, false);
  // 対応しているパラメータの上書きは従来どおり効く。
  assert.equal(query.speedScale, 1.2);
});

test('VOICE_PARAMS のキーはそのままクエリの項目名として使える', async () => {
  const engine = makeEngine();
  const voice = {};
  for (const p of VOICE_PARAMS) voice[p.key] = p.default;
  const query = await withFetch(
    async () => jsonResponse(audioQueryBody()),
    () => engine.audioQuery('てすと', 3, voice),
  );
  for (const p of VOICE_PARAMS) {
    assert.equal(query[p.key], p.default, `${p.key} がクエリへ反映されていない`);
  }
});

test('数値でない値はクエリを書き換えない', async () => {
  const engine = makeEngine();
  const query = await withFetch(
    async () => jsonResponse(audioQueryBody()),
    () => engine.audioQuery('てすと', 3, { pauseLengthScale: '1.5', speedScale: NaN, volumeScale: null }),
  );
  assert.equal(query.pauseLengthScale, 1.0);
  assert.equal(query.speedScale, 1.0);
  assert.equal(query.volumeScale, 1.0);
});

test('ENGINE のエラー応答は status 付きの EngineError になる', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => withFetch(
      async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'internal error',
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
      () => engine.audioQuery('てすと', 3, {}),
    ),
    (err) => {
      assert.equal(err.name, 'EngineError');
      assert.equal(err.status, 500);
      assert.match(err.message, /audio_query/);
      return true;
    },
  );
});

test('content-length が JSON 応答の上限を超えると本文を読まず EngineError になる', async () => {
  const engine = makeEngine();
  let bodyRead = false;
  await assert.rejects(
    () => withFetch(
      async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(8 * 1024 * 1024 + 1) },
        text: async () => { bodyRead = true; return '{}'; },
      }),
      () => engine.version(),
    ),
    (err) => err instanceof EngineError && /\/version/.test(err.message) && /8388608/.test(err.message),
  );
  assert.equal(bodyRead, false);
});

test('長いエラー応答は本文を切り詰め、status を保った EngineError になる', async () => {
  const engine = makeEngine();
  let cancelled = false;
  let reads = 0;
  await assert.rejects(
    () => withFetch(
      async () => ({
        ok: false,
        status: 422,
        headers: { get: () => String(10 * 1024 * 1024) },
        body: {
          getReader: () => ({
            read: async () => (reads++ < 10 ? { done: false, value: new Uint8Array(1024 * 1024).fill(0x61) } : { done: true }),
            cancel: async () => { cancelled = true; },
            releaseLock() {},
          }),
        },
      }),
      () => engine.version(),
    ),
    (err) => err instanceof EngineError && err.status === 422,
  );
  assert.equal(cancelled, true);
  assert.equal(reads, 1);
});

test('エラー応答の本文の受信に失敗しても status を保った EngineError になる', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => withFetch(
      async () => ({
        ok: false,
        status: 422,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => { throw new TypeError('terminated'); },
            cancel: async () => {},
            releaseLock() {},
          }),
        },
      }),
      () => engine.version(),
    ),
    (err) => err instanceof EngineError && err.status === 422,
  );
});

test('JSON 応答が上限を超えると EngineError になる', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => withFetch(
      async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => ' '.repeat(8 * 1024 * 1024 + 1),
      }),
      () => engine.version(),
    ),
    (err) => err instanceof EngineError && /8388608/.test(err.message),
  );
});

test('WAV ストリームが上限を超えると読み込みを中止して EngineError になる', async () => {
  const engine = makeEngine();
  const chunk = Buffer.alloc(1024 * 1024);
  let index = 0;
  let cancelled = false;
  let signal;
  await assert.rejects(
    () => withFetch(
      async (_url, init) => {
        signal = init.signal;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: async () => index++ < 65 ? { done: false, value: chunk } : { done: true },
              cancel: async () => { cancelled = true; },
              releaseLock() {},
            }),
          },
        };
      },
      () => engine.synthesis({}, 3),
    ),
    (err) => err instanceof EngineError && /synthesis/.test(err.message) && /67108864/.test(err.message),
  );
  assert.equal(cancelled, true);
  assert.equal(signal.aborted, true);
});

test('synthesis は不正な WAV を EngineError にする', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => withFetch(async () => binaryResponse(Buffer.from([1, 2, 3])), () => engine.synthesis({}, 3)),
    (err) => err instanceof EngineError && /不正な WAV/.test(err.message),
  );
});

test('synthesis は正しい WAV を返す', async () => {
  const engine = makeEngine();
  const wav = wavBytes();
  const result = await withFetch(async () => binaryResponse(wav), () => engine.synthesis({}, 3));
  assert.deepEqual(result, wav);
});

test('応答が来ないまま中断されたらタイムアウトの EngineError になる', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => withFetch(
      async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
      () => engine.audioQuery('てすと', 3, {}),
    ),
    (err) => {
      assert.equal(err.name, 'EngineError');
      assert.match(err.message, /タイムアウト/);
      return true;
    },
  );
});

test('synthesize は上書き済みのクエリを /synthesis へ渡す', async () => {
  const engine = makeEngine();
  const requests = [];
  const { query } = await withFetch(
    async (url, init) => {
      requests.push({ url, init });
      if (String(url).includes('/audio_query')) return jsonResponse(audioQueryBody());
      return binaryResponse(wavBytes());
    },
    () => engine.synthesize('てすと', 3, { pauseLengthScale: 1.6 }),
  );
  const synthesis = requests.find((r) => String(r.url).includes('/synthesis'));
  assert.ok(synthesis, '/synthesis が呼ばれていない');
  const sent = JSON.parse(Buffer.from(synthesis.init.body).toString('utf8'));
  assert.equal(sent.pauseLengthScale, 1.6);
  assert.equal(query.pauseLengthScale, 1.6);
});
