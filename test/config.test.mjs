// ConfigStore の revision (AUD-06 follow-up) のテスト。
// UI 側の自己通知判定・外部更新の取り扱いはこの revision に依存しているため、
// 「保存・パッチ・外部エディタでの直接編集のたびに単調増加し、change /
// externalChange イベントへ一緒に渡ること」をここで担保する。
// ディスクへは書き込みたくないので fs の副作用は全てモックする。

import fs from 'node:fs';
import { beforeEach, afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore } from '../src/daemon/config.js';

beforeEach(() => {
  mock.method(fs, 'mkdirSync', () => undefined);
  mock.method(fs, 'writeFileSync', () => undefined);
  mock.method(fs, 'renameSync', () => undefined);
  // 常に「まだ設定ファイルが無い」ことにして、load() が既定値で save() を
  // 呼ぶ経路（revision が 1 になる経路）に揃える。
  mock.method(fs, 'existsSync', () => false);
});

afterEach(() => {
  mock.restoreAll();
});

test('revision は最初 0、load() が新規作成で save() すると 1 になる', () => {
  const store = new ConfigStore();
  assert.equal(store.revision, 0);
  store.load();
  assert.equal(store.revision, 1);
});

test('save() のたびに revision が増え、change イベントへ渡る', () => {
  const store = new ConfigStore();
  store.load();

  const seen = [];
  store.on('change', (cfg, revision) => seen.push(revision));

  const next = store.save({ ...store.config, daemon: { ...store.config.daemon, port: 12345 } });
  assert.equal(store.revision, 2);
  assert.deepEqual(seen, [2]);
  assert.equal(next.daemon.port, 12345);

  store.save({ ...store.config, daemon: { ...store.config.daemon, port: 12346 } });
  assert.equal(store.revision, 3);
  assert.deepEqual(seen, [2, 3]);
});

test('patch() も revision を増やす', () => {
  const store = new ConfigStore();
  store.load();

  const next = store.patch({ daemon: { port: 9999 } });
  assert.equal(store.revision, 2);
  assert.equal(next.daemon.port, 9999);
});

// bootId (Codex レビュー追加対応): revision はプロセスのメモリ上だけの
// カウンタなのでデーモン再起動をまたぐと 0 から数え直される。UI 側は
// bootId が変わったことをもって「再起動された」と検出するため、
// 同一プロセス内では不変・別インスタンス（＝別プロセスを模す）では
// 別の値になることを担保する。

test('bootId は同一インスタンス内では不変で、save/patch/watch では変わらない', () => {
  const store = new ConfigStore();
  const initial = store.bootId;
  assert.equal(typeof initial, 'string');
  assert.ok(initial.length > 0);

  store.load();
  assert.equal(store.bootId, initial);

  store.save({ ...store.config, daemon: { ...store.config.daemon, port: 12345 } });
  assert.equal(store.bootId, initial);

  store.patch({ daemon: { port: 9999 } });
  assert.equal(store.bootId, initial);
});

test('bootId は ConfigStore のインスタンスごとに異なる（プロセス再起動を模す）', () => {
  const a = new ConfigStore();
  const b = new ConfigStore();
  assert.notEqual(a.bootId, b.bootId);
});

test('change イベントは revision に加えて bootId を渡す', () => {
  const store = new ConfigStore();
  store.load();

  let seenBootId;
  store.on('change', (cfg, revision, bootId) => { seenBootId = bootId; });
  store.save({ ...store.config, daemon: { ...store.config.daemon, port: 12345 } });

  assert.equal(seenBootId, store.bootId);
});

// mutationId (Codex レビュー追加対応): UI が保存要求ごとに払い出す識別子。
// save()/patch() に渡すとそのまま change イベントへエコーされ、UI 側が
// 「自分がいま送った保存の自己通知」を PUT 応答と SSE の到着順に依存せず
// 確定判定できるようにする。

