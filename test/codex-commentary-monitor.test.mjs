import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexCommentaryMonitor, extractCommentaryItems, commentaryEnabled } from '../src/daemon/codex-commentary-monitor.js';

test('commentaryEnabled: 既定は有効、Codex ターゲットか Commentary イベントを明示的に無効化したときだけ false', () => {
  assert.equal(commentaryEnabled({}), true);
  assert.equal(commentaryEnabled({ targets: {} }), true);
  assert.equal(commentaryEnabled({ targets: { codex: {} } }), true);
  assert.equal(commentaryEnabled({ targets: { codex: { enabled: true } } }), true);
  assert.equal(commentaryEnabled({ targets: { codex: { enabled: false } } }), false);
  assert.equal(
    commentaryEnabled({ targets: { codex: { enabled: true, events: { Commentary: { enabled: false } } } } }),
    false,
  );
  assert.equal(
    commentaryEnabled({ targets: { codex: { events: { Commentary: { enabled: true } } } } }),
    true,
  );
});

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
      // start() がバックオフを restartDelayMs へ戻すので、注入はコンストラクタで行う
      restartDelayMs: 5,
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
      // start() がバックオフを restartDelayMs へ戻すので、注入はコンストラクタで行う
      restartDelayMs: 5,
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

/** 単一スレッド固定で、その時点の state.items を commentary として返す制御可能な transport。 */
class ControllableThreadTransport extends EventEmitter {
  constructor(state) { super(); this.state = state; }
  start() {}
  notify() {}
  async request(method) {
    if (method === 'initialize') return {};
    if (method === 'thread/list') return { data: [{ id: 'th' }] };
    if (method === 'thread/turns/list') {
      const items = this.state.items.map((id) => ({ id, type: 'agentMessage', phase: 'commentary', text: id }));
      return { data: [{ id: 'turn', items }] };
    }
    return { data: [] };
  }
  dispose() {}
}

test('stop() 後の start() は baseline を取り直し、無効化中に増えた item をまとめて読み上げない', async () => {
  const state = { items: ['A'] };
  const monitor = new CodexCommentaryMonitor({
    pollMs: 5,
    restartDelayMs: 5,
    transportFactory: () => new ControllableThreadTransport(state),
  });
  const received = [];
  monitor.on('commentary', (event) => received.push(event.itemId));

  try {
    // 1 回目の start: A が baseline に入り、読み上げられない。
    monitor.start();
    await waitFor(() => monitor.baselineComplete);
    assert.deepEqual(received, []);

    // baseline 確定後に増えた B は読み上げる。
    state.items = ['A', 'B'];
    await waitFor(() => received.includes('B'));
    assert.deepEqual(received, ['B']);

    // 無効化（stop）している間に C が増える。
    monitor.stop();
    state.items = ['A', 'B', 'C'];

    // 2 回目の start: baseline を取り直すので、既にある C はまとめて読み上げない。
    monitor.start();
    await waitFor(() => monitor.baselineComplete);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(received, ['B']);

    // 新しい baseline 確定後に増えた D は読み上げる。
    state.items = ['A', 'B', 'C', 'D'];
    await waitFor(() => received.includes('D'));
    assert.deepEqual(received, ['B', 'D']);
  } finally {
    monitor.dispose();
  }
});

test('CLI 不在: 3 回連続で失敗したら低頻度の再試行へ切り替え、warn は 1 回だけ出す', async () => {
  const warns = [];
  const log = { warn: (msg) => warns.push(msg), debug: () => {} };
  let factoryCalls = 0;

  class AlwaysFailTransport extends EventEmitter {
    start() {}
    notify() {}
    async request(method) {
      if (method === 'initialize') throw new Error('codex コマンドが見つかりません');
      return { data: [] };
    }
    dispose() {}
  }

  const monitor = new CodexCommentaryMonitor({
    pollMs: 5,
    restartDelayMs: 5,
    slowRetryDelayMs: 80,
    log,
    transportFactory: () => {
      factoryCalls += 1;
      return new AlwaysFailTransport();
    },
  });

  try {
    monitor.start();
    await waitFor(() => monitor.slowRetry);
    const fastCalls = factoryCalls;
    assert.equal(fastCalls, 3);
    // 短い間隔（restartDelayMs=5ms）での再試行は止まっている
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(factoryCalls, fastCalls);
    // ただし恒久停止ではなく、低頻度（slowRetryDelayMs=80ms）では試し続ける
    await waitFor(() => factoryCalls > fastCalls);
    assert.equal(monitor.running, true);
    const slowWarns = warns.filter((m) => m.includes('再試行の間隔を広げます'));
    assert.equal(slowWarns.length, 1);
  } finally {
    monitor.dispose();
  }
});

