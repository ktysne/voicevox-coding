// Logger のファイル出力（非同期ストリーム化・稼働中ローテーション）のテスト。
// 実際のファイルシステムへ書き込むため、テストごとに一時ディレクトリを使う。
// flush の完了を確実に待つため、検証の前には必ず logger.close() を await する。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../src/daemon/logger.js';

const tmpDirs = [];

function tmpLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-logger-'));
  tmpDirs.push(dir);
  return path.join(dir, 'daemon.log');
}

// テストが作った一時ディレクトリを後始末する（反復実行で %TEMP% に残骸を溜めない）
after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** 固定の sleep は低速な環境で不安定になるので、条件の成立を期限付きで待つ。 */
async function waitFor(cond, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: 条件が時間内に成立しませんでした');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('書き込んだ行は close() 後にファイルへ flush されている', async () => {
  const logPath = tmpLogPath();
  const logger = new Logger(() => 'info', { path: logPath });
  logger.info('hello world');
  logger.warn('warn message');
  await logger.close();

  const content = readIfExists(logPath);
  assert.match(content, /hello world/);
  assert.match(content, /warn message/);
});

test('サイズ上限を超えた次の書き込みでローテーションが起きる（.1 は置き換えられる）', async () => {
  const logPath = tmpLogPath();
  // 既に .1 が存在するケースも兼ねる。ローテーションで置き換えられるはず。
  fs.writeFileSync(`${logPath}.1`, '古い退避ログ\n', 'utf8');

  // 1 行 33 + message.length バイト（ts 24 文字 + " [" + level + "] " + message + "\n"）。
  // message を 10 文字にすると 1 行 43 バイトになる。maxBytes=100 なら 2 行(86B)まで耐え、
  // 3 行目(129B)でローテーションが走る。
  const maxBytes = 100;
  const logger = new Logger(() => 'info', { path: logPath, maxBytes });
  const line = 'x'.repeat(10);
  logger.info(line);
  logger.info(line);
  logger.info(line); // ここで 129B > 100B となりローテーションが走り始める(非同期)

  // ローテーションの完了を待たずに、その最中に届いた行も失われないことを確認する
  logger.info('after-rotate-1');
  logger.info('after-rotate-2');

  await logger.close();

  const backup = readIfExists(`${logPath}.1`);
  const main = readIfExists(logPath);

  // 退避されたのは元のログ（.1 は上書きされ、古い退避ログは残っていない）
  assert.doesNotMatch(backup, /古い退避ログ/);
  assert.equal((backup.match(/x{10}/g) ?? []).length, 3);

  // ローテーション後の新しいファイルに、以降の行が入っている
  assert.match(main, /after-rotate-1/);
  assert.match(main, /after-rotate-2/);

  // 「超過は最大 1 行分」: 退避されたファイルのサイズは maxBytes + 最後の 1 行以内
  const lastLineBytes = Buffer.byteLength(`${line}\n`, 'utf8') + 40; // 十分に余裕を持たせた上限
  assert.ok(
    Buffer.byteLength(backup, 'utf8') <= maxBytes + lastLineBytes,
    `退避ファイルが超過しすぎている: ${Buffer.byteLength(backup, 'utf8')} bytes`
  );
  assert.ok(Buffer.byteLength(backup, 'utf8') > maxBytes, '本来ローテーションが必要なサイズになっていない');
});

