import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineError, VoicevoxEngine } from '../src/daemon/voicevox.js';
import { VOICE_PARAMS } from '../src/daemon/catalog.js';
import { EngineTrust, parseNetstatListeners, NO_LISTENERS_REASON } from '../src/daemon/engine-trust.js';

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
  return new VoicevoxEngine(() => ({ baseUrl: 'http://127.0.0.1:50021', timeoutSec: 5 }), {
    trust: { check: async () => ({ trusted: true, pids: [123] }) },
  });
}

test('untrusted のとき fetch が呼ばれず本文を送らない', async () => {
  const engine = new VoicevoxEngine(() => ({}), {
    trust: { check: async () => ({ trusted: false, pids: [123], reason: '別ユーザー (PID 123)' }) },
  });
  const requests = [];
  await withFetch(async (url, init) => {
    requests.push({ url, init });
    return binaryResponse(wavBytes());
  }, async () => {
    await assert.rejects(() => engine.synthesis({ text: '秘密の本文' }, 3),
      (err) => err instanceof EngineError && err.untrusted === true);
  });
  assert.deepEqual(requests, []);
});

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
              // 終わらないストリーム。上限を超えたチャンクで読むのをやめることを読んだ回数で確かめる
              read: async () => { index++; return { done: false, value: chunk }; },
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
  assert.equal(index, 65);
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

test('synthesis は再生時間が上限を超えた WAV を形式の不正と区別したメッセージで拒む', async () => {
  const engine = makeEngine();
  const wav = wavBytes();
  // 24kHz / 16bit / モノラル (48000 B/s) で 5 分 + 1 秒ぶんの data を主張する
  const dataSize = 48000 * 301;
  const long = Buffer.alloc(44 + dataSize);
  wav.copy(long, 0, 0, 44);
  long.writeUInt32LE(36 + dataSize, 4);
  long.writeUInt32LE(dataSize, 40);
  await assert.rejects(
    () => withFetch(async () => binaryResponse(long), () => engine.synthesis({}, 3)),
    (err) => err instanceof EngineError && /再生時間/.test(err.message) && !/不正な WAV/.test(err.message),
  );
});

test('parseNetstatListeners は IPv4・IPv6・全インターフェースの待受だけを重複なく返す', () => {
  const output = `
  プロトコル ローカルアドレス 外部アドレス 状態 PID
  TCP 127.0.0.1:50021 0.0.0.0:0 LISTENING 10
  TCP 127.20.30.40:50021 0.0.0.0:0 待機 11
  TCP [::1]:50021 [::]:0 LISTENING 12
  TCP 0.0.0.0:50021 0.0.0.0:0 LISTENING 13
  TCP [::]:50021 [::]:0 待機 14
  TCP 127.0.0.1:50021 0.0.0.0:0 LISTENING 10
  TCP 127.0.0.1:50021 127.0.0.1:12345 ESTABLISHED 15
  TCP [::1]:50021 [::1]:12345 ESTABLISHED 16
  TCP 127.0.0.1:50022 0.0.0.0:0 LISTENING 17
  TCP 192.168.1.1:50021 0.0.0.0:0 LISTENING 18
  UDP 127.0.0.1:50021 *:* 19
  TCP 127.0.0.1:50021 0.0.0.0:0 LISTENING 0
  TCP 127.0.0.1:50021 0.0.0.0:0 LISTENING invalid`;
  assert.deepEqual(parseNetstatListeners(output, 50021), [10, 11, 12, 13, 14]);
});

const LOCAL_ENGINE = 'http://127.0.0.1:50021';

test('EngineTrust は同じユーザーを許可し所有者をキャッシュする', async () => {
  let queries = 0;
  const trust = new EngineTrust({ listListeners: async () => [10], queryProcessOwner: async () => { queries++; return 'same'; } });
  assert.deepEqual(await trust.check(LOCAL_ENGINE), { trusted: true, pids: [10] });
  assert.equal((await trust.check(LOCAL_ENGINE)).trusted, true);
  assert.equal(queries, 1);
});

