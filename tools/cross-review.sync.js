#!/usr/bin/env node
// tools/cross-review.sync.js
//
// ai-cross-review の「そのままコピーするファイル」(CLI 本体、手順書、観点テンプレート、テスト等)
// を、上流リポジトリから取り込み先プロジェクトへ取り込む同期スクリプト。
// 手動コピー運用を、マニフェスト (cross-review.sync.json) に基づく機械的な同期へ置き換える。
//
// 使い方:
//   node tools/cross-review.sync.js                 # マニフェストに従い上流から取り込む (コピー)
//   node tools/cross-review.sync.js --check         # ドリフト検査のみ (書き込まない。差分があれば exit 1)
//   node tools/cross-review.sync.js --dry-run       # 書き込まず、何が変わるかだけ表示
//   node tools/cross-review.sync.js --ref <ref>     # 取り込む上流の ref をマニフェストより優先
//   node tools/cross-review.sync.js --manifest <p>  # マニフェストの場所を指定 (既定: スクリプト隣の cross-review.sync.json)
//   node tools/cross-review.sync.js --root <p>      # 取り込み先プロジェクトのルートを指定 (既定: tools/ の 1 つ上)
//   node tools/cross-review.sync.js --help
//
// 設計判断:
// - 依存パッケージを追加しない (Node 標準 API のみ、CommonJS)。cross-review.js と同じ方針。
// - 上流の取得は git のみで行う。ref (ブランチ / タグ / コミット SHA) を一時ディレクトリへ
//   shallow fetch し、そこからファイルをコピーする。取得した実コミットをマニフェストの
//   lastSyncedCommit に記録し、どの版から取り込んだかを履歴に残す。
// - どのファイルをどこへ取り込むかは cross-review.sync.json (マニフェスト) が単一ソース。
//   取り込み先のディレクトリ構成が上流と違っても from / to で対応付ける。テストの require パス等は
//   replace で機械置換する (上流側を書き換えない)。
// - --check は書き込まず、上流 (ref) と取り込み先の差分 (ドリフト) だけを報告する。
//   差分があれば exit 1 にして CI で検知できるようにする (取り込み先の docs:check 相当のドリフト検知)。
// - 副作用 (git 実行、一時ディレクトリ、ファイル I/O) は deps で差し替え可能にし、純粋なロジック
//   (引数解析、マニフェスト検証、置換、同期プラン算出) を単体テストで固定する。cross-review.js と同様。

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MANIFEST_FILENAME = 'cross-review.sync.json';

const USAGE = [
  'ai-cross-review 同期スクリプト (上流の「そのままコピーするファイル」を取り込む)',
  '',
  '使い方: node tools/cross-review.sync.js [options]',
  '',
  'options:',
  '  --check           ドリフト検査のみ。書き込まず、上流 (ref) との差分があれば exit 1',
  '  --dry-run         書き込まず、同期で何が変わるかだけ表示する',
  '  --ref <ref>       取り込む上流の ref をマニフェストより優先 (ブランチ / タグ / コミット)',
  '  --manifest <path> マニフェストの場所を指定 (既定: スクリプト隣の cross-review.sync.json)',
  '  --root <path>     取り込み先プロジェクトのルートを指定 (既定: tools/ の 1 つ上)',
  '  -h, --help        このヘルプを表示',
  '',
  'マニフェスト (cross-review.sync.json) の形:',
  '  {',
  '    "upstream": { "repo": "https://github.com/ktysne/ai-cross-review.git", "ref": "main" },',
  '    "lastSyncedCommit": null,',
  '    "files": [',
  '      { "from": "tools/cross-review.js", "to": "tools/cross-review.js" },',
  '      { "from": "tests/cross-review.test.js", "to": "tests/tools/cross-review.test.js",',
  '        "replace": [ { "from": "../tools/cross-review.js", "to": "../../tools/cross-review.js" } ] }',
  '    ]',
  '  }',
  '',
  '例:',
  '  node tools/cross-review.sync.js            # 上流から取り込む',
  '  node tools/cross-review.sync.js --check    # ドリフト検査 (CI 向け)',
  '  npm run sync                               # = node tools/cross-review.sync.js (scripts に登録した場合)',
].join('\n');

