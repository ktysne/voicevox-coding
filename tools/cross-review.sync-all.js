#!/usr/bin/env node
// tools/cross-review.sync-all.js
//
// ローカルの作業ルート (例: /Develop) 配下から「ai-cross-review を導入したプロジェクト」を自動判定し、
// それぞれを cross-review.sync.js で一括同期 (上書き更新 / ドリフト検査) する外部ツール。
// 1 リポずつ手で sync を回す代わりに、上流の更新を導入先全体へまとめて反映するための maintainer 向け infra。
//
// 使い方:
//   node tools/cross-review.sync-all.js [root]            # root 配下を走査して一括同期 (既定 root: cwd)
//   node tools/cross-review.sync-all.js --root /Develop   # 走査ルートを指定
//   node tools/cross-review.sync-all.js --check           # 各プロジェクトをドリフト検査のみ (書き込まない)
//   node tools/cross-review.sync-all.js --dry-run         # 各プロジェクトで何が変わるかだけ表示 (書き込まない)
//   node tools/cross-review.sync-all.js --ref <ref>       # 取り込む上流 ref を全プロジェクト共通で上書き
//   node tools/cross-review.sync-all.js --depth <n>       # 走査の最大深さ (既定 4)
//   node tools/cross-review.sync-all.js --list            # 検出したプロジェクトを列挙するだけ (同期しない)
//   node tools/cross-review.sync-all.js --global-skill    # 相互レビュー SKILL をホームのグローバル配置へ配る
//   node tools/cross-review.sync-all.js --help
//
// 設計判断:
// - 「導入プロジェクト」の判定は同期マニフェスト cross-review.sync.json の存在で行う。これが同期に必須の
//   単一マーカーで、誤検出しにくい (README の導入手順とも一致)。慣例どおり tools/cross-review.sync.json に
//   置かれる前提だが、ルート直下に置かれていても拾えるようにする。
// - 実際の同期は各プロジェクトに同梱された版ではなく、この checkout の cross-review.sync.js (runSync) を
//   再利用して回す。導入先の sync スクリプトが古くても、最新ロジックで一括反映できる。各プロジェクトの
//   マニフェスト (upstream.repo / ref / files) はそのプロジェクト固有なので尊重する。
// - --check モードでは各プロジェクトのマニフェスト検査 (sync の --check-manifest) も併せて回す。一括検査は
//   「取り込み先が上流に追いつけているか」を見る用途なので、ファイルのドリフトと配布物の取りこぼしを
//   1 回で拾えるようにする。未登録の件数は集計行に出すが、ドリフトではないので終了コードには含めない。
// - 各プロジェクトの stderr はこのツールが捕捉するので、runSync の 1 行警告 ([cross-review] で始まる行)
//   はそのままでは消える。集計行の直後へインデントして出し、どのプロジェクトの警告かを対応付ける。
//   検査が回らなかった (雛形が無い / 読めない / 構造不正) ときは集計行にも「マニフェスト検査スキップ」を
//   出し、未登録 0 件の正常な検査と見分けられるようにする。
// - --global-skill は、相互レビューの汎用ルールを各リポジトリの CLAUDE.md へ写す運用をやめ、ホームの
//   グローバル SKILL 1 箇所に集約するための配布口。配布元はこの checkout の SKILL で、配布先は
//   GLOBAL_SKILL_TARGETS に持つ。Codex 側 (~/.codex/skills/) はレビュー時にこの写しを読むため、古いままだと
//   旧ルールで動く。ただし Codex を入れていない環境にディレクトリを作らないよう、requireDir がある配布先は
//   その親ディレクトリが既にあるときだけ配る。
// - 1 プロジェクトの失敗 (マニフェスト不正、上流取得失敗等) で全体を止めない。各プロジェクトを独立に回し、
//   最後に集計を出す。終了コードは「いずれかが失敗」または「--check でいずれかにドリフト」で 1。
// - 副作用 (ディレクトリ走査、runSync 実行) は deps で差し替え可能にし、純粋なロジック (引数解析、
//   プロジェクトルート算出、結果分類、集計) を単体テストで固定する。cross-review.sync.js と同じ方針。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SYNC_MANIFEST_FILENAME = 'cross-review.sync.json';
const DEFAULT_DEPTH = 4;
// 走査時にたどらないディレクトリ (生成物、VCS、隠しディレクトリ)。
const SKIP_DIRS = new Set(['node_modules', '.git']);

