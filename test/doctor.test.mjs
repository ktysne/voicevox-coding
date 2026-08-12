import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexHomeMatches,
  missingToolEvents,
  normalizeInstallManifest,
  extraToolEvents,
  normalizePathForComparison,
  parseCodexInitializeResult,
  resolveTargetPlan,
} from '../scripts/doctor.mjs';

test('initialize 応答から Codex の実使用 CODEX_HOME を取り出す', () => {
  assert.equal(
    parseCodexInitializeResult({ result: { codexHome: 'C:\\Users\\alice\\.codex' } }),
    'C:\\Users\\alice\\.codex',
  );
  assert.equal(parseCodexInitializeResult({ result: {} }), null);
  assert.equal(parseCodexInitializeResult(null), null);
});

test('Codex HOME の比較は Windows の大小文字・区切り差を吸収する', () => {
  assert.equal(
    codexHomeMatches('C:\\Users\\Alice\\.codex', 'c:/Users/Alice/.codex/'),
    true,
  );
  assert.equal(codexHomeMatches('C:\\Users\\Alice\\.codex', 'C:\\Users\\Bob\\.codex'), false);
});

test('Codex HOME の比較用正規化は空文字を無効値として扱う', () => {
  assert.equal(normalizePathForComparison('  '), null);
  assert.equal(normalizePathForComparison('C:\\Users\\Alice\\.codex\\'), 'C:\\Users\\Alice\\.codex');
});

test('resolveTargetPlan: manifest があり skip 指定なら検査を省略する', () => {
  const manifest = { schemaVersion: 1, skipClaude: false, skipCodex: true, includeToolEvents: false };
  assert.deepEqual(
    resolveTargetPlan(manifest, { skipKey: 'skipCodex', hooksExist: true, cliAvailable: true, migrateWhenMissing: true }),
    { mode: 'skip' },
  );
  // hooksExist / cliAvailable の値に関わらず、manifest の skip 指定が優先される
  assert.deepEqual(
    resolveTargetPlan(manifest, { skipKey: 'skipCodex', hooksExist: false, cliAvailable: false, migrateWhenMissing: true }),
    { mode: 'skip' },
  );
});

test('resolveTargetPlan: manifest があり skip 指定が無ければ通常どおり検査する', () => {
  const manifest = { schemaVersion: 1, skipClaude: false, skipCodex: false, includeToolEvents: false };
  assert.deepEqual(
    resolveTargetPlan(manifest, { skipKey: 'skipClaude', hooksExist: false }),
    { mode: 'check' },
  );
  assert.deepEqual(
    resolveTargetPlan(manifest, { skipKey: 'skipCodex', hooksExist: false, cliAvailable: false, migrateWhenMissing: true }),
    { mode: 'check' },
  );
});

test('resolveTargetPlan: manifest が無く、フックも CLI も無ければ未導入と推定する（移行判定対象のみ）', () => {
  assert.deepEqual(
    resolveTargetPlan(null, { skipKey: 'skipCodex', hooksExist: false, cliAvailable: false, migrateWhenMissing: true }),
    { mode: 'warn-uninstalled' },
  );
});

test('resolveTargetPlan: manifest が無くてもフックか CLI があれば従来どおり検査する', () => {
  assert.deepEqual(
    resolveTargetPlan(null, { skipKey: 'skipCodex', hooksExist: true, cliAvailable: false, migrateWhenMissing: true }),
    { mode: 'check' },
  );
  assert.deepEqual(
    resolveTargetPlan(null, { skipKey: 'skipCodex', hooksExist: false, cliAvailable: true, migrateWhenMissing: true }),
    { mode: 'check' },
  );
});

test('resolveTargetPlan: 移行判定を行わない対象（Claude）は manifest が無ければ常に検査する', () => {
  assert.deepEqual(
    resolveTargetPlan(null, { skipKey: 'skipClaude', hooksExist: false }),
    { mode: 'check' },
  );
});

test('missingToolEvents: includeToolEvents が期待どおり登録されていれば差分は無い', () => {
  const manifest = { includeToolEvents: true };
  const ours = [{ ev: 'Stop' }, { ev: 'PreToolUse' }, { ev: 'PostToolUse' }];
  assert.deepEqual(missingToolEvents(manifest, ours), []);
});

test('missingToolEvents: includeToolEvents が期待されているのに登録が無ければ差分を返す', () => {
  const manifest = { includeToolEvents: true };
  const ours = [{ ev: 'Stop' }, { ev: 'PreToolUse' }];
  assert.deepEqual(missingToolEvents(manifest, ours), ['PostToolUse']);
});

test('missingToolEvents: includeToolEvents を期待していなければ登録の有無に関わらず差分は無い', () => {
  assert.deepEqual(missingToolEvents({ includeToolEvents: false }, []), []);
  assert.deepEqual(missingToolEvents(null, []), []);
});

test('normalizeInstallManifest: 正しい形式はそのまま返す', () => {
  const m = { schemaVersion: 1, includeToolEvents: false, skipClaude: false, skipCodex: true, registerStartup: true };
  assert.equal(normalizeInstallManifest(m), m);
});

test('normalizeInstallManifest: 型が不正・不完全・未知バージョンは無効扱い（null）にする', () => {
  const full = { schemaVersion: 1, includeToolEvents: false, skipClaude: false, registerStartup: true };
  // "false" のような文字列 bool は truthy に化けて検査を誤って省略するため弾く
  assert.equal(normalizeInstallManifest({ ...full, skipCodex: 'false' }), null);
  assert.equal(normalizeInstallManifest({ ...full, schemaVersion: '1', skipCodex: false }), null);
  // 欠落キーを既定値へ倒すと意図しない再登録が起きるため、不完全な manifest は弾く
  assert.equal(normalizeInstallManifest({ schemaVersion: 1, skipCodex: true }), null);
  // 未知の schemaVersion を現行形式として処理しない
  assert.equal(normalizeInstallManifest({ ...full, schemaVersion: 2, skipCodex: false }), null);
  assert.equal(normalizeInstallManifest({ skipCodex: false }), null); // schemaVersion 無し
  assert.equal(normalizeInstallManifest(null), null);
  assert.equal(normalizeInstallManifest('text'), null);
});

test('extraToolEvents: 対象外なのに残っている高頻度フックを検出する', () => {
  const manifest = { includeToolEvents: false };
  const ours = [{ ev: 'Stop' }, { ev: 'PreToolUse' }];
  assert.deepEqual(extraToolEvents(manifest, ours), ['PreToolUse']);
});

test('extraToolEvents: 期待どおり（有効・または manifest なし）なら差分は無い', () => {
  assert.deepEqual(extraToolEvents({ includeToolEvents: true }, [{ ev: 'PreToolUse' }]), []);
  assert.deepEqual(extraToolEvents(null, [{ ev: 'PreToolUse' }]), []);
  assert.deepEqual(extraToolEvents({ includeToolEvents: false }, [{ ev: 'Stop' }]), []);
});
