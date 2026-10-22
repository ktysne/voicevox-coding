import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealHookBody, openSealedHook } from '../src/daemon/hook-seal.js';

const TOKEN = 'a'.repeat(64);
const NOW = 1700000000000;
const BODY = { target: 'claudeCode', payload: { hook_event_name: 'Stop', last_assistant_message: '秘密の本文' } };

test('封筒を復号するとターゲットと本文が戻る', () => {
  const sealed = sealHookBody(TOKEN, BODY, NOW);
  assert.deepEqual(openSealedHook(TOKEN, sealed, NOW), { ok: true, ...BODY });
  assert.notEqual(sealed.iv, sealHookBody(TOKEN, BODY, NOW).iv);
  assert.ok(!JSON.stringify(sealed).includes('秘密の本文'));
});

test('別トークンでは封筒を復号できない', () => {
  assert.equal(openSealedHook('b'.repeat(64), sealHookBody(TOKEN, BODY, NOW), NOW).ok, false);
});

for (const field of ['ct', 'tag']) {
  test(`${field} の改ざんを拒否する`, () => {
    const sealed = sealHookBody(TOKEN, BODY, NOW);
    const bytes = Buffer.from(sealed[field], 'base64');
    bytes[0] ^= 1;
    sealed[field] = bytes.toString('base64');
    assert.equal(openSealedHook(TOKEN, sealed, NOW).ok, false);
  });
}

test('時刻は前後 60 秒の境界まで受理し、それを超えると拒否する', () => {
  for (const offset of [-60001, -60000, 60000, 60001]) {
    assert.equal(openSealedHook(TOKEN, sealHookBody(TOKEN, BODY, NOW + offset), NOW).ok, Math.abs(offset) <= 60000);
  }
  for (const ts of [null, '1700000000000']) {
    assert.equal(openSealedHook(TOKEN, sealHookBody(TOKEN, BODY, ts), NOW).ok, false);
  }
});

test('欄の欠落、型違い、長さ違い、不正な base64 とバージョンを拒否する', () => {
  const sealed = sealHookBody(TOKEN, BODY, NOW);
  for (const field of ['v', 'iv', 'ct', 'tag']) {
    const missing = { ...sealed };
    delete missing[field];
    assert.equal(openSealedHook(TOKEN, missing, NOW).ok, false, field);
    for (const value of [null, {}, [], 42, '', '???']) {
      assert.equal(openSealedHook(TOKEN, { ...sealed, [field]: value }, NOW).ok, false, field);
    }
  }
  for (const field of ['iv', 'tag']) {
    assert.equal(openSealedHook(TOKEN, { ...sealed, [field]: Buffer.alloc(5).toString('base64') }, NOW).ok, false);
  }
  for (const v of [0, 2, '1']) assert.equal(openSealedHook(TOKEN, { ...sealed, v }, NOW).ok, false);
  for (const body of [null, undefined, [], 'bad']) assert.equal(openSealedHook(TOKEN, body, NOW).ok, false);
});
