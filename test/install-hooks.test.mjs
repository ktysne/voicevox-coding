// install.ps1 のフック解除（Remove-OurHook / Remove-AllOurHooks）と
// update.ps1 の manifest 検証（Read-InstallManifest）のテスト。
// いずれも破壊的または構成を左右する処理なので、実際に pwsh で実行して確かめる。
// スクリプト本体は読み込むと main が走るため dot-source できず、
// backup-retention.test.mjs と同じ方式で関数定義をテキストとして抽出する。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

/** スクリプトから関数定義を抽出する（関数はカラム 0 の `}` で終わる流儀に依存）。 */
function extractFunction(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`function ${name}`));
  assert.notEqual(start, -1, `function ${name} が見つからない`);
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

function runHarness(scriptFile, functionNames, harnessBody) {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', scriptFile), 'utf8');
  const functions = functionNames.map((n) => extractFunction(source, n)).join('\n\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-hooks-'));
  tmpDirs.push(dir);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'function Write-Ok($msg)    { Write-Host "ok: $msg" }',
    'function Write-Warn2($msg) { Write-Host "warn: $msg" }',
    `$WORK = '${dir.replace(/'/g, "''")}'`,
    // Remove-AllOurHooks / Test-OurHookCommand が参照する配置先パス
    "$HookScript = Join-Path $WORK 'hook-client.js'",
    functions,
    harnessBody,
  ].join('\n');
  const scriptPath = path.join(dir, 'harness.ps1');
  fs.writeFileSync(scriptPath, `﻿${script}`, 'utf8');
  const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, `pwsh が失敗した: ${r.stderr}`);
  return { dir, stdout: r.stdout };
}

// 我々のフックと他製品のフック（similar な名前を含む）が混在する設定を
// PowerShell 側で組み立てるスニペット。$WORK / $HookScript を前提にする。
const BUILD_SAMPLE = `
$target = Join-Path $WORK 'settings.json'
$ours = 'node "' + $HookScript + '" claudeCode'
$root = [ordered]@{
  hooks = [ordered]@{
    Stop = @(
      @{ hooks = @(@{ type = 'command'; command = $ours }) },
      @{ hooks = @(@{ type = 'command'; command = 'node "C:\\tools\\codegraph.js"' }) }
    )
    PreToolUse = @(
      @{ matcher = '*'; hooks = @(
        @{ type = 'command'; command = $ours },
        @{ type = 'command'; command = 'node "C:\\other\\their-hook-client.js" x' }
      ) }
    )
  }
}
Set-Content -LiteralPath $target -Value ($root | ConvertTo-Json -Depth 10) -Encoding UTF8
`;

function collectCommands(result) {
  const commands = [];
  for (const groups of Object.values(result.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : [groups]) {
      const hooks = Array.isArray(g.hooks) ? g.hooks : [g.hooks];
      for (const hk of hooks) if (hk) commands.push(String(hk.command));
    }
  }
  return commands;
}

test('Remove-AllOurHooks は自分のフックだけ解除し、似た名前の他製品フックは残す', { skip: !pwshOk }, () => {
  const { dir } = runHarness(
    'install.ps1',
    ['Test-OurHookCommand', 'Backup-File', 'Remove-OldBackups', 'Remove-AllOurHooks'],
    `${BUILD_SAMPLE}
Remove-AllOurHooks $target 'テスト対象'
`,
  );
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const commands = collectCommands(result);
  assert.ok(!commands.some((c) => c.includes(path.join(dir, 'hook-client.js'))), '自分のフックが残っている');
  assert.ok(commands.some((c) => c.includes('their-hook-client.js')), '他製品の similar-hook-client.js を巻き込んで削除した');
  assert.ok(commands.some((c) => c.includes('codegraph.js')), '無関係のフックを巻き込んで削除した');
  // バックアップが作られている（破壊的変更の復旧手段）
  assert.ok(fs.readdirSync(dir).some((f) => /settings\.json\.bak-\d{8}-\d{6}/.test(f)), 'バックアップが無い');
});

test('Remove-OurHook は対象イベントの自分のフックだけを解除する', { skip: !pwshOk }, () => {
  const { dir } = runHarness(
    'install.ps1',
    ['Test-OurHookCommand', 'Remove-OurHook'],
    `${BUILD_SAMPLE}
$root2 = (Get-Content -LiteralPath $target -Raw -Encoding UTF8) | ConvertFrom-Json -AsHashtable
$root2 = Remove-OurHook -Root $root2 -EventName 'PreToolUse'
Set-Content -LiteralPath $target -Value ($root2 | ConvertTo-Json -Depth 10) -Encoding UTF8
`,
  );
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const commands = collectCommands(result);
  const oursPath = path.join(dir, 'hook-client.js');
  // PreToolUse の自分のフックは消え、共有グループの他製品フックは残る
  const preToolCommands = collectCommands({ hooks: { PreToolUse: result.hooks.PreToolUse ?? [] } });
  assert.ok(!preToolCommands.some((c) => c.includes(oursPath)), 'PreToolUse の自分のフックが残っている');
  assert.ok(preToolCommands.some((c) => c.includes('their-hook-client.js')), '共有グループの他製品フックが消えた');
  // 対象外の Stop の自分のフックは残る
  assert.ok(commands.some((c) => c.includes(oursPath)), '対象外イベントの自分のフックまで消えた');
});

test('Read-InstallManifest は不完全・未知バージョンの manifest を無効扱いにする', { skip: !pwshOk }, () => {
  const { stdout } = runHarness('update.ps1', ['Read-InstallManifest'], `
$full = '{"schemaVersion":1,"savedAt":"x","includeToolEvents":false,"skipClaude":false,"skipCodex":true,"registerStartup":true}'
$incomplete = '{"schemaVersion":1,"skipCodex":true}'
$unknown = '{"schemaVersion":2,"includeToolEvents":false,"skipClaude":false,"skipCodex":true,"registerStartup":true}'
$stringBool = '{"schemaVersion":1,"includeToolEvents":false,"skipClaude":false,"skipCodex":"false","registerStartup":true}'
foreach ($case in @(@('full', $full), @('incomplete', $incomplete), @('unknown', $unknown), @('stringBool', $stringBool))) {
  $p = Join-Path $WORK ($case[0] + '.json')
  Set-Content -LiteralPath $p -Value $case[1] -Encoding UTF8
  $m = Read-InstallManifest $p
  Write-Output ($case[0] + '=' + ($(if ($null -eq $m) { 'null' } else { 'valid' })))
}
`);
  assert.match(stdout, /full=valid/);
  assert.match(stdout, /incomplete=null/);
  assert.match(stdout, /unknown=null/);
  assert.match(stdout, /stringBool=null/);
});