test('EngineTrust は別ユーザーを拒否しその結果をキャッシュする', async () => {
  let queries = 0;
  const trust = new EngineTrust({ listListeners: async () => [10, 11], queryProcessOwner: async (pid) => { queries++; return pid === 10 ? 'same' : 'other'; } });
  const result = await trust.check(LOCAL_ENGINE);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /別ユーザー.*11/);
  await trust.check(LOCAL_ENGINE);
  assert.equal(queries, 2);
});

test('EngineTrust は所有者照会の失敗を拒否しキャッシュしない', async () => {
  let queries = 0;
  const trust = new EngineTrust({ listListeners: async () => [10], queryProcessOwner: async () => { queries++; return 'unknown'; } });
  const result = await trust.check(LOCAL_ENGINE);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /確認できません.*10/);
  await trust.check(LOCAL_ENGINE);
  assert.equal(queries, 2);
});

test('EngineTrust は待受から消えた PID のキャッシュを捨てて再照会する', async () => {
  let pids = [10];
  let queries = 0;
  const trust = new EngineTrust({ listListeners: async () => pids, queryProcessOwner: async () => { queries++; return queries === 1 ? 'same' : 'other'; } });
  assert.equal((await trust.check(LOCAL_ENGINE)).trusted, true);
  pids = [];
  assert.equal((await trust.check(LOCAL_ENGINE)).reason, NO_LISTENERS_REASON);
  pids = [10];
  assert.equal((await trust.check(LOCAL_ENGINE)).trusted, false);
  assert.equal(queries, 2);
});

test('EngineTrust は managed の PID の所有者を照会しない', async () => {
  const trust = new EngineTrust({ listListeners: async () => [10], queryProcessOwner: async () => assert.fail('所有者の照会は不要') });
  trust.setManagedPids(() => [10]);
  assert.equal((await trust.check(LOCAL_ENGINE)).trusted, true);
});

test('EngineTrust は外部ホストを skipped にしループバックだけ確認する', async () => {
  const ports = [];
  const trust = new EngineTrust({ listListeners: async (port) => { ports.push(port); return [10]; }, queryProcessOwner: async () => 'same' });
  assert.deepEqual(await trust.check('http://192.168.1.1:50021'), { trusted: true, skipped: true, pids: [] });
  assert.equal(await trust.listeners('https://example.com'), null);
  for (const host of ['localhost', '[::1]', '127.2.3.4']) {
    assert.equal((await trust.check(`http://${host}:50021`)).trusted, true);
  }
  assert.deepEqual(ports, [50021, 50021, 50021]);
});

test('EngineTrust は netstat の失敗を拒否する', async () => {
  const trust = new EngineTrust({ listListeners: async () => { throw new Error('netstat failed'); } });
  const result = await trust.check(LOCAL_ENGINE);
  assert.equal(result.trusted, false);
  assert.match(result.reason, /netstat failed/);
  await assert.rejects(() => trust.listeners(LOCAL_ENGINE), /netstat failed/);
});

test('EngineTrust は同じ PID への同時照会を一回にまとめる', async () => {
  let finish;
  let queries = 0;
  const trust = new EngineTrust({ listListeners: async () => [10], queryProcessOwner: () => { queries++; return new Promise((resolve) => { finish = resolve; }); } });
  const first = trust.check(LOCAL_ENGINE);
  const second = trust.check(LOCAL_ENGINE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queries, 1);
  finish('same');
  assert.equal((await first).trusted, true);
  assert.equal((await second).trusted, true);
});

test('status は所有者が不信なときだけ untrusted を返す', async () => {
  const engine = new VoicevoxEngine(() => ({}), { trust: { check: async () => ({ trusted: false, pids: [10], reason: '別ユーザー (PID 10)' }) } });
  const status = await engine.status();
  assert.equal(status.available, false);
  assert.equal(status.untrusted, true);
  assert.match(status.error, /10/);
  engine.trust.check = async () => ({ trusted: false, pids: [], reason: NO_LISTENERS_REASON });
  assert.equal(Object.hasOwn(await engine.status(), 'untrusted'), false);
});

test('synthesis は応答後に待受が入れ替わったら WAV を返さない', async () => {
  let checks = 0;
  const engine = new VoicevoxEngine(() => ({}), { trust: { check: async () => ({ trusted: true, pids: [++checks === 1 ? 10 : 11] }) } });
  await withFetch(async () => binaryResponse(wavBytes()), async () => {
    await assert.rejects(() => engine.synthesis({}, 3), (err) => err instanceof EngineError && err.untrusted === true);
  });
  assert.equal(checks, 2);
});

