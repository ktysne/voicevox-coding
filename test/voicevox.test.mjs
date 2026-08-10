import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoicevoxEngine } from '../src/daemon/voicevox.js';
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

test('pauseLengthScale を持たない古い ENGINE の応答にもフィールドを足す', async () => {
  const engine = makeEngine();
  const old = audioQueryBody();
  delete old.pauseLength;
  delete old.pauseLengthScale;
  const query = await withFetch(
    async () => jsonResponse(old),
    () => engine.audioQuery('てすと', 3, { pauseLengthScale: 0.8 }),
  );
  // 古い ENGINE は未知フィールドとして無視するので、付けて送っても壊れない。
  assert.equal(query.pauseLengthScale, 0.8);
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

test('synthesize は上書き済みのクエリを /synthesis へ渡す', async () => {
  const engine = makeEngine();
  const requests = [];
  const { query } = await withFetch(
    async (url, init) => {
      requests.push({ url, init });
      if (String(url).includes('/audio_query')) return jsonResponse(audioQueryBody());
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    },
    () => engine.synthesize('てすと', 3, { pauseLengthScale: 1.6 }),
  );
  const synthesis = requests.find((r) => String(r.url).includes('/synthesis'));
  assert.ok(synthesis, '/synthesis が呼ばれていない');
  const sent = JSON.parse(Buffer.from(synthesis.init.body).toString('utf8'));
  assert.equal(sent.pauseLengthScale, 1.6);
  assert.equal(query.pauseLengthScale, 1.6);
});