// --global-skill の配布元 (この checkout のルートからの相対)。一括同期と同じく、配布するのは
// 各プロジェクトに同梱された版ではなくこの checkout の版とする。
const SKILL_SOURCE = ['.claude', 'skills', 'cross-review', 'SKILL.md'];
// --global-skill の配布先 (ホームからの相対)。requireDir が非 null の配布先は、そのディレクトリが
// 既にあるときだけ配る (そのツールを入れていない環境に配布先ディレクトリを作らないため)。
const GLOBAL_SKILL_TARGETS = [
  { to: ['.claude', 'skills', 'cross-review', 'SKILL.md'], requireDir: null },
  { to: ['.codex', 'skills', 'cross-review', 'SKILL.md'], requireDir: ['.codex', 'skills'] },
];
// planGlobalSkill が返す状態の表示名。
const GLOBAL_STATUS_LABEL = { create: '新規', update: '更新', unchanged: '一致', skip: '対象外' };

const USAGE = [
  'ai-cross-review 一括同期ツール (作業ルート配下の導入プロジェクトをまとめて同期する)',
  '',
  '使い方: node tools/cross-review.sync-all.js [root] [options]',
  '',
  'options:',
  '  --root <path>   走査するルート (位置引数 root と同義。既定: cwd)',
  '  --check         各プロジェクトをドリフト検査のみ。書き込まず、差分があれば exit 1',
  '  --dry-run       各プロジェクトで何が変わるかだけ表示する (書き込まない)',
  '  --ref <ref>     取り込む上流 ref を全プロジェクト共通で上書き (ブランチ / タグ / コミット)',
  '  --depth <n>     走査の最大深さ (既定 4)',
  '  --list          検出したプロジェクトを列挙するだけ (同期しない)',
  '  --global-skill  相互レビュー SKILL をホームのグローバル配置 (~/.claude/skills、~/.codex/skills) へ配る',
  '  -h, --help      このヘルプを表示',
  '',
  '判定: cross-review.sync.json (同期マニフェスト) を持つディレクトリを導入プロジェクトとみなす。',
  '--check では各プロジェクトのマニフェスト検査 (sync --check-manifest) も併せて回す。',
  '--global-skill は単独 (--root 無し) でも動き、そのときはプロジェクト走査をせずグローバル配布だけを行う。',
  '~/.codex/skills/ は既に存在するときだけ配る (Codex 未導入の環境にディレクトリを作らないため)。',
  '',
  '例:',
  '  node tools/cross-review.sync-all.js --root /Develop --check   # /Develop 配下のドリフト検査',
  '  node tools/cross-review.sync-all.js --root /Develop           # /Develop 配下を一括同期',
  '  node tools/cross-review.sync-all.js --global-skill            # グローバル SKILL だけを配る',
].join('\n');

// process.argv.slice(2) を受け取り、モードとオプションを解釈する。
function parseArgs(argv) {
  const args = argv.slice();
  const out = { root: null, mode: 'sync', dryRun: false, ref: null, depth: DEFAULT_DEPTH, list: false, globalSkill: false, help: false, error: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--check') {
      out.mode = 'check';
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--list') {
      out.list = true;
    } else if (a === '--global-skill') {
      out.globalSkill = true;
    } else if (a === '--root') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) out.error = '--root にはディレクトリパスが必要です';
      else { out.root = v; i++; }
    } else if (a.startsWith('--root=')) {
      const v = a.slice('--root='.length);
      if (!v) out.error = '--root にはディレクトリパスが必要です';
      else out.root = v;
    } else if (a === '--ref') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) out.error = '--ref には ref (ブランチ / タグ / コミット) が必要です';
      else { out.ref = v; i++; }
    } else if (a.startsWith('--ref=')) {
      const v = a.slice('--ref='.length);
      if (!v) out.error = '--ref には ref が必要です';
      else out.ref = v;
    } else if (a === '--depth') {
      const v = args[i + 1];
      const n = Number(v);
      if (!v || v.startsWith('-') || !Number.isInteger(n) || n < 0) out.error = '--depth には 0 以上の整数が必要です';
      else { out.depth = n; i++; }
    } else if (a.startsWith('--depth=')) {
      const v = a.slice('--depth='.length);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) out.error = '--depth には 0 以上の整数が必要です';
      else out.depth = n;
    } else if (a.startsWith('-')) {
      out.error = `不明なオプション: ${a}`;
    } else if (out.root == null) {
      // 位置引数: 走査ルート。--root と同義 (片方だけ指定する想定)。
      out.root = a;
    } else {
      out.error = `余計な引数: ${a}`;
    }
  }
  return out;
}

