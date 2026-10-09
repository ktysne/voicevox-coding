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
//   node tools/cross-review.sync.js --check-manifest # 上流の雛形にあって files[] に無い配布物を列挙 (--check を含意。書き込まない)
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
// - --check-manifest は、上流の雛形 (tools/cross-review.sync.example.json = 配布物一式の正本) にあって
//   取り込み先のマニフェストの files[] に無いエントリを列挙する。上流が配り始めたファイルの取りこぼしを
//   知らせるだけで、マニフェストは書き換えない (何を取り込むかは取り込み先の判断であるため)。
//   同じ理由で、未登録があってもドリフトではないので exit 1 にしない。
//   単独指定でも書き込みを起こさないよう、parseArgs で --check を含意させる (列挙するだけの検査という
//   案内どおりに振る舞わせるため)。ドリフトがあれば --check と同じく exit 1 になる。
//   雛形が無い / 読めない / 構造が不正なときは警告して検査だけスキップし、同期そのものは止めない。
// - 上流の移行ノート (docs/migrations/*.md) のうち、まだ見せていないものを同期時に stderr へ表示する。
//   同期では直せない取り込み先側の作業 (gitignore、package.json の scripts、CLAUDE.md の節) を
//   人が取りこぼさないようにするため。未読の判定はマニフェストの shownMigrations (表示済みファイル名)
//   で行う。上流は shallow fetch (depth 1) なので、ノートの since (SHA) と lastSyncedCommit の
//   祖先関係は判定できない。since は情報用に留め、選別には使わない。
// - 副作用 (git 実行、一時ディレクトリ、ファイル I/O) は deps で差し替え可能にし、純粋なロジック
//   (引数解析、マニフェスト検証、置換、同期プラン算出) を単体テストで固定する。cross-review.js と同様。

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MANIFEST_FILENAME = 'cross-review.sync.json';
// 上流の移行ノートの置き場 (上流ルートからの相対)。マニフェストの migrationsDir で上書きできる。
const DEFAULT_MIGRATIONS_DIR = 'docs/migrations';
// 上流にある配布物一式の雛形 (上流ルートからの相対)。--check-manifest はこの files[] を正本として、
// 取り込み先のマニフェストに無いエントリを探す。
const UPSTREAM_EXAMPLE_MANIFEST = 'tools/cross-review.sync.example.json';

const USAGE = [
  'ai-cross-review 同期スクリプト (上流の「そのままコピーするファイル」を取り込む)',
  '',
  '使い方: node tools/cross-review.sync.js [options]',
  '',
  'options:',
  '  --check           ドリフト検査のみ。書き込まず、上流 (ref) との差分があれば exit 1',
  '  --check-manifest  上流の雛形にあって files[] に無い配布物を列挙する (--check を含意。書き込まない)',
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
  '    "shownMigrations": [],',
  '    "files": [',
  '      { "from": "tools/cross-review.js", "to": "tools/cross-review.js" },',
  '      { "from": "tests/cross-review.test.js", "to": "tests/tools/cross-review.test.js",',
  '        "replace": [ { "from": "../tools/cross-review.js", "to": "../../tools/cross-review.js" } ] }',
  '    ]',
  '  }',
  '',
  'shownMigrations には、上流の移行ノート (docs/migrations/*.md) のうち表示済みのファイル名が記録される。',
  '記録に無いノートは同期時に stderr へ全文表示される (取り込み先で必要な手作業の案内)。',
  '',
  '--check-manifest は上流の tools/cross-review.sync.example.json (配布物一式の正本) と files[] を突き合わせ、',
  '未登録のエントリを列挙する。足すかどうかは取り込み先の判断なので、マニフェストは書き換えない。',
  '列挙するだけの検査なので --check を含意し、単独指定でも書き込みは起きない (ドリフトがあれば exit 1。',
  '未登録があっても exit 1 にはしない)。',
  '',
  '例:',
  '  node tools/cross-review.sync.js            # 上流から取り込む',
  '  node tools/cross-review.sync.js --check    # ドリフト検査 (CI 向け)',
  '  node tools/cross-review.sync.js --check-manifest          # 配布物の取りこぼし確認 (--check を含意。書き込まない)',
  '  node tools/cross-review.sync.js --check --check-manifest  # ドリフト検査 + 配布物の取りこぼし確認 (上と同じ)',
  '  npm run sync                               # = node tools/cross-review.sync.js (scripts に登録した場合)',
].join('\n');

