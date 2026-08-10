// tray-worker.ps1 の不変条件を静的に固定する回帰テスト (#35)。
//
// トレイは PowerShell なので node --test では実行できない。代わりに、
// 「失敗が誰にも見えないまま消える」構造に戻っていないことをソースの形で確かめる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trayPs1 = path.join(repoRoot, 'src', 'tray', 'tray-worker.ps1');
const source = fs.readFileSync(trayPs1, 'utf8');

// Invoke-Daemon の呼び出し 1 件を、行番号付きで拾う。
function invokeDaemonCalls() {
  return source
    .split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, text }))
    .filter((row) => row.text.includes('Invoke-Daemon ') && !row.text.trimStart().startsWith('#'));
}

test('ユーザー操作起点の Invoke-Daemon 呼び出しは失敗を通知する (-Action を伴う)', () => {
  // 状態変更 API はすべてメニュー操作から呼ばれる。失敗を黙って捨てると
  // #31 の 415 のように不具合が長く気づかれない。
  const missing = invokeDaemonCalls()
    .filter((row) => /'POST'/.test(row.text) && !/-Action\b/.test(row.text))
    .map((row) => `${row.line}: ${row.text.trim()}`);

  assert.deepEqual(
    missing,
    [],
    '-Action の無い POST 呼び出しがある。失敗が stderr にもデーモンのログにも残らなくなる:\n' +
      missing.join('\n'),
  );
});

test('2 秒ごとのポーリングは失敗を通知しない (-Action を伴わない)', () => {
  // デーモン停止中は毎回失敗するので、通知するとログが埋まる。
  const noisy = invokeDaemonCalls()
    .filter((row) => row.text.includes("'/api/state'") && /-Action\b/.test(row.text))
    .map((row) => `${row.line}: ${row.text.trim()}`);

  assert.deepEqual(
    noisy,
    [],
    `ポーリングに -Action が付いている。デーモン停止中に警告ログが鳴り続ける:\n${noisy.join('\n')}`,
  );
});

test('「終了」は停止 API の結果を確かめてから Stop-Tray する', () => {
  const handler = source.match(/\$miExit\.Add_Click\(\{([\s\S]*?)\n\}\)/);
  assert.ok(handler, '$miExit.Add_Click のハンドラが見つからない');
  const body = handler[1];

  // 停止 API を呼んだ直後に無条件で Stop-Tray してはいけない。
  // 畳んでよいのは「受理された」か「デーモンがもう応答しない」と分かったときだけ (#35)。
  assert.ok(
    !/\/api\/shutdown[^\n]*\n\s*Stop-Tray/.test(body),
    '停止 API の成否を確かめずに Stop-Tray している。失敗するとトレイだけ消えて停止手段が失われる',
  );
  assert.match(body, /ShowBalloonTip/, '停止に失敗したことを利用者へ知らせる通知が無い');
});