// マニフェストのパスから、そのプロジェクトのルート (to パスの基準) を求める。
// 慣例どおり tools/cross-review.sync.json なら tools の 1 つ上、そうでなければマニフェストの置き場所。
function projectRootForManifest(manifestPath) {
  const dir = path.dirname(manifestPath);
  if (path.basename(dir) === 'tools') return path.dirname(dir);
  return dir;
}

// root 配下を深さ制限付きで走査し、cross-review.sync.json を持つディレクトリ (= 導入プロジェクト) の
// マニフェストパス一覧を返す。deps.listDir(dir) は { name, isDirectory(), isFile() } の配列を返す
// (既定は fs.readdirSync withFileTypes)。読めないディレクトリはスキップする。
function findManifests(root, maxDepth, deps = {}) {
  const listDir = deps.listDir || ((d) => fs.readdirSync(d, { withFileTypes: true }));
  const found = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = listDir(dir);
    } catch {
      return; // 読めないディレクトリは黙ってスキップ
    }
    let manifestHere = null;
    const subdirs = [];
    for (const ent of entries) {
      if (ent.isFile && ent.isFile() && ent.name === SYNC_MANIFEST_FILENAME) {
        manifestHere = path.join(dir, ent.name);
      } else if (ent.isDirectory && ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        subdirs.push(ent.name);
      }
    }
    if (manifestHere) {
      const key = path.resolve(projectRootForManifest(manifestHere));
      // 同一プロジェクトで tools/ 直下とルート直下の両方に置かれていても 1 回だけ。
      if (!seen.has(key)) { seen.add(key); found.push(manifestHere); }
    }
    // depth は root を 0 とした探索深さ。maxDepth に達したらサブディレクトリはたどらない
    // (--depth 0 は root 直下のみ。tools/cross-review.sync.json を拾うには最低 depth 2 が要る)。
    if (depth >= maxDepth) return;
    for (const name of subdirs) walk(path.join(dir, name), depth + 1);
  };
  walk(root, 0);
  return found.sort();
}

// マニフェストの内容が cross-review.sync.js 用 (upstream / files を持つ) かを判定する。
// マニフェスト内容を 3 通りに分類する:
//   'ok'      : upstream / files を持つ同期対象マニフェスト。
//   'skip'    : valid JSON だが新スキーマでない (旧 {source,ref,commit} の独自 sync 来歴や、別用途で
//               たまたま同名のファイル)。一括同期では対象外として skip する (ハードエラーにしない)。
//   'invalid' : 読めない (IO/権限エラー = raw が null) / JSON 構文エラー (破損)。正式導入先の設定破損を
//               skip で握り潰すと CI の sync-all --check で検出できなくなるため、error/exit 1 に分ける。
function classifyManifestRaw(raw) {
  if (raw == null) return 'invalid';                          // 読めない (read error)
  let obj;
  try { obj = JSON.parse(raw); } catch { return 'invalid'; }  // JSON 構文エラー (破損)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'skip'; // valid JSON だが新スキーマでない
  return (obj.upstream !== undefined || obj.files !== undefined) ? 'ok' : 'skip';
}

// 後方互換: 「同期対象 (ok) か」を真偽で返す薄いラッパ。破損 (invalid) と対象外 (skip) は
// どちらも false になる点に注意 (両者の区別が要る runAll では classifyManifestRaw を直接使う)。
function isSyncManifestContent(raw) {
  return classifyManifestRaw(raw) === 'ok';
}

