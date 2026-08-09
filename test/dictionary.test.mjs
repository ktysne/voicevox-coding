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
 * 所有状態のファイルをメモリ上で代替する。
 * writeState は一時ファイルへ書いてから rename するので、その 2 段階も再現する。
 * @returns {{writes:Array<object>, patch:(next:object)=>void}}
 *   writes は writeState ごとの state のスナップショット、patch は保存済み state の書き換え
 */
function stubState(initial = { words: {} }) {
  const writes = [];
  let current = JSON.stringify(initial);
  let tmp = null;
  const realReadFileSync = fs.readFileSync;
  const realWriteFileSync = fs.writeFileSync;
  const realRenameSync = fs.renameSync;
  const realMkdirSync = fs.mkdirSync;
  mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (file === STATE_PATH) return current;
    return realReadFileSync(file, ...rest);
  });
  mock.method(fs, 'writeFileSync', (file, data, ...rest) => {
    if (file === `${STATE_PATH}.tmp`) {
      tmp = data;
      return undefined;
    }
    return realWriteFileSync(file, data, ...rest);
  });
  mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (from === `${STATE_PATH}.tmp` && to === STATE_PATH) {
      current = tmp;
      writes.push(JSON.parse(current));
      return undefined;
    }
    return realRenameSync(from, to, ...rest);
  });
  mock.method(fs, 'mkdirSync', (dir, ...rest) => {
    if (dir === CONFIG_DIR) return undefined;
    return realMkdirSync(dir, ...rest);
  });
  return {
    writes,
    patch: (next) => { current = JSON.stringify({ ...JSON.parse(current), ...next }); },
  };
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
  const { writes } = stubState();
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
  const { writes } = stubState({ words: { VOICEVOX: 'uuid-old' } });
  const engine = new FakeEngine({ userDictError: new Error('接続できません') });

  await assert.rejects(
    () => syncEngineDictionary(engine, [word('VOICEVOX', 'ボイスボックス')]),
    /ユーザー辞書の一覧を取得できないため同期を中止しました/,
  );

  assert.deepEqual(engine.calls, [['userDict']]);
  assert.deepEqual(writes, []);
});

test('途中の追加が失敗しても成功済みの uuid は state に残る', async () => {
  const { writes } = stubState();
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
  const { writes } = stubState({ words: { 残す語: 'uuid-keep', 消す語: 'uuid-drop' } });
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
  const { writes } = stubState({ words: { 復活語: 'uuid-gone' } });
  const engine = new FakeEngine({ dict: {} });

  const result = await syncEngineDictionary(engine, [word('復活語', 'フッカツゴ')]);

  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.deepEqual(writes.at(-1).words, { 復活語: 'uuid-復活語' });
});

test('追加が失敗しても ENGINE に登録されていれば uuid を拾って state に残す', async () => {
  const { writes } = stubState();
  // 登録は通ったが応答だけ失敗した状況を再現する
  const engine = new FakeEngine({
    onAdd: (payload, _index, self) => {
      self.dict['uuid-orphan'] = { ...payload };
      throw new Error('応答が途切れました');
    },
  });

  await assert.rejects(
    () => syncEngineDictionary(engine, [word('孤立語', 'コリツゴ')]),
    /応答が途切れました/,
  );

  assert.deepEqual(writes.at(-1).words, { 孤立語: 'uuid-orphan' });
  assert.equal(writes.at(-1).pending, null);
});

test('追加の確認まで失敗しても、次回の同期が pending から実体を拾って二重登録しない', async () => {
  const { writes } = stubState();
  const engine = new FakeEngine({
    onAdd: (payload, _index, self) => {
      // 登録は通ったが、応答も直後の一覧取得も失敗した
      self.dict['uuid-registered'] = { ...payload };
      self.userDictError = new Error('接続が切れました');
      throw new Error('応答が途切れました');
    },
  });

  await assert.rejects(
    () => syncEngineDictionary(engine, [word('切断語', 'セツダンゴ')]),
    /応答が途切れました/,
  );

  assert.deepEqual(writes.at(-1).words, {});
  assert.equal(writes.at(-1).pending.surface, '切断語');
  assert.equal(writes.at(-1).pending.pronunciation, 'セツダンゴ');

  // 復旧後の同期では追加をやり直さず、登録済みの uuid を所有し直す
  engine.userDictError = null;
  engine.onAdd = null;
  const result = await syncEngineDictionary(engine, [word('切断語', 'セツダンゴ')]);

  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.deepEqual(writes.at(-1).words, { 切断語: 'uuid-registered' });
});