test('synthesis は待受 PID の順序だけの変化を許可する', async () => {
  let checks = 0;
  const engine = new VoicevoxEngine(() => ({}), { trust: { check: async () => ({ trusted: true, pids: ++checks === 1 ? [10, 11] : [11, 10] }) } });
  assert.deepEqual(await withFetch(async () => binaryResponse(wavBytes()), () => engine.synthesis({}, 3)), wavBytes());
});

test('EngineTrust は待受が消えた後に完了した所有者照会をキャッシュへ戻さない', async () => {
  let pids = [10];
  let finish;
  let queries = 0;
  const trust = new EngineTrust({ listListeners: async () => pids, queryProcessOwner: () => {
    queries++;
    return queries === 1 ? new Promise((resolve) => { finish = resolve; }) : 'other';
  } });
  const oldCheck = trust.check(LOCAL_ENGINE);
  await new Promise((resolve) => setImmediate(resolve));
  pids = [];
  assert.equal((await trust.check(LOCAL_ENGINE)).trusted, false);
  finish('same');
  await oldCheck;
  pids = [10];
  assert.equal((await trust.check(LOCAL_ENGINE)).trusted, false);
  assert.equal(queries, 2);
});

test('synthesis は応答後に所有者を確認できなければ WAV を返さない', async () => {
  let checks = 0;
  const engine = new VoicevoxEngine(() => ({}), { trust: { check: async () => ({ trusted: ++checks === 1, pids: [10], reason: '確認できません (PID 10)' }) } });
  await withFetch(async () => binaryResponse(wavBytes()), async () => {
    await assert.rejects(() => engine.synthesis({}, 3), (err) => err instanceof EngineError && err.untrusted === true);
  });
});

test('parseNetstatListeners は接続先のアドレスファミリーで受けうる待受だけを返す', () => {
  const output = `
  TCP 127.0.0.1:50021 0.0.0.0:0 LISTENING 10
  TCP 127.20.30.40:50021 0.0.0.0:0 LISTENING 11
  TCP [::1]:50021 [::]:0 LISTENING 12
  TCP 0.0.0.0:50021 0.0.0.0:0 LISTENING 13
  TCP [::]:50021 [::]:0 LISTENING 14`;
  assert.deepEqual(parseNetstatListeners(output, 50021, '127.0.0.1'), [10, 13]);
  assert.deepEqual(parseNetstatListeners(output, 50021, '[::1]'), [12, 14]);
  assert.deepEqual(parseNetstatListeners(output, 50021, 'localhost'), [10, 11, 12, 13, 14]);
});

test('EngineTrust は照会中に待受から消えた PID の結果を許可に使わない', async () => {
  let pids = [10];
  let finish;
  const trust = new EngineTrust({ listListeners: async () => pids, queryProcessOwner: () => new Promise((resolve) => { finish = resolve; }) });
  const oldCheck = trust.check(LOCAL_ENGINE);
  await new Promise((resolve) => setImmediate(resolve));
  pids = [];
  await trust.check(LOCAL_ENGINE);
  finish('same');
  assert.equal((await oldCheck).trusted, false);
});

test('信頼の確認を待つ間に接続先が変わっても、確かめた接続先にだけ送る', async () => {
  let baseUrl = 'http://127.0.0.1:50021';
  let release;
  const checked = [];
  const engine = new VoicevoxEngine(() => ({ baseUrl, timeoutSec: 5 }), {
    trust: { check: async (url) => { checked.push(url); await new Promise((resolve) => { release = resolve; }); return { trusted: true, pids: [10] }; } },
  });
  const urls = [];
  await withFetch(async (url) => { urls.push(String(url)); return jsonResponse('0.25.2'); }, async () => {
    const pending = engine.version();
    await new Promise((resolve) => setImmediate(resolve));
    baseUrl = 'http://192.168.1.50:50021';
    release();
    await pending;
  });
  assert.deepEqual(checked, ['http://127.0.0.1:50021']);
  assert.deepEqual(urls, ['http://127.0.0.1:50021/version']);
});