test('save() に渡した mutationId が change イベントへそのままエコーされる', () => {
  const store = new ConfigStore();
  store.load();

  const seen = [];
  store.on('change', (cfg, revision, bootId, mutationId) => seen.push(mutationId));

  store.save({ ...store.config, daemon: { ...store.config.daemon, port: 12345 } }, 'mut-1');
  assert.deepEqual(seen, ['mut-1']);

  // mutationId を渡さない保存（外部要因を模す）では null のまま
  store.save({ ...store.config, daemon: { ...store.config.daemon, port: 12346 } });
  assert.deepEqual(seen, ['mut-1', null]);
});

test('patch() に渡した mutationId も change イベントへエコーされる', () => {
  const store = new ConfigStore();
  store.load();

  const seen = [];
  store.on('change', (cfg, revision, bootId, mutationId) => seen.push(mutationId));

  store.patch({ daemon: { port: 9999 } }, 'mut-2');
  assert.deepEqual(seen, ['mut-2']);
});

// watch() は変更検知から 150ms 遅らせて再読み込みする（エディタの書き込み
// 完了待ち）。node:test の mock.timers は Node バージョンによって
// enable() の引数形式（配列 or { apis: [...] }）が異なり、
// package.json の engines（node >=20）の下限では壊れる組み合わせがある。
// ここでは setTimeout/clearTimeout 自体を直接差し替えて、
// 150ms 分の実待機をせず同期的にコールバックを実行させることで
// タイマー API のバージョン差を気にせず済むようにする。
function mockImmediateTimeout() {
  mock.method(globalThis, 'setTimeout', (fn) => {
    fn();
    return 0;
  });
  mock.method(globalThis, 'clearTimeout', () => {});
}

test('外部エディタでの直接編集 (watch) も revision を増やし change/externalChange の両方に渡る', () => {
  let watchCallback;
  mock.method(fs, 'watch', (_dir, cb) => {
    watchCallback = cb;
    return { close() {} };
  });
  mock.method(fs, 'readFileSync', () => JSON.stringify({ daemon: { port: 7777 } }));
  mockImmediateTimeout();

  const store = new ConfigStore();
  store.load();
  assert.equal(store.revision, 1);
  // load() 内の save() が自分の書き込みループ防止のための抑止窓
  // (suppressWatchUntil) をセットしているので、直後の発火が無視されない
  // よう解除しておく（このテストの主眼はその抑止機構自体ではない）。
  store.suppressWatchUntil = 0;

  const seenChange = [];
  const seenExternal = [];
  store.on('change', (cfg, revision, bootId, mutationId) => seenChange.push({ revision, bootId, mutationId }));
  store.on('externalChange', (cfg, revision, bootId, mutationId) => seenExternal.push({ revision, bootId, mutationId }));

  store.watch();
  watchCallback('change', 'config.json');

  assert.equal(store.revision, 2);
  // 外部エディタでの編集は UI からの保存要求ではないので mutationId は null。
  // bootId はプロセス内で不変なので store.bootId と一致する。
  assert.deepEqual(seenChange, [{ revision: 2, bootId: store.bootId, mutationId: null }]);
  assert.deepEqual(seenExternal, [{ revision: 2, bootId: store.bootId, mutationId: null }]);
  assert.equal(store.config.daemon.port, 7777);
});

test('watch() は自分の保存直後 (suppressWatchUntil 内) の発火を無視し revision を増やさない', () => {
  let watchCallback;
  mock.method(fs, 'watch', (_dir, cb) => {
    watchCallback = cb;
    return { close() {} };
  });
  mock.method(fs, 'readFileSync', () => JSON.stringify({ daemon: { port: 1111 } }));
  mockImmediateTimeout();

  const store = new ConfigStore();
  store.load();
  store.watch();
  store.save({ ...store.config, daemon: { ...store.config.daemon, port: 12345 } });
  assert.equal(store.revision, 2);

  // save() 直後は suppressWatchUntil の抑止期間内なので、ここでの発火は無視される
  watchCallback('change', 'config.json');
  assert.equal(store.revision, 2);
});
