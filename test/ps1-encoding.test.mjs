// .ps1 ファイルの UTF-8 BOM 有無を検査する回帰テスト (AUD-10 系の再発防止)。
//
// Windows PowerShell 5.1 は BOM の無い .ps1 を実行環境の ANSI コードページ
// (この環境では 932 = Shift-JIS) で読み込む。そのため BOM が欠けたファイルに
// 日本語コメントが含まれていると文字化けし、最悪の場合は構文エラーで
// スクリプトが起動すらできなくなる (scripts/update.ps1 で実際に発生した不具合)。
// pwsh (PowerShell 7) は BOM が無くても UTF-8 として読めるため、pwsh だけで
// 動作確認しても見逃される点に注意。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git', '.claude']);

function findPs1Files(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      results.push(...findPs1Files(path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.ps1')) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

const ps1Files = findPs1Files(repoRoot);

test('リポジトリ内に .ps1 ファイルが見つかる (列挙ロジックの健全性確認)', () => {
  assert.ok(
    ps1Files.length > 0,
    '.ps1 ファイルが 1 つも見つからなかった。列挙ロジックが壊れている可能性がある。',
  );
});

test('すべての .ps1 ファイルが UTF-8 BOM (EF BB BF) を持つ', () => {
  const missingBom = [];
  for (const filePath of ps1Files) {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(3);
    fs.readSync(fd, buffer, 0, 3, 0);
    fs.closeSync(fd);

    const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    if (!hasBom) {
      missingBom.push(path.relative(repoRoot, filePath).split(path.sep).join('/'));
    }
  }

  assert.deepEqual(
    missingBom,
    [],
    `UTF-8 BOM の無い .ps1 ファイルがある: ${missingBom.join(', ')}\n` +
      'BOM が無いと Windows PowerShell 5.1 が ANSI コードページ (このリポジトリの想定環境では 932 = Shift-JIS) で' +
      'ファイルを読み込み、日本語コメントが文字化けして構文エラーになる (scripts/update.ps1 で実際に発生)。',
  );
});
