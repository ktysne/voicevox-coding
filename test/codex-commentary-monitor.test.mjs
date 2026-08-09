import test from 'node:test';
import assert from 'node:assert/strict';
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
