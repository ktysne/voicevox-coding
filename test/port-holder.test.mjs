import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePortHolder } from '../src/daemon/port-holder.js';

for (const [name, owners, expected] of [
  ['同じユーザー', ['same'], 'same'],
  ['別ユーザー', ['other'], 'other'],
  ['所有者不明', ['unknown'], 'unknown'],
  ['待受なし', [], 'unknown'],
  ['全待受が同じユーザー', ['same', 'same'], 'same'],
  ['同一と不明の混在', ['same', 'unknown'], 'unknown'],
  ['同一と別ユーザーの混在', ['same', 'other'], 'other'],
  ['不明と別ユーザーの混在', ['unknown', 'other'], 'other'],
]) {
  test(`ポート所有者: ${name}`, async () => {
    const pids = owners.map((_, i) => i + 100);
    const result = await describePortHolder({ port: 7591,
      listListeners: async (port, host) => {
        assert.equal(port, 7591);
        assert.equal(host, '127.0.0.1');
        return pids;
      },
      queryProcessOwner: async (pid) => owners[pids.indexOf(pid)],
    });
    assert.deepEqual(result, { owner: expected, pids });
  });
}

test('待受の列挙が失敗した場合は不明になる', async () => {
  assert.deepEqual(await describePortHolder({ port: 7591, listListeners: async () => { throw new Error('failed'); } }),
    { owner: 'unknown', pids: [] });
});

test('所有者照会の失敗が混じる場合は同一ユーザーとみなさず、別ユーザーを優先する', async () => {
  for (const owner of ['same', 'other']) {
    const result = await describePortHolder({ port: 7591, listListeners: async () => [100, 200],
      queryProcessOwner: async (pid) => { if (pid === 100) throw new Error('failed'); return owner; },
    });
    assert.deepEqual(result, { owner: owner === 'other' ? 'other' : 'unknown', pids: [100, 200] });
  }
});