// process.argv.slice(2) を受け取り、同期モードとオプションを解釈する。
function parseArgs(argv) {
  const args = argv.slice();
  const out = { mode: 'sync', dryRun: false, ref: null, manifestPath: null, root: null, help: false, error: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--check') {
      out.mode = 'check';
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--ref') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) out.error = '--ref には ref (ブランチ / タグ / コミット) が必要です';
      else { out.ref = v; i++; }
    } else if (a.startsWith('--ref=')) {
      const v = a.slice('--ref='.length);
      if (!v) out.error = '--ref には ref が必要です';
      else out.ref = v;
    } else if (a === '--manifest') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) out.error = '--manifest にはファイルパスが必要です';
      else { out.manifestPath = v; i++; }
    } else if (a.startsWith('--manifest=')) {
      const v = a.slice('--manifest='.length);
      if (!v) out.error = '--manifest にはファイルパスが必要です';
      else out.manifestPath = v;
    } else if (a === '--root') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) out.error = '--root にはディレクトリパスが必要です';
      else { out.root = v; i++; }
    } else if (a.startsWith('--root=')) {
      const v = a.slice('--root='.length);
      if (!v) out.error = '--root にはディレクトリパスが必要です';
      else out.root = v;
    } else if (a.startsWith('-')) {
      out.error = `不明なオプション: ${a}`;
    } else {
      out.error = `不明な引数: ${a}`;
    }
  }
  return out;
}

// マニフェストを読み込み JSON として解釈する。読めない / JSON でないときは例外を投げる。
// deps.readFile / deps.exists でテストから差し替え可能。
function loadManifest(manifestPath, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  if (!exists(manifestPath)) {
    throw new Error(`マニフェストが見つかりません: ${manifestPath}`);
  }
  let raw;
  try {
    raw = readFile(manifestPath);
  } catch (err) {
    throw new Error(`マニフェストを読めません: ${manifestPath} (${(err && err.message) || 'read error'})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`マニフェストが JSON として不正です: ${manifestPath} (${(err && err.message) || 'parse error'})`);
  }
}

// マニフェストの形を検証する。問題があれば分かりやすい日本語メッセージで例外を投げる。
// refOverride (--ref) があれば upstream.ref は無くてもよい。
function validateManifest(manifest, refOverride) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('マニフェストはオブジェクトである必要があります');
  }
  // 旧形式 ({source, ref, commit}) の検出: upstream / files を持たず source / commit があるなら、
  // 取り込み先が独自 sync 機構のレガシーマニフェストを同名で置いている可能性が高い。汎用の
  // 「upstream がありません」より具体的に、新形式への移行手順を促す (移行初回の取り込みを滑らかに)。
  if (manifest.upstream === undefined && manifest.files === undefined
      && (manifest.source !== undefined || manifest.commit !== undefined)) {
    throw new Error(
      'マニフェストが旧形式 ({source, ref, commit}) のようです。'
      + ' 新形式 ({upstream:{repo,ref}, files:[...]}) へ移行してください'
      + ' (雛形は cross-review.sync.example.json)。',
    );
  }
  const up = manifest.upstream;
  if (!up || typeof up !== 'object') {
    throw new Error('マニフェストに upstream オブジェクトがありません');
  }
  if (!up.repo || typeof up.repo !== 'string') {
    throw new Error('upstream.repo (git リポジトリ URL / パス) を文字列で指定してください');
  }
  if (!refOverride && (!up.ref || typeof up.ref !== 'string')) {
    throw new Error('upstream.ref を指定するか --ref で渡してください');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('マニフェストの files に取り込むファイルを 1 つ以上指定してください');
  }
  manifest.files.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`files[${idx}] はオブジェクトである必要があります`);
    }
    if (!entry.from || typeof entry.from !== 'string') {
      throw new Error(`files[${idx}].from (上流相対パス) を文字列で指定してください`);
    }
    if (!entry.to || typeof entry.to !== 'string') {
      throw new Error(`files[${idx}].to (取り込み先相対パス) を文字列で指定してください`);
    }
    if (entry.replace != null) {
      if (!Array.isArray(entry.replace)) {
        throw new Error(`files[${idx}].replace は配列である必要があります`);
      }
      entry.replace.forEach((r, j) => {
        if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') {
          throw new Error(`files[${idx}].replace[${j}] は { from, to } (ともに文字列) である必要があります`);
        }
      });
    }
  });
}

// replace (機械置換) を順に適用する。from は正規表現でなく「文字列リテラル」として全置換する。
// 主用途: コピーしたテストの require パスを取り込み先の配置へ合わせる (上流側は書き換えない)。
function applyReplacements(content, replacements) {
  if (!Array.isArray(replacements) || replacements.length === 0) return content;
  let out = content;
  for (const r of replacements) {
    if (!r.from) continue;
    out = out.split(r.from).join(r.to);
  }
  return out;
}

// resolved が root の中 (root 自身を除く配下) に収まるか検証する。
// マニフェスト由来のパスで root の外へ書き出す / 読み出す事故を防ぐ。
function assertWithinRoot(root, resolved, label) {
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} がルートの外を指しています: ${resolved} (root: ${root})`);
  }
}

