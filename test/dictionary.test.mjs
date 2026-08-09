import fs from 'node:fs';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_DIR } from '../src/daemon/config.js';
import { syncEngineDictionary } from '../src/daemon/dictionary.js';

// 所有状態は fs 経由で読み書きするため、STATE_PATH への I/O だけ横取りして実ファイルを触らない。
const STATE_PATH = path.join(CONFIG_DIR, 'engine-dict-state.json');

afterEach(() => {
  mock.restoreAll();
});

/**
 * 所有状態のファイルをメモリ上で代替する。書き込んだ内容は次の読み込みに反映される。
 * @returns {Array<object>} writeState の呼び出しごとに積まれる state のスナップショット
 */
function stubState(initial = { words: {} }) {
  const writes = [];
  let current = JSON.stringify(initial);
  const realReadFileSync = fs.readFileSync;
  const realWriteFileSync = fs.writeFileSync;
  const realMkdirSync = fs.mkdirSync;
  mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (file === STATE_PATH) return current;
    return realReadFileSync(file, ...rest);
  });
  mock.method(fs, 'writeFileSync', (file, data, ...rest) => {
    if (file === STATE_PATH) {
      current = data;
      writes.push(JSON.parse(data));
      return undefined;
    }
    return realWriteFileSync(file, data, ...rest);
  });
  mock.method(fs, 'mkdirSync', (dir, ...rest) => {
    if (dir === CONFIG_DIR) return undefined;
    return realMkdirSync(dir, ...rest);
  });
  return writes;
}

class FakeEngine {
  /**
   * @param {object} [opts]
   * @param {object} [opts.dict] ENGINE 側の uuid -> 単語のマップ。追加・削除で更新される
   * @param {Error} [opts.userDictError] userDict() を失敗させる場合の例外
   * @param {(payload:object, index:number, engine:FakeEngine) => string} [opts.onAdd]
   *   追加時の挙動。uuid を返すか、例外を投げる（副作用ありの失敗も再現できる）
   * @param {(uuid:string) => void} [opts.onDelete] 削除時の挙動。例外を投げてもよい
   */
  constructor({ dict = {}, userDictError = null, onAdd = null, onDelete = null } = {}) {
    this.dict = dict;
    this.userDictError = userDictError;
    this.onAdd = onAdd;
    this.onDelete = onDelete;
    this.calls = [];
  }

  async userDict() {
    this.calls.push(['userDict']);
    if (this.userDictError) throw this.userDictError;
    return { ...this.dict };
  }

  async addUserDictWord(payload) {
    const index = this.calls.filter(([kind]) => kind === 'add').length;
    this.calls.push(['add', payload.surface]);
    const uuid = this.onAdd ? this.onAdd(payload, index, this) : `uuid-${payload.surface}`;
    this.dict[uuid] = { ...payload };
    return uuid;
  }

  async updateUserDictWord(uuid, payload) {
    this.calls.push(['update', uuid, payload.surface]);
    this.dict[uuid] = { ...payload };
  }

  async deleteUserDictWord(uuid) {
    this.calls.push(['delete', uuid]);
    if (this.onDelete) this.onDelete(uuid);
    delete this.dict[uuid];
  }
}

const word = (surface, pronunciation) => ({ surface, pronunciation, accentType: 0 });

test('同じ表記が複数あると 2 件目以降を skipped にして追加は 1 回だけにする', async () => {
  const writes = stubState();
  const engine = new FakeEngine();

  const result = await syncEngineDictionary(engine, [
    word('VOICEVOX', 'ボイスボックス'),
    word('VOICEVOX', 'ボイスボックスニ'),
  ]);

  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.skipped, [{ surface: 'VOICEVOX', errors: ['表記が重複しています'] }]);
  assert.deepEqual(engine.calls.filter(([kind]) => kind === 'add'), [['add', 'VOICEVOX']]);
  assert.deepEqual(writes.at(-1).words, { VOICEVOX: 'uuid-VOICEVOX' });
});