test('初回走査だけ失敗しても、後続のポーリングで完走すれば接続成功と記録される', async () => {
  const warns = [];
  const log = { warn: (msg) => warns.push(msg), info: () => {}, debug: () => {} };
  let listCalls = 0;

  class FirstScanFailsTransport extends EventEmitter {
    start() {}
    notify() {}
    async request(method) {
      if (method === 'initialize') return {};
      if (method === 'thread/list') {
        listCalls += 1;
        if (listCalls === 1) throw new Error('初回だけ失敗');
        return { data: [] };
      }
      return { data: [] };
    }
    dispose() {}
  }

  const monitor = new CodexCommentaryMonitor({
    pollMs: 5,
    restartDelayMs: 5,
    log,
    transportFactory: () => new FirstScanFailsTransport(),
  });

  try {
    monitor.start();
    // 初回走査は失敗するが、後続のポーリングの走査が完走した時点で接続成功になる。
    // これが無いと、この後の切断 + 失敗 3 回で低頻度モードへ誤って入る。
    await waitFor(() => monitor.everConnected);
    assert.equal(monitor.slowRetry, false);
    assert.equal(monitor.consecutiveFailures, 0);
  } finally {
    monitor.dispose();
  }
});

test('低頻度の再試行中に接続が回復したら通常の監視へ戻る', async () => {
  const warns = [];
  const infos = [];
  const log = { warn: (msg) => warns.push(msg), info: (msg) => infos.push(msg), debug: () => {} };
  let factoryCalls = 0;

  class RecoveringTransport extends EventEmitter {
    constructor(shouldFail) {
      super();
      this.shouldFail = shouldFail;
    }
    start() {}
    notify() {}
    async request(method) {
      if (this.shouldFail && method === 'initialize') throw new Error('まだ起動できない');
      return { data: [] };
    }
    dispose() {}
  }

  const monitor = new CodexCommentaryMonitor({
    pollMs: 5,
    restartDelayMs: 5,
    slowRetryDelayMs: 30,
    log,
    // 最初の 3 回は失敗し、4 回目（低頻度での再試行）から成功する
    transportFactory: () => new RecoveringTransport(++factoryCalls <= 3),
  });

  try {
    monitor.start();
    await waitFor(() => monitor.slowRetry);
    // デーモン起動時にたまたま不調だっただけなら、設定変更なしで自動復旧する
    await waitFor(() => monitor.everConnected);
    assert.equal(monitor.slowRetry, false);
    assert.ok(infos.some((m) => m.includes('接続を回復しました')));
  } finally {
    monitor.dispose();
  }
});

test('一度接続に成功していれば、その後何度切断されても打ち切らずに再接続を続ける', async () => {
  const warns = [];
  const log = { warn: (msg) => warns.push(msg), debug: () => {} };
  let generation = 0;

  class FlakyTransport extends EventEmitter {
    constructor() {
      super();
      this.gen = ++generation;
      // 接続のたびにすぐ切断する（CLI 不在ではなく、app-server 側の一時的な不調を模す）。
      this.closeTimer = setTimeout(() => this.emit('close', new Error('一時切断')), 15);
    }
    start() {}
    notify() {}
    async request(method) {
      if (method === 'initialize') return {};
      return { data: [] };
    }
    dispose() { clearTimeout(this.closeTimer); }
  }

  const monitor = new CodexCommentaryMonitor({
    pollMs: 5,
    restartDelayMs: 5,
    log,
    transportFactory: () => new FlakyTransport(),
  });

  try {
    monitor.start();
    await waitFor(() => monitor.everConnected);
    // everConnected になった後、切替閾値（3 回）を超えて短い間隔の再接続が続くことを確認する。
    await waitFor(() => generation >= 6);

    assert.equal(monitor.running, true);
    assert.equal(monitor.slowRetry, false);
    const slowWarns = warns.filter((m) => m.includes('再試行の間隔を広げます'));
    assert.equal(slowWarns.length, 0);
  } finally {
    monitor.dispose();
  }
});