// git を実行し stdout を返す。テストから差し替えられるよう実体を分離する。
function defaultGitRunner(args) {
  const res = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    const detail = res.stderr || `exit ${res.status}`;
    throw new Error(`git ${args.join(' ')} に失敗しました: ${detail}`);
  }
  return res.stdout || '';
}

// 上流 (repo の ref) を一時ディレクトリへ shallow fetch して用意する。
// 戻り値: { dir, commit, cleanup }。cleanup() で一時ディレクトリを削除する。
// SHA 直接指定も拾えるよう、clone --branch ではなく init + fetch <ref> を使う。
function defaultPrepareUpstream(repo, ref, deps = {}) {
  const gitRun = deps.gitRun || defaultGitRunner;
  const mkdtemp = deps.mkdtemp || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'cross-review-sync-')));
  const rm = deps.rm || ((d) => fs.rmSync(d, { recursive: true, force: true }));
  const dir = mkdtemp();
  try {
    gitRun(['init', '--quiet', dir]);
    gitRun(['-C', dir, 'remote', 'add', 'origin', repo]);
    gitRun(['-C', dir, 'fetch', '--quiet', '--depth', '1', 'origin', ref]);
    gitRun(['-C', dir, 'checkout', '--quiet', 'FETCH_HEAD']);
    const commit = gitRun(['-C', dir, 'rev-parse', 'HEAD']).trim();
    return { dir, commit, cleanup: () => rm(dir) };
  } catch (err) {
    // 後始末の失敗で本来の fetch 失敗理由を握りつぶさないよう、rm の例外は無視して元の err を投げる。
    try { rm(dir); } catch { /* 一時ディレクトリ削除の失敗は無視 */ }
    throw err;
  }
}

// 各ファイルの取り込みプランを算出する (書き込みはしない)。
//   expected: 上流の内容に replace を適用した「取り込み先のあるべき内容」
//   current : 取り込み先の現在の内容 (無ければ null)
//   status  : create (新規) / update (差分あり) / unchanged (一致)
function computeSyncPlan(manifest, upstreamDir, destRoot, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  return manifest.files.map((entry) => {
    const upstreamAbs = path.resolve(upstreamDir, entry.from);
    assertWithinRoot(path.resolve(upstreamDir), upstreamAbs, `files.from (${entry.from})`);
    const destAbs = path.resolve(destRoot, entry.to);
    assertWithinRoot(path.resolve(destRoot), destAbs, `files.to (${entry.to})`);
    if (!exists(upstreamAbs)) {
      throw new Error(`上流にファイルがありません: ${entry.from}`);
    }
    const expected = applyReplacements(readFile(upstreamAbs), entry.replace);
    const current = exists(destAbs) ? readFile(destAbs) : null;
    let status;
    if (current == null) status = 'create';
    else if (current !== expected) status = 'update';
    else status = 'unchanged';
    return { from: entry.from, to: entry.to, destAbs, expected, status };
  });
}

const STATUS_LABEL = { create: '新規', update: '更新', unchanged: '一致' };

