import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import net from 'node:net';
import { CallerVerifier } from '../src/daemon/caller-check.js';

const SID = 'S-1-5-21-123';
const socket = () => ({ remoteFamily: 'IPv4', remoteAddress: '127.0.0.1', remotePort: 12345 });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t, options = {}) {
  const children = [];
  const warnings = [];
  const verifier = new CallerVerifier({ warn: (message) => warnings.push(message) }, {
    timeoutMs: 200, restartDelayMs: 1, ...options,
    spawnFn(command, args, spawnOptions) {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
      assert.ok(args[5].endsWith('caller-worker.ps1'));
      assert.equal(spawnOptions.windowsHide, true);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), commands: [], killed: false });
      child.stdin = new Writable({ write(chunk, encoding, done) { child.commands.push(chunk.toString()); done(); } });
      child.kill = () => { child.killed = true; };
      child.line = (line) => child.stdout.write(`${line}\n`);
      children.push(child);
      return child;
    },
  });
  t.after(() => verifier.dispose());
  return { verifier, children, warnings };
}

test('READY を待って分割行を組み立て、id ごとに逆順の応答を照合する', async (t) => {
  const { verifier, children } = fixture(t);
  verifier.start();
  const child = children[0];
  const a = verifier.verifySocket(socket(), 7591);
  const b = verifier.verifySocket(socket(), 7591);
  assert.equal(child.commands.length, 0);
  child.stdout.write(`REA`);
  child.stdout.write(`DY ${SID}\r\n`);
  assert.deepEqual(child.commands, ['1 12345 7591\n', '2 12345 7591\n']);
  child.line('999 OK S-1-5-21-123');
  child.line('2 OK S-1-5-21-999');
  child.line(`1 OK ${SID}`);
  assert.equal((await a).sameUser, true);
  assert.equal((await b).sameUser, false);
});

test('SID の一致、不一致、ERR はソケット単位でキャッシュする', async (t) => {
  const { verifier, children } = fixture(t);
  verifier.start();
  const child = children[0];
  child.line(`READY ${SID}`);
  for (const [index, response] of [`OK ${SID}`, 'OK S-1-5-21-999', 'ERR process'].entries()) {
    const connection = socket();
    const pending = verifier.verifySocket(connection, 7591);
    child.line(`${index + 1} ${response}`);
    const result = await pending;
    assert.equal(result.sameUser, index === 0);
    assert.deepEqual(await verifier.verifySocket(connection, 7591), result);
  }
  assert.equal(child.commands.length, 3);
});

test('未起動の結果をキャッシュせず、起動後には同じソケットを確認する', async (t) => {
  const { verifier, children, warnings } = fixture(t);
  const connection = socket();
  assert.equal((await verifier.verifySocket(connection, 7591)).sameUser, false);
  assert.equal((await verifier.verifySocket(connection, 7591)).sameUser, false);
  verifier.start();
  children[0].line(`READY ${SID}`);
  const pending = verifier.verifySocket(connection, 7591);
  children[0].line(`1 OK ${SID}`);
  assert.equal((await pending).sameUser, true);
  assert.equal(warnings.length, 1);
});

test('応答待ち上限で世代を破棄し、旧世代の遅延応答を後続要求に混ぜない', async (t) => {
  const { verifier, children, warnings } = fixture(t, { timeoutMs: 30 });
  verifier.start();
  const old = children[0];
  old.line(`READY ${SID}`);
  const connection = socket();
  const result = await verifier.verifySocket(connection, 7591);
  assert.equal(result.sameUser, false);
  assert.match(result.reason, /上限/);
  assert.equal(old.killed, true);
  await delay(5);
  const child = children[1];
  child.line(`READY ${SID}`);
  const pending = verifier.verifySocket(connection, 7591);
  old.line(`2 OK ${SID}`);
  child.line(`1 OK ${SID}`);
  child.line('2 ERR process');
  assert.deepEqual(await pending, { sameUser: false, reason: 'process' });
  assert.equal(warnings.length, 1);
});

