import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Tray } from '../src/daemon/tray.js';

// 実トレイ（PowerShell）は起動できないので、EventEmitter を子プロセスに見立てて
// テストから emit('exit', code) / emit('error', err) を発火させる。
class FakeChild extends EventEmitter {
  kill() {
    this.killed = true;
  }
}

/** spawn の代わりに FakeChild を返し、生成された子プロセスを記録する。 */
function fakeSpawner() {
  const children = [];
  const spawnFn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { children, spawnFn };
}

function createLogger() {
  const messages = [];
  return {
    messages,
    log: {
      info: (m) => messages.push(m),
      warn: (m) => messages.push(m),
      error: (m) => messages.push(m),
      debug: () => {},
    },
  };
}

/** 固定の sleep は低速な環境で不安定になるので、条件の成立を期限付きで待つ。 */
async function waitFor(cond, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: 条件が時間内に成立しませんでした');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('短時間に4回連続で異常終了したら諦める', async () => {
  const { children, spawnFn } = fakeSpawner();
  const { messages, log } = createLogger();
  const tray = new Tray(7591, log, '', { spawnFn, stableMs: 50, restartDelayMs: 5 });

  tray.start();
  assert.equal(children.length, 1);

  // 安定稼働の閾値（50ms）を待たずに立て続けに落として、再起動を使い切らせる
  for (let i = 0; i < 3; i += 1) {
    children.at(-1).emit('exit', 1);
    await waitFor(() => children.length === i + 2);
  }

  children.at(-1).emit('exit', 1);
  // 上限を超えたので、これ以上は再起動されない
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(children.length, 4);
  assert.ok(messages.some((m) => m.includes('諦めました')));
});

test('安定稼働後のクラッシュではカウンタがリセットされる', async () => {
  const { children, spawnFn } = fakeSpawner();
  const { messages, log } = createLogger();
  const tray = new Tray(7591, log, '', { spawnFn, stableMs: 50, restartDelayMs: 5 });

  tray.start();
  for (let i = 0; i < 5; i += 1) {
    // 安定稼働とみなされる時間だけ待ってから落とす
    await new Promise((resolve) => setTimeout(resolve, 60));
    children.at(-1).emit('exit', 1);
    await waitFor(() => children.length === i + 2);
  }

  // 5 回とも安定稼働後のクラッシュなので、諦めずに毎回再起動されている
  assert.equal(children.length, 6);
  assert.ok(!messages.some((m) => m.includes('諦めました')));
});

test('error 経路でも再試行される', async () => {
  const { children, spawnFn } = fakeSpawner();
  const { messages, log } = createLogger();
  const tray = new Tray(7591, log, '', { spawnFn, stableMs: 50, restartDelayMs: 5 });

  tray.start();
  assert.equal(children.length, 1);

  children[0].emit('error', new Error('spawn EACCES'));
  await waitFor(() => children.length === 2);
  assert.ok(messages.some((m) => m.includes('トレイを起動できません')));
  assert.equal(tray.restarts, 1);
});

test('stop() 後はタイマー経由の再起動が起きない', async () => {
  const { children, spawnFn } = fakeSpawner();
  const { log } = createLogger();
  const tray = new Tray(7591, log, '', { spawnFn, stableMs: 50, restartDelayMs: 20 });

  tray.start();
  assert.equal(children.length, 1);

  children[0].emit('exit', 1);
  // 再起動タイマーが仕込まれた直後に停止する
  tray.stop();

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(children.length, 1);
  assert.equal(tray.restartTimer, null);
});

test('exit と error が同一子プロセスで二重発火しても再起動は一度だけ', async () => {
  const { children, spawnFn } = fakeSpawner();
  const { log } = createLogger();
  const tray = new Tray(7591, log, '', { spawnFn, stableMs: 50, restartDelayMs: 5 });

  tray.start();
  const child = children[0];
  child.emit('exit', 1);
  child.emit('error', new Error('二重発火'));

  await waitFor(() => children.length === 2);
  // 二重発火分の余計な再起動がスケジュールされていないことを確認する
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(children.length, 2);
  assert.equal(tray.restarts, 1);
});
