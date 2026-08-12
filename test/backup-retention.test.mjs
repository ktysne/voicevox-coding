// install.ps1 のバックアップ処理（Backup-File / Remove-OldBackups）のテスト。
// 世代削除は破壊的な処理なので、実際に pwsh で実行して確かめる。
// install.ps1 は読み込むと main の処理が走るため dot-source はできず、
// 関数定義をテキストとして抽出して一時スクリプトに組み立てる。
// （uninstall.ps1 の Remove-OldBackups は同一ロジックの複製なので install 側で代表する）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_PS1 = path.join(ROOT, 'scripts', 'install.ps1');

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

/** install.ps1 から関数定義を抽出する（関数はカラム 0 の `}` で終わる流儀に依存）。 */
function extractFunction(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`function ${name}`));
  assert.notEqual(start, -1, `install.ps1 に function ${name} が見つからない`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.notEqual(end, -1, `function ${name} の終端が見つからない`);
  return lines.slice(start, end + 1).join('\n');
}

const pwshOk = (() => {
  try {
    return spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
})();

/** 抽出した関数 + 検証本体を一時 .ps1 に書いて pwsh で実行する。 */
function runHarness(harnessBody) {
  const source = fs.readFileSync(INSTALL_PS1, 'utf8');
  const functions = [
    extractFunction(source, 'Backup-File'),
    extractFunction(source, 'Remove-OldBackups'),
  ].join('\n\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-bak-'));
  tmpDirs.push(dir);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Remove-OldBackups が参照する表示関数のスタブ
    'function Write-Warn2($msg) { Write-Host "warn: $msg" }',
    functions,
    `$WORK = '${dir.replace(/'/g, "''")}'`,
    harnessBody,
  ].join('\n');
  const scriptPath = path.join(dir, 'harness.ps1');
  fs.writeFileSync(scriptPath, `﻿${script}`, 'utf8');
  const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, `pwsh が失敗した: ${r.stderr}`);
  return { dir, stdout: r.stdout };
}

function listNames(dir) {
  return fs.readdirSync(dir).filter((f) => f !== 'harness.ps1').sort();
}

test('世代整理は厳密一致する古い世代だけを消し、似た名前は巻き込まない', { skip: !pwshOk }, () => {
  const { dir } = runHarness(`
$target = Join-Path $WORK 'settings.json'
Set-Content -LiteralPath $target -Value '{}'
foreach ($d in 1..8) {
  Set-Content -LiteralPath (Join-Path $WORK ("settings.json.bak-2026010" + $d + "-000000")) -Value 'old'
}
Set-Content -LiteralPath (Join-Path $WORK 'settings.json.bak-20260101-000000-extra') -Value 'decoy'
Set-Content -LiteralPath (Join-Path $WORK 'settings.json.backup-20260101-000000') -Value 'decoy'
Set-Content -LiteralPath (Join-Path $WORK 'other.json.bak-20260101-000000') -Value 'decoy'
Remove-OldBackups $target
`);
  const names = listNames(dir);
  // 新しい 5 世代（04〜08）は残る
  for (const d of [4, 5, 6, 7, 8]) {
    assert.ok(names.includes(`settings.json.bak-2026010${d}-000000`), `2026010${d} が消えている`);
  }
  // 古い 3 世代（01〜03）は消える
  for (const d of [1, 2, 3]) {
    assert.ok(!names.includes(`settings.json.bak-2026010${d}-000000`), `2026010${d} が残っている`);
  }
  // 紛らわしい名前のファイルは一切巻き込まない
  assert.ok(names.includes('settings.json.bak-20260101-000000-extra'));
  assert.ok(names.includes('settings.json.backup-20260101-000000'));
  assert.ok(names.includes('other.json.bak-20260101-000000'));
});

test('世代が 5 件以下なら何も削除しない', { skip: !pwshOk }, () => {
  const { dir } = runHarness(`
$target = Join-Path $WORK 'settings.json'
Set-Content -LiteralPath $target -Value '{}'
foreach ($d in 1..3) {
  Set-Content -LiteralPath (Join-Path $WORK ("settings.json.bak-2026010" + $d + "-000000")) -Value 'old'
}
Remove-OldBackups $target
`);
  const names = listNames(dir);
  for (const d of [1, 2, 3]) {
    assert.ok(names.includes(`settings.json.bak-2026010${d}-000000`));
  }
});

test('同一秒の枝番が二桁になっても、数値順で新しい 5 世代が残る', { skip: !pwshOk }, () => {
  const { dir } = runHarness(`
$target = Join-Path $WORK 'settings.json'
Set-Content -LiteralPath $target -Value '{}'
# 同一秒に 12 世代（無印 = 1 番目、-2 〜 -12）。文字列降順だと -9 が -10 より
# 新しい扱いになり、本来最新の -10 〜 -12 が消えてしまう
Set-Content -LiteralPath (Join-Path $WORK 'settings.json.bak-20260101-000000') -Value 'g1'
foreach ($n in 2..12) {
  Set-Content -LiteralPath (Join-Path $WORK ("settings.json.bak-20260101-000000-" + $n)) -Value ("g" + $n)
}
Remove-OldBackups $target
`);
  const names = listNames(dir);
  // 数値順で新しい 5 世代（-8 〜 -12）が残る
  for (const n of [8, 9, 10, 11, 12]) {
    assert.ok(names.includes(`settings.json.bak-20260101-000000-${n}`), `-${n} が消えている`);
  }
  // 古い側（無印と -2 〜 -7）は消える
  assert.ok(!names.includes('settings.json.bak-20260101-000000'), '無印が残っている');
  for (const n of [2, 3, 4, 5, 6, 7]) {
    assert.ok(!names.includes(`settings.json.bak-20260101-000000-${n}`), `-${n} が残っている`);
  }
});

test('同一秒のバックアップは上書きせず一意化され、一意化された世代も整理対象になる', { skip: !pwshOk }, () => {
  const { dir, stdout } = runHarness(`
$target = Join-Path $WORK 'hooks.json'
Set-Content -LiteralPath $target -Value 'v1'
$b1 = Backup-File $target
Set-Content -LiteralPath $target -Value 'v2'
$b2 = Backup-File $target
Write-Output "B1=$(Split-Path -Leaf $b1)"
Write-Output "B2=$(Split-Path -Leaf $b2)"
`);
  const b1 = stdout.match(/B1=(.+)/)?.[1]?.trim();
  const b2 = stdout.match(/B2=(.+)/)?.[1]?.trim();
  assert.ok(b1 && b2, `バックアップ名を取得できない: ${stdout}`);
  assert.notEqual(b1, b2, '同一秒の 2 回目が同じ名前になっている（上書きで世代が失われる）');
  const names = listNames(dir);
  assert.ok(names.includes(b1));
  assert.ok(names.includes(b2));
  // 両方とも世代整理の対象パターンに一致する（-N の一意化を含む）
  const pattern = /^hooks\.json\.bak-\d{8}-\d{6}(-\d+)?$/;
  assert.match(b1, pattern);
  assert.match(b2, pattern);
  // 中身はそれぞれの時点のもの
  assert.equal(fs.readFileSync(path.join(dir, b1), 'utf8').trim(), 'v1');
  assert.equal(fs.readFileSync(path.join(dir, b2), 'utf8').trim(), 'v2');
});