// 同期 / 検査を実行する本体。副作用は deps で差し替え可能。
// 戻り値: { ref, commit, results, drift, wrote } (テストから検証する)。process.exitCode も設定する。
function runSync(opts, deps = {}) {
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps.writeFile || ((p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); });
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const prepareUpstream = deps.prepareUpstream || defaultPrepareUpstream;
  const scriptDir = deps.scriptDir || __dirname;

  const manifestPath = opts.manifestPath
    ? path.resolve(opts.manifestPath)
    : path.join(scriptDir, DEFAULT_MANIFEST_FILENAME);
  // 既定の取り込み先ルートは tools/ の 1 つ上 (= プロジェクトルート)。cwd に依存せず解決する。
  const destRoot = opts.root ? path.resolve(opts.root) : path.resolve(scriptDir, '..');

  let manifest;
  try {
    manifest = loadManifest(manifestPath, { readFile, exists });
    validateManifest(manifest, opts.ref);
  } catch (err) {
    writeErr(`${(err && err.message) || 'マニフェストの読み込みに失敗しました'}\n`);
    process.exitCode = 2;
    return null;
  }

  const ref = opts.ref || manifest.upstream.ref;
  let upstream;
  try {
    upstream = prepareUpstream(manifest.upstream.repo, ref, deps);
  } catch (err) {
    writeErr(`上流の取得に失敗しました (${manifest.upstream.repo} @ ${ref}): ${(err && err.message) || 'git error'}\n`);
    process.exitCode = 1;
    return null;
  }

  try {
    let plan;
    try {
      plan = computeSyncPlan(manifest, upstream.dir, destRoot, { readFile, exists });
    } catch (err) {
      writeErr(`${(err && err.message) || '同期プランの算出に失敗しました'}\n`);
      process.exitCode = 1;
      return null;
    }

    const changed = plan.filter((p) => p.status !== 'unchanged');
    const drift = changed.length > 0;
    const results = plan.map((p) => ({ from: p.from, to: p.to, status: p.status }));
    const wrote = [];

    writeOut(`上流: ${manifest.upstream.repo} @ ${ref} (${upstream.commit})\n`);
    for (const p of plan) {
      writeOut(`  [${STATUS_LABEL[p.status]}] ${p.to}\n`);
    }

    // --check は --dry-run より優先する (ここで先に return する)。両方指定すると検査として振る舞い、
    // ドリフトがあれば exit 1 になる。dry-run は同期モードでの「書き込まないプレビュー」専用。
    if (opts.mode === 'check') {
      // 検査のみ: 書き込まず、ドリフトがあれば exit 1。
      if (drift) {
        writeOut(`ドリフトを検出しました (${changed.length} 件)。同期するには --check を外して実行してください。\n`);
        process.exitCode = 1;
      } else {
        writeOut('ドリフトはありません (上流と一致)。\n');
      }
      return { ref, commit: upstream.commit, results, drift, wrote };
    }

    if (opts.dryRun) {
      writeOut(drift ? `dry-run: ${changed.length} 件を更新します (書き込みはしていません)。\n` : 'dry-run: 変更はありません。\n');
      return { ref, commit: upstream.commit, results, drift, wrote };
    }

    // 同期 (コピー): 差分のあるファイルだけ書き込む。
    for (const p of changed) {
      writeFile(p.destAbs, p.expected);
      wrote.push(p.to);
    }
    // 取り込み元コミットを記録し、どの版から取り込んだかを履歴に残す。記録値 (commit / ref) が
    // 変わるときだけ書き戻す。同一コミットの再同期では、ユーザが手で整形したマニフェストを毎回
    // 上書きしない (不要な差分、整形崩れを防ぐ)。上流が進めば取り込みファイルが一致でも記録は更新する。
    if (manifest.lastSyncedCommit !== upstream.commit || manifest.lastSyncedRef !== ref) {
      manifest.lastSyncedCommit = upstream.commit;
      manifest.lastSyncedRef = ref;
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    writeOut(wrote.length ? `同期しました (${wrote.length} 件を更新)。\n` : '同期しました (変更なし)。\n');
    return { ref, commit: upstream.commit, results, drift, wrote };
  } finally {
    if (upstream && typeof upstream.cleanup === 'function') {
      try { upstream.cleanup(); } catch { /* 一時ディレクトリ削除の失敗は無視する */ }
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (opts.error) {
    process.stderr.write(`${opts.error}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  runSync(opts);
}

module.exports = {
  parseArgs,
  loadManifest,
  validateManifest,
  applyReplacements,
  assertWithinRoot,
  computeSyncPlan,
  runSync,
  defaultPrepareUpstream,
  DEFAULT_MANIFEST_FILENAME,
  USAGE,
};

if (require.main === module) main();
