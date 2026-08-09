import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Player } from '../src/daemon/player.js';

// 実ワーカー（PowerShell）は起動できないので、stdin/stdout を偽装した子プロセスで置き換える。
// 応答は明示的に emitLine() したときだけ返るため、タイムアウトと遅延応答を再現できる。
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.stdin = {
      writable: true,
      write: (chunk) => {
        this.written.push(chunk);
        return true;
      },
    };
  }

  emitLine(line) {
    this.stdout.emit('data', `${line}\n`);
  }

  kill() {
    this.killed = true;
    this.stdin.writable = false;
    // 実プロセスと同じく、終了通知は次のティック以降に届く
    setImmediate(() => this.emit('exit', null));
  }
}

/** spawn の代わりに FakeChild を返し、世代ごとの子プロセスを記録する。 */
function fakeSpawner() {
  const children = [];
  const spawnFn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { children, spawnFn };
}

function createPlayer({ timeoutMs = 20 } = {}) {
  const { children, spawnFn } = fakeSpawner();
  const warnings = [];
  const log = { warn: (m) => warnings.push(m), error: (m) => warnings.push(m), debug: () => {} };
  const player = new Player(log, { spawnFn, timeoutMs });
  player.start();
  return { player, children, warnings };
}

test('正常な応答は対応する待機処理を解決する', async () => {
  const { player, children } = createPlayer();
  const promise = player.play('C:/tmp/a.wav');
  assert.equal(children[0].written.at(-1), 'PLAY C:/tmp/a.wav\n');
  children[0].emitLine('OK');
  await promise;
  assert.equal(player.pending.length, 0);
  assert.equal(children[0].killed, false);
});

test('ERR 応答は待機処理を失敗させる', async () => {
  const { player, children } = createPlayer();
  const promise = player.hold();
  children[0].emitLine('ERR デバイスがありません');
  await assert.rejects(promise, /デバイスがありません/);
});

test('タイムアウトすると全 pending が失敗しワーカーが kill される', async () => {
  const { player, children, warnings } = createPlayer();
  const first = player.play('C:/tmp/a.wav');
  const second = player.play('C:/tmp/b.wav');
  await Promise.all([
    assert.rejects(first, /再生ワーカーが応答しません/),
    assert.rejects(second, /再生ワーカーが応答しません/),
  ]);
  assert.equal(children[0].killed, true);
  assert.equal(player.pending.length, 0);
  assert.equal(player.child, null);
  assert.ok(warnings.some((m) => m.includes('再生ワーカーが応答しません')));
});

test('タイムアウト後の遅延応答は新しい世代のコマンドを解決しない', async () => {
  const { player, children } = createPlayer();
  const timedOut = player.play('C:/tmp/a.wav');
  await assert.rejects(timedOut, /再生ワーカーが応答しません/);

  // 新しい世代を起動してからコマンドを送る
  player.start();
  assert.equal(children.length, 2);
  const next = player.play('C:/tmp/b.wav');
  let settled = false;
  next.then(() => { settled = true; }, () => { settled = true; });

  // 旧ワーカーが遅れて応答しても、新世代の待機処理には割り当てられない
  children[0].emitLine('OK');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(player.pending.length, 1);

  // 新ワーカー自身の応答で解決する
  children[1].emitLine('OK');
  await next;
});

test('ワーカーの終了で待機処理が失敗し、旧世代の exit は二重処理されない', async () => {
  const { player, children } = createPlayer({ timeoutMs: 5000 });
  const promise = player.play('C:/tmp/a.wav');
  children[0].emit('exit', 1);
  await assert.rejects(promise, /再生ワーカーが終了しました/);
  assert.equal(player.child, null);

  player.start();
  const next = player.play('C:/tmp/b.wav');
  let settled = false;
  next.then(() => { settled = true; }, () => { settled = true; });
  // 旧世代の遅延した exit で新世代の待機処理を壊さない
  children[0].emit('exit', 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(player.child, children[1]);

  children[1].emitLine('OK');
  await next;
});

test('dispose 後は自動再起動しない', async () => {
  const { player, children } = createPlayer({ timeoutMs: 5000 });
  const promise = player.dispose();
  children[0].emitLine('OK');
  await promise;
  assert.equal(children[0].killed, true);
  assert.equal(player.child, null);
  player.start();
  assert.equal(children.length, 1);
});