test('READY 待ちにも上限があり、終了・起動失敗時の結果はキャッシュしない', async (t) => {
  const { verifier, children, warnings } = fixture(t, { timeoutMs: 30, startTimeoutMs: 30 });
  verifier.start();
  const connection = socket();
  assert.equal((await verifier.verifySocket(connection, 7591)).sameUser, false);
  await delay(5);
  const pending = verifier.verifySocket(connection, 7591);
  children[1].emit('exit', 1);
  assert.equal((await pending).sameUser, false);
  await delay(5);
  children[2].emit('error', new Error('spawn failed'));
  await delay(5);
  children[3].line(`READY ${SID}`);
  const retry = verifier.verifySocket(connection, 7591);
  const id = children[3].commands[0].split(' ')[0];
  children[3].line(`${id} OK ${SID}`);
  assert.equal((await retry).sameUser, true);
  assert.equal(warnings.length, 1);
});

test('応答待ちの上限より遅く、起動待ちの上限より早く READY が届けば確認できる', async (t) => {
  const { verifier, children } = fixture(t, { timeoutMs: 20, startTimeoutMs: 500 });
  verifier.start();
  const pending = verifier.verifySocket(socket(), 7591);
  await delay(60);
  children[0].line(`READY ${SID}`);
  const id = children[0].commands[0].split(' ')[0];
  children[0].line(`${id} OK ${SID}`);
  assert.equal((await pending).sameUser, true);
  assert.equal(children.length, 1);
});

test('同期的な起動失敗の再起動回数を制限し、警告は一度だけ出す', async () => {
  let starts = 0;
  const warnings = [];
  const verifier = new CallerVerifier({ warn: (message) => warnings.push(message) }, {
    spawnFn() { starts++; throw new Error('spawn'); }, restartDelayMs: 1, maxRestarts: 2,
  });
  try {
    verifier.start();
    await delay(30);
    assert.equal(starts, 3);
    assert.equal(warnings.length, 1);
    assert.equal((await verifier.verifySocket(socket(), 7591)).sameUser, false);
  } finally { verifier.dispose(); }
});

test('IPv4 の 127.0.0.1 以外には問い合わせない', async (t) => {
  const { verifier, children } = fixture(t);
  verifier.start();
  children[0].line(`READY ${SID}`);
  for (const connection of [
    { ...socket(), remoteFamily: 'IPv6', remoteAddress: '::1' },
    { ...socket(), remoteAddress: '192.168.1.1' },
    { ...socket(), remoteAddress: '127.0.0.2' },
    { ...socket(), remoteFamily: 'IPv6', remoteAddress: '::ffff:127.0.0.1' },
  ]) assert.equal((await verifier.verifySocket(connection, 7591)).sameUser, false);
  assert.equal(children[0].commands.length, 0);
});

test('dispose は待機を解決して stdin を閉じ、再起動しない', async (t) => {
  const { verifier, children } = fixture(t);
  verifier.start();
  const pending = verifier.verifySocket(socket(), 7591);
  verifier.dispose();
  assert.equal((await pending).sameUser, false);
  assert.equal(children[0].stdin.writableEnded, true);
  children[0].emit('exit', 0);
  verifier.start();
  await delay(5);
  assert.equal(children.length, 1);
});

test('Windows の本物のワーカーで同じプロセスの接続を確認する', { skip: process.platform !== 'win32' }, async (t) => {
  const warnings = [];
  const verifier = new CallerVerifier({ warn: (message) => warnings.push(message) }, { timeoutMs: 10000, maxRestarts: 0 });
  const server = net.createServer();
  t.after(() => { verifier.dispose(); server.close(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const client = net.connect(server.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  const connection = await accepted;
  t.after(() => connection.destroy());
  verifier.start();
  const result = await verifier.verifySocket(connection, server.address().port);
  assert.equal(result.sameUser, true, `${result.reason ?? ''} ${warnings.join('; ')}`);
});
