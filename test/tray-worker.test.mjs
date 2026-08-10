// tray-worker.ps1 の不変条件を静的に固定する回帰テスト (#35)。
//
// トレイは PowerShell なので node --test では実行できない。代わりに、
// 「失敗が誰にも見えないまま消える」「デーモンが生きているのにトレイだけ消える」
// という #31 / #35 の構造に戻っていないことを、ソースの形で確かめる。

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

function exitHandlerBody() {
  // 閉じ括弧のインデントに依存しないよう \s* を挟む。
  const m = source.match(/\$miExit\.Add_Click\(\{([\s\S]*?)\n\s*\}\)/);
  assert.ok(m, '$miExit.Add_Click のハンドラが見つからない。抽出の正規表現が古い可能性がある');
  return m[1];
}

test('Invoke-Daemon は未知のパラメータを黙って捨てない', () => {
  // 簡易関数のままだと、綴り違いの -Action がエラーにならず $args に落ちて消える。
  // 呼び出し側の見た目は正しいまま通知だけが失われ、以下のテストも緑のまま通ってしまう。
  assert.match(
    source,
    /function Invoke-Daemon\s*\{\s*\r?\n\s*\[CmdletBinding\(\)\]/,
    'Invoke-Daemon に [CmdletBinding()] が無い',
  );
  for (const name of ['$Action', '$Ok']) {
    assert.ok(
      new RegExp(`^\\s*(\\[[^\\]]+\\])?\\s*\\${name}\\b`, 'm').test(source),
      `param() に ${name} が無い。呼び出し側の -${name.slice(1)} が黙って無視される`,
    );
  }
});

test('ユーザー操作起点の Invoke-Daemon 呼び出しは失敗を通知する (-Action を伴う)', () => {
  // 状態変更 API はすべてメニュー操作から呼ばれる。失敗を黙って捨てると
  // #31 の 415 のように不具合が長く気づかれない。
  const posts = invokeDaemonCalls().filter((row) => /'POST'/.test(row.text));

  // 抽出が空振りして「検査が消えた」ことに気づけるよう、件数の下限を先に固定する。
  assert.ok(
    posts.length >= 5,
    `POST 呼び出しの抽出が ${posts.length} 件しか無い。抽出条件が実装とずれている可能性がある`,
  );

  // -Action '' や -Action $null では通知が出ないので、値が空でないことまで見る。
  const missing = posts
    .filter((row) => !/-Action\s+(?:'[^']+'|\$\w+)/.test(row.text))
    .map((row) => `${row.line}: ${row.text.trim()}`);

  assert.deepEqual(
    missing,
    [],
    `-Action の無い POST 呼び出しがある。失敗が stderr にもデーモンのログにも残らない:\n${missing.join('\n')}`,
  );
});

test('2 秒ごとのポーリングは失敗を通知しない (-Action を伴わない)', () => {
  // デーモン停止中は毎回失敗するので、通知するとログが埋まる。
  const polls = invokeDaemonCalls().filter((row) => row.text.includes("'/api/state'"));
  assert.equal(polls.length, 1, 'ポーリング呼び出しの抽出結果が想定と違う');

  assert.ok(
    !/-Action\b/.test(polls[0].text),
    'ポーリングに -Action が付いている。デーモン停止中に警告ログが鳴り続ける',
  );
});

test('「終了」は停止 API の結果を確かめてから Stop-Tray する', () => {
  const body = exitHandlerBody();

  assert.match(
    body,
    /'\/api\/shutdown'[^\n]*-Ok\s+\(\[ref\]/,
    '停止 API の呼び出しが成否を受け取っていない',
  );

  // 無条件の Stop-Tray が 1 つでもあれば、失敗時にトレイだけ消えて停止手段が失われる。
  const unguarded = body
    .split(/\r?\n/)
    .filter((line) => /\bStop-Tray\b/.test(line) && !line.trimStart().startsWith('#'))
    .filter((line) => !line.includes('if ('));

  assert.deepEqual(
    unguarded,
    [],
    `条件の付かない Stop-Tray がある。停止に失敗してもトレイだけ消えてしまう:\n${unguarded.join('\n')}`,
  );

  assert.match(body, /ShowBalloonTip/, '停止に失敗したことを利用者へ知らせる通知が無い');
});