// process.argv.slice(2) を受け取り、同期モードとオプションを解釈する。
function parseArgs(argv) {
  const args = argv.slice();
  const out = { mode: 'sync', dryRun: false, checkManifest: false, ref: null, manifestPath: null, root: null, help: false, error: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--check') {
      out.mode = 'check';
    } else if (a === '--check-manifest') {
      // モードではなく付加的な検査。--check と併用できる (単独指定の扱いはループ後で決める)。
      out.checkManifest = true;
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
  // --check-manifest は「上流の配布物を取りこぼしていないか」を列挙するだけの検査なので、単独指定でも
  // 書き込み (ファイル同期、lastSyncedCommit の書き戻し) を起こさない。--check を含意させて非書き込みに
  // 揃える (ドリフトがあれば --check と同じく exit 1。未登録は exit 1 にしない)。
  if (out.checkManifest) out.mode = 'check';
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
  if (manifest.shownMigrations != null) {
    if (!Array.isArray(manifest.shownMigrations)
        || manifest.shownMigrations.some((n) => typeof n !== 'string')) {
      throw new Error('shownMigrations は表示済み移行ノートのファイル名 (文字列) の配列である必要があります');
    }
  }
  if (manifest.migrationsDir != null
      && (typeof manifest.migrationsDir !== 'string' || manifest.migrationsDir === '')) {
    throw new Error('migrationsDir は上流の移行ノート置き場 (上流相対パス) を文字列で指定してください');
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

// 移行ノート先頭の YAML 風フロントマター (--- で囲んだ since: <上流 SHA> の 1 行) を読む。
// since は「このノートが対象とする上流の版」を人が追うための情報で、未読判定には使わない
// (shallow fetch では SHA の祖先関係を判定できないため)。
// 想定した形でなければ { ok: false, reason } を返し、呼び出し側がそのノートをスキップする。
function parseMigrationFrontMatter(raw) {
  const text = typeof raw === 'string' ? raw.replace(/^\uFEFF/, '') : '';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { ok: false, reason: '先頭が --- で始まっていません' };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { ok: false, reason: 'フロントマターが --- で閉じていません' };
  let since = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const m = /^since:\s*(\S+)$/.exec(line);
    if (!m) return { ok: false, reason: `解釈できない行: ${lines[i]}` };
    since = m[1];
  }
  if (!since) return { ok: false, reason: 'since がありません' };
  return { ok: true, since };
}

// 上流の移行ノート置き場にある *.md を列挙する。
function defaultListMigrations(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
}

// 上流の移行ノートを読み集める。
// 戻り値: { present, notes, warnings }。present は置き場そのものの有無 (無ければ機能ごと何もしない。
// 移行ノートを持たない古い ref との後方互換)。1 件のノートの不備 (読めない / フロントマター不正) は
// warnings に積んでそのノートだけスキップし、同期全体は止めない。
function collectMigrationNotes(upstreamDir, migrationsDir, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const listMigrations = deps.listMigrations || defaultListMigrations;
  const upstreamRoot = path.resolve(upstreamDir);
  const dirAbs = path.resolve(upstreamRoot, migrationsDir);
  assertWithinRoot(upstreamRoot, dirAbs, `migrationsDir (${migrationsDir})`);
  if (!exists(dirAbs)) return { present: false, notes: [], warnings: [] };
  const notes = [];
  const warnings = [];
  let names;
  try {
    names = listMigrations(dirAbs);
  } catch (err) {
    return { present: false, notes: [], warnings: [`移行ノートの一覧を取得できません: ${migrationsDir} (${(err && err.message) || 'read error'})`] };
  }
  for (const name of names) {
    let body;
    try {
      body = readFile(path.join(dirAbs, name));
    } catch (err) {
      warnings.push(`移行ノートを読めません: ${name} (${(err && err.message) || 'read error'})`);
      continue;
    }
    const fm = parseMigrationFrontMatter(body);
    if (!fm.ok) {
      warnings.push(`移行ノートのフロントマターを解釈できません: ${name} (${fm.reason})`);
      continue;
    }
    notes.push({ name, body, since: fm.since });
  }
  return { present: true, notes, warnings };
}

// 表示する移行ノートと、マニフェストへ書き戻す表示済み一覧を決める純粋関数。
// notes は { name, body } の配列 (名前順)。
// 初期化規則:
// - 初回同期 (lastSyncedCommit が null) で記録が空のとき: 表示せず全件を記録する。
//   新規導入先はテンプレートを最新から取るので、過去の移行作業は不要なため。雛形
//   (cross-review.sync.example.json) が shownMigrations: [] を持つので、「キーが無い」だけでなく
//   「空配列」も初回として扱う (まだ一度も同期していない以上、空の記録は未表示の証拠にならない)。
// - 既に同期実績があり (lastSyncedCommit が非 null) shownMigrations が無いとき: 全件を未読として表示する。
//   この機能より前から使っている取り込み先が、溜まっている移行作業を一度で受け取れるようにするため。
// - それ以外: shownMigrations に無いノートを未読として表示する。
// 記録は既存の値を保ったまま未読分を追加する (上流から消えたノートの記録も残し、再表示を防ぐ)。
function selectMigrationNotes({ manifest, notes }) {
  const list = Array.isArray(notes) ? notes : [];
  const shown = manifest && Array.isArray(manifest.shownMigrations) ? manifest.shownMigrations : null;
  const firstSync = !manifest || manifest.lastSyncedCommit == null;
  const names = list.map((n) => n.name);
  if (firstSync && (shown == null || shown.length === 0)) return { toShow: [], nextShown: names };
  if (shown == null) return { toShow: list.slice(), nextShown: names };
  const seen = new Set(shown);
  const toShow = list.filter((n) => !seen.has(n.name));
  return { toShow, nextShown: shown.concat(toShow.map((n) => n.name)) };
}

// 表示済み一覧をマニフェストへ書き戻す必要があるかを判定する。
// 記録が無く未読も無い (移行ノートを 1 件も持たない上流) ときは、空配列を足すだけの差分を作らない。
function shownMigrationsChanged(prev, next) {
  if (!Array.isArray(prev)) return next.length > 0;
  if (prev.length !== next.length) return true;
  return prev.some((name, i) => name !== next[i]);
}

// 未読の移行ノートを人が読む形に整える (stderr 向け)。ノートは短い前提で全文を出す。
function formatMigrationNotes(notes) {
  const lines = [`[cross-review] 未読の移行ノート (${notes.length} 件)`];
  lines.push('取り込み先で必要な作業が書かれています。同期のあとに対応してください。');
  for (const n of notes) {
    lines.push('');
    lines.push(`--- ${n.name} ---`);
    lines.push(String(n.body).replace(/\s+$/, ''));
  }
  return lines.join('\n') + '\n';
}

// 上流の雛形マニフェストにあって、取り込み先のマニフェストの files[] に無いエントリを返す純粋関数。
// 対応付けの同一性は from (上流相対パス) で見る。to は取り込み先の配置で変わるため比較に使わない。
// 戻り値は雛形での並び順を保った [{ from, to }]。
function findMissingManifestEntries(exampleManifest, localManifest) {
  const exampleFiles = exampleManifest && Array.isArray(exampleManifest.files) ? exampleManifest.files : [];
  const localFiles = localManifest && Array.isArray(localManifest.files) ? localManifest.files : [];
  const registered = new Set(
    localFiles.filter((e) => e && typeof e.from === 'string').map((e) => e.from),
  );
  return exampleFiles
    .filter((e) => e && typeof e.from === 'string' && !registered.has(e.from))
    .map((e) => ({ from: e.from, to: typeof e.to === 'string' ? e.to : e.from }));
}

// 雛形マニフェストが配布物の正本として使える形かを判定する。
// files が配列で、from を文字列で持つエントリが 1 つ以上あることを要求する。これを満たさない雛形から
// 未登録エントリを求めると、突き合わせる相手が 1 件も無いまま「未登録なし」と誤報するため
// (検査したのに何も見ていない状態を、検査に成功したと区別できなくする)。
function isUsableExampleManifest(example) {
  if (!example || typeof example !== 'object' || !Array.isArray(example.files)) return false;
  return example.files.some((e) => e && typeof e.from === 'string');
}

// 上流の雛形マニフェストを読み、未登録エントリを求める。
// 戻り値: { entries, warning }。上流に雛形が無い / 読めない / JSON として不正 / 構造が不正なときは
// entries を空にし、warning に理由を入れて検査をスキップする (雛形を持たない古い ref でも同期そのものは通す)。
function collectMissingManifestEntries(upstreamDir, manifest, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const examplePath = path.resolve(upstreamDir, UPSTREAM_EXAMPLE_MANIFEST);
  if (!exists(examplePath)) {
    return { entries: [], warning: `上流に配布物の雛形 (${UPSTREAM_EXAMPLE_MANIFEST}) が無いため、マニフェスト検査をスキップします` };
  }
  let example;
  try {
    example = JSON.parse(readFile(examplePath));
  } catch (err) {
    return { entries: [], warning: `上流の配布物の雛形を読めません: ${UPSTREAM_EXAMPLE_MANIFEST} (${(err && err.message) || 'read error'})` };
  }
  if (!isUsableExampleManifest(example)) {
    return { entries: [], warning: `上流の配布物の雛形の構造が不正です (${UPSTREAM_EXAMPLE_MANIFEST} の files[] に from を持つエントリがありません)。マニフェスト検査をスキップします` };
  }
  return { entries: findMissingManifestEntries(example, manifest), warning: null };
}

// 未登録の配布物を人が読む形に整える (stdout 向け)。
function formatMissingManifestEntries(entries) {
  const lines = [`マニフェスト未登録の配布物 (${entries.length} 件): 上流の雛形にあって files[] にありません。`];
  for (const e of entries) lines.push(`  - ${e.from} -> ${e.to}`);
  lines.push('必要なものだけ files[] に足してください (この検査はマニフェストを書き換えません)。');
  return lines.join('\n') + '\n';
}

const STATUS_LABEL = { create: '新規', update: '更新', unchanged: '一致' };

// 同期 / 検査を実行する本体。副作用は deps で差し替え可能。
// 戻り値: { ref, commit, results, drift, wrote, migrations, missingManifestEntries } (テストから検証する)。
// migrations は今回表示した未読移行ノートのファイル名、missingManifestEntries は --check-manifest で
// 見つかった未登録の配布物 (指定しなければ空配列)。process.exitCode も設定する。
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

    // 移行ノートの選別。置き場の読み取りに失敗しても同期は続ける (ノートは案内であって同期の前提ではない)。
    const migrationsDir = manifest.migrationsDir || DEFAULT_MIGRATIONS_DIR;
    let collected = { present: false, notes: [], warnings: [] };
    try {
      collected = collectMigrationNotes(upstream.dir, migrationsDir, { readFile, exists, listMigrations: deps.listMigrations });
    } catch (err) {
      writeErr(`[cross-review] 移行ノートを確認できませんでした: ${(err && err.message) || 'read error'}\n`);
    }
    for (const w of collected.warnings) writeErr(`[cross-review] ${w}\n`);
    // 置き場が無い上流 (移行ノートより前の ref) では機能ごと何もしない。マニフェストの記録も触らない。
    const selection = collected.present ? selectMigrationNotes({ manifest, notes: collected.notes }) : null;
    const unread = selection ? selection.toShow : [];
    const migrations = unread.map((n) => n.name);

    // マニフェスト検査 (--check-manifest)。上流が配り始めた配布物の取りこぼしを知らせるだけで、
    // マニフェストは書き換えず、終了コードにも影響させない (足すかどうかは取り込み先の判断であるため)。
    // 検査をスキップした理由 (雛形の不在、読めない、構造不正) は manifestCheckWarning として戻り値にも
    // 載せる。stderr の警告は一括同期 (sync-all) では流れて見落とすので、呼び出し側が「未登録 0 件」と
    // 「そもそも検査できていない」を区別できるようにするため。
    let missingManifestEntries = [];
    let manifestCheckWarning = null;
    let manifestChecked = false;
    if (opts.checkManifest) {
      let missing = { entries: [], warning: null };
      try {
        missing = collectMissingManifestEntries(upstream.dir, manifest, { readFile, exists });
      } catch (err) {
        missing = { entries: [], warning: `マニフェスト検査に失敗しました: ${(err && err.message) || 'read error'}` };
      }
      if (missing.warning) writeErr(`[cross-review] ${missing.warning}\n`);
      manifestCheckWarning = missing.warning || null;
      manifestChecked = !missing.warning;
      missingManifestEntries = missing.entries;
    }

    writeOut(`上流: ${manifest.upstream.repo} @ ${ref} (${upstream.commit})\n`);
    for (const p of plan) {
      writeOut(`  [${STATUS_LABEL[p.status]}] ${p.to}\n`);
    }
    if (missingManifestEntries.length) {
      writeOut(formatMissingManifestEntries(missingManifestEntries));
    } else if (manifestChecked) {
      writeOut('マニフェスト未登録の配布物はありません (上流の雛形と一致)。\n');
    }

    // --check は --dry-run より優先する (ここで先に return する)。両方指定すると検査として振る舞い、
    // ドリフトがあれば exit 1 になる。dry-run は同期モードでの「書き込まないプレビュー」専用。
    if (opts.mode === 'check') {
      // 検査のみ: 書き込まず、ドリフトがあれば exit 1。
      // 移行ノートは件数だけ知らせる (全文は同期時に出す)。取り込み先の手作業の有無はドリフトではないので、
      // 未読が残っていても exit 1 にはしない。
      if (unread.length) {
        writeErr(`[cross-review] 未読の移行ノートが ${unread.length} 件あります (同期時に表示)\n`);
      }
      if (drift) {
        writeOut(`ドリフトを検出しました (${changed.length} 件)。同期するには --check を外して実行してください。\n`);
        process.exitCode = 1;
      } else {
        writeOut('ドリフトはありません (上流と一致)。\n');
      }
      return { ref, commit: upstream.commit, results, drift, wrote, migrations, missingManifestEntries, manifestCheckWarning };
    }

    // 未読の移行ノートを全文表示する。dry-run でも表示はするが、記録 (shownMigrations) は残さない
    // ため、同じノートが次の同期でもう一度出る (書き込まないプレビューという dry-run の意味を保つ)。
    if (unread.length) writeErr(formatMigrationNotes(unread));

    if (opts.dryRun) {
      writeOut(drift ? `dry-run: ${changed.length} 件を更新します (書き込みはしていません)。\n` : 'dry-run: 変更はありません。\n');
      return { ref, commit: upstream.commit, results, drift, wrote, migrations, missingManifestEntries, manifestCheckWarning };
    }

    // 同期 (コピー): 差分のあるファイルだけ書き込む。
    for (const p of changed) {
      writeFile(p.destAbs, p.expected);
      wrote.push(p.to);
    }
    // 取り込み元コミットと表示済み移行ノートを記録し、どの版から取り込んだかを履歴に残す。記録値
    // (commit / ref / shownMigrations) が変わるときだけ書き戻す。同一コミットの再同期では、ユーザが
    // 手で整形したマニフェストを毎回上書きしない (不要な差分、整形崩れを防ぐ)。上流が進めば取り込み
    // ファイルが一致でも記録は更新する。
    const migrationsRecordChanged = selection
      && shownMigrationsChanged(manifest.shownMigrations, selection.nextShown);
    if (manifest.lastSyncedCommit !== upstream.commit || manifest.lastSyncedRef !== ref || migrationsRecordChanged) {
      manifest.lastSyncedCommit = upstream.commit;
      manifest.lastSyncedRef = ref;
      if (selection) manifest.shownMigrations = selection.nextShown;
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    writeOut(wrote.length ? `同期しました (${wrote.length} 件を更新)。\n` : '同期しました (変更なし)。\n');
    return { ref, commit: upstream.commit, results, drift, wrote, migrations, missingManifestEntries, manifestCheckWarning };
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
  parseMigrationFrontMatter,
  collectMigrationNotes,
  selectMigrationNotes,
  shownMigrationsChanged,
  formatMigrationNotes,
  findMissingManifestEntries,
  collectMissingManifestEntries,
  formatMissingManifestEntries,
  runSync,
  defaultPrepareUpstream,
  DEFAULT_MANIFEST_FILENAME,
  DEFAULT_MIGRATIONS_DIR,
  UPSTREAM_EXAMPLE_MANIFEST,
  USAGE,
};

if (require.main === module) main();
