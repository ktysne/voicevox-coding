import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexCommentaryMonitor, extractCommentaryItems } from '../src/daemon/codex-commentary-monitor.js';

test('agentMessage の commentary かつ空でない本文だけを抽出する', () => {
  assert.deepEqual(extractCommentaryItems({ items: [
    { id: 'a', type: 'agentMessage', phase: 'commentary', text: ' 進行中 ' },
    { id: 'b', type: 'agentMessage', phase: 'final_answer', text: '完了' },
    { id: 'c', type: 'toolCall', phase: 'commentary', text: 'tool' },
    { id: 'd', type: 'agentMessage', phase: 'commentary', text: '  ' },
  ] }), [{ itemId: 'a', message: '進行中' }]);
});

class FakeTransport {
  constructor(scans) { this.scans = scans; this.index = 0; }
  async request(method, params) {
    const scan = this.scans[Math.min(this.index, this.scans.length - 1)];
    if (method === 'thread/list') return { data: scan.map((x) => ({ id: x.threadId })) };
    const found = scan.find((x) => x.threadId === params.threadId);
    if (params.threadId === scan.at(-1)?.threadId) this.index++;
    return { data: [{ id: found.turnId, items: found.items }] };
  }
}

test('初回は seed のみ、既知 item は重複通知せず、新規 thread の最新 commentary は通知する', async () => {
  const transport = new FakeTransport([
    [{ threadId: 'old', turnId: 't1', items: [{ id: 'i1', type: 'agentMessage', phase: 'commentary', text: '過去' }] }],
    [
      { threadId: 'old', turnId: 't2', items: [{ id: 'i2', type: 'agentMessage', phase: 'commentary', text: '新着' }] },
      { threadId: 'new', turnId: 't3', items: [{ id: 'i3', type: 'agentMessage', phase: 'commentary', text: '新規スレッド' }] },
    ],
    [
      { threadId: 'old', turnId: 't2', items: [{ id: 'i2', type: 'agentMessage', phase: 'commentary', text: '新着' }] },
      { threadId: 'new', turnId: 't3', items: [{ id: 'i3', type: 'agentMessage', phase: 'commentary', text: '新規スレッド' }] },
    ],
  ]);
  const monitor = new CodexCommentaryMonitor({ transportFactory: () => transport });
  monitor.transport = transport;
  const received = [];
  monitor.on('commentary', (event) => received.push(event));
  await monitor.scan();
  assert.deepEqual(received, []);
  await monitor.scan();
  assert.deepEqual(received, [
    { itemId: 'i2', message: '新着', threadId: 'old', turnId: 't2' },
    { itemId: 'i3', message: '新規スレッド', threadId: 'new', turnId: 't3' },
  ]);
  await monitor.scan();
  assert.equal(received.length, 2);
});

/** setInterval を監視し、生成数と未解除の本数を数える。 */
function trackIntervals() {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const active = new Set();
  let created = 0;
  globalThis.setInterval = (...args) => {
    const handle = originalSet(...args);
    created += 1;
    active.add(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    active.delete(handle);
    return originalClear(handle);
  };
  return {
    get created() { return created; },
    get active() { return active.size; },
    restore() {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    },
  };
}

/** 条件が満たされるまで短い間隔で待つ。 */
async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('条件が満たされませんでした');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 接続と切断を制御できる app-server transport の代役。 */
class FakeConnectionTransport extends EventEmitter {
  constructor({ onThreadList } = {}) {
    super();
    this.onThreadList = onThreadList;
    this.started = false;
    this.disposed = false;
    this.scanCount = 0;
    this.calls = [];
  }
  start() { this.started = true; }
  notify() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'thread/list') {
      this.scanCount += 1;
      // onThreadList が応答を返した場合はそれを使う（切断後に解決する応答の再現用）。
      const response = await this.onThreadList?.(this);
      return response ?? { data: [] };
    }
    return { data: [] };
  }
  dispose() { this.disposed = true; }
}

test('初回走査中に切断しても再接続後のポーリングタイマーは一本だけになる', async () => {
  const timers = trackIntervals();
  try {
    const transports = [];
    const monitor = new CodexCommentaryMonitor({
      pollMs: 10,
      transportFactory: () => {
        // 一本目だけ、初回走査の最中に切断を発火させる。
        const first = transports.length === 0;
        const transport = new FakeConnectionTransport({
          onThreadList: first ? (self) => self.emit('close', new Error('切断されました')) : undefined,
        });
        transports.push(transport);
        return transport;
      },
    });
    monitor.backoffMs = 5;
    monitor.start();

    await waitFor(() => transports.length === 2 && timers.active > 0);
    // 一本目の世代はタイマーを作らず、二本目の世代だけがポーリングする。
    assert.equal(timers.created, 1);
    assert.equal(timers.active, 1);
    assert.equal(monitor.transport, transports[1]);

    const before = transports[0].scanCount;
    await waitFor(() => transports[1].scanCount >= 2);
    assert.equal(transports[0].scanCount, before);

    monitor.dispose();
    assert.equal(timers.active, 0);
    assert.equal(monitor.timer, null);
  } finally {
    timers.restore();
  }
});

test('切断後に古い走査が完了しても、その結果を新しい接続へ持ち込まない', async () => {
  const timers = trackIntervals();
  try {
    let releaseStale = null;
    const transports = [];
    const monitor = new CodexCommentaryMonitor({
      pollMs: 10,
      transportFactory: () => {
        const first = transports.length === 0;
        const transport = new FakeConnectionTransport({
          // 一本目は切断を発火したうえで、応答だけを遅れて返す。
          onThreadList: first
            ? (self) => {
                self.emit('close', new Error('切断されました'));
                return new Promise((resolve) => {
                  releaseStale = () => resolve({ data: [{ id: 'stale' }] });
                });
              }
            : undefined,
        });
        transports.push(transport);
        return transport;
      },
    });
    monitor.backoffMs = 5;
    monitor.start();

    await waitFor(() => transports.length === 2 && releaseStale !== null);
    releaseStale();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 古い世代の thread/list 結果で thread/turns/list を呼ばない。
    const turnCalls = transports.flatMap((t) => t.calls.filter((c) => c.method === 'thread/turns/list'));
    assert.deepEqual(turnCalls, []);
    assert.equal(timers.active, 1);

    monitor.dispose();
    assert.equal(timers.active, 0);
  } finally {
    timers.restore();
  }
});

test('dispose() 後は再接続もポーリングも起こらない', async () => {
  const timers = trackIntervals();
  try {
    const transports = [];
    const monitor = new CodexCommentaryMonitor({
      pollMs: 10,
      transportFactory: () => {
        const transport = new FakeConnectionTransport();
        transports.push(transport);
        return transport;
      },
    });
    monitor.start();
    await waitFor(() => timers.active === 1);

    monitor.dispose();
    assert.equal(timers.active, 0);
    assert.equal(transports[0].disposed, true);

    // 切断が遅れて届いても、停止後は再接続を予約しない。
    transports[0].emit('close', new Error('停止後の切断'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(transports.length, 1);
    assert.equal(timers.active, 0);
  } finally {
    timers.restore();
  }
});
