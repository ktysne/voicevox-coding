import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexHomeMatches,
  normalizePathForComparison,
  parseCodexInitializeResult,
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