test('ローテーションを跨いで大量に書いても行が失われない', async () => {
  const logPath = tmpLogPath();
  // 退避世代は .1 の 1 世代しか残らない仕様なので、バースト中に複数回
  // ローテーションが起きると古い世代が正当に上書きされてしまい、この
  // テストの前提（全行が main か .1 のどちらかに揃っている）が崩れる。
  // そのため maxBytes は「バースト中にちょうど 1 回だけ」超える大きさにする。
  // 1 行は固定長（33 + 8 = 41 バイト）にしておき、閾値超過のタイミングを予測可能にする。
  const total = 60;
  const maxBytes = 2000; // 41B/行 * 60行 = 2460B のほぼ中間。1 回だけ超過する
  const logger = new Logger(() => 'info', { path: logPath, maxBytes });

  for (let i = 0; i < total; i++) {
    logger.info(`line-${String(i).padStart(3, '0')}`);
  }
  await logger.close();

  const combined = readIfExists(logPath) + readIfExists(`${logPath}.1`);
  const found = [...combined.matchAll(/line-(\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const expected = Array.from({ length: total }, (_, i) => i);
  assert.deepEqual(found, expected);
});

test('stream のエラー後はメモリのみに落ち、間を置いて開き直すと復旧する', async () => {
  const logPath = tmpLogPath();
  const logger = new Logger(() => 'info', { path: logPath });
  logger.info('before-failure');

  // 書き込み障害を模擬する。ストリームは捨てられ、warn が 1 回だけ残る
  logger.stream.emit('error', new Error('模擬障害'));
  logger.info('during-failure');
  const warns = logger.recent(100).filter((l) => l.message.includes('ログファイルへ書き込めません'));
  assert.equal(warns.length, 1);

  // 開き直しの待ち時間を省略して復旧させる
  logger.reopenAt = 0;
  logger.info('after-recovery');
  // 復旧の通知は fd が実際に開けた 'open' の後に出るので、通知が出るまで待ってから閉じる
  await waitFor(() => !logger.streamFailed);
  await logger.close();

  const content = readIfExists(logPath);
  assert.match(content, /after-recovery/);
  // 障害中の行はファイルには無いが、メモリ側には残っている
  assert.doesNotMatch(content, /during-failure/);
  assert.ok(logger.recent(100).some((l) => l.message === 'during-failure'));
  // 復旧したことも知らせている
  assert.ok(logger.recent(100).some((l) => l.message.includes('書き込みを再開しました')));
});

test('復旧を起こした行がローテーションを跨いでも失われない', async () => {
  const logPath = tmpLogPath();
  const maxBytes = 120;
  const logger = new Logger(() => 'info', { path: logPath, maxBytes });
  logger.info('aaaa');
  logger.stream.emit('error', new Error('模擬障害'));

  // 開き直した直後の書き込みが上限を跨ぎ、ローテーションを誘発するケース。
  // 復旧通知の再入で this.stream が消え、この行が落ちる回帰があった。
  logger.reopenAt = 0;
  logger.info('x'.repeat(100));
  await waitFor(() => fs.existsSync(`${logPath}.1`) && !logger.rotating);
  await logger.close();

  const combined = readIfExists(logPath) + readIfExists(`${logPath}.1`);
  assert.match(combined, /x{100}/);
});

test('logLevel を error に絞ってもログ基盤自身の障害通知は残る', async () => {
  const logPath = tmpLogPath();
  const logger = new Logger(() => 'error', { path: logPath });
  logger.warn('通常の warn は閾値で消える');
  logger.stream.emit('error', new Error('模擬障害'));

  const messages = logger.recent(100).map((l) => l.message);
  assert.ok(!messages.includes('通常の warn は閾値で消える'));
  assert.equal(messages.filter((m) => m.includes('ログファイルへ書き込めません')).length, 1);
  await logger.close();
});

test('ローテーションが固着していても close() は期限内に返る', async () => {
  const logPath = tmpLogPath();
  const logger = new Logger(() => 'info', { path: logPath });
  logger.info('a');
  logger.rotating = true; // ストレージ障害でローテーションが終わらない状況を模擬
  const t0 = Date.now();
  await logger.close();
  // main.js の 2 秒のフォールバック exit より先に返ること
  assert.ok(Date.now() - t0 < 1900, `close() に ${Date.now() - t0}ms かかった`);
});

test('close() は二重に呼んでも例外にならない', async () => {
  const logPath = tmpLogPath();
  const logger = new Logger(() => 'info', { path: logPath });
  logger.info('a');
  await assert.doesNotReject(Promise.all([logger.close(), logger.close()]));
});

test('recent() はメモリ上限（既存挙動）で古い行から切られる', async () => {
  const logPath = tmpLogPath();
  const logger = new Logger(() => 'info', { path: logPath });
  for (let i = 0; i < 450; i++) logger.info(`m${i}`);

  const recent = logger.recent(1000);
  assert.equal(recent.length, 400);
  assert.equal(recent[0].message, 'm50');
  assert.equal(recent[399].message, 'm449');

  await logger.close();
});
