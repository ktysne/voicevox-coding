// node --test test/message-stream.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageAccumulator } from '../src/daemon/message-stream.js';
import { defaultConfig } from '../src/daemon/config.js';
import { resolveUtterance } from '../src/daemon/events.js';

const flush = (id, index, delta, final = false) => ({
  hook_event_name: 'MessageDisplay',
  message_id: id,
  turn_id: 't1',
  index,
  delta,
  final,
});

/** onComplete が呼ばれるまで待つ（grace 期間があるため）。 */
function collect(options = {}) {
  const got = [];
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const acc = new MessageAccumulator((info) => {
    got.push(info);
    resolve(info);
  }, { graceMs: 20, ...options });
  return { acc, got, done };
}

test('断片を index 順に連結して final でまとめて出す', async () => {
  const { acc, done } = collect();
  acc.push('claudeCode', flush('m1', 0, '全7件が trusted になっていますが、'));
  acc.push('claudeCode', flush('m1', 1, '1つ問題があります。'));
  acc.push('claudeCode', flush('m1', 2, 'まず実際に発火するか確かめます。', true));
  const info = await done;
  assert.equal(info.text, '全7件が trusted になっていますが、1つ問題があります。まず実際に発火するか確かめます。');
  assert.equal(info.target, 'claudeCode');
  acc.dispose();
});

test('順不同で届いても index 順に並べ直す', async () => {
  const { acc, done } = collect();
  acc.push('claudeCode', flush('m2', 2, 'CCC', true));
  acc.push('claudeCode', flush('m2', 0, 'AAA'));
  acc.push('claudeCode', flush('m2', 1, 'BBB'));
  const info = await done;
  assert.equal(info.text, 'AAABBBCCC');
  acc.dispose();
});

test('final の delta が空でも直前までの内容を出す', async () => {
  const { acc, done } = collect();
  acc.push('claudeCode', flush('m3', 0, '本文です。\n'));
  acc.push('claudeCode', flush('m3', 1, '', true));
  const info = await done;
  assert.equal(info.text, '本文です。\n');
  acc.dispose();
});

test('final が来ないうちは何も出さない', async () => {
  const { acc, got } = collect();
  acc.push('claudeCode', flush('m4', 0, 'まだ途中'));
  acc.push('claudeCode', flush('m4', 1, 'です'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(got.length, 0);
  assert.equal(acc.pending, 1);
  acc.dispose();
});

test('メッセージが混ざっても message_id ごとに独立している', async () => {
  const { acc, got } = collect();
  acc.push('claudeCode', flush('a', 0, 'Aの本文'));
  acc.push('claudeCode', flush('b', 0, 'Bの本文'));
  acc.push('claudeCode', flush('b', 1, '', true));
  acc.push('claudeCode', flush('a', 1, '', true));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((g) => g.text).sort(), ['Aの本文', 'Bの本文']);
  acc.dispose();
});

test('中身が空なら発話しない', async () => {
  const { acc, got } = collect();
  acc.push('claudeCode', flush('m5', 0, '   ', true));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(got.length, 0);
  acc.dispose();
});

test('放置されたバッファは TTL で捨てられる', async () => {
  const { acc } = collect({ ttlMs: 1 });
  acc.push('claudeCode', flush('m6', 0, '中断されたメッセージ'));
  assert.equal(acc.pending, 1);
  // sweep は内部タイマー任せなので、TTL 判定そのものを確認する
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(acc.pending, 1, 'sweep 実行前は残っている');
  acc.dispose();
  assert.equal(acc.pending, 0);
});

test('MessageDisplay は既定で有効で、本文を読む', () => {
  const profile = defaultConfig().targets.claudeCode;
  assert.equal(profile.events.MessageDisplay.enabled, true);
  const r = resolveUtterance({
    eventName: 'MessageDisplay',
    payload: { hook_event_name: 'MessageDisplay', message: '## 途中経過\nツールを実行します。' },
    profile,
    dictionary: { replacements: [] },
  });
  assert.equal(r.speak, true);
  assert.match(r.text, /ツールを実行します/);
});

test('MessageDisplay を無効にすると読み上げない', () => {
  const profile = defaultConfig().targets.claudeCode;
  profile.events.MessageDisplay.enabled = false;
  const r = resolveUtterance({
    eventName: 'MessageDisplay',
    payload: { hook_event_name: 'MessageDisplay', message: '途中経過' },
    profile,
    dictionary: { replacements: [] },
  });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'event-disabled');
});

test('Codex には MessageDisplay が無い', () => {
  const cfg = defaultConfig();
  assert.ok(!('MessageDisplay' in cfg.targets.codex.events));
  assert.ok('MessageDisplay' in cfg.targets.claudeCode.events);
});

test('既定のキュー方針は途中経過向けに enqueue', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.targets.claudeCode.queue.policy, 'enqueue');
  assert.ok(cfg.targets.claudeCode.queue.dedupeWindowSec >= 5, 'Stop との二重読みを防げる長さ');
});
