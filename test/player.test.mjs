import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Player, appendWavSilence } from '../src/daemon/player.js';

/**
 * テスト用の最小 WAV (PCM) を組み立てる。data の後ろへ extraChunk を続けると、
 * appendWavSilence が「data の後ろに別チャンクが続く」形として弾く対象になる。
 * 元データは 0xAA で埋め、継ぎ足した無音 (0 または 0x80) と見分けられるようにする。
 */
function buildWav({
  dataSize = 4,
  byteRate = 48000,
  blockAlign = 2,
  bitsPerSample = 16,
  sampleRate = 24000,
  channels = 1,
  extraChunk = null,
} = {}) {
  const dataPad = dataSize % 2;
  const tail = dataPad + (extraChunk ? 8 + extraChunk.size + (extraChunk.size % 2) : 0);
  const buf = Buffer.alloc(44 + dataSize + tail);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // AudioFormat = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  buf.fill(0xaa, 44, 44 + dataSize);
  if (extraChunk) {
    const extraOffset = 44 + dataSize + dataPad;
    buf.write(extraChunk.id, extraOffset, 'ascii');
    buf.writeUInt32LE(extraChunk.size, extraOffset + 4);
  }
  buf.writeUInt32LE(buf.length - 8, 4);
  return buf;
}

test('appendWavSilence は無音を末尾へ継ぎ足し、data と RIFF のサイズを書き直す', () => {
  const buf = buildWav({ dataSize: 4, byteRate: 48000, blockAlign: 2, bitsPerSample: 16 });
  const out = appendWavSilence(buf, 100);
  assert.ok(out);
  // 100ms 分 = 48000 * 0.1 = 4800 バイト（blockAlign=2 の倍数なのでそのまま入る）
  assert.equal(out.length, buf.length + 4800);
  assert.equal(out.readUInt32LE(40), 4 + 4800); // data チャンクのサイズ
  assert.equal(out.readUInt32LE(4), out.length - 8); // RIFF のサイズ
  assert.deepEqual(out.subarray(44, 48), buf.subarray(44, 48)); // 元データはそのまま残る
  assert.ok(out.subarray(48, 48 + 4800).every((b) => b === 0)); // 継ぎ足しは 16bit なので 0 埋め
  assert.equal(buf.length, 48); // 元の buf は書き換えない
});

test('appendWavSilence は 8bit PCM の無音を 0x80 で埋める', () => {
  const buf = buildWav({ dataSize: 4, byteRate: 24000, blockAlign: 1, bitsPerSample: 8 });
  const out = appendWavSilence(buf, 100);
  assert.ok(out);
  assert.ok(out.subarray(48).every((b) => b === 0x80));
});

test('appendWavSilence は奇数長の 8bit PCM で旧パディングを捨てて新しいパディングを付ける', () => {
  const buf = buildWav({ dataSize: 3, byteRate: 2000, blockAlign: 1, bitsPerSample: 8 });
  buf[47] = 0x55; // 旧 data パディングを無音としてコピーしないことを確認する
  const out = appendWavSilence(buf, 1); // 2 バイトを継ぎ足し、data サイズを 5 にする
  assert.ok(out);
  assert.deepEqual(out.subarray(44, 47), Buffer.from([0xaa, 0xaa, 0xaa]));
  assert.deepEqual(out.subarray(47, 49), Buffer.from([0x80, 0x80]));
  assert.equal(out[49], 0); // 奇数になった data の末尾に RIFF パディングを付ける
  assert.equal(out.readUInt32LE(40), 5);
  assert.equal(out.readUInt32LE(4), 42);
  assert.equal(out.length, 50);
});

test('appendWavSilence は data の後ろに別チャンクが続く WAV では null を返す', () => {
  const buf = buildWav({ dataSize: 2, extraChunk: { id: 'JUNK', size: 0 } });
  assert.equal(appendWavSilence(buf, 100), null);
});

test('appendWavSilence は RIFF として読めないデータでは null を返す', () => {
  assert.equal(appendWavSilence(Buffer.from('not a wav'), 100), null);
});

test('appendWavSilence は silenceMs が正の有限数でなければ null を返す', () => {
  const buf = buildWav();
  assert.equal(appendWavSilence(buf, 0), null);
  assert.equal(appendWavSilence(buf, -10), null);
  assert.equal(appendWavSilence(buf, NaN), null);
  assert.equal(appendWavSilence(buf, Infinity), null);
});

test('appendWavSilence は byteRate や blockAlign が壊れていれば null を返す', () => {
  assert.equal(appendWavSilence(buildWav({ byteRate: 0 }), 100), null);
  assert.equal(appendWavSilence(buildWav({ blockAlign: 0 }), 100), null);
});

test('appendWavSilence は切り下げると 0 バイトになる短い無音では null を返す', () => {
  // rawBytes = round(byteRate * silenceMs / 1000) が blockAlign 未満なら切り下げで 0 になる
  const buf = buildWav({ byteRate: 100, blockAlign: 100 });
  assert.equal(appendWavSilence(buf, 1), null);
});

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