test('辞書一覧の取得に失敗したら同期を中止して追加も更新もしない', async () => {
  const writes = stubState({ words: { VOICEVOX: 'uuid-old' } });
  const engine = new FakeEngine({ userDictError: new Error('接続できません') });

  await assert.rejects(
    () => syncEngineDictionary(engine, [word('VOICEVOX', 'ボイスボックス')]),
    /ユーザー辞書の一覧を取得できないため同期を中止しました/,
  );

  assert.deepEqual(engine.calls, [['userDict']]);
  assert.deepEqual(writes, []);
});

test('途中の追加が失敗しても成功済みの uuid は state に残る', async () => {
  const writes = stubState();
  const engine = new FakeEngine({
    onAdd: (payload, index) => {
      if (index === 1) throw new Error('追加に失敗しました');
      return `uuid-${payload.surface}`;
    },
  });

  await assert.rejects(
    () => syncEngineDictionary(engine, [word('一語目', 'イチゴメ'), word('二語目', 'ニゴメ')]),
    /追加に失敗しました/,
  );

  assert.deepEqual(writes.at(-1).words, { 一語目: 'uuid-一語目' });
});

test('既存の所有語は更新し、設定から消えた語は ENGINE からも削除する', async () => {
  const writes = stubState({ words: { 残す語: 'uuid-keep', 消す語: 'uuid-drop' } });
  const engine = new FakeEngine({ dict: { 'uuid-keep': {}, 'uuid-drop': {} } });

  const result = await syncEngineDictionary(engine, [word('残す語', 'ノコスゴ')]);

  assert.deepEqual(result, { added: 0, updated: 1, removed: 1, skipped: [], failed: [] });
  assert.deepEqual(engine.calls, [
    ['userDict'],
    ['update', 'uuid-keep', '残す語'],
    ['delete', 'uuid-drop'],
  ]);
  assert.deepEqual(writes.at(-1).words, { 残す語: 'uuid-keep' });
});

test('ENGINE 側から消えた所有語は再登録して新しい uuid を持ち直す', async () => {
  const writes = stubState({ words: { 復活語: 'uuid-gone' } });
  const engine = new FakeEngine({ dict: {} });

  const result = await syncEngineDictionary(engine, [word('復活語', 'フッカツゴ')]);

  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.deepEqual(writes.at(-1).words, { 復活語: 'uuid-復活語' });
});

test('追加が失敗しても ENGINE に登録されていれば uuid を拾って state に残す', async () => {
  const writes = stubState();
  // 登録は通ったが応答だけ失敗した状況を再現する
  const engine = new FakeEngine({
    onAdd: (payload, _index, self) => {
      self.dict['uuid-orphan'] = { surface: payload.surface };
      throw new Error('応答が途切れました');
    },
  });

  await assert.rejects(
    () => syncEngineDictionary(engine, [word('孤立語', 'コリツゴ')]),
    /応答が途切れました/,
  );

  assert.deepEqual(writes.at(-1).words, { 孤立語: 'uuid-orphan' });
});

test('削除に失敗した語は failed に積み、所有を残して次回に持ち越す', async () => {
  const writes = stubState({ words: { 消す語: 'uuid-drop' } });
  const engine = new FakeEngine({
    dict: { 'uuid-drop': { surface: '消す語' } },
    onDelete: () => { throw new Error('削除できません'); },
  });

  const result = await syncEngineDictionary(engine, []);

  assert.equal(result.removed, 0);
  assert.deepEqual(result.failed, [
    { surface: '消す語', errors: ['ENGINE から削除できませんでした: 削除できません'] },
  ]);
  assert.deepEqual(writes.at(-1).words, { 消す語: 'uuid-drop' });
});

test('同期は直列化され、並行実行でも同じ表記を二重登録しない', async () => {
  stubState();
  const engine = new FakeEngine();

  const [first, second] = await Promise.all([
    syncEngineDictionary(engine, [word('並行語', 'ヘイコウゴ')]),
    syncEngineDictionary(engine, [word('並行語', 'ヘイコウゴ')]),
  ]);

  assert.equal(first.added + second.added, 1);
  assert.equal(first.updated + second.updated, 1);
  assert.deepEqual(engine.calls.filter(([kind]) => kind === 'add'), [['add', '並行語']]);
});