test('追加前から在る同じ表記の手動登録語は回収しない', async () => {
  // 表記も読みも同じ語が手動で登録済み。ツール側の追加は成立せずに失敗する
  const manual = { 'uuid-manual': { surface: '同名語', pronunciation: 'ドウメイゴ' } };
  const { writes, patch } = stubState();
  const engine = new FakeEngine({
    dict: { ...manual },
    onAdd: () => { throw new Error('追加に失敗しました'); },
  });

  await assert.rejects(
    () => syncEngineDictionary(engine, [word('同名語', 'ドウメイゴ')]),
    /追加に失敗しました/,
  );

  // 手動登録語を所有すると、設定から消したときに巻き添えで削除してしまう
  assert.deepEqual(writes.at(-1).words, {});
  assert.deepEqual(writes.at(-1).pending.knownUuids, ['uuid-manual']);

  // 猶予を過ぎたあとの同期でも、既存の uuid は奪わずに追加をやり直す
  patch({ pending: { ...writes.at(-1).pending, at: 0 } });
  engine.onAdd = null;
  const result = await syncEngineDictionary(engine, [word('同名語', 'ドウメイゴ')]);

  assert.equal(result.added, 1);
  assert.deepEqual(writes.at(-1).words, { 同名語: 'uuid-同名語' });
});

test('前回の追加が確定していないうちは追加をやり直さず failed に積む', async () => {
  const pending = { surface: '保留語', pronunciation: 'ホリュウゴ', knownUuids: [], at: Date.now() };
  const { writes, patch } = stubState({ words: {}, pending });
  const engine = new FakeEngine();

  // ENGINE 側でまだ追加を処理中かもしれないので、猶予のあいだは触らない
  const result = await syncEngineDictionary(engine, [word('保留語', 'ホリュウゴ')]);

  assert.equal(result.added, 0);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(engine.calls.filter(([kind]) => kind === 'add'), []);
  assert.equal(writes.at(-1).pending.surface, '保留語');

  // 猶予を過ぎたら改めて追加する
  patch({ pending: { ...pending, at: 0 } });
  const retry = await syncEngineDictionary(engine, [word('保留語', 'ホリュウゴ')]);

  assert.equal(retry.added, 1);
  assert.deepEqual(writes.at(-1).words, { 保留語: 'uuid-保留語' });
});

test('遅れて ENGINE に現れた登録は pending から回収して追加し直さない', async () => {
  const pending = { surface: '遅延語', pronunciation: 'チエンゴ', knownUuids: [], at: Date.now() };
  const { writes } = stubState({ words: {}, pending });
  // 前回の同期がタイムアウトしたあと、ENGINE 側の処理が完了した状態
  const engine = new FakeEngine({ dict: { 'uuid-late': { surface: '遅延語', pronunciation: 'チエンゴ' } } });

  const result = await syncEngineDictionary(engine, [word('遅延語', 'チエンゴ')]);

  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.deepEqual(writes.at(-1).words, { 遅延語: 'uuid-late' });
});

test('半角と全角の違いだけの表記も重複として弾く', async () => {
  stubState();
  const engine = new FakeEngine();

  const result = await syncEngineDictionary(engine, [
    word('VOICEVOX', 'ボイスボックス'),
    word('ＶＯＩＣＥＶＯＸ', 'ボイスボックス'),
  ]);

  assert.equal(result.added, 1);
  assert.deepEqual(result.skipped, [{ surface: 'ＶＯＩＣＥＶＯＸ', errors: ['表記が重複しています'] }]);
});

test('削除に失敗した語は failed に積み、所有を残して次回に持ち越す', async () => {
  const { writes } = stubState({ words: { 消す語: 'uuid-drop' } });
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