// runSync の戻り値 (result) と捕捉した exit コードから、表示用のステータスを決める。
//   error        : マニフェスト不正、上流取得失敗、例外 (result が null か code===2、または threw)
//   drift        : --check で上流と差分あり
//   clean        : --check で差分なし
//   updated      : 同期で 1 件以上書き込んだ
//   would-update : --dry-run で 1 件以上変わる
//   unchanged    : 変更なし
function classifyResult({ mode, dryRun }, { result, code, threw }) {
  if (threw || result == null) return { status: 'error', changed: 0 };
  const changed = Array.isArray(result.results)
    ? result.results.filter((r) => r.status !== 'unchanged').length
    : 0;
  if (mode === 'check') {
    if (code === 1 || result.drift) return { status: 'drift', changed };
    if (code && code !== 0) return { status: 'error', changed };
    return { status: 'clean', changed };
  }
  if (code && code !== 0) return { status: 'error', changed };
  if (dryRun) return { status: changed > 0 ? 'would-update' : 'unchanged', changed };
  const wrote = Array.isArray(result.wrote) ? result.wrote.length : changed;
  return { status: wrote > 0 ? 'updated' : 'unchanged', changed };
}

// 1 プロジェクトを同期する (実体)。cross-review.sync.js の runSync を再利用し、その出力と
// process.exitCode を捕捉する (runSync は失敗時に process.exitCode を立てる仕様のため)。
// deps.runSync を渡すとテストから差し替えられる。
function syncOne(manifestPath, opts, deps = {}) {
  const runSync = deps.runSync || require('./cross-review.sync.js').runSync;
  const root = projectRootForManifest(manifestPath);
  const out = [];
  const err = [];
  // --check のときはマニフェスト検査も回す。一括検査は「取り込み先が上流に追いつけているか」を見る
  // 用途なので、ファイルのドリフトと配布物の取りこぼしを 1 回で拾う。
  const subOpts = { mode: opts.mode, dryRun: opts.dryRun, ref: opts.ref, manifestPath, root, checkManifest: opts.mode === 'check' };
  // runSync は process.exitCode を破壊的に設定するので、退避→0 リセット→実行→読み出し→復元する。
  const prevExit = process.exitCode;
  process.exitCode = 0;
  let result = null;
  let threw = null;
  try {
    result = runSync(subOpts, { out: (s) => out.push(s), err: (s) => err.push(s) });
  } catch (e) {
    threw = e;
  }
  const code = process.exitCode || 0;
  process.exitCode = prevExit;
  return { manifestPath, root, result, code, threw, out: out.join(''), err: err.join('') };
}

// --global-skill の配布先ごとに、配布してよいか (requireDir の有無) を判定する。
// 戻り値: [{ path, available, reason }]。targets 未指定なら既定の GLOBAL_SKILL_TARGETS を使う。
function resolveGlobalTargets(home, targets, exists) {
  const list = Array.isArray(targets) && targets.length ? targets : GLOBAL_SKILL_TARGETS;
  return list.map((t) => {
    const dest = path.join(home, ...t.to);
    if (t.requireDir) {
      const req = path.join(home, ...t.requireDir);
      if (!exists(req)) return { path: dest, available: false, reason: `${req} が無いため配布しない` };
    }
    return { path: dest, available: true, reason: null };
  });
}

// グローバル SKILL の配布プランを算出する純粋関数 (書き込みはしない)。
// 戻り値: [{ path, status, reason }]。status は create (未配置) / update (内容が古い) /
// unchanged (一致) / skip (requireDir が無いので配らない)。
function planGlobalSkill({ home, targets, exists, readFile, skillText }) {
  return resolveGlobalTargets(home, targets, exists).map((t) => {
    if (!t.available) return { path: t.path, status: 'skip', reason: t.reason };
    if (!exists(t.path)) return { path: t.path, status: 'create', reason: '未配置' };
    let current;
    try {
      current = readFile(t.path);
    } catch (err) {
      // 配置済みだが読めない (権限、壊れたリンク等)。一致を確かめられない以上、古い写しが残る方が
      // 害が大きいので更新扱いにして上書きを試す。
      return { path: t.path, status: 'update', reason: `既存を読めないため上書き (${(err && err.message) || 'read error'})` };
    }
    if (current === skillText) return { path: t.path, status: 'unchanged', reason: '最新と一致' };
    return { path: t.path, status: 'update', reason: '内容が古い' };
  });
}

// 配布先をホーム基準の短い表記 (~/...) にする。集計行が絶対パスで長くなるのを避けるため。
function formatGlobalPath(home, p) {
  const rel = path.relative(home, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return `~${path.sep}${rel}`;
}

// グローバル SKILL の配布を実行する。--check / --dry-run では書き込まない。
// 戻り値は集計アイテム { kind: 'global', project, status, changed, plans } (エラー時は message 付き)。
// 走査対象のプロジェクトと同じ集計に並べるため、status は他の項目と同じ語彙 (updated / unchanged /
// would-update / drift / clean / error) に寄せる。
function runGlobalSkill(opts, deps = {}) {
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const home = deps.home || os.homedir();
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps.writeFile || ((p, c) => fs.writeFileSync(p, c));
  const mkdir = deps.mkdir || ((d) => fs.mkdirSync(d, { recursive: true }));
  const scriptDir = deps.scriptDir || __dirname;
  const sourcePath = path.join(path.resolve(scriptDir, '..'), ...SKILL_SOURCE);
  const errorItem = (message) => ({ kind: 'global', project: 'global', status: 'error', changed: 0, message, plans: [] });

  if (!exists(sourcePath)) return errorItem(`配布元の SKILL がありません: ${sourcePath}`);
  let skillText;
  try {
    skillText = readFile(sourcePath);
  } catch (err) {
    return errorItem(`配布元の SKILL を読めません: ${sourcePath} (${(err && err.message) || 'read error'})`);
  }

  const plans = planGlobalSkill({ home, targets: deps.targets, exists, readFile, skillText });
  writeOut(`グローバル SKILL の配布元: ${sourcePath}\n`);
  for (const p of plans) {
    if (p.status === 'skip') writeErr(`[cross-review] グローバル SKILL を配布しません: ${formatGlobalPath(home, p.path)} (${p.reason})\n`);
  }

  const pending = plans.filter((p) => p.status === 'create' || p.status === 'update');
  const project = `global: ${plans.map((p) => `${formatGlobalPath(home, p.path)} (${GLOBAL_STATUS_LABEL[p.status] || p.status})`).join(', ')}`;
  // --check は --dry-run より優先する (cross-review.sync.js と同じ規則)。
  if (opts.mode === 'check') {
    return { kind: 'global', project, status: pending.length ? 'drift' : 'clean', changed: pending.length, plans };
  }
  if (opts.dryRun) {
    return { kind: 'global', project, status: pending.length ? 'would-update' : 'unchanged', changed: pending.length, plans };
  }
  let wrote = 0;
  try {
    for (const p of pending) {
      mkdir(path.dirname(p.path));
      writeFile(p.path, skillText);
      wrote++;
    }
  } catch (err) {
    return { ...errorItem(`グローバル SKILL の配布に失敗しました: ${(err && err.message) || 'write error'}`), plans };
  }
  return { kind: 'global', project, status: wrote > 0 ? 'updated' : 'unchanged', changed: wrote, plans };
}

const STATUS_LABEL = {
  error: 'エラー',
  drift: 'ドリフト',
  clean: '一致',
  updated: '更新',
  'would-update': '更新予定',
  unchanged: '変更なし',
  skipped: '対象外',
};

// 集計結果を人間向けの文字列に整形する (テスト可能な純関数)。
// rootLabel が null のときは走査していない (--global-skill 単独) ので、走査ルートの見出しを出さない。
// 件数はプロジェクト行だけを数える (kind: 'global' の行は導入プロジェクトではないため)。
// item.warnings があれば、そのプロジェクトの行の直後にインデントして並べる (どのプロジェクトの警告かを
// 対応付けられるようにするため)。
function formatSummary(rootLabel, items) {
  const lines = [];
  if (rootLabel != null) {
    lines.push(`走査ルート: ${rootLabel}`);
    lines.push(`検出した導入プロジェクト: ${items.filter((it) => it.kind !== 'global').length} 件`);
    lines.push('');
  }
  for (const it of items) {
    const label = STATUS_LABEL[it.status] || it.status;
    let detail = '';
    if (it.status === 'updated' || it.status === 'would-update' || it.status === 'drift') {
      detail = ` (${it.changed} 件)`;
    } else if (it.status === 'error' || it.status === 'skipped') {
      detail = it.message ? ` (${it.message})` : '';
    }
    // 未読の移行ノート (取り込み先で人がやる作業) があった件数。同期の本文は各プロジェクトの stderr に
    // 出るが、一括同期では流れて見落としやすいので集計にも残す。
    const note = it.migrations > 0 ? ` (移行ノート ${it.migrations} 件)` : '';
    // 上流の雛形にあって files[] に無い配布物の件数 (--check で検査したときだけ入る)。取り込み先が
    // 足すかどうかを判断する材料なので、ドリフトとは別に出す。
    const missing = it.missingManifest > 0 ? ` (マニフェスト未登録 ${it.missingManifest} 件)` : '';
    // マニフェスト検査そのものが回らなかった (雛形が無い / 読めない / 構造不正) ことを明示する。
    // 「未登録 0 件」と「検査できていない」を集計行だけで見分けられるようにするため。理由は直後の
    // 警告行に出る。
    const skipped = it.manifestCheckSkipped ? ' (マニフェスト検査スキップ)' : '';
    lines.push(`  [${label}]${detail} ${it.project}${note}${missing}${skipped}`);
    for (const w of Array.isArray(it.warnings) ? it.warnings : []) lines.push(`    ${w}`);
  }
  return lines.join('\n') + '\n';
}

// runSync が stderr へ出した 1 行警告 ([cross-review] で始まる行) を取り出す純粋関数。
// 一括同期では各プロジェクトの stderr を捕捉してしまうため、そのままでは雛形が無い / 読めない / 構造が
// 不正といった警告が握り潰され、正常な検査と区別できなくなる。集計へ添えるためにここで拾う。
// 未読の移行ノートの全文ブロック (先頭行が「[cross-review] 未読の移行ノート ...」) は、件数が集計行の
// 「(移行ノート N 件)」に出るうえ本文が長いので対象にしない。
function collectSyncWarnings(err) {
  return String(err || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[cross-review] ') && !line.startsWith('[cross-review] 未読の移行ノート'));
}

// 1 件分のエラーメッセージを取り出す (runSync は stderr に出して null を返す。例外時は message)。
function errorMessageOf({ threw, err }) {
  if (threw) return (threw && threw.message) || String(threw);
  const trimmed = (err || '').trim();
  if (!trimmed) return '同期に失敗しました';
  // 複数行のときは最終行 (最も具体的な理由) を採る。
  const parts = trimmed.split('\n').filter(Boolean);
  return parts[parts.length - 1];
}

// 一括同期の本体。副作用は deps で差し替え可能。
// 戻り値: { items, exitCode }。process.exitCode も設定する。
function runAll(opts, deps = {}) {
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const find = deps.findManifests || ((root, depth) => findManifests(root, depth, deps));
  const doSync = deps.syncOne || ((mp, o) => syncOne(mp, o, deps));
  // マニフェスト内容の先読み (同期対象判定用)。読めなければ null → 同期対象外 (skip) 扱い。
  const readManifest = deps.readManifest || ((mp) => { try { return fs.readFileSync(mp, 'utf8'); } catch { return null; } });
  const doGlobalSkill = deps.runGlobalSkill || ((o) => runGlobalSkill(o, deps));

  // --global-skill を --root 無しで指定したときは、グローバル配布だけを行う (走査しない)。
  // 走査ルートの既定は cwd なので、明示が無ければ「配布だけしたい」と解釈する。
  const globalOnly = opts.globalSkill && opts.root == null;
  const root = path.resolve(opts.root || '.');
  const manifests = globalOnly ? [] : find(root, opts.depth);

  if (!globalOnly && manifests.length === 0) {
    writeErr(`導入プロジェクト (${SYNC_MANIFEST_FILENAME} を持つディレクトリ) が見つかりません: ${root}\n`);
    process.exitCode = 1;
    return { items: [], exitCode: 1 };
  }

  if (opts.list) {
    const listed = [];
    if (!globalOnly) {
      writeOut(`走査ルート: ${root}\n検出した導入プロジェクト: ${manifests.length} 件\n\n`);
      for (const mp of manifests) {
        writeOut(`  ${projectRootForManifest(mp)}\n`);
        listed.push({ project: projectRootForManifest(mp), status: 'listed', changed: 0 });
      }
    }
    if (opts.globalSkill) {
      const home = deps.home || os.homedir();
      const exists = deps.exists || ((p) => fs.existsSync(p));
      writeOut(`${listed.length ? '\n' : ''}グローバル SKILL の配布先:\n`);
      for (const t of resolveGlobalTargets(home, deps.targets, exists)) {
        writeOut(`  ${formatGlobalPath(home, t.path)}${t.available ? '' : ` (対象外: ${t.reason})`}\n`);
        listed.push({ kind: 'global', project: formatGlobalPath(home, t.path), status: 'listed', changed: 0 });
      }
    }
    return { items: listed, exitCode: 0 };
  }

  const items = [];
  let anyError = false;
  let anyDrift = false;
  for (const mp of manifests) {
    const project = projectRootForManifest(mp);
    const kind = classifyManifestRaw(readManifest(mp));
    // 破損 (読めない / JSON 構文エラー) は正式導入先の設定崩れなので skip せず error/exit 1 にする
    // (CI の sync-all --check で検出できるようにする)。1 件の error で他プロジェクトは止めない。
    if (kind === 'invalid') {
      items.push({ project, status: 'error', changed: 0, message: `${SYNC_MANIFEST_FILENAME} を読み込めない、または JSON として不正です` });
      anyError = true;
      continue;
    }
    // upstream / files を持たないマニフェスト (旧 {source,ref,commit} の独自 sync 来歴や別用途の
    // 同名ファイル) は同期対象外として skip する。1 件の非準拠で全体を失敗させない。
    if (kind === 'skip') {
      items.push({ project, status: 'skipped', changed: 0, message: 'upstream/files を持たないため同期対象外' });
      continue;
    }
    const res = doSync(mp, opts);
    const { status, changed } = classifyResult(opts, res);
    const item = { project, status, changed };
    // runSync が表示した未読移行ノートの件数 (無い / 失敗時は 0)。
    const migrations = res.result && Array.isArray(res.result.migrations) ? res.result.migrations.length : 0;
    if (migrations > 0) item.migrations = migrations;
    // マニフェスト未登録の配布物の件数 (--check のときだけ検査される)。取り込み先の判断待ちであって
    // ドリフトではないので、集計に出すだけで exit コードには含めない。
    const missing = res.result && Array.isArray(res.result.missingManifestEntries) ? res.result.missingManifestEntries.length : 0;
    if (missing > 0) item.missingManifest = missing;
    // マニフェスト検査が回らなかったとき (雛形が無い / 読めない / 構造不正) は、未登録 0 件と混同しない
    // よう集計行に印を付ける。
    if (res.result && res.result.manifestCheckWarning) item.manifestCheckSkipped = true;
    // runSync の 1 行警告は捕捉した stderr に埋もれるので、集計へ引き上げる (全モード共通)。
    const warnings = collectSyncWarnings(res.err);
    if (warnings.length) item.warnings = warnings;
    if (status === 'error') { item.message = errorMessageOf(res); anyError = true; }
    if (status === 'drift') anyDrift = true;
    items.push(item);
  }

  if (opts.globalSkill) {
    // グローバル SKILL が古いのは取り込み先のドリフトと同じ扱いにする (--check なら exit 1)。
    const globalItem = doGlobalSkill(opts);
    items.push(globalItem);
    if (globalItem.status === 'error') anyError = true;
    if (globalItem.status === 'drift') anyDrift = true;
  }

  writeOut(formatSummary(globalOnly ? null : root, items));

  const exitCode = anyError || (opts.mode === 'check' && anyDrift) ? 1 : 0;
  process.exitCode = exitCode;
  return { items, exitCode };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE + '\n'); return; }
  if (opts.error) { process.stderr.write(`${opts.error}\n\n${USAGE}\n`); process.exitCode = 2; return; }
  runAll(opts);
}

module.exports = {
  parseArgs,
  projectRootForManifest,
  findManifests,
  classifyManifestRaw,
  isSyncManifestContent,
  classifyResult,
  syncOne,
  resolveGlobalTargets,
  planGlobalSkill,
  formatGlobalPath,
  runGlobalSkill,
  formatSummary,
  collectSyncWarnings,
  errorMessageOf,
  runAll,
  SYNC_MANIFEST_FILENAME,
  SKILL_SOURCE,
  GLOBAL_SKILL_TARGETS,
  DEFAULT_DEPTH,
  USAGE,
};

if (require.main === module) main();
