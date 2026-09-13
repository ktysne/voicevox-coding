#!/usr/bin/env node
// tools/cross-review.js
//
// Claude ↔ Codex の相互レビューを 1 コマンドで回す CLI ブリッジ。
// 「片方の AI で実装 → もう片方の AI でレビュー」を、チャットログを手でコピーせず、
// git の差分を直接レビュアー CLI へ渡して実行する。
//
// 使い方:
//   node tools/cross-review.js codex            # 現在のブランチ (既定 base との差分) を Codex がレビュー
//   node tools/cross-review.js claude           # 同上を Claude がレビュー
//   node tools/cross-review.js subagent         # 外部 CLI を起動せずレビュープロンプトを stdout に出す (リモートコントロール用)
//   node tools/cross-review.js codex --fix      # Codex がレビューに加え検出事項を直接修正 (作業ツリー編集)
//   node tools/cross-review.js codex --fix --instructions notes.md  # レビュアーの指摘 (notes.md) を渡して Codex に修正させる
//   node tools/cross-review.js codex --uncommitted    # 未コミットの作業ツリー差分をレビュー
//   node tools/cross-review.js claude --base develop  # 比較先ブランチを変更
//   node tools/cross-review.js state            # この枝の往復回数・直前レビュー SHA・非対応指摘を表示
//   node tools/cross-review.js dismiss "<要約>" # 非対応と判断した指摘を記録し、以降再指摘させない
//   node tools/cross-review.js comment --round 1  # 判断ファイルと検証出力から PR コメント本文を生成
//   npm run review:codex                        # = node tools/cross-review.js codex
//   npm run review:codex:fix                    # = node tools/cross-review.js codex --fix
//   npm run review:claude -- --uncommitted      # npm 経由で追加引数を渡す (-- が必要)
//
// 設計判断:
// - 依存パッケージを追加しない (Node 標準 API のみ)。
// - codex / claude いずれも「観点 + スコープ + 差分本文 + モード別指示」を stdin で渡し、
//   汎用 `codex exec` / `claude -p` を使う。codex の専用サブコマンド `codex exec review` は
//   v0.137.0 で `--uncommitted` / `--base` が `[PROMPT]` と排他になり、プロジェクト固有の
//   チェックリスト (.cross-review.md) を同時に渡せなくなったため、汎用 exec + 自前の差分埋め込みに統一した。
// - レビューのみ (既定) は codex を `-s read-only` で起動し、ファイルを書き換えさせない。
//   `--fix` 指定時のみ codex を `-s workspace-write` で起動し、検出事項を作業ツリーへ直接
//   修正させる (相互レビューフローの 3B「レビュー + 修正を依頼」)。claude CLI 経路 (claude -p) の
//   自動修正は未対応 (--fix は codex / subagent のみ)。
// - codex の起動は、claude-codex-bridge の起動スクリプト (codex-agent.sh) があればそれを経由する。
//   モデル、推論 effort、認証ホーム (CODEX_HOME) を定義ファイル `~/.claude/gpt-agents/<name>.md` 側で
//   一元管理し、Claude Code のサブエージェント経由の起動と条件を揃えるため。サンドボックスも定義側の
//   `codex_sandbox` で決まるので、read-only の `codex-review` と workspace-write の `codex-subagent` を
//   --fix の有無で選び分けたうえ、起動前に定義ファイルの `codex_sandbox` を読んで --fix の有無と
//   一致するかを検査し (食い違えばエラー終了)、「レビューのみは read-only」の不変条件を保つ。
//   bridge は codex への追加引数を受け付けないため、承認方針はスクリプト本文の指定がすべてになる。
//   スクリプトが `approval_policy=never` を明示していない場合は bridge を使わず直接起動へ戻し、
//   「Codex の承認は never 固定」を保つ。スクリプトが無い環境でも従来どおり直接起動する
//   (`--no-codex-agent` で明示的に直接起動へ戻せる)。
// - Codex が利用上限に達したときは、レビューを失敗で終わらせず subagent 経路と同じプロンプトを
//   ファイルへ書き出し、終了コード 75 で「客観サブエージェントへ渡してください」と促す
//   (`--no-fallback` で従来どおりの失敗終了に戻せる)。
// - リモートコントロール環境では codex/claude スタンドアロン CLI を spawn できない。その場合は
//   reviewer に `subagent` を指定すると、外部プロセスを起動せず、組み立てたレビュープロンプト
//   (観点 + スコープ + 差分本文 + モード別指示) を stdout に出すだけにする。呼び出し側 (Claude) が
//   その出力を Agent ツールの客観レビュー用サブエージェントへ渡してレビューさせる
//   (Codex の代わりに「Claude の客観的な観点を持つサブエージェント」がレビュアーになる)。
//   プロンプト組み立て、観点解決、差分収集は codex/claude 経路と同一なので観点が揺れない。
// - プロジェクト固有のレビュー観点は、リポジトリ直下の `.cross-review.md` を単一ソースとして
//   読み込み、各レビュアー (codex / claude / subagent) へ同じチェックリストとして添える (無ければ汎用観点 GENERIC_CHECKLIST へ
//   フォールバック)。この CLI は engine 部分が完全に汎用なので、他リポへ `tools/cross-review.js` を
//   コピーし `.cross-review.md` を置くだけで観点を差し替えて再利用できる。観点を更新したら
//   `.cross-review.md` を直す。
// - レビュアー個別の「申し送り、重点指摘」は `--instructions <path>` で渡す。これは観点
//   (.cross-review.md) を置き換えず、それに加えてプロンプトへ添える別系統。一方のレビュアーが
//   出した指摘をファイルに書き、`codex --fix --instructions <path>` で他方に直接修正させる用途を
//   一級でサポートする (この目的で CROSS_REVIEW_CHECKLIST を流用すると観点が消えるため非推奨)。
// - 往復回数、直前レビュー時の HEAD、非対応と判断した指摘は、リポジトリ直下の
//   `.cross-review-state.json` にブランチ単位で記録する。これらはブランチごとに決まる値で、
//   会話の外に置かないと妥当性確認のたびに人が SHA を控え直すことになるため。状態遷移は純粋関数
//   (nextState / withDismissed / withoutBranch) に閉じ、読み書きだけを I/O 側 (readState /
//   writeState) に置く。ファイルが壊れているときは警告して無視し、書き戻さない (記録を消さない)。
//   書き込みは必ず「書く直前に読み直した状態」を基にする。レビュアーの実行中に別プロセスが
//   dismiss や別ブランチのレビュー完了を書いていることがあり、起動前のスナップショットで
//   上書きするとその更新が消えるため。往復を CLI が観測できない経路 (利用上限フォールバック) は
//   記録せず、レビューを終えた利用者が `state --mark` で進める。
// - 既定 base は「前回レビュー SHA → PR の base ブランチ → origin/main → ローカル main」の順で
//   解決する。前者ほど差分が小さく、かつ人の指定なしで決まる情報だから。決めた base と解決方法は
//   差分サイズと同じ stderr 行に必ず出し、stale な比較に気づけるようにする。
// - 往復を記録できたときは、開始時のブランチ名を安全化したディレクトリへ、レビュアーの出力
//   (subagent 経路は渡したプロンプト) と実行経路のメタ情報を保存する。PR コメントの定型は
//   主セッションが書く判断ファイルと検証出力からの機械的な変換なので、材料を会話の外へ残しておく。
//   保存の失敗はレビューを失敗にしない (出力は端末に出ているため)。`comment` は判断ファイルが
//   揃ったときだけ本文を生成し、既定では `gh pr comment --body-file` のコマンド例を出す。
//   `--post` 指定時は生成本文をいったん保存してから同じメモリ本文を標準入力で投稿し、
//   投稿に失敗した場合は保存した本文を削除する。
// - レビュー実行前に PR の有無を `gh pr view` で確かめ、無いと分かったときだけ警告する。
//   PR コメントを共有ログにする運用なので、PR 未作成のまま往復を始めると記録が揮発する。
//   gh 不在やネットワーク断は「分からない」に倒して黙って続行する (リモートを持たない
//   取り込み先を止めないため)。PR の番号と base ブランチは同じ 1 回の呼び出しから得る。
// - 差分サイズが閾値を超えたときは即中断せず、ファイル単位の要約閾値を段階的に下げて縮退を試す。
//   閾値をわずかに超えただけの差分で再実行を強いると、差分収集を二重に行うことになるため。
//   縮退しても収まらないときだけ中断する (--strict-diff-guard で従来の即中断に戻せる)。
// - claude の --uncommitted は Codex の --uncommitted (staged+unstaged+untracked) と結果を
//   揃えるため、tracked 変更 (git diff HEAD) に加えて未追跡ファイルも new file 差分として含める。
// - 前提: codex / claude レビュアーは「スタンドアロン CLI」が PATH にあること
//   (VS Code プラグイン / デスクトップアプリとは別物)。CLI レビューはレビュアー CLI が
//   ネットワーク/API 接続を使うため、必要に応じてサンドボックス無効、ネットワーク許可で起動する
//   (cross-review フロー ドキュメント参照)。
//   subagent レビュアーは外部 CLI を起動しない (プロンプトを stdout に出すだけ) ので CLI 不要。

'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

// レビュー観点はプロジェクト固有なので、リポジトリ直下の `.cross-review.md` を単一ソースとして
// 読み込む。この CLI を他リポへコピーしても `.cross-review.md` を置くだけで観点を差し替えられる。
// 解決順は loadChecklist 参照: 環境変数 CROSS_REVIEW_CHECKLIST(パス) → <cwd>/.cross-review.md →
// <スクリプト>/../.cross-review.md → GENERIC_CHECKLIST。このリポジトリの観点は `.cross-review.md` にある。
const CHECKLIST_FILENAME = '.cross-review.md';

// 除外パターンファイル名。観点 (.cross-review.md) と同じ解決順で探す。
const IGNORE_FILENAME = '.cross-review-ignore';

// 状態ファイル名。ブランチ単位で「往復回数 / 直前レビュー時の HEAD / 非対応と判断した指摘」を持つ。
// 観点と違い cwd では探さず、スクリプト位置からリポジトリ直下に固定して解決する
// (サブディレクトリから起動しても同じ枝の記録を読み書きするため。resolveStatePath 参照)。
// git 管理下に置かない前提なので、取り込み先でも .gitignore へ追加する。
const STATE_FILENAME = '.cross-review-state.json';

// レビュー出力と PR コメント生成物の置き場 (リポジトリ直下)。状態ファイルと同じく
// スクリプト位置から解決し、cwd に依存させない (resolveReviewDir 参照)。
// 生成物なので git 管理下に置かない前提。取り込み先でも .gitignore へ追加する。
const REVIEW_DIR_NAME = '.cross-review';

// PR コメントに載せる検証出力の行数上限 (末尾から数える)。長いテスト出力で
// コメントが埋まらないようにするための上限で、切り詰めたときはその旨を本文に書く。
const VERIFY_TAIL_LINES = 200;

// 生成したコメント全体がこの文字数を超えたら警告する。GitHub の上限 65,536 文字に対する
// 余裕分で、投稿すると弾かれる可能性を知らせるだけ (投稿は利用者が行うので実行は止めない)。
const COMMENT_SIZE_WARN_LIMIT = 65000;

// 差分サイズガードの段階的縮退で試す「ファイル単位の要約閾値」(KB)。大きい順に下げる。
// 既定 64KB で全体閾値を超えた差分を、再度 git を叩かずに縮めるための段。
const DIFF_SHRINK_STEPS = [32, 16, 8];

// fetch を省略する環境変数。オフライン作業で毎回 10 秒待たされるのを避ける。
// 「ネットワークに触らない」意味なので、fetch だけでなく gh の呼び出しも省く。
const NO_FETCH_ENV = 'CROSS_REVIEW_NO_FETCH';

// gh から受け取ったブランチ名として許す形。git の引数へ埋める前に検査し、
// `-` 始まりのような「オプションと解釈されうる値」を弾く。
const SAFE_REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// claude-codex-bridge の Codex 起動スクリプト。ホームディレクトリからの相対パスで探す
// (環境変数 CROSS_REVIEW_CODEX_AGENT で明示指定も可能)。
const CODEX_AGENT_SCRIPT_SUBPATH = ['.claude', 'tools', 'codex-agent.sh'];

// bridge 経由で使う定義名。サンドボックスは定義ファイル側の codex_sandbox で決まるため、
// 「レビューのみは read-only、--fix のときだけ workspace-write」の不変条件は、定義名の選択と
// 起動前の codex_sandbox 検査 (checkCodexAgentSandbox) の両方で守る。
// codex-review = read-only / codex-subagent = workspace-write。
const CODEX_AGENT_REVIEW_NAME = 'codex-review';
const CODEX_AGENT_FIX_NAME = 'codex-subagent';

// bridge の定義ファイル置き場。codex-agent.sh と同じく <cwd> → <ホーム> の順で探す
// (プロジェクト定義がユーザ定義を上書きする)。
const CODEX_AGENT_DEF_SUBDIR = ['.claude', 'gpt-agents'];

// 定義ファイルの codex_sandbox が取り得る値。既定は安全側の read-only (bridge 側の既定と揃える)。
const CODEX_SANDBOX_READ_ONLY = 'read-only';
const CODEX_SANDBOX_WORKSPACE_WRITE = 'workspace-write';

// bridge 経由を許す条件。codex-agent.sh は codex への追加引数を受け付けないため、承認方針は
// スクリプト本文の指定がすべてになる。この文字列を明示していないスクリプトは
// 「Codex の承認は never 固定」を保証できないので bridge 経由に使わない。
const APPROVAL_NEVER_MARKER = 'approval_policy=never';

// codex-agent.sh の終了コード。3 = bridge が未導入 (codex コマンドや定義が無い、codex_enabled: false)、
// 75 = Codex が利用上限で実行できなかった。
const CODEX_AGENT_EXIT_MISSING = 3;
const USAGE_LIMIT_EXIT_CODE = 75;

// 直接起動時に利用上限を見分けるための出力パターン。codex-agent.sh 側の判定と同じ語を使う。
// 429 は単語境界で照合し、ID や桁数の一致で誤検出しないようにする。
const USAGE_LIMIT_PATTERN = /usage limit|rate limit|too many requests|\b429\b/i;

// 利用上限の判定に使う出力の保持量 (末尾のみ)。ログ全体を溜め込まないための上限。
const OUTPUT_TAIL_LIMIT = 64 * 1024;

// レビュー出力を `.cross-review/` へ保存するために保持する量の上限。上限判定の末尾 64KB とは別に、
// 保存用は全文を溜める。青天井にすると異常出力でメモリを食い潰すため上限を設け、
// 超えた分は先頭を捨てて末尾を残す (保存時に切り詰めた旨を書き添える)。
const OUTPUT_CAPTURE_LIMIT = 4 * 1024 * 1024;

// 上限超過で先頭を捨てたときに、保存する本文の先頭へ入れる注記。保存ファイルはそのまま
// PR コメントへ転載されるので、「全文ではない」ことがファイル単体で分かるようにする。
// 上限の単位は文字数 (UTF-16 コード単位) であってバイト数ではない。JavaScript の文字列長で数えるのが
// 最も安価で、日本語主体の出力でもメモリ上限の目安 (最大でその 3 倍のバイト数) として足りるため。
const OUTPUT_TRUNCATED_NOTICE = `（レビュー出力が上限 ${groupDigits(OUTPUT_CAPTURE_LIMIT)} 文字を超えたため先頭を切り詰めた。`
  + `保持しているのは末尾 ${groupDigits(OUTPUT_CAPTURE_LIMIT)} 文字）`;

// 文字列の末尾 limit 文字を返す。先頭が下位サロゲート (サロゲートペアの後半) になったら 1 文字捨て、
// 絵文字などの補助文字を境界で割らない (割れたまま書き出すと孤立サロゲートが置換文字になる)。
function tailChars(text, limit) {
  const s = String(text == null ? '' : text);
  if (s.length <= limit) return s;
  let out = s.slice(-limit);
  const first = out.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1);
  return out;
}

// 既定で差分本文から除外するファイル群 (ロックファイル、生成物、ソースマップ)。
// レビュー価値が低くトークンを浪費しがちなので、明示的に除外する。
// パターンはファイル名のみ (どの階層でも一致させたい) で、git パススペックでは
// glob + top マジックワード + `**/` 接頭で再帰一致させる (toExcludePathspecs 参照)。
const DEFAULT_EXCLUDE_PATTERNS = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'go.sum',
  '*.min.js',
  '*.min.css',
  '*.map',
];

// `.cross-review.md` が無いときの汎用フォールバック観点。特定リポに依存しない一般論のみ。
// 「指摘の出し方」を含めるのは、レビュアーが実害の無い細部や運用上到達しない値への指摘に寄りやすく、
// 呼び出し側の裏取りが指摘の選別で埋まるため。裏取りで使う基準を先に渡して出力側で絞る。
const GENERIC_CHECKLIST = [
  'あなたはこのリポジトリのコードレビュアーです。',
  '以下の差分を日本語でレビューし、各指摘に重大度 (blocker / 要修正 / 提案) を付けてください。',
  '問題が無ければその旨も明記してください。',
  '',
  '一般的な観点:',
  '- 正当性: ロジック誤り・境界条件・null/undefined・例外処理やエラーハンドリングの漏れ。',
  '- 回帰: 差分に現れていない既存挙動を壊していないか。',
  '- 後方互換: 永続化フォーマット / 公開 API / 設定スキーマの互換性を壊していないか。',
  '- テスト・lint: 変更に見合うテストがあるか、lint / 型チェック / ビルドを通る変更か。',
  '- スコープ: 無関係なリファクタや不要な変更が混ざっていないか。',
  '',
  '指摘の出し方:',
  '- 指摘は「実害がある (不具合、データ破損、セキュリティ、仕様違反)」「守るべき不変条件の違反」「改善提案」に分類し、重大度順 (blocker、要修正、提案) に並べてください。',
  '- 実際に到達しない入力や、運用上使わない値を前提にした指摘は出さないでください。出す場合は到達経路を示してください。',
  '- blocker と要修正は重大度順に上位 10 件まで詳述し、それを超える分は重大度を保ったまま一覧にまとめてください（「提案」へ格下げしない）。',
  '- 各指摘に、その指摘が当たらない条件 (反例) を一行添えてください。',
  '',
  '(プロジェクト固有の観点は、リポジトリ直下に .cross-review.md を置くと自動で添付されます。)',
].join('\n');

// レビュー観点を解決する。解決順は:
//   1. 環境変数 CROSS_REVIEW_CHECKLIST (パス)
//   2. <cwd>/.cross-review.md            (npm run review:* の通常経路。cwd はパッケージ直下)
//   3. <スクリプト>/../.cross-review.md   (tools/cross-review.js の 1 つ上 = リポジトリ直下。
//                                          cwd がリポ直下でなくても絶対パス等で起動すれば観点を拾える)
//   4. GENERIC_CHECKLIST                  (どれも無ければ汎用観点。起動時に stderr へ警告)
// deps で env / cwd / scriptDir / fs / 警告出力を差し替え可能にする (テストで再現するため)。
function loadChecklist(deps = {}) {
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const scriptDir = deps.scriptDir || __dirname;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const warn = deps.warn || ((m) => process.stderr.write(m));
  const envPath = env.CROSS_REVIEW_CHECKLIST || '';
  const candidates = [];
  if (envPath) candidates.push(envPath);
  candidates.push(path.join(cwd, CHECKLIST_FILENAME));
  candidates.push(path.join(scriptDir, '..', CHECKLIST_FILENAME));
  const seen = new Set();
  for (const p of candidates) {
    if (seen.has(p)) continue; // cwd == リポ直下のときに同一パスを二重判定しない。
    seen.add(p);
    try {
      if (exists(p)) {
        const body = readFile(p).replace(/\s+$/, '');
        if (body.trim()) return body;
      }
    } catch {
      // 読めなければ次の候補 / フォールバックへ進む。
    }
    // 明示指定した CROSS_REVIEW_CHECKLIST が解決できなかったら、黙ってフォールバックせず警告する
    // (誤ったパス / 空ファイルで意図しない観点になる運用事故を検知しやすくするため)。
    if (envPath && p === envPath) {
      warn(`[cross-review] CROSS_REVIEW_CHECKLIST=${envPath} を読めません (存在しない/空/読取不可)。他の候補にフォールバックします。\n`);
    }
  }
  warn(`[cross-review] ${CHECKLIST_FILENAME} が見つかりません。汎用観点でレビューします。\n`);
  return GENERIC_CHECKLIST;
}

// `--instructions <path>` のファイル本文を読む。観点 (.cross-review.md) とは別系統で、
// 「レビュアーからの申し送り、重点指摘」をプロンプトへ追加で添えるためのもの。
// 読めなければ例外を投げ、呼び出し側 (runReview) がエラー終了させる。
// deps.readFile でテストから差し替え可能。
function loadInstructions(instructionsPath, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  return String(readFile(instructionsPath)).replace(/\s+$/, '');
}

// 除外パターン (.cross-review-ignore) を解決して読む。解決順は観点 (loadChecklist) と同じ流儀:
//   1. 環境変数 CROSS_REVIEW_IGNORE (パス)
//   2. <cwd>/.cross-review-ignore
//   3. <スクリプト>/../.cross-review-ignore
// 形式は 1 行 1 パターン、`#` 始まりはコメント、空行無視。見つかった最初の 1 つだけを読む。
// 戻り値は「既定パターン (DEFAULT_EXCLUDE_PATTERNS) + ファイルのパターン」の配列
// (ファイルが無ければ既定のみ)。env 明示指定が読めない場合は警告して次の候補へ (loadChecklist と同じ流儀)。
// deps で env / cwd / scriptDir / fs / 警告出力を差し替え可能にする (テスト用)。
function loadIgnorePatterns(deps = {}) {
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const scriptDir = deps.scriptDir || __dirname;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const warn = deps.warn || ((m) => process.stderr.write(m));
  const envPath = env.CROSS_REVIEW_IGNORE || '';
  const candidates = [];
  if (envPath) candidates.push(envPath);
  candidates.push(path.join(cwd, IGNORE_FILENAME));
  candidates.push(path.join(scriptDir, '..', IGNORE_FILENAME));
  const seen = new Set();
  for (const p of candidates) {
    if (seen.has(p)) continue; // cwd == リポ直下のときに同一パスを二重判定しない。
    seen.add(p);
    let body = null;
    try {
      if (exists(p)) body = readFile(p);
    } catch {
      body = null; // 読めなければ次の候補へ進む。
    }
    if (body != null) {
      const extra = String(body)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
      return DEFAULT_EXCLUDE_PATTERNS.concat(extra);
    }
    // 明示指定した CROSS_REVIEW_IGNORE が解決できなかったら、黙って次へ進まず警告する
    // (誤ったパスで意図しない除外設定になる運用事故を検知しやすくするため)。
    if (envPath && p === envPath) {
      warn(`[cross-review] CROSS_REVIEW_IGNORE=${envPath} を読めません (存在しない/読取不可)。他の候補にフォールバックします。\n`);
    }
  }
  return DEFAULT_EXCLUDE_PATTERNS.slice();
}

// 除外パターン配列を git パススペック群に変換する。ファイル名のみのパターンを
// どの階層でも一致させるため、glob マジックワード + `**/` 接頭で再帰一致させる。
// `top` マジックワードで repo ルート相対に固定する: これが無いとパススペックが cwd 相対になり、
// リポジトリのサブディレクトリから実行したとき除外範囲 (ひいては差分スコープ) がそのサブツリーに
// 狭まってしまう (include 側を `:/` にしているのと対になる)。
// (例: `package-lock.json` → `:(exclude,glob,top)**/package-lock.json`、
//  `*.min.js` → `:(exclude,glob,top)**/*.min.js`)。実挙動はテストと git で確認済み。
function toExcludePathspecs(patterns) {
  return patterns.map((p) => `:(exclude,glob,top)**/${p}`);
}

// レビューのみ (既定) の追加指示。ファイルを変更させない。
const REVIEW_ONLY_INSTRUCTION = [
  '【モード: レビューのみ】',
  'ファイルは変更しないでください。指摘のみを重大度 (blocker / 要修正 / 提案) 付きで列挙し、',
  '問題が無ければその旨を明記してください。',
].join('\n');

// --fix の追加指示。検出事項を作業ツリーへ直接修正させる (相互レビューフロー 3B)。
const FIX_INSTRUCTION = [
  '【モード: レビュー + 修正】',
  '検出した問題は、作業ツリーのファイルを直接編集して修正してください。',
  '- 修正は差分に現れた変更へのフィードバックに限定し、無関係なリファクタはしない。',
  '- レビュー観点 (.cross-review.md) に挙げた禁則・不変条件を壊さない。',
  '- 仕様判断・設計選択などユーザの確認が要る事項は修正せず、指摘として残す。',
  '- 最後に「修正したファイルと内容・理由」「未修正で残した指摘」を日本語で要約する。',
  '構文チェック / lint / テスト / プロジェクト固有の整合性チェックは呼び出し側が後で実行する。',
].join('\n');

// `--instructions <path>` で渡された「レビュアーからの申し送り、重点指摘」をプロンプトへ
// 添えるときの見出し。観点 (.cross-review.md) を置き換えず、それに加える位置づけ。
// 主用途: 一方のレビュアーが出した指摘を他方に渡して `--fix` で直接修正させる。
const REVIEWER_NOTES_HEADER = [
  '【レビュアーからの申し送り・重点指摘】',
  '以下は、もう一方のレビュアー (Claude 等) が既に検出した重点事項です。',
  'レビュー時は最優先で検証し、--fix 時はこれらの修正を最優先で行ってください。',
  '（仕様判断・設計選択が要る事項は修正せず指摘として残すルールは従来どおり）',
].join('\n');

// 状態ファイルの dismissed (前の往復で非対応と判断した指摘) をプロンプトへ添えるときの見出し。
const DISMISSED_HEADER = [
  '【前回までに非対応と判断した指摘（再指摘しない）】',
  '以下は過去の往復で検討したうえで非対応と判断済みです。同じ指摘を繰り返さないでください',
  '（新しい根拠がある場合に限り、その根拠を明示したうえで指摘してください）。',
].join('\n');

// dismissed 一覧を申し送り (--instructions) と同じ系統の追加テキストに整える純粋関数。
// buildReviewPrompt の引数を増やさず、申し送りの後ろに続く節として渡すためのもの。
// 1 件も無ければ null を返す (呼び出し側は何も足さない)。
function buildDismissedSection(dismissed) {
  const items = Array.isArray(dismissed)
    ? dismissed.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : [];
  if (items.length === 0) return null;
  return [DISMISSED_HEADER, items.map((s) => `- ${s}`).join('\n')].join('\n');
}

// 申し送り本文と dismissed の節を 1 本のテキストに結合する純粋関数。
// どちらか一方だけでもそのまま返し、両方あれば申し送りの後ろに dismissed を置く。
function joinReviewerNotes(instructions, dismissedSection) {
  const parts = [instructions, dismissedSection]
    .map((s) => (s == null ? '' : String(s).trim()))
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

const USAGE = [
  'Claude ↔ Codex 相互レビュー CLI ブリッジ',
  '',
  '使い方: node tools/cross-review.js <codex|claude|subagent|state|dismiss|comment|artifacts> [options]',
  '',
  'レビュアー:',
  '  codex      codex スタンドアロン CLI でレビュー (既定 read-only、--fix で workspace-write)',
  '  claude     claude スタンドアロン CLI でレビュー (claude -p)',
  '  subagent   外部 CLI を起動せず、レビュープロンプトを stdout に出力 (リモートコントロール用)。',
  '             codex/claude CLI を spawn できない環境向け。出力を Agent ツールの客観レビュー用',
  '             サブエージェントへ渡してレビューさせる。--fix も可 (FIX 指示付きで出力)。',
  '',
  'サブコマンド (状態ファイル .cross-review-state.json の操作):',
  '  state             現在のブランチの往復回数・直前レビュー SHA・非対応指摘を JSON で表示',
  '  state --reset     現在のブランチの記録を消す',
  '  state --mark      往復を 1 回分記録する (round を 1 増やし、直前レビュー SHA を現在の HEAD にする)。',
  '                    --uncommitted を付けると SHA を据え置く (--uncommitted のレビュー後に使う)。',
  '                    利用上限フォールバックのプロンプトを客観サブエージェントへ渡してレビューを',
  '                    終えた後など、CLI がレビューの成立を観測できないときに手で記録する',
  '  dismiss "<要約>"  非対応と判断した指摘を記録する (以降のレビュープロンプトに',
  '                    「再指摘しない」節として添えられる。同じ要約は重複追加しない)',
  '',
  'サブコマンド (PR コメントの生成):',
  '  comment --round <N>   ブランチ別 .cross-review/branch-<slug>-<hash>/ のメタ情報、判断ファイル',
  '                        (round-<N>-triage.md)、検証出力を定型に整形し、gh pr comment --body-file 用の',
  '                        ファイルを書き出す (既定では投稿しない。コマンド例は stderr に出る)',
  '                        --post <PR番号> を付けると生成本文を gh pr comment へ直接投稿する',
  '  artifacts --clean-legacy  .cross-review 直下に残る旧形式の出力だけを削除する',
  '',
  'options:',
  '  --fix                 修正まで依頼 (codex: workspace-write で直接編集 / subagent: FIX 指示付きで出力。claude CLI 経路は非対応)',
  '  --uncommitted         未コミットの作業ツリー差分 (tracked + untracked) をレビュー',
  '  --base <ref>          比較先ブランチ / コミットを指定 (既定: 前回レビュー SHA → PR の base',
  '                        → origin/main → ローカル main の順に解決)',
  '  --max-diff-kb <n>     レビュー差分サイズの上限 (KB)。超過時はファイル要約の閾値を段階的に',
  '                        下げて縮退を試み、それでも収まらなければ起動せず中断',
  '                        (既定 256。0 でガード無効。環境変数 CROSS_REVIEW_MAX_DIFF_KB でも指定可)',
  '  --max-file-diff-kb <n> ファイル単位の差分がこの KB を超えたら本文を stat 要約に置換',
  '                        (既定 64。0 で無効 = 段階的縮退も行わない。',
  '                        環境変数 CROSS_REVIEW_MAX_FILE_DIFF_KB でも指定可)',
  '  --strict-diff-guard   差分サイズ超過時に段階的縮退を試さず、従来どおり即中断する',
  '  --no-state            状態ファイル (.cross-review-state.json) の読み書きを行わない (CI 等)',
  '  --no-exclude          既定除外も含めすべての除外を無効化 (緊急時の逃げ道)',
  '  --instructions <path> レビュアーからの申し送り・重点指摘ファイルをプロンプトへ添付',
  '                        (観点 .cross-review.md は置き換えず追加。--fix と併用で指摘を直接修正させる)',
  '  --codex-agent <name>  bridge (codex-agent.sh) で使う定義名を明示 (既定: レビューのみ codex-review /',
  '                        --fix は codex-subagent。--fix と食い違う定義名はエラー)',
  '  --no-codex-agent      bridge を使わず codex を直接起動する (従来の起動方法)',
  '  --no-fallback         Codex が利用上限でも subagent 代替へ切り替えず、そのまま失敗終了する',
  '  --no-pr-check         レビュー実行前の PR 存在確認 (gh pr view) を省く',
  '  --reviewer <name>     comment: 対象のレビュアーを明示 (省略時はブランチ別ディレクトリのメタ情報から自動選択)',
  '  --verify <path>       comment: 検証コマンドの出力ファイルを「確認内容」節へ入れる (末尾 200 行まで)',
  '  --out <path>          comment: 生成した本文の書き出し先 (既定はブランチ別ディレクトリの round-<N>-comment.md)',
  '  --post <N>            comment: 生成本文を gh pr comment <N> --body-file - で投稿する (1 以上の整数)',
  '  --clean-legacy        artifacts: .cross-review 直下の旧形式出力を削除する',
  '  --fallback-prompt <path> 利用上限時に出力する代替プロンプトの書き出し先',
  '                        (既定: OS の一時ディレクトリ/cross-review-fallback-<pid>.md)',
  '  -h, --help            このヘルプを表示',
  '',
  'codex の起動: claude-codex-bridge の codex-agent.sh があれば経由します',
  '  (解決順は 環境変数 CROSS_REVIEW_CODEX_AGENT → ~/.claude/tools/codex-agent.sh。無ければ codex を直接起動)。',
  '  モデル・推論 effort・認証ホーム・サンドボックスは定義 ~/.claude/gpt-agents/<name>.md に従います。',
  '  bridge 経由はスクリプトが approval_policy=never を明示している場合に限ります (無ければ直接起動)。',
  '  定義の codex_sandbox が --fix の有無と食い違う場合は起動せずエラー終了します。',
  '利用上限時: Codex が利用上限に達したら subagent 代替のプロンプトをファイルへ書き出し、終了コード 75 で終わります',
  '  (--no-fallback で無効化)。このとき往復は記録しません (レビューの成立を CLI が観測できないため)。',
  '  サブエージェントでのレビューを終えたら state --mark で記録してください。',
  'レビュー観点: リポジトリ直下の .cross-review.md を読み込みます',
  '  (環境変数 CROSS_REVIEW_CHECKLIST でパス指定可。スクリプト位置からも解決。無ければ汎用観点)。',
  '差分の除外: ロックファイル・生成物 (package-lock.json / *.min.js / *.map 等) を既定で除外します',
  '  (.cross-review-ignore で追加可。環境変数 CROSS_REVIEW_IGNORE でパス指定可。--no-exclude で無効化)。',
  '既定 base: 状態ファイルの前回レビュー SHA → gh pr view の base ブランチ (origin/<name>)',
  '  → origin/main → ローカル main の順に解決し、決めた base と解決方法を差分サイズと同じ行に出します',
  '  (--base 明示時と --uncommitted 時はこの解決を行いません)。',
  '  環境変数 CROSS_REVIEW_NO_FETCH=1 で fetch と gh の呼び出しを省きます (オフライン作業向け)。',
  '状態ファイル: <スクリプト>/../.cross-review-state.json にブランチ単位で往復回数・直前レビュー SHA・',
  '  非対応と判断した指摘を記録します (git 管理外を想定。--no-state で無効化)。',
  'レビュー出力: 往復を記録できたときだけ、開始時のブランチ名を安全化した',
  '  <スクリプト>/../.cross-review/branch-<slug>-<hash>/ へ保存します',
  '  (codex / claude はレビュアーの出力を round-<N>-<reviewer>.md、subagent は渡したプロンプトを',
  '   round-<N>-<reviewer>-prompt.md、いずれも実行経路と base を round-<N>-<reviewer>.json に記録)。',
  '  旧平置き出力は自動で読みません。必要なら artifacts --clean-legacy で削除できます。',
  'PR の確認: レビュー実行前に gh pr view で PR の有無を調べ、無いと分かったときだけ警告します',
  '  (実行は止めません。--no-pr-check と CROSS_REVIEW_NO_FETCH=1 で省略)。',
  '',
  '例:',
  '  npm run review:codex',
  '  npm run review:codex:fix',
  '  npm run review:claude -- --uncommitted',
  '  node tools/cross-review.js codex --base develop',
  '  node tools/cross-review.js codex --fix --uncommitted --instructions notes.md',
  '      (レビュー指摘 notes.md を渡し、未コミット差分を Codex に修正させる)',
  '  node tools/cross-review.js subagent --uncommitted',
  '      (リモートコントロール用: 未コミット差分のレビュープロンプトを stdout に出力し、',
  '       Agent ツールの客観サブエージェントへ渡す)',
  '  node tools/cross-review.js codex --no-codex-agent',
  '      (bridge を使わず codex を直接起動する)',
  '  node tools/cross-review.js codex --no-fallback',
  '      (利用上限でも subagent 代替へ切り替えない)',
  '  node tools/cross-review.js state',
  '      (現在のブランチの往復回数・直前レビュー SHA・非対応指摘を表示)',
  '  node tools/cross-review.js state --mark',
  '      (サブエージェントでのレビューを終えた後に、往復を 1 回分記録する)',
  '  node tools/cross-review.js dismiss "運用上到達しない入力への指摘"',
  '      (非対応と判断した指摘を記録し、以降のレビューで再指摘させない)',
  '  node tools/cross-review.js comment --round 1 --verify verify.log',
  '      (1 往復目の PR コメント本文を生成する。生成後 gh pr comment --body-file で投稿する)',
  '  node tools/cross-review.js comment --round 1 --post 42',
  '      (生成した本文を PR #42 へ標準入力経由で投稿する)',
  '  node tools/cross-review.js artifacts --clean-legacy',
  '      (旧形式の平置き出力を削除する)',
].join('\n');

// 非負整数として解釈できれば数値を、できなければ null を返す。
// 受理するのは数字だけからなる文字列 (前後空白は許容)。負号、小数点、指数表記、空文字は不可。
// --max-diff-kb のフラグ値と CROSS_REVIEW_MAX_DIFF_KB の解釈に共通で使う。
function parseNonNegativeInt(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// `--reviewer` で受け付ける名前の形。`.cross-review/` のファイル名へ埋めるので、
// パス区切りや `..` を含む値は弾く。
const SAFE_REVIEWER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// process.argv.slice(2) を受け取り、サブコマンド (レビュアー / state / dismiss / comment) と
// 差分スコープを解釈する。
function parseArgs(argv) {
  const args = argv.slice();
  const out = {
    // 実行するサブコマンド。'review' はレビュアー (codex / claude / subagent) の実行、
    // 'state' は状態ファイルの表示と初期化、'dismiss' は非対応と判断した指摘の記録、
    // 'comment' は保存済みメタ情報、判断ファイル、検証出力から PR コメント本文を生成する。
    command: 'review',
    reviewer: null,
    dismissText: null, // dismiss の要約 (command === 'dismiss' のときだけ使う)
    reset: false, // state --reset (現在の枝の記録を消す)
    mark: false, // state --mark (現在の枝の往復を手で 1 進める)
    noState: false, // --no-state で状態ファイルの読み書きを無効化する (CI 等)
    strictDiffGuard: false, // --strict-diff-guard で差分ガードを従来の即中断に戻す
    mode: 'base',
    baseRef: 'main',
    baseExplicit: false, // --base / --base= が指定されたか (既定 base 解決をスキップする判定に使う)
    fix: false,
    instructionsPath: null,
    maxDiffKb: null, // --max-diff-kb の値 (未指定は null。閾値の最終解決は resolveMaxDiffKb)
    maxFileDiffKb: null, // --max-file-diff-kb の値 (未指定は null。最終解決は resolveMaxFileDiffKb)
    noExclude: false, // --no-exclude で既定除外も含めすべての除外を無効化する (緊急時の逃げ道)
    // codex-agent.sh (bridge) 経由の起動設定。3 状態を 1 フィールドで表す:
    //   null   = 既定 (スクリプトがあれば bridge、無ければ直接起動)
    //   false  = --no-codex-agent (常に直接起動)
    //   文字列 = --codex-agent <name> (使う定義名を明示)
    // --codex-agent と --no-codex-agent を併記した場合は後に書いたほうが勝つ。
    codexAgent: null,
    noFallback: false, // --no-fallback で利用上限時の subagent 代替への切り替えを無効化する
    fallbackPromptPath: null, // --fallback-prompt の書き出し先 (未指定なら一時ディレクトリ)
    noPrCheck: false, // --no-pr-check でレビュー実行前の PR 存在確認を省く
    // comment サブコマンド用。round は対象の往復番号、reviewerName は `--reviewer`
    // (省略時はブランチ別ディレクトリのメタ情報から自動で選ぶ)。
    round: null,
    reviewerName: null,
    verifyPath: null, // --verify の検証出力ファイル
    outPath: null, // --out の書き出し先 (未指定はブランチ別ディレクトリの round-<N>-comment.md)
    postNumber: null, // --post の投稿先 PR 番号 (comment 専用)
    cleanLegacy: false, // artifacts --clean-legacy (旧平置き出力の削除)
    help: false,
    error: null,
  };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--fix') {
      out.fix = true;
    } else if (a === '--no-exclude') {
      out.noExclude = true;
    } else if (a === '--no-state') {
      out.noState = true;
    } else if (a === '--strict-diff-guard') {
      out.strictDiffGuard = true;
    } else if (a === '--reset') {
      out.reset = true;
    } else if (a === '--mark') {
      out.mark = true;
    } else if (a === '--no-codex-agent') {
      out.codexAgent = false;
    } else if (a === '--no-fallback') {
      out.noFallback = true;
    } else if (a === '--no-pr-check') {
      out.noPrCheck = true;
    } else if (a === '--round' || a.startsWith('--round=')) {
      const v = a === '--round' ? args[i + 1] : a.slice('--round='.length);
      const n = parseNonNegativeInt(v);
      if (n == null || n < 1) {
        out.error = '--round には 1 以上の整数を指定してください';
        // 値トークン (例: -1) が次ループで「不明なオプション」と誤判定されないよう消費する。
        if (a === '--round' && v != null && !v.startsWith('--')) i++;
      } else {
        out.round = n;
        if (a === '--round') i++;
      }
    } else if (a === '--reviewer' || a.startsWith('--reviewer=')) {
      const v = a === '--reviewer' ? args[i + 1] : a.slice('--reviewer='.length);
      if (!v || v.startsWith('-')) {
        out.error = '--reviewer にはレビュアー名が必要です';
      } else if (!SAFE_REVIEWER_NAME.test(v)) {
        // `.cross-review/` のファイル名に埋めるので、パスに化ける名前は受けない。
        out.error = `--reviewer に使えない名前です: ${v}`;
        if (a === '--reviewer') i++;
      } else {
        out.reviewerName = v;
        if (a === '--reviewer') i++;
      }
    } else if (a === '--verify' || a.startsWith('--verify=')) {
      const v = a === '--verify' ? args[i + 1] : a.slice('--verify='.length);
      if (!v || v.startsWith('-')) {
        out.error = '--verify にはファイルパスが必要です';
      } else {
        out.verifyPath = v;
        if (a === '--verify') i++;
      }
    } else if (a === '--out' || a.startsWith('--out=')) {
      const v = a === '--out' ? args[i + 1] : a.slice('--out='.length);
      if (!v || v.startsWith('-')) {
        out.error = '--out にはファイルパスが必要です';
      } else {
        out.outPath = v;
        if (a === '--out') i++;
      }
    } else if (a === '--post' || a.startsWith('--post=')) {
      const v = a === '--post' ? args[i + 1] : a.slice('--post='.length);
      const n = parseNonNegativeInt(v);
      if (n == null || n < 1) {
        out.error = '--post には 1 以上の整数を指定してください';
        if (a === '--post' && v != null && !v.startsWith('--')) i++;
      } else {
        out.postNumber = n;
        if (a === '--post') i++;
      }
    } else if (a === '--clean-legacy') {
      out.cleanLegacy = true;
    } else if (a === '--codex-agent') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        out.error = '--codex-agent には定義名が必要です';
      } else {
        out.codexAgent = v;
        i++;
      }
    } else if (a.startsWith('--codex-agent=')) {
      const v = a.slice('--codex-agent='.length);
      if (!v) {
        out.error = '--codex-agent には定義名が必要です'; // `--codex-agent=` 空値は黙って素通りさせない。
      } else {
        out.codexAgent = v;
      }
    } else if (a === '--fallback-prompt') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        out.error = '--fallback-prompt にはファイルパスが必要です';
      } else {
        out.fallbackPromptPath = v;
        i++;
      }
    } else if (a.startsWith('--fallback-prompt=')) {
      const v = a.slice('--fallback-prompt='.length);
      if (!v) {
        out.error = '--fallback-prompt にはファイルパスが必要です';
      } else {
        out.fallbackPromptPath = v;
      }
    } else if (a === '--uncommitted') {
      out.mode = 'uncommitted';
    } else if (a === '--instructions') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        out.error = '--instructions にはファイルパスが必要です';
      } else {
        out.instructionsPath = v;
        i++;
      }
    } else if (a.startsWith('--instructions=')) {
      const v = a.slice('--instructions='.length);
      if (!v) {
        out.error = '--instructions にはファイルパスが必要です'; // `--instructions=` 空値は黙って素通りさせない。
      } else {
        out.instructionsPath = v;
      }
    } else if (a === '--base') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        out.error = '--base にはブランチ名が必要です';
      } else {
        out.baseRef = v;
        out.baseExplicit = true;
        i++;
      }
    } else if (a.startsWith('--base=')) {
      out.baseRef = a.slice('--base='.length);
      out.baseExplicit = true;
    } else if (a === '--max-diff-kb') {
      const v = args[i + 1];
      const n = parseNonNegativeInt(v);
      if (n == null) {
        out.error = '--max-diff-kb には 0 以上の整数を指定してください';
        // 値トークン (例: -1) が次ループで「不明なオプション」と誤判定されないよう、
        // 別フラグでない (= 値として与えられた) ものはここで消費する。
        if (v != null && !v.startsWith('--')) i++;
      } else {
        out.maxDiffKb = n;
        i++;
      }
    } else if (a.startsWith('--max-diff-kb=')) {
      const n = parseNonNegativeInt(a.slice('--max-diff-kb='.length));
      if (n == null) {
        out.error = '--max-diff-kb には 0 以上の整数を指定してください';
      } else {
        out.maxDiffKb = n;
      }
    } else if (a === '--max-file-diff-kb') {
      const v = args[i + 1];
      const n = parseNonNegativeInt(v);
      if (n == null) {
        out.error = '--max-file-diff-kb には 0 以上の整数を指定してください';
        // 値トークン (例: -1) が次ループで「不明なオプション」と誤判定されないよう消費する。
        if (v != null && !v.startsWith('--')) i++;
      } else {
        out.maxFileDiffKb = n;
        i++;
      }
    } else if (a.startsWith('--max-file-diff-kb=')) {
      const n = parseNonNegativeInt(a.slice('--max-file-diff-kb='.length));
      if (n == null) {
        out.error = '--max-file-diff-kb には 0 以上の整数を指定してください';
      } else {
        out.maxFileDiffKb = n;
      }
    } else if (a.startsWith('-')) {
      out.error = `不明なオプション: ${a}`;
    } else {
      rest.push(a);
    }
  }
  if (!out.help && !out.error && rest[0] === 'comment') {
    // PR コメント本文の生成。保存済みのメタ情報と判断ファイルを読むだけで、
    // レビュアーの起動も状態ファイルの更新も行わない。
    out.command = 'comment';
    if (out.noState) {
      // comment は状態ファイルを読み書きしない。指定しても効かないので黙って無視しない。
      out.error = '--no-state は state / dismiss / comment サブコマンドとは併用できません';
    } else if (out.cleanLegacy) {
      out.error = '--clean-legacy は artifacts サブコマンドでのみ使えます';
    } else if (out.reset) {
      out.error = '--reset は state サブコマンドでのみ使えます';
    } else if (out.mark) {
      out.error = '--mark は state サブコマンドでのみ使えます';
    } else if (out.round == null) {
      out.error = 'comment には --round <N> が必要です (例: comment --round 1)';
    }
  } else if (!out.help && !out.error && (rest[0] === 'state' || rest[0] === 'dismiss' || rest[0] === 'artifacts')) {
    // レビュアー以外のサブコマンド。状態ファイルだけを扱うので、レビュアーは決めない。
    out.command = rest[0];
    if (out.noState) {
      out.error = '--no-state は state / dismiss / comment サブコマンドとは併用できません';
    } else if (out.command === 'dismiss') {
      if (out.reset) {
        out.error = '--reset は state サブコマンドでのみ使えます';
      } else if (out.mark) {
        out.error = '--mark は state サブコマンドでのみ使えます';
      } else {
        // 引用符を付け忘れた複数語の要約も 1 件として受ける。
        const text = rest.slice(1).join(' ').trim();
        if (!text) {
          out.error = 'dismiss には非対応と判断した指摘の要約が必要です (例: dismiss "この指摘は運用上到達しない")';
        } else {
          out.dismissText = text;
        }
      }
    } else if (out.command === 'artifacts') {
      const commentOnly = [
        out.round != null ? '--round' : null,
        out.reviewerName != null ? '--reviewer' : null,
        out.verifyPath != null ? '--verify' : null,
        out.outPath != null ? '--out' : null,
        out.postNumber != null ? '--post' : null,
      ].filter(Boolean);
      if (commentOnly.length > 0) {
        out.error = `${commentOnly.join(' / ')} は comment サブコマンドでのみ使えます`;
      } else if (!out.cleanLegacy) {
        out.error = 'artifacts には --clean-legacy が必要です';
      } else if (out.reset || out.mark) {
        out.error = '--reset / --mark は artifacts サブコマンドでは使えません';
      }
    } else if (out.reset && out.mark) {
      // 記録を消すのと往復を 1 進めるのは相反する操作なので、どちらの意図か決められない。
      out.error = '--reset と --mark は併用できません';
    }
  } else if (!out.help && !out.error) {
    out.reviewer = rest[0] || null;
    // reviewer: codex / claude は外部スタンドアロン CLI を起動する。subagent は外部 CLI を起動せず、
    // 組み立てたレビュープロンプトを stdout に出すだけ (リモートコントロール環境で codex/claude CLI を
    // spawn できないとき、その出力を Claude が Agent ツールの客観レビュー用サブエージェントへ渡す)。
    if (out.reviewer !== 'codex' && out.reviewer !== 'claude' && out.reviewer !== 'subagent') {
      out.error = `レビュアーは codex / claude / subagent を指定してください (指定: ${out.reviewer || 'なし'})`;
    } else if (out.fix && out.reviewer === 'claude') {
      // --fix は作業ツリーを書き換える。codex は workspace-write、subagent は FIX 指示付きプロンプトを出して
      // 書込権限付きサブエージェントに直させる、で対応する。claude CLI 経路 (claude -p) のみ自動修正を未配線。
      out.error = '--fix は codex か subagent のみ対応です (claude CLI 経路の自動修正は未対応)';
    } else if (typeof out.codexAgent === 'string') {
      // bridge 経由のサンドボックスは定義ファイル側の codex_sandbox で決まるので、--fix の有無と
      // 定義名が食い違うと「レビューのみなのに書き込める」「--fix なのに書けない」状態になる。
      // 既知の 2 定義に限って食い違いを弾く (それ以外の名前は利用者が用意した定義として通す)。
      if (out.codexAgent === CODEX_AGENT_REVIEW_NAME && out.fix) {
        out.error = `--codex-agent ${CODEX_AGENT_REVIEW_NAME} は読み取り専用の定義です (--fix とは併用できません)`;
      } else if (out.codexAgent === CODEX_AGENT_FIX_NAME && !out.fix) {
        out.error = `--codex-agent ${CODEX_AGENT_FIX_NAME} は書き込み可能な定義です (--fix 無しでは使えません)`;
      }
    }
    // --reset / --mark は状態ファイルの操作用なので、レビュアー実行では受け付けない。
    if (!out.error && out.reset) out.error = '--reset は state サブコマンドでのみ使えます';
    if (!out.error && out.mark) out.error = '--mark は state サブコマンドでのみ使えます';
  }
  // comment 専用のオプションを他のサブコマンドで受けても効かないので、黙って無視せずエラーにする。
  if (!out.help && !out.error && out.command !== 'comment') {
    const given = [
      out.round != null ? '--round' : null,
      out.reviewerName != null ? '--reviewer' : null,
      out.verifyPath != null ? '--verify' : null,
      out.outPath != null ? '--out' : null,
      out.postNumber != null ? '--post' : null,
    ].filter(Boolean);
    if (given.length > 0) {
      out.error = `${given.join(' / ')} は comment サブコマンドでのみ使えます`;
    } else if (out.cleanLegacy && out.command !== 'artifacts') {
      out.error = '--clean-legacy は artifacts サブコマンドでのみ使えます';
    }
  }
  return out;
}

// codex exec に渡す引数。プロンプト (観点 + 差分 + モード別指示) は末尾 '-' で stdin から読ませる。
// レビューのみは read-only でファイルを保護し、--fix のときだけ workspace-write で
// 検出事項を作業ツリーへ直接修正させる。専用サブコマンド `review` は v0.137.0 で
// `--uncommitted`/`--base` が [PROMPT] と排他になり観点チェックリストを渡せないため使わない。
// `-c approval_policy=never`: codex exec は元々非対話 (既定 approval=never) だが、ユーザの
// config.toml が on-request 等でも Claude からの自走が承認待ちで止まらないよう明示的に固定する。
function codexExecArgs(opts) {
  return [
    'exec',
    '-s', opts.fix ? 'workspace-write' : 'read-only',
    '-c', 'approval_policy=never',
    '-',
  ];
}

// git を実行し stdout を返す。テストから差し替えられるよう実体を分離する。
// opts:
//   - allowDiffExit: git diff --no-index は差分があると exit 1 を返すので許容する。
//   - allowFailure:  非ゼロ終了 (やタイムアウト) でも throw せず null を返す。fetch / rev-parse の
//                    ベストエフォート実行に使う (成功判定は戻り値が null かどうか)。
//   - timeoutMs:     spawnSync の timeout (ミリ秒)。タイムアウトすると非ゼロ終了になる。
function defaultGitRunner(args, opts) {
  const allowDiffExit = !!(opts && opts.allowDiffExit);
  const allowFailure = !!(opts && opts.allowFailure);
  const timeoutMs = opts && opts.timeoutMs;
  const spawnOpts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  if (timeoutMs) spawnOpts.timeout = timeoutMs;
  const res = spawnSync('git', args, spawnOpts);
  const ok = res.status === 0 || (allowDiffExit && res.status === 1);
  if (!ok) {
    // allowFailure 経路では、リモート無し、オフライン、タイムアウト、参照不在などを
    // 例外ではなく null で表現し、呼び出し側がベストエフォートで続行できるようにする。
    if (allowFailure) return null;
    const detail = res.stderr || (res.error && res.error.message) || `exit ${res.status}`;
    throw new Error(`git ${args.join(' ')} に失敗しました: ${detail}`);
  }
  return res.stdout || '';
}

// gh CLI を実行して結果を返す。非ゼロ終了や起動エラーも結果に残すのは、PR 不在、
// 認証エラー、タイムアウトを呼び出し側が区別し、書き込みの再実行を誤らないため。
// 読み取りは既定 10 秒、投稿などの書き込みは呼び出し側が timeout を延長する。
// Windows では gh が .cmd shim のことがあるため、レビュアー CLI と同じ解決を通す。
function defaultGhRunner(args, options = {}) {
  const resolved = resolveReviewerCommandForSpawn('gh');
  const input = options.input == null ? options.stdin : options.input;
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 10000;
  const maxBuffer = Number.isFinite(options.maxBuffer) && options.maxBuffer > 0
    ? options.maxBuffer
    : 1024 * 1024;
  const res = spawnSync(resolved.cmd, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer,
    shell: resolved.shell,
    ...(input == null ? {} : { input: String(input) }),
  });
  const error = res.error
    ? `${res.error.code ? `${res.error.code}: ` : ''}${res.error.message || 'gh execution error'}`
    : (res.signal ? `gh がシグナル ${res.signal} で終了しました` : '');
  return {
    status: Number.isInteger(res.status) ? res.status : null,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error,
  };
}

// ghRun の戻り値を { status, stdout, stderr, error } に正規化する純粋関数。
// 文字列と error の無い status 省略オブジェクトは、既存スタブとの互換性のため成功とみなす。
// 起動エラーやシグナル終了では status を null のまま残し、成功へ変換しない。
function normalizeGhResult(res) {
  if (res == null) return null;
  if (typeof res === 'string') return { status: 0, stdout: res, stderr: '', error: '' };
  if (typeof res !== 'object') return null;
  const error = String(res.error == null ? '' : res.error);
  const hasStatus = Object.prototype.hasOwnProperty.call(res, 'status');
  return {
    status: Number.isInteger(res.status) ? res.status : (!hasStatus && !error ? 0 : null),
    stdout: String(res.stdout == null ? '' : res.stdout),
    stderr: String(res.stderr == null ? '' : res.stderr),
    error,
  };
}

// gh が「この枝に PR が無い」と答えたときの出力パターン。非ゼロ終了の理由がこれだと
// 判定できたときだけ「PR 未作成」を確定させ、それ以外の失敗 (未認証、ネットワーク断など) は
// 「分からない」に倒す (誤警告を出さないため)。
const NO_PR_PATTERN = /no pull requests found|could not resolve to a pullrequest/i;

// PR の情報が分からないときの戻り値 (gh 不在、実行失敗、CROSS_REVIEW_NO_FETCH=1)。
function unknownPrInfo() {
  return { known: false, present: false, number: null, baseRefName: null };
}

// `gh pr view --json number,baseRefName` を 1 回だけ実行して PR の有無、番号、base ブランチを得る。
// 番号は「PR 未作成の警告」と `comment` のコマンド例に、base ブランチは既定 base の解決に使う。
// 同じ情報を 2 か所が必要とするので、呼び出しを 1 本にまとめる (createPrInfoReader が結果を保持する)。
// 戻り値:
//   - { known:false } … gh 不在 / 実行失敗 / noFetch。PR の有無が分からないので黙って続行する。
//   - { known:true, present:false } … gh が「PR が無い」と答えた。未作成の警告を出してよい。
//   - { known:true, present:true, number, baseRefName } … PR がある。
function readPrInfo(ghRun, noFetch) {
  if (noFetch) return unknownPrInfo();
  let res;
  try {
    res = normalizeGhResult(ghRun(['pr', 'view', '--json', 'number,baseRefName']));
  } catch {
    return unknownPrInfo(); // gh の起動自体に失敗しても黙って続行する。
  }
  if (res == null) return unknownPrInfo();
  if (res.status !== 0) {
    if (NO_PR_PATTERN.test(`${res.stderr}\n${res.stdout}`)) {
      return { known: true, present: false, number: null, baseRefName: null };
    }
    return unknownPrInfo();
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return unknownPrInfo(); // JSON として読めない出力は判断材料にしない。
  }
  if (!parsed || typeof parsed !== 'object') return unknownPrInfo();
  const number = Number.isSafeInteger(parsed.number) && parsed.number > 0 ? parsed.number : null;
  const baseRefName = typeof parsed.baseRefName === 'string' && parsed.baseRefName.trim()
    ? parsed.baseRefName.trim()
    : null;
  return { known: true, present: true, number, baseRefName };
}

// readPrInfo を 1 回だけ呼び、結果を保持して返すリーダを作る。
// 既定 base の解決と PR 未作成の警告が同じ情報を使うので、gh の起動を 1 回に抑える。
function createPrInfoReader(deps = {}, noFetch = false) {
  const ghRun = deps.ghRun || defaultGhRunner;
  let cached = null;
  return () => {
    if (cached == null) cached = readPrInfo(ghRun, noFetch);
    return cached;
  };
}

// 環境変数で fetch (とネットワークを使う gh 呼び出し) を省略する指定かを判定する。
// 未設定、空文字、`0`、`false` は「省略しない」。
function isNoFetch(env) {
  const raw = (env || process.env)[NO_FETCH_ENV];
  if (raw == null) return false;
  const s = String(raw).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

// SHA の短縮表記 (通知用)。git の既定と同じ 7 桁。
function shortSha(sha) {
  return String(sha == null ? '' : sha).slice(0, 7);
}

// 状態ファイルのパス。cwd に依存させず、スクリプト位置からリポジトリ直下に固定する。
function resolveStatePath(deps = {}) {
  const scriptDir = deps.scriptDir || __dirname;
  return path.join(scriptDir, '..', STATE_FILENAME);
}

// 1 ブランチ分の初期状態。
function emptyBranchState() {
  return { round: 0, lastReviewedSha: null, dismissed: [] };
}

// 読み込んだ JSON を既知の形へ正規化する純粋関数。型が違う値は初期値へ落とす
// (手で編集された状態ファイルでも後段が壊れないようにする)。
function normalizeState(raw) {
  const out = { branches: {} };
  const src = (raw && typeof raw === 'object' && raw.branches && typeof raw.branches === 'object')
    ? raw.branches
    : {};
  for (const [name, value] of Object.entries(src)) {
    if (!name) continue;
    const v = (value && typeof value === 'object') ? value : {};
    const round = (Number.isSafeInteger(v.round) && v.round >= 0) ? v.round : 0;
    const sha = (typeof v.lastReviewedSha === 'string' && v.lastReviewedSha.trim())
      ? v.lastReviewedSha.trim()
      : null;
    const dismissed = Array.isArray(v.dismissed)
      ? v.dismissed.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
      : [];
    out.branches[name] = { round, lastReviewedSha: sha, dismissed };
  }
  return out;
}

// state から 1 ブランチ分を取り出す純粋関数 (記録が無ければ初期状態)。
function branchStateOf(state, branch) {
  const normalized = normalizeState(state);
  if (!branch) return emptyBranchState();
  return normalized.branches[branch] || emptyBranchState();
}

// レビュー実行 1 回分の状態遷移を返す純粋関数 (I/O は持たない)。
//   - round は codex / claude / subagent のどの経路でも 1 増やす (1 往復 = レビュー 1 回)。
//     引数 reviewer はどの経路が走ったかを示すが、どれも 1 往復として数えるので遷移には影響しない。
//   - sha が無いときは lastReviewedSha を据え置く。--uncommitted は作業ツリー差分で
//     「この SHA 以降の増分」の意味を持たないため、往復だけ数えて SHA は更新しない。
//   - branch が無い (取得できない) ときは何も記録しない。
function nextState(state, { branch, sha, reviewer } = {}) {
  const base = normalizeState(state);
  if (!branch) return base;
  const prev = branchStateOf(base, branch);
  const branches = { ...base.branches };
  branches[branch] = {
    round: prev.round + 1,
    lastReviewedSha: sha ? String(sha) : prev.lastReviewedSha,
    dismissed: prev.dismissed.slice(),
  };
  return { branches };
}

// 非対応と判断した指摘を 1 件足す純粋関数。同じ要約は重複して追加しない。
function withDismissed(state, branch, text) {
  const base = normalizeState(state);
  const value = String(text == null ? '' : text).trim();
  if (!branch || !value) return base;
  const prev = branchStateOf(base, branch);
  if (prev.dismissed.includes(value)) return base;
  const branches = { ...base.branches };
  branches[branch] = { ...prev, dismissed: prev.dismissed.concat(value) };
  return { branches };
}

// 1 ブランチ分の記録を消す純粋関数 (state --reset)。他の枝の記録は残す。
function withoutBranch(state, branch) {
  const base = normalizeState(state);
  if (!branch) return base;
  const branches = { ...base.branches };
  delete branches[branch];
  return { branches };
}

// 状態ファイルを読む。戻り値は { path, state, corrupt }。
// 見つからなければ空の状態 (corrupt:false)。JSON が壊れている / 読めない場合は corrupt:true にし、
// 呼び出し側は「警告して無視、書き戻さない」を選べるようにする (既存の記録を上書きで消さないため)。
function readState(deps = {}) {
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const statePath = resolveStatePath(deps);
  let present = false;
  try {
    present = !!exists(statePath);
  } catch {
    present = false; // 存在確認そのものが失敗したら「無い」と同じ扱いにする。
  }
  if (!present) return { path: statePath, state: normalizeState(null), corrupt: false };
  let body;
  try {
    body = String(readFile(statePath));
  } catch {
    return { path: statePath, state: normalizeState(null), corrupt: true };
  }
  try {
    return { path: statePath, state: normalizeState(JSON.parse(body)), corrupt: false };
  } catch {
    return { path: statePath, state: normalizeState(null), corrupt: true };
  }
}

// 状態ファイルを書く。書けなくてもレビュー自体は続けたいので、失敗は警告 1 行で false を返す。
// 書き込みの差し替えは deps.writeStateFile。deps.writeFile (利用上限時の代替プロンプト) とは
// 別の口にして、片方のテスト注入がもう片方を巻き込まないようにする。
function writeState(state, deps = {}) {
  const writeFile = deps.writeStateFile || ((p, body) => fs.writeFileSync(p, body, 'utf8'));
  const warn = deps.warn || ((m) => process.stderr.write(m));
  const statePath = resolveStatePath(deps);
  try {
    writeFile(statePath, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
    return true;
  } catch (err) {
    warn(`[cross-review] 状態ファイルを書けません: ${statePath} (${(err && err.message) || 'write error'})\n`);
    return false;
  }
}

// 現在のブランチ名。detached HEAD では git が 'HEAD' を返すので、それをそのままキーに使う。
// 取得できなければ null (呼び出し側は状態の読み書きを行わない)。
function currentBranchName(gitRun) {
  const out = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
  if (out == null) return null;
  const name = String(out).trim();
  return name || null;
}

// 現在の HEAD の SHA。SHA として解釈できない出力は記録しない (状態ファイルを汚さない)。
function currentHeadSha(gitRun) {
  const out = gitRun(['rev-parse', 'HEAD'], { allowFailure: true });
  if (out == null) return null;
  const sha = String(out).trim();
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
}

// SHA がコミットとして存在するか (rebase や amend で消えた SHA を base に使わないための確認)。
function commitExists(gitRun, sha) {
  if (!sha) return false;
  return gitRun(['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true }) != null;
}

// 差分本文と「除外したが変更のあったファイル一覧」を組み立てる。
// gitRun は (args, { allowDiffExit }) => stdout の関数。
// uncommitted では Codex の --uncommitted と揃えるため、tracked 変更に加えて
// 未追跡 (untracked) ファイルも new file 差分として含める。
// 戻り値: { diffText, excludedFiles }
//   - diffText: 除外パススペック適用後の差分本文。
//   - excludedFiles: 除外したが変更のあったファイル名一覧 (除外なし/除外ありの name-only 差集合)。
// opts.excludePathspecs があれば差分収集に渡し、加えて差集合を name-only でベストエフォート取得する
// (一覧取得は軽量な name-only。失敗時は除外一覧なしで続行)。
function collectReviewDiff(opts, gitRun) {
  // include 側は repo ルート (`:/`) を指す。これと除外側の `top` マジックワードにより、
  // cwd がリポジトリ直下でなくても差分スコープがリポ全体のまま変わらない (cwd 相対の `.` だと退行)。
  const excludeSpecs = opts.excludePathspecs || [];
  const hasExclude = excludeSpecs.length > 0;
  // name-only 一覧から「除外で落ちたファイル」を差集合で求める (ベストエフォート)。
  const diffNames = (args) => {
    try {
      const out = gitRun(args, { allowDiffExit: true });
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return null; // name-only 取得失敗時は差集合を諦める (本体の差分収集は続行)。
    }
  };
  const subtract = (full, kept) => {
    if (full == null || kept == null) return [];
    const keptSet = new Set(kept);
    return full.filter((f) => !keptSet.has(f));
  };

  if (opts.mode !== 'uncommitted') {
    const range = `${opts.baseRef}...HEAD`;
    const diffArgs = ['diff', range];
    if (hasExclude) diffArgs.push('--', ':/', ...excludeSpecs);
    const diffText = gitRun(diffArgs, { allowDiffExit: true }).replace(/\n$/, '');
    let excludedFiles = [];
    if (hasExclude) {
      const full = diffNames(['diff', '--name-only', range]);
      const kept = diffNames(['diff', '--name-only', range, '--', ':/', ...excludeSpecs]);
      excludedFiles = subtract(full, kept);
    }
    return { diffText, excludedFiles };
  }
  // --instructions の申し送りファイルが untracked のままリポジトリ内に置かれていても、
  // レビュー対象 (実コード差分) に紛れ込まないよう除外する。絶対パスで突き合わせる。
  // Windows はパスが大文字小文字を区別しないため、比較時のみ lowercase 正規化して取りこぼさない。
  const normCmp = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const excludeAbs = opts.instructionsPath ? normCmp(opts.instructionsPath) : null;
  const parts = [];
  const trackedArgs = ['diff', 'HEAD'];
  if (hasExclude) trackedArgs.push('--', ':/', ...excludeSpecs);
  const tracked = gitRun(trackedArgs, { allowDiffExit: true });
  if (tracked.trim()) parts.push(tracked.replace(/\n$/, ''));
  const lsArgs = ['ls-files', '--others', '--exclude-standard', '-z'];
  if (hasExclude) lsArgs.push('--', ':/', ...excludeSpecs);
  const listed = gitRun(lsArgs, {});
  const untracked = listed.split('\0').filter(Boolean);
  for (const file of untracked) {
    if (excludeAbs && normCmp(file) === excludeAbs) continue; // 申し送りファイル自体は対象外。
    // /dev/null は git が全 OS で空ファイルとして解釈する。差分ありで exit 1 になる。
    const added = gitRun(['diff', '--no-index', '--', '/dev/null', file], { allowDiffExit: true });
    if (added.trim()) parts.push(added.replace(/\n$/, ''));
  }
  let excludedFiles = [];
  if (hasExclude) {
    // tracked: name-only の差集合。untracked: ls-files の差集合 (申し送りファイルは除く)。
    const trackedFull = diffNames(['diff', '--name-only', 'HEAD']);
    const trackedKept = diffNames(['diff', '--name-only', 'HEAD', '--', ':/', ...excludeSpecs]);
    const trackedExcluded = subtract(trackedFull, trackedKept);
    const fullLs = gitRun(['ls-files', '--others', '--exclude-standard', '-z'], {});
    const fullUntracked = fullLs.split('\0').filter(Boolean)
      .filter((f) => !(excludeAbs && normCmp(f) === excludeAbs));
    const keptUntracked = new Set(untracked);
    const untrackedExcluded = fullUntracked.filter((f) => !keptUntracked.has(f));
    excludedFiles = trackedExcluded.concat(untrackedExcluded);
  }
  return { diffText: parts.join('\n'), excludedFiles };
}

// PR の base ブランチ (readPrInfo の結果) を origin/<name> として解決できれば返す。
// gh 不在、PR 無し、失敗、解決不能はいずれも null で、呼び出し側は黙って次の解決へ進む
// (gh を入れていない取り込み先の挙動を変えないため)。
function resolvePrBaseRef(gitRun, prInfo) {
  const name = prInfo && prInfo.present ? prInfo.baseRefName : null;
  if (!name || !SAFE_REF_NAME.test(name)) return null;
  // origin/main と同じくベストエフォートで取得してから verify する。
  gitRun(['fetch', 'origin', name, '--quiet'], { allowFailure: true, timeoutMs: 10000 });
  const verified = gitRun(
    ['rev-parse', '--verify', '--quiet', `origin/${name}`],
    { allowFailure: true },
  );
  return verified != null ? `origin/${name}` : null;
}

// 既定 base の解決方法 (source) に対応する人向けの表記。差分サイズと同じ stderr 行と、
// PR コメントの要約行 (buildRoundComment) が同じ語を使うよう 1 か所にまとめる。
const BASE_SOURCE_LABELS = {
  uncommitted: '未コミットの作業ツリー差分',
  explicit: '--base 指定',
  state: '前回レビュー時の SHA',
  pr: 'PR の base',
  'origin-main': 'origin/main 優先解決',
  'local-main': 'ローカル main',
};

// source に対応する表記を返す。未知の値はそのまま返す (メタ情報が古い形でも壊さない)。
function baseSourceLabel(source) {
  return BASE_SOURCE_LABELS[source] || String(source == null ? '不明' : source);
}

// 既定 base (--base 未指定、コミット済み差分モード) を解決し、「何をどう決めたか」まで返す。
// 戻り値: { ref, source, label, display }
//   - source: 'uncommitted' | 'explicit' | 'state' | 'pr' | 'origin-main' | 'local-main'
//   - label / display: 差分サイズと同じ stderr 行に出す人向けの表記。
// 既定時の解決順は次の 3 段で、いずれも失敗すれば次へ進む。
//   1. 状態ファイルの lastReviewedSha (往復 2 回目以降は前回レビュー以降の増分だけを送る)。
//      SHA が現存しない (rebase や amend で消えた) 場合は使わない。
//   2. PR の base ブランチ (gh pr view --json baseRefName)。スタック PR で親 PR の差分が
//      混ざるのを防ぐ。origin/<name> が verify できたときだけ採用する。
//   3. origin/main をベストエフォートで取得して verify (ローカル main が stale だと
//      merge-base が古くなり、HEAD 取り込み済みの main 側コミットまで差分に混入するため)。
//      解決できなければ従来どおりローカル main。
// opts.mode === 'uncommitted' と opts.baseExplicit では何もせず opts.baseRef を返す
// (ユーザが明示した base / 未コミット差分には介入しない。fetch も gh も呼ばない)。
// 人向け通知は deps.err (無ければ process.stderr.write) へ。
// gitRun は (args, opts) => stdout | null の関数 (allowFailure 経路で失敗時 null)。
// deps.branchState に状態ファイルの当該ブランチ分を渡すと 1 段目が有効になる。
function resolveBaseSelection(opts, gitRun, deps = {}) {
  if (opts.mode === 'uncommitted') {
    return { ref: opts.baseRef, source: 'uncommitted', label: baseSourceLabel('uncommitted'), display: opts.baseRef };
  }
  if (opts.baseExplicit) {
    return { ref: opts.baseRef, source: 'explicit', label: baseSourceLabel('explicit'), display: opts.baseRef };
  }
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const noFetch = isNoFetch(deps.env);

  // 1. 前回レビュー時の SHA。
  const branchState = deps.branchState || null;
  const lastSha = branchState && branchState.lastReviewedSha;
  if (lastSha && commitExists(gitRun, lastSha)) {
    const round = (branchState.round || 0) + 1;
    writeErr(`[cross-review] base として前回レビュー時の ${shortSha(lastSha)} を使用します (往復 ${round} 回目。--base で変更可)。\n`);
    return { ref: lastSha, source: 'state', label: baseSourceLabel('state'), display: shortSha(lastSha) };
  }

  // 2. PR の base ブランチ。PR の情報は deps.prInfo (呼び出し側が保持するリーダ) から得る。
  // 未指定なら自前で 1 回だけ読む (この関数を単体で呼ぶ経路のため)。
  const prInfoOf = deps.prInfo || createPrInfoReader(deps, noFetch);
  const prBase = resolvePrBaseRef(gitRun, prInfoOf());
  if (prBase) {
    writeErr(`[cross-review] base として PR の base ブランチ ${prBase} を使用します (--base で変更可)。\n`);
    return { ref: prBase, source: 'pr', label: baseSourceLabel('pr'), display: prBase };
  }

  // 3. origin/main → ローカル main。
  // fetch の成否は allowFailure 経路の契約「null = 失敗 / null 以外 (空文字含む) = 成功」で判定する
  // (--quiet 付き fetch は成功時 stdout が空。gitRun を差し替えるときもこの契約を守ること)。
  let fetchFailed = false;
  if (!noFetch) {
    const fetched = gitRun(
      ['fetch', 'origin', 'main', '--quiet'],
      { allowFailure: true, timeoutMs: 10000 },
    );
    fetchFailed = fetched == null;
  }
  const verified = gitRun(
    ['rev-parse', '--verify', '--quiet', 'origin/main'],
    { allowFailure: true },
  );
  const ref = verified != null ? 'origin/main' : 'main';
  if (fetchFailed) {
    // どのローカル参照で比較するのかと、それがいつのコミットかまで出す
    // (stale な参照との比較に気づけるようにする)。日時が取れない場合は省く。
    const dated = gitRun(['log', '-1', '--format=%ci', ref], { allowFailure: true });
    const when = dated == null ? '' : String(dated).trim();
    writeErr(`[cross-review] origin の取得に失敗しました (オフライン等)。取得済みの ${ref} で続行します`
      + `${when ? ` (${ref} の最終コミット: ${when})` : ''}。\n`);
  }
  if (ref === 'origin/main') {
    writeErr('[cross-review] base として origin/main を使用します (--base で変更可)。\n');
    return { ref, source: 'origin-main', label: baseSourceLabel('origin-main'), display: ref };
  }
  return { ref: 'main', source: 'local-main', label: baseSourceLabel('local-main'), display: 'main' };
}

// 既定 base の解決結果からブランチ / SHA だけを取り出す薄いラッパ。
// 解決方法まで要る呼び出し側は resolveBaseSelection を使う。
function resolveBaseRef(opts, gitRun, deps = {}) {
  return resolveBaseSelection(opts, gitRun, deps).ref;
}

// レビュー差分サイズのガード閾値 (KB) を解決する。優先順:
//   1. CLI フラグ --max-diff-kb (opts.maxDiffKb が数値なら採用)
//   2. 環境変数 CROSS_REVIEW_MAX_DIFF_KB (非負整数として解釈できれば採用。できなければ無視して次へ)
//   3. 既定 256
// 戻り値 0 は「ガード無効」を表す。
function resolveMaxDiffKb(opts, env) {
  if (opts && typeof opts.maxDiffKb === 'number') return opts.maxDiffKb;
  const e = env || process.env;
  const fromEnv = parseNonNegativeInt(e.CROSS_REVIEW_MAX_DIFF_KB);
  if (fromEnv != null) return fromEnv;
  return 256;
}

// 巨大なファイル差分を stat 要約に置換する純関数。
// diffText を `diff --git ` 行でファイル単位チャンクに分割し、チャンクのバイトサイズ (utf8) が
// maxFileDiffKb KB を超えたら、本文を「diff --git 行 + 1 行の省略注記」に置き換える。
// maxFileDiffKb が 0 なら無置換でそのまま返す。
// 戻り値: { text, replacedCount } (置換が起きたチャンク数)。
function summarizeLargeFileDiffs(diffText, maxFileDiffKb) {
  if (!maxFileDiffKb || maxFileDiffKb <= 0) return { text: diffText, replacedCount: 0 };
  if (!diffText) return { text: diffText, replacedCount: 0 };
  const limitBytes = maxFileDiffKb * 1024;
  // `diff --git ` 行の直前で分割する。先頭に `diff --git ` 以外の前置きがあれば
  // それは独立した先頭チャンク (置換対象外) として保持する。
  const lines = diffText.split('\n');
  const chunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current != null) chunks.push(current);
      current = [line];
    } else if (current == null) {
      // `diff --git ` より前の前置き行 (通常は無いが堅牢化のため)。
      current = [line];
      // この先頭チャンクは diff ヘッダを持たないので置換対象にしない印を付ける。
      current.__preamble = true;
    } else {
      current.push(line);
    }
  }
  if (current != null) chunks.push(current);

  let replacedCount = 0;
  const outChunks = chunks.map((chunkLines) => {
    const chunkText = chunkLines.join('\n');
    if (chunkLines.__preamble) return chunkText; // 前置きは置換しない。
    const header = chunkLines[0];
    if (!header || !header.startsWith('diff --git ')) return chunkText;
    const bytes = Buffer.byteLength(chunkText, 'utf8');
    if (bytes <= limitBytes) return chunkText;
    // 追加/削除行数を数える (+++ / --- のヘッダ行は除く)。
    let added = 0;
    let removed = 0;
    for (const l of chunkLines) {
      if (l.startsWith('+') && !l.startsWith('+++')) added++;
      else if (l.startsWith('-') && !l.startsWith('---')) removed++;
    }
    replacedCount++;
    const kb = (bytes / 1024).toFixed(1);
    return `${header}\n(この差分は ${kb}KB・追加 ${added} 行 / 削除 ${removed} 行のため本文を省略。レビューに必要なら作業ツリーのファイルを個別に読むこと)`;
  });
  return { text: outChunks.join('\n'), replacedCount };
}

// 差分サイズガードの段階的縮退を計算する純粋関数。
// 全体閾値 (maxDiffKb) を超えた差分に対し、ファイル単位の要約閾値を steps の順に下げて
// summarizeLargeFileDiffs を再適用し、全体閾値以下に収まった段で止める。
// diffText には「要約を掛ける前の元の差分」を渡す。段ごとに元から計算し直すので git は再実行しない。
// steps の既定は DIFF_SHRINK_STEPS。現在の閾値以上の段は縮まないので飛ばす。
// 戻り値: { text, usedFileKb, replacedCount, fits, tried }
//   - fits:true なら text をそのままレビューへ回してよい。
//   - fits:false のときは最後に試した (最も強い) 段の結果を返す。呼び出し側は中断する。
//   - 要約が無効 (maxFileDiffKb が 0) か全体ガードが無効 (maxDiffKb が 0) なら縮退しない。
function shrinkDiffToFit(diffText, { maxDiffKb, maxFileDiffKb, steps } = {}) {
  const tried = [];
  if (!(maxFileDiffKb > 0) || !(maxDiffKb > 0)) {
    return { text: diffText, usedFileKb: maxFileDiffKb, replacedCount: 0, fits: false, tried };
  }
  const candidates = (steps || DIFF_SHRINK_STEPS)
    .filter((kb) => kb > 0 && kb < maxFileDiffKb)
    .sort((a, b) => b - a);
  let last = null;
  for (const kb of candidates) {
    tried.push(kb);
    const summarized = summarizeLargeFileDiffs(diffText, kb);
    const fits = Buffer.byteLength(summarized.text, 'utf8') / 1024 <= maxDiffKb;
    last = {
      text: summarized.text,
      usedFileKb: kb,
      replacedCount: summarized.replacedCount,
      fits,
      tried: tried.slice(),
    };
    if (fits) return last;
  }
  // 試せる段が無かった (既に最小の段より小さい閾値だった) 場合も「収まらない」で返す。
  return last || { text: diffText, usedFileKb: maxFileDiffKb, replacedCount: 0, fits: false, tried };
}

// ファイル単位の差分置換しきい値 (KB) を解決する。優先順:
//   1. CLI フラグ --max-file-diff-kb (opts.maxFileDiffKb が数値なら採用)
//   2. 環境変数 CROSS_REVIEW_MAX_FILE_DIFF_KB (非負整数として解釈できれば採用)
//   3. 既定 64
// 戻り値 0 は「置換無効」を表す。
function resolveMaxFileDiffKb(opts, env) {
  if (opts && typeof opts.maxFileDiffKb === 'number') return opts.maxFileDiffKb;
  const e = env || process.env;
  const fromEnv = parseNonNegativeInt(e.CROSS_REVIEW_MAX_FILE_DIFF_KB);
  if (fromEnv != null) return fromEnv;
  return 64;
}

// レビュアーへ渡すプロンプト (観点 + スコープ + モード別指示 + 申し送り + 差分本文)。
// codex / claude / subagent 共通 (codex/claude は stdin、subagent は stdout へ出す)。
// opts.fix で「修正まで依頼」と「レビューのみ」を切り替える。
// checklist は loadChecklist() の戻り値 (未指定/空なら GENERIC_CHECKLIST を使う)。
// instructions は --instructions の本文 (任意)。観点とは別に「重点指摘」として添える。
// excludedFiles は「除外したが変更のあったファイル名一覧」(任意)。1 件以上あればプロンプトに枠を足す。
function buildReviewPrompt(diffText, opts, checklist, instructions, excludedFiles) {
  const reviewPoints = (checklist != null && String(checklist).trim())
    ? checklist
    : GENERIC_CHECKLIST;
  const scope = opts.mode === 'uncommitted'
    ? '未コミットの作業ツリー差分 (tracked: git diff HEAD ＋ untracked 新規ファイル)'
    : `現在のブランチと ${opts.baseRef} の差分 (git diff ${opts.baseRef}...HEAD)`;
  const parts = [
    reviewPoints,
    '',
    `レビュー対象: ${scope}`,
    // 同一内容に二重にトークンを使わせないため、差分の再取得を抑止する枠付け。
    '差分本文はこのプロンプトに全文含まれている。git diff やファイル全文の再取得はしないこと（同じ内容に二重にトークンを使わない）。',
    '文脈の補完は、差分の周辺コード・呼び出し元・関連定義の確認など必要最小限に限定すること。',
    '（除外・省略されたファイルを読む必要があると判断した場合はこの限りではない）',
    '',
    opts.fix ? FIX_INSTRUCTION : REVIEW_ONLY_INSTRUCTION,
  ];
  if (instructions != null && String(instructions).trim()) {
    parts.push('', REVIEWER_NOTES_HEADER, String(instructions).trim());
  }
  if (Array.isArray(excludedFiles) && excludedFiles.length > 0) {
    parts.push(
      '',
      '【レビュー対象外（除外済み）の変更ファイル】',
      '以下は生成物・ロックファイル等として差分本文から除外した。必要と判断した場合のみ個別に読むこと:',
      excludedFiles.map((f) => `- ${f}`).join('\n'),
    );
  }
  parts.push('', '--- DIFF START ---', diffText, '--- DIFF END ---');
  return parts.join('\n');
}

// レビュー出力と PR コメント生成物の置き場。状態ファイルと同じく cwd に依存させず、
// スクリプト位置からリポジトリ直下に固定する (サブディレクトリから起動しても同じ場所を使う)。
function resolveReviewDir(deps = {}) {
  const scriptDir = deps.scriptDir || __dirname;
  return path.join(scriptDir, '..', REVIEW_DIR_NAME);
}

// ブランチ名をディレクトリ名へ安全に変換する。スラッシュなどはハイフンへ置換し、
// 元の UTF-8 名からハッシュを付けることで、置換後や大文字小文字の衝突を分離する。
// slug は読みやすさのため 64 文字に制限するが、ハッシュは必ず残す。
function safeBranchDirName(branch) {
  const original = String(branch == null ? '' : branch);
  let slug = original
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64)
    .replace(/^[.-]+|[.-]+$/g, '');
  if (!slug) slug = 'branch';
  const hash = crypto.createHash('sha256').update(original, 'utf8').digest('hex').slice(0, 16);
  return `branch-${slug}-${hash}`;
}

// ブランチ単位のレビュー出力先。resolveReviewDir はリポジトリ直下のルートを返し、
// 生成物だけをこの下へ分けることで、別ブランチの同じ往復番号を上書きしない。
function resolveBranchReviewDir(branch, deps = {}) {
  return path.join(resolveReviewDir(deps), safeBranchDirName(branch));
}

// 往復 N とレビュアー名から、`.cross-review/` に置くファイル名一式を返す純粋関数。
// 保存側 (runReview) と読み出し側 (runCommentCommand)、ドキュメントで名前がずれないよう 1 か所で決める。
//   - review: レビュアーの出力全文 (subagent 経路は主セッションが任意で貼る)
//   - prompt: subagent へ渡したプロンプト (subagent 経路のみ保存する)
//   - meta:   実行経路や base を記録する JSON
//   - triage: 主セッションが書く判断ファイル (指摘ごとの裏取りと対応)
//   - comment: 生成した PR コメント本文
function roundFileNames(round, reviewer) {
  return {
    review: `round-${round}-${reviewer}.md`,
    prompt: `round-${round}-${reviewer}-prompt.md`,
    meta: `round-${round}-${reviewer}.json`,
    triage: `round-${round}-triage.md`,
    comment: `round-${round}-comment.md`,
  };
}

// `.cross-review/` へ 1 ファイル書く既定の実装 (ディレクトリが無ければ作る)。
// 状態ファイル (writeStateFile) や利用上限の代替プロンプト (writeFile) とは別の口にして、
// 片方のテスト注入がもう片方を巻き込まないようにする。
function defaultReviewFileWriter(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

// レビュー出力 (または subagent へ渡したプロンプト) とメタ情報を `.cross-review/` へ保存する。
// 保存は往復が記録できたときだけ行う (往復番号が確定しないとファイル名を決められないため)。
// 保存の失敗はレビュー自体の失敗にしない。レビュアーの出力は端末に出ているので、
// 書けなかったことを警告するに留める。
// 戻り値は書いたパス ({ bodyPath, metaPath })、書けなければ null。
function saveRoundArtifacts({ branch, round, reviewer, body, bodyName, meta }, deps = {}) {
  const writeReviewFile = deps.writeReviewFile || defaultReviewFileWriter;
  const warn = deps.warn || ((m) => process.stderr.write(m));
  if (branch == null || String(branch).trim() === '') {
    warn('[cross-review] ブランチ名を取得できないためレビュー出力を保存できません。\n');
    return null;
  }
  const dir = resolveBranchReviewDir(branch, deps);
  const names = roundFileNames(round, reviewer);
  const bodyPath = path.join(dir, bodyName || names.review);
  const metaPath = path.join(dir, names.meta);
  try {
    const text = String(body == null ? '' : body);
    writeReviewFile(bodyPath, text.endsWith('\n') ? text : `${text}\n`);
    writeReviewFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    return { bodyPath, metaPath };
  } catch (err) {
    warn(`[cross-review] レビュー出力を保存できません: ${bodyPath} (${(err && err.message) || 'write error'})\n`);
    return null;
  }
}

// PR コメントに出すレビュアーの表示名。
const REVIEWER_DISPLAY_NAMES = {
  codex: 'Codex',
  claude: 'Claude',
  subagent: 'Claude 客観サブエージェント',
};
function reviewerDisplayName(reviewer) {
  return REVIEWER_DISPLAY_NAMES[reviewer] || String(reviewer == null ? '' : reviewer);
}

// メタ情報の via (実行経路) に対応する表示。
const VIA_LABELS = {
  agent: 'bridge 経由',
  direct: '直接起動',
  subagent: 'subagent',
};

// 判断ファイルの雛形。主セッションが指摘ごとに裏取りと対応を書くための形。
// 指摘が複数あるときは同じ形の節を並べる。
const TRIAGE_TEMPLATE = [
  '### 指摘 1（<重大度>）: <要約>',
  '> <レビュアーの指摘の引用>',
  '',
  '**裏取り**: <妥当 / 誤り / 過剰 と理由>',
  '**対応**: <対応内容とコミット、または非対応の理由>',
].join('\n');

// 桁区切りを入れた数値表記。文字数を人向けに書くときに使う。Intl (toLocaleString) は
// Node のビルドによってロケールデータの有無が変わるので、自前で揃えて出力を一定にする。
function groupDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 本文をコードフェンスで囲むときの区切り。本文に含まれるバックティック連なりより 1 つ長くし、
// 検証出力に ``` が含まれていてもフェンスが割れないようにする。
function fenceFor(text) {
  const runs = String(text == null ? '' : text).match(/`{3,}/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return '`'.repeat(Math.max(3, longest + 1));
}

// メタ情報 (round-<N>-<reviewer>.json) を PR コメント冒頭の 1 行にまとめる純粋関数。
// runCommentCommand は入力の欠落や JSON 不正を先に失敗扱いにするが、既存の呼び出し元が
// この純粋関数だけを使う場合は、欠落した項目を「不明」として安全に表示する。
function buildMetaSummary(meta) {
  if (!meta || typeof meta !== 'object') {
    return '実行経路: 不明 / base: 不明 / 差分サイズ: 不明 (メタ情報が読めませんでした)';
  }
  const via = VIA_LABELS[meta.via] || (meta.via ? String(meta.via) : '不明');
  const base = meta.base && typeof meta.base === 'object' ? meta.base : {};
  const scope = base.source === 'uncommitted'
    ? `対象: ${baseSourceLabel('uncommitted')}`
    : `base: ${base.ref ? `${base.ref} (${baseSourceLabel(base.source)})` : '不明'}`;
  const size = typeof meta.diffKb === 'number' && Number.isFinite(meta.diffKb)
    ? `${meta.diffKb.toFixed(1)}KB`
    : '不明';
  return `実行経路: ${via} / ${scope} / 差分サイズ: ${size}`;
}

// 1 往復分の PR コメント本文を組み立てる純粋関数 (I/O は持たない)。
//   - round / reviewer: 見出しに使う往復番号とレビュアー。
//   - meta:    round-<N>-<reviewer>.json の内容 (無ければ null)。
//   - triage:  判断ファイルの本文 (無ければ null。指摘の節は空にして、その旨を書く)。
//   - verify:  検証コマンドの出力 (無ければ節ごと省く)。長ければ末尾 VERIFY_TAIL_LINES 行に切る。
// 見出しは運用で使ってきた「## クロスレビュー N 往復目: <レビュアー> の指摘と対応」に合わせる。
function buildRoundComment({ round, reviewer, meta, triage, verify } = {}) {
  const parts = [
    `## クロスレビュー ${round} 往復目: ${reviewerDisplayName(reviewer)} の指摘と対応`,
    '',
    buildMetaSummary(meta),
    '',
  ];
  const triageBody = triage == null ? '' : String(triage).replace(/\s+$/, '');
  parts.push(
    triageBody || '（判断ファイルが未記入のため、指摘と対応の節は空です）',
    '',
  );
  const verifyBody = verify == null ? '' : String(verify).replace(/\s+$/, '');
  if (verifyBody) {
    const lines = verifyBody.split('\n');
    const truncated = lines.length > VERIFY_TAIL_LINES;
    const shown = truncated ? lines.slice(-VERIFY_TAIL_LINES) : lines;
    parts.push('### 確認内容', '');
    if (truncated) {
      parts.push(`（出力が長いため末尾 ${VERIFY_TAIL_LINES} 行のみ。全 ${lines.length} 行）`, '');
    }
    const fence = fenceFor(verifyBody);
    parts.push(`${fence}text`, shown.join('\n'), fence, '');
  }
  return `${parts.join('\n')}\n`;
}

// claude-codex-bridge の起動スクリプト (codex-agent.sh) のパスを解決する。解決順は:
//   1. 環境変数 CROSS_REVIEW_CODEX_AGENT (パス)
//   2. <ホーム>/.claude/tools/codex-agent.sh
// どちらも無ければ null (呼び出し側は codex を直接起動する)。
// 明示指定 (env) が解決できないときは、黙って既定パスへ落ちず警告する
// (観点ファイルの解決と同じ流儀。誤ったパスで意図しない起動経路になる運用事故を検知するため)。
// deps で env / homedir / 存在確認 / 警告出力を差し替え可能にする (テスト用)。
function resolveCodexAgentScript(deps = {}) {
  const env = deps.env || process.env;
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const warn = deps.warn || ((m) => process.stderr.write(m));
  const home = deps.homedir || os.homedir();
  const envPath = env.CROSS_REVIEW_CODEX_AGENT || '';
  const candidates = [];
  if (envPath) candidates.push(envPath);
  candidates.push(path.join(home, ...CODEX_AGENT_SCRIPT_SUBPATH));
  for (const p of candidates) {
    let found = false;
    try {
      found = !!exists(p);
    } catch {
      found = false; // 存在確認が失敗したら次の候補 / 直接起動へ進む。
    }
    if (found) return p;
    if (envPath && p === envPath) {
      warn(`[cross-review] CROSS_REVIEW_CODEX_AGENT=${envPath} が見つかりません。既定パスへフォールバックします。\n`);
    }
  }
  return null;
}

// bridge 経由で使う定義名を決める。--codex-agent で明示されていればそれ、無ければ
// --fix の有無で read-only (codex-review) と workspace-write (codex-subagent) を選び分ける。
function codexAgentNameFor(opts) {
  if (typeof opts.codexAgent === 'string') return opts.codexAgent;
  return opts.fix ? CODEX_AGENT_FIX_NAME : CODEX_AGENT_REVIEW_NAME;
}

// 定義ファイルのフロントマター (先頭行の `---` から次の `---` まで) から 1 キーの値を取り出す。
// 解釈は codex-agent.sh の fm_get と揃える:
//   - 前方一致した最初の行だけを使う (`<key>:` は行頭から)
//   - `key:` 直後の空白を落とし、そのあとに続く「空白 + #」以降を行末コメントとして落とす
//     (値の内部の # は残す)
//   - 前後の空白と、値全体を囲む引用符を除く
// 先頭行が `---` でなければフロントマター無しとみなして null を返す。キーが無いときも null。
function frontMatterValue(text, key) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const prefix = `${key}:`;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') break;
    if (!line.startsWith(prefix)) continue;
    let raw = line.slice(prefix.length).replace(/^[ \t]*/, '');
    raw = raw.replace(/[ \t][ \t]*#.*$/, '').trim();
    if (raw.length >= 2
      && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
      raw = raw.slice(1, -1);
    }
    return raw;
  }
  return null;
}

// 定義ファイル本文から codex_sandbox を読む。キーが無い、値が空、フロントマターが無い場合は
// bridge 側と同じ既定 (read-only) を返す。
function codexAgentSandboxOf(text) {
  const value = frontMatterValue(text, 'codex_sandbox');
  return value ? value : CODEX_SANDBOX_READ_ONLY;
}

// 定義ファイル (.claude/gpt-agents/<name>.md) を bridge と同じ順で探して本文を返す。
// どこにも無い / 読めない場合は null (呼び出し側は検査せず bridge に委ねる)。
// deps で cwd / homedir / 存在確認 / 読み込みを差し替え可能にする (テスト用)。
function readCodexAgentDefinition(name, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const home = deps.homedir || os.homedir();
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  for (const dir of [cwd, home]) {
    const defPath = path.join(dir, ...CODEX_AGENT_DEF_SUBDIR, `${name}.md`);
    let present = false;
    try {
      present = !!exists(defPath);
    } catch {
      present = false; // 存在確認そのものの失敗は「無い」と同じ扱い (bridge 側の検査に委ねる)。
    }
    if (!present) continue;
    // 存在するのに読めない定義は「無い」と同じにしない。bridge はその定義で起動するため、
    // 検証できないまま起動したり、別候補 (ホーム側) を検証して安全と見なしたりできない。
    try {
      return { path: defPath, text: readFile(defPath) };
    } catch (err) {
      return { path: defPath, error: (err && err.message) || 'read error' };
    }
  }
  return null;
}

// 定義ファイルの codex_sandbox が --fix の有無と一致するかを判定する純粋関数。
// レビューのみ (--fix 無し) は read-only、--fix は workspace-write でなければならない。
// bridge 経由ではサンドボックスを決めるのが定義ファイルなので、定義名が既定か明示かに関わらず
// 起動前にここで突き合わせる (利用者が定義ファイルの中身を変えている可能性があるため)。
function checkCodexAgentSandbox({ fix, sandbox } = {}) {
  const expected = fix ? CODEX_SANDBOX_WORKSPACE_WRITE : CODEX_SANDBOX_READ_ONLY;
  return { ok: sandbox === expected, expected, actual: sandbox };
}

// codex-agent.sh が承認方針を never に固定しているかを判定する純粋関数。
// スクリプトが codex への追加引数を受け付けない以上、この明示が無ければ承認方針は
// codex の config.toml 次第になり、「Codex の承認は never 固定」を保証できない。
// 文字列の存在ではなく「codex exec の呼び出し (行末の \\ による継続行を含む) の引数に
// -c approval_policy=never がある」ことを要求する。コメント (# 以降) は行末のものも含めて
// 取り除き、echo 等の別コマンドの引数は数えない (どちらも codex の起動引数に乗らないため)。
// 引用符の有無 (-c approval_policy=never / -c "approval_policy=never" / -c 'approval_policy=never')
// は問わない。判定は文字列ベースなので、bridge スクリプトが変数展開や関数経由で引数を組み立てる
// 形に変わったら追従が要る (そのときは直接起動へ戻るだけで、不変条件は破れない)。
const APPROVAL_NEVER_ARG_PATTERN = /(^|\s)-c\s+["']?approval_policy=never["']?(\s|$)/;
function scriptPinsApprovalNever(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  // 1. 各行から # 以降のコメントを落とす (引用符内の # は bash スクリプトでは稀なので区別しない)。
  // 2. 行末が \\ の行は次の行と連結し、1 コマンド 1 行にする。
  const commands = [];
  let current = '';
  for (const raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, '');
    if (/\\\s*$/.test(line)) {
      current += line.replace(/\\\s*$/, ' ');
      continue;
    }
    commands.push(current + line);
    current = '';
  }
  if (current) commands.push(current);
  // 3. codex exec の呼び出しを含むコマンドに限って、その引数列に -c approval_policy=never を求める。
  return commands.some((cmd) => {
    const at = cmd.search(/(^|\s)codex\s+exec(\s|$)/);
    return at >= 0 && APPROVAL_NEVER_ARG_PATTERN.test(cmd.slice(at));
  });
}

// bridge (codex-agent.sh) 経由の起動を組み立てる。起動前に 2 つの不変条件を確かめる:
//   - 承認は never 固定: スクリプトが approval_policy=never を明示していること。
//     明示が無い、またはスクリプトを読めない場合は null を返し、呼び出し側は直接起動へ戻す
//     (直接起動なら -c approval_policy=never を自分で渡せる)。
//   - サンドボックス: 定義ファイルの codex_sandbox が --fix の有無と一致すること。
//     食い違う場合は { error } を返し、レビュアーを起動させない。
// 定義ファイルが見つからないときは検査せず bridge に委ねる (bridge が終了コード 3 で未導入を
// 知らせ、呼び出し側が直接起動へ戻る)。
function codexAgentInvocation(script, opts, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const warn = deps.warn || ((m) => process.stderr.write(m));
  let scriptText;
  try {
    scriptText = readFile(script);
  } catch (err) {
    warn(`[cross-review] codex-agent.sh を読めないため直接起動へ切り替えます: ${script} (${(err && err.message) || 'read error'})\n`);
    return null;
  }
  if (!scriptPinsApprovalNever(scriptText)) {
    warn(`[cross-review] codex-agent.sh が ${APPROVAL_NEVER_MARKER} を明示していないため直接起動へ切り替えます (claude-codex-bridge #16 を参照)\n`);
    return null;
  }
  const agentName = codexAgentNameFor(opts);
  const def = readCodexAgentDefinition(agentName, deps);
  if (def && def.error) {
    return { error: `定義 ${agentName} を読めないため起動しません (${def.error}): ${def.path}` };
  }
  if (def) {
    const check = checkCodexAgentSandbox({ fix: opts.fix, sandbox: codexAgentSandboxOf(def.text) });
    if (!check.ok) {
      return {
        error: `定義 ${agentName} の codex_sandbox が ${check.actual} です`
          + ` (${opts.fix ? '--fix では' : 'レビューのみでは'} ${check.expected} が必要): ${def.path}`,
      };
    }
  }
  const cwd = deps.cwd || process.cwd();
  // codex-agent.sh は依頼文を stdin から読み、定義ファイルのフロントマターに従って
  // CODEX_HOME / モデル / effort / サンドボックスを決めて codex exec を起動する。
  return {
    cmd: 'bash',
    args: [script, agentName, '-C', cwd],
    via: 'agent',
    agentName,
    scriptPath: script,
    notice: opts.fix
      ? `Codex にレビュー + 検出事項の修正を依頼します (作業ツリーを編集します): codex-agent.sh 経由 (定義: ${agentName})\n`
      : `Codex でレビューを実行します: codex-agent.sh 経由 (定義: ${agentName})\n`,
  };
}

// reviewer / fix から「起動コマンド、引数、端末通知」を決める純粋関数。
// 主変更点 (どのレビュアーをどのサンドボックスで呼ぶか) を spawn 抜きで検証できるよう、
// runReview の配線部分を分離する。stdin に渡すプロンプトは prompt をそのまま使う。
// codex は codex-agent.sh (bridge) があればそれを経由し (via: 'agent')、無ければ
// codex を直接起動する (via: 'direct')。via は利用上限の判定 (isUsageLimitExit) と
// bridge 未導入時の再起動判断に使う。deps は resolveCodexAgentScript / codexAgentInvocation へ
// 渡す (env / homedir / exists / readFile / warn) ほか、bridge へ渡す作業ディレクトリ
// (deps.cwd) を差し替える。
// 戻り値に error があるときは起動してはいけない (呼び出し側がエラー終了する)。
function reviewerInvocation(opts, deps = {}) {
  if (opts.reviewer === 'codex') {
    // --no-codex-agent (codexAgent === false) は解決自体を行わず、常に直接起動する。
    const script = opts.codexAgent === false ? null : resolveCodexAgentScript(deps);
    // bridge 経由が不変条件 (承認 never 固定) を満たせないときは null が返るので直接起動へ落ちる。
    const agentInv = script ? codexAgentInvocation(script, opts, deps) : null;
    if (agentInv) return agentInv;
    return {
      cmd: 'codex',
      args: codexExecArgs(opts),
      via: 'direct',
      notice: opts.fix
        ? 'Codex にレビュー + 検出事項の修正を依頼します (作業ツリーを編集します)...\n'
        : 'Codex でレビューを実行します...\n',
    };
  }
  if (opts.reviewer === 'subagent') {
    // 外部 CLI を起動しない (emit:true)。組み立てたレビュープロンプトを stdout に出すだけで、
    // 実際のレビューは呼び出し側 (Claude) が Agent ツールで起動する客観サブエージェントが行う。
    // リモートコントロール環境 (codex/claude CLI を spawn できない) のフォールバック。
    return {
      emit: true,
      notice: opts.fix
        ? 'リモートコントロール用: レビュー + 修正プロンプトを stdout に出力します (書込権限付きの客観サブエージェントへ渡してください)。\n'
        : 'リモートコントロール用: レビュープロンプトを stdout に出力します (客観サブエージェントへ渡してください)。\n',
    };
  }
  return { cmd: 'claude', args: ['-p'], notice: 'Claude でレビューを実行します...\n' };
}

function isPathLikeCommand(cmd) {
  return path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\');
}

function isDirectWindowsExecutable(cmd) {
  return ['.exe', '.com'].includes(path.extname(cmd).toLowerCase());
}

function isWindowsShellWrapper(cmd) {
  return ['.cmd', '.bat'].includes(path.extname(cmd).toLowerCase());
}

function defaultWindowsCommandLookup(cmd) {
  const res = spawnSync('where.exe', [cmd], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Windows では PowerShell の Get-Command が .ps1 shim を返すことがある一方、
// where.exe では実行可能な .exe も見えることがある。直接起動できる .exe/.com を優先し、
// 見つからない場合だけ shell 経由にフォールバックする。これにより claude.exe 環境では
// shell:true と args の組み合わせに対する Node の警告を避けられる。
function resolveReviewerCommandForSpawn(cmd, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return { cmd, shell: false };
  if (isPathLikeCommand(cmd)) {
    return { cmd, shell: !isDirectWindowsExecutable(cmd) };
  }

  const lookup = deps.lookup || defaultWindowsCommandLookup;
  const candidates = lookup(cmd);
  const direct = candidates.find(isDirectWindowsExecutable);
  if (direct) return { cmd: direct, shell: false };

  const shellWrapper = candidates.find(isWindowsShellWrapper);
  if (shellWrapper) return { cmd: shellWrapper, shell: true };

  // .ps1 は cmd.exe では直接実行できないため、このフォールバックは環境依存。
  // npm グローバルインストールは通常 .cmd shim も作るので、実運用ではまずそこを使う。
  return { cmd: candidates[0] || cmd, shell: true };
}

// 子プロセスの出力 (Buffer の塊) を文字列として溜め込む収集器を作る純粋関数 (I/O は持たない)。
// ストリームごとに StringDecoder を持つのが要点で、塊の境界でマルチバイト文字が割れても
// 置換文字 (U+FFFD) を混ぜずに復元する (塊ごとに toString('utf8') すると、3 バイト文字が
// 2 分割された時点で壊れ、保存した全文を PR コメントへ転載したときに文字化けとして残る)。
// 保持するのは 2 種類で、用途が違うので上限も別:
//   - outputTail: 利用上限の判定に使う末尾 OUTPUT_TAIL_LIMIT
//   - output:     `.cross-review/` へ保存する全文。OUTPUT_CAPTURE_LIMIT を超えたら先頭を捨て、
//                 捨てたことを truncated で知らせる (保存側が注記を足せるようにするため)
// 使い方: push(ストリーム名, chunk) で流し込み、終了時に end() で decoder の残りを回収する。
function createStreamCollector() {
  const decoders = new Map();
  let output = '';
  let outputTail = '';
  let truncated = false;
  const absorb = (text) => {
    if (!text) return;
    outputTail += text;
    if (outputTail.length > OUTPUT_TAIL_LIMIT) outputTail = outputTail.slice(-OUTPUT_TAIL_LIMIT);
    output += text;
    if (output.length > OUTPUT_CAPTURE_LIMIT) {
      output = tailChars(output, OUTPUT_CAPTURE_LIMIT);
      truncated = true;
    }
  };
  const result = () => ({ output, outputTail, truncated });
  return {
    push(stream, chunk) {
      let decoder = decoders.get(stream);
      if (!decoder) {
        decoder = new StringDecoder('utf8');
        decoders.set(stream, decoder);
      }
      absorb(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')));
    },
    // 未完成のバイト列が残っていれば吐き出す。2 回呼んでも二重に足さないよう decoder を捨てる。
    end() {
      for (const decoder of decoders.values()) absorb(decoder.end());
      decoders.clear();
      return result();
    },
    result,
  };
}

// レビュアー CLI を起動し、stdin にプロンプトを流し込む。出力は端末へそのまま流す。
// Windows では起動直前に where.exe で実体を解決し、可能なら shell を使わずに起動する。
// stdio を pipe にするのは、端末へ転送しつつ末尾を保持して利用上限の判定に使うため
// (受け取った塊をそのまま書き出すので、見た目は stdio:'inherit' と変わらない)。
// onExit は終了時に 1 回だけ { code, outputTail, output, truncated, error } で呼ぶ
// (runReview が outputTail を上限判定に、output を `.cross-review/` への保存に使い、
//  truncated なら保存本文の先頭へ切り詰めの注記を足す)。
function spawnReviewer(cmd, args, stdinText, onExit) {
  const resolved = resolveReviewerCommandForSpawn(cmd);
  const child = spawn(resolved.cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Windows では .cmd/.bat shim のことがあるため、その場合だけ shell 経由にする。
    shell: resolved.shell,
  });
  // 転送側は Buffer のまま書いてバイト列を保ち、保持側は収集器 (StringDecoder) に任せる。
  // stdout と stderr は別々にデコードする (混ぜると片方の未完成バイト列がもう片方の先頭に
  // 継ぎ足され、境界で壊れるため)。
  const collector = createStreamCollector();
  const forward = (stream, sink, name) => {
    if (!stream) return;
    stream.on('data', (chunk) => {
      sink.write(chunk);
      collector.push(name, chunk);
    });
  };
  forward(child.stdout, process.stdout, 'stdout');
  forward(child.stderr, process.stderr, 'stderr');
  let settled = false;
  const finish = (code, error) => {
    if (settled) return; // error → close の順で両方発火することがあるため 1 回に絞る。
    settled = true;
    process.exitCode = code == null ? 1 : code;
    const { output, outputTail, truncated } = collector.end();
    if (typeof onExit === 'function') onExit({ code, outputTail, output, truncated, error: error || null });
  };
  child.on('error', (err) => {
    if (err && err.code === 'ENOENT') {
      process.stderr.write(`${cmd} CLI が見つかりません。PATH に ${cmd} を通してください。\n`);
    } else {
      process.stderr.write(`${cmd} の起動に失敗しました: ${err && err.message}\n`);
    }
    finish(1, err);
  });
  // 'exit' ではなく 'close' を待つ。pipe した stdout/stderr を読み切ってから判定するため。
  child.on('close', (code) => {
    finish(code, null);
  });
  if (child.stdin) {
    // 相手がプロンプトを読み切らずに終了することがある (bridge が定義不備で早期終了する等)。
    // その場合 stdin が EPIPE で error を出すので、握りつぶして終了コード側で判断する
    // (未処理の error イベントにすると、フォールバックの前にこのプロセスごと落ちる)。
    child.stdin.on('error', () => {});
    child.stdin.write(stdinText);
    child.stdin.end();
  }
  return child;
}

// レビュアーの終了が「Codex の利用上限」かどうかを判定する純粋関数。
//   - bridge 経由 (via: 'agent') は codex-agent.sh が上限を終了コード 75 に写像するのでそれだけを見る。
//   - 直接起動 (via: 'direct') は終了コードに上限専用の値が無いため、非ゼロ終了かつ
//     出力の末尾に上限を示す語があるときに限って上限と判定する。
// 正常終了 (0) とシグナル終了 (code == null) は上限として扱わない。
function isUsageLimitExit(result) {
  const { via, code, outputTail } = result || {};
  if (via === 'agent') return code === USAGE_LIMIT_EXIT_CODE;
  if (code === 0 || code == null) return false;
  return USAGE_LIMIT_PATTERN.test(String(outputTail || ''));
}

// 利用上限時に出す代替プロンプトの書き出し先を決める。--fallback-prompt があればそれ、
// 無ければ一時ディレクトリに pid 付きのファイル名を作る (同時実行でぶつからないように)。
function resolveFallbackPromptPath(opts, deps = {}) {
  if (opts && opts.fallbackPromptPath) return opts.fallbackPromptPath;
  const tmp = deps.tmpdir || os.tmpdir();
  const pid = deps.pid || process.pid;
  return path.join(tmp, `cross-review-fallback-${pid}.md`);
}

// 利用上限時のフォールバック。subagent 経路と同じプロンプト本文をファイルへ書き出し、
// 次に何をすればよいかを stderr に出して終了コードを 75 にする。
// stdout はレビュアーの出力で使われているので、プロンプト本文を stdout に混ぜない。
// 戻り値は書き出したパス (書けなければ null)。
function emitFallbackPrompt(prompt, opts, deps = {}) {
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const writeFile = deps.writeFile || ((p, body) => fs.writeFileSync(p, body, 'utf8'));
  const promptPath = resolveFallbackPromptPath(opts, deps);
  try {
    writeFile(promptPath, `${prompt}\n`);
  } catch (err) {
    writeErr(`[cross-review] 代替プロンプトを書き出せません: ${promptPath} (${(err && err.message) || 'write error'})\n`);
    process.exitCode = 1;
    return null;
  }
  writeErr(
    `[cross-review] Codex の利用上限のため subagent 代替に切り替えます。プロンプト: ${promptPath}\n`
    + '  その内容を Claude の客観サブエージェント (読み取り専用。--fix 時は書込権限付き) へ渡してください。\n'
    // --uncommitted のレビューだったなら、記録でも SHA を据え置く (経路によって状態遷移が食い違わないように)。
    + `  サブエージェントでのレビューが終わったら \`node tools/cross-review.js state --mark${opts.mode === 'uncommitted' ? ' --uncommitted' : ''}\` で往復を記録してください。\n`
    + '  PR コメントには「Codex を直接実行できないため (利用上限) subagent 代替で確認した」と残してください。\n',
  );
  process.exitCode = USAGE_LIMIT_EXIT_CODE;
  return promptPath;
}

// deps で gitRun / spawnFn を差し替え可能にする (テストから stdin 本文まで検証するため)。
// 既定は実 git / 実 spawn。codex 経路でも「観点 + 差分本文 + モード指示」を stdin に渡すのが
// 中核なので、その配線を結合テストで固定できるようにする。
function runReview(opts, deps = {}) {
  const gitRun = deps.gitRun || defaultGitRunner;
  const spawnFn = deps.spawnFn || spawnReviewer;
  // 人向け通知は writeErr、機械が拾う本文 (subagent のプロンプト) は writeOut に分離する。
  // deps.out / deps.err で差し替え可能にし、subagent 経路の stdout 本文をテストから検証する。
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  // 観点は deps.checklist 指定があれば優先、無ければ .cross-review.md / 汎用観点を解決する。
  const checklist = deps.checklist != null ? deps.checklist : loadChecklist(deps);
  // 申し送り (--instructions) は観点とは別系統。deps.instructions 指定があれば優先、
  // 無ければ opts.instructionsPath からファイルを読む (読めなければエラー終了)。
  let instructions = deps.instructions != null ? deps.instructions : null;
  if (instructions == null && opts.instructionsPath) {
    try {
      instructions = loadInstructions(opts.instructionsPath, deps);
    } catch (err) {
      writeErr(`--instructions のファイルを読めません: ${opts.instructionsPath} (${(err && err.message) || 'read error'})\n`);
      process.exitCode = 1;
      return null;
    }
  }
  // bridge の解決や状態ファイルの警告は、他の通知と同じ stderr の出口 (writeErr) へ流す。
  const invDeps = deps.warn ? deps : { ...deps, warn: writeErr };
  // 状態ファイル (往復回数 / 直前レビュー SHA / 非対応と判断した指摘) を読む。
  // --no-state、ブランチ名を取れない、ファイルが壊れているときは記録を使わず読み書きもしない。
  const readStateFn = deps.readState || readState;
  const writeStateFn = deps.writeState || writeState;
  const branch = opts.noState ? null : currentBranchName(gitRun);
  const loadedState = branch ? readStateFn(invDeps) : null;
  if (loadedState && loadedState.corrupt) {
    writeErr(`[cross-review] 状態ファイルを読めません (JSON 不正)。無視して続行します: ${loadedState.path}\n`);
  }
  const stateUsable = !!(loadedState && !loadedState.corrupt);
  const branchState = stateUsable ? branchStateOf(loadedState.state, branch) : null;
  // レビュアーを起動する前の HEAD を控える。--fix は作業ツリーしか触らないので、
  // 起動前後で HEAD は変わらない。
  const headSha = stateUsable && opts.mode !== 'uncommitted' ? currentHeadSha(gitRun) : null;
  // PR の情報 (番号と base ブランチ) は 1 回の `gh pr view --json number,baseRefName` から得て
  // 使い回す。既定 base の解決と PR 未作成の警告が同じ情報を必要とするため。
  const noFetch = isNoFetch(deps.env);
  const prInfoOf = deps.prInfo || createPrInfoReader(deps, noFetch);
  // レビューの往復は PR コメントを共有ログにする運用なので、PR が無いまま始めると記録が揮発する。
  // gh が「PR が無い」と答えたときだけ警告し、実行は止めない (gh 不在やネットワーク断で
  // 止めると、リモートを持たない取り込み先の作業まで妨げるため)。
  // CROSS_REVIEW_NO_FETCH=1 のときは gh を呼ばない方針に合わせて確認自体を省く。
  if (!opts.noPrCheck && !noFetch) {
    const prInfo = prInfoOf();
    if (prInfo.known && !prInfo.present) {
      writeErr('[cross-review] この枝の PR が見つかりません。レビューを回す前に PR を作成してください (例: gh pr create)。\n');
    }
  }
  // 既定 base (--base 未指定、コミット済み差分) は「前回レビュー SHA → PR の base →
  // origin/main → ローカル main」の順に解決する。opts を直接書き換えず、解決後の base を
  // 以降のスコープ表記、差分収集で使う。
  const baseSelection = resolveBaseSelection(opts, gitRun, { ...invDeps, branchState, prInfo: prInfoOf });
  const resolvedBaseRef = baseSelection.ref;
  // 除外パススペックを解決する (--no-exclude 指定時は無効化)。観点と同じ流儀で .cross-review-ignore を読む。
  const excludePatterns = opts.noExclude
    ? []
    : (deps.ignorePatterns != null ? deps.ignorePatterns : loadIgnorePatterns(deps));
  const excludePathspecs = toExcludePathspecs(excludePatterns);
  const baseChanged = resolvedBaseRef !== opts.baseRef;
  const resolvedOpts = (baseChanged || excludePathspecs.length > 0)
    ? { ...opts, baseRef: resolvedBaseRef, excludePathspecs }
    : opts;
  // どのレビュアー (codex / claude / subagent) も自前で差分を取り出し、プロンプトへ同梱する (untracked も含める)。
  let diffText;
  let excludedFiles = [];
  try {
    const collected = collectReviewDiff(resolvedOpts, gitRun);
    diffText = collected.diffText.trim();
    excludedFiles = collected.excludedFiles || [];
  } catch (err) {
    writeErr(`${(err && err.message) || 'git の実行に失敗しました'}\n`);
    process.exitCode = 1;
    return null;
  }
  if (!diffText) {
    // subagent は stdout を「サブエージェントへ渡すプロンプト」専用にするため、差分なしの通知も
    // stderr 側へ出す (stdout は空のまま保ち、空通知をプロンプトと誤認させない)。codex/claude は従来どおり stdout。
    (opts.reviewer === 'subagent' ? writeErr : writeOut)('レビュー対象の差分がありません。\n');
    return null;
  }
  // 巨大なファイル差分を stat 要約へ置換する (全体ガードの前に行う = 置換で縮んだ分はガードに掛からない)。
  // 縮退 (shrinkDiffToFit) は要約前の本文から計算し直すので、元の差分をここで保持しておく。
  const rawDiffText = diffText;
  const maxFileDiffKb = resolveMaxFileDiffKb(opts, deps.env);
  const summarized = summarizeLargeFileDiffs(rawDiffText, maxFileDiffKb);
  diffText = summarized.text;
  if (summarized.replacedCount > 0) {
    writeErr(`[cross-review] 大きなファイル差分 ${summarized.replacedCount} 件を要約に置換しました (--max-file-diff-kb で調整可)\n`);
  }
  const maxDiffKb = resolveMaxDiffKb(opts, deps.env);
  const overGuard = (text) => maxDiffKb > 0 && Buffer.byteLength(text, 'utf8') / 1024 > maxDiffKb;
  // 閾値を超えたら即中断せず、ファイル単位の要約閾値を段階的に下げて縮退を試す
  // (閾値をわずかに超えただけの差分で再実行させないため。git は再実行しない)。
  // --strict-diff-guard と --max-file-diff-kb 0 (要約無効) のときは従来どおり即中断する。
  let shrink = null;
  if (overGuard(diffText) && !opts.strictDiffGuard && maxFileDiffKb > 0) {
    shrink = shrinkDiffToFit(rawDiffText, { maxDiffKb, maxFileDiffKb });
    if (shrink.fits) {
      diffText = shrink.text;
      writeErr(`[cross-review] 差分が閾値 ${maxDiffKb}KB を超えたため、ファイル単位の要約閾値を ${shrink.usedFileKb}KB へ下げて ${shrink.replacedCount} 件を要約に置換しました。\n`);
    }
  }
  // 差分サイズは常に表示する (トークン浪費、stale base の検知)。
  // どの base とどの解決方法で比較したのかを同じ行に出し、比較対象が分からないまま
  // レビューが回ることを防ぐ。
  const diffKb = Buffer.byteLength(diffText, 'utf8') / 1024;
  const scopeLine = baseSelection.source === 'uncommitted'
    ? `対象: ${baseSelection.label}`
    : `base: ${baseSelection.display} (${baseSelection.label})`;
  writeErr(`[cross-review] ${scopeLine} / レビュー差分サイズ: ${diffKb.toFixed(1)}KB\n`);
  if (overGuard(diffText)) {
    let reason = '';
    if (opts.strictDiffGuard) {
      reason = '  --strict-diff-guard 指定のため、ファイル要約による段階的縮退は試していません。\n';
    } else if (maxFileDiffKb <= 0) {
      reason = '  --max-file-diff-kb 0 (ファイル要約が無効) のため、段階的縮退は試していません。\n';
    } else if (shrink && shrink.tried.length > 0) {
      reason = `  ファイル単位の要約閾値を ${shrink.tried.join('KB → ')}KB まで下げても収まりませんでした。\n`;
    }
    writeErr(
      `[cross-review] レビュー差分が閾値 ${maxDiffKb}KB を超えました (${diffKb.toFixed(1)}KB)。レビュアーを起動せず中断します。\n`
      + reason
      + '  考えられる原因: ローカル main が stale (git fetch origin main 後に再実行 / --base origin/main を明示)、生成物・lock ファイルの混入。\n'
      + '  意図的に大きい差分なら --max-diff-kb <n> を引き上げるか --max-diff-kb 0 でガードを無効化してください。\n',
    );
    process.exitCode = 1;
    return null;
  }
  // 非対応と判断した指摘は、申し送り (--instructions) と同じ系統の追加テキストとして
  // 観点と申し送りの後ろへ添える (buildReviewPrompt の引数は増やさない)。
  const reviewerNotes = joinReviewerNotes(
    instructions,
    branchState ? buildDismissedSection(branchState.dismissed) : null,
  );
  const prompt = buildReviewPrompt(diffText, resolvedOpts, checklist, reviewerNotes, excludedFiles);
  // サーキットブレーカーの 3 往復に達する実行は、起動前に知らせる (判断は運用側に残すので止めない)。
  if (branchState && branchState.round + 1 >= 3) {
    writeErr(`[cross-review] この枝の往復は ${branchState.round + 1} 回目です。3 往復到達時の扱いはサーキットブレーカーの規則を参照してください。\n`);
  }
  // 往復を数えるのは「レビューが実際に成立した」と CLI が観測できたときだけに限る。
  // 観測できるのは次の 2 つ:
  //   1. subagent 経路でプロンプトを stdout に出力したとき (明示的に選んだ経路なので、
  //      利用者がその場でサブエージェントへ渡す前提で数える)。
  //   2. レビュアー CLI が終了コード 0 で終わったとき (bridge → 直接起動のやり直しがある場合は
  //      やり直した後の結果で判断する)。
  // 起動失敗 (ENOENT 等)、非ゼロ終了、--no-fallback の失敗終了、利用上限フォールバックでは
  // 記録しない。記録してしまうと次回の既定 base がその時点の SHA になり、未レビューの差分が
  // 「差分なし」になって再試行できなくなるため。フォールバック後の記録は、サブエージェントでの
  // レビューを終えた利用者が `state --mark` で行う。
  // 1 実行につき最大 1 回 (bridge のやり直しを 2 往復と数えない)。
  // 戻り値は記録できた往復番号 (記録しなかったときは null)。レビュー出力の保存先
  // ブランチ別ディレクトリの round-<N>-<reviewer>.md の N に使うので、記録と保存の番号がずれない。
  let roundRecorded = false;
  const recordRound = () => {
    if (roundRecorded) return null;
    roundRecorded = true;
    if (!stateUsable) return null;
    // 書き込む直前に状態を読み直す (read-modify-write)。レビュアーの実行中に別プロセスが
    // dismiss や別ブランチのレビュー完了を書いていることがあり、起動前のスナップショットを
    // 基に書くとその更新を消してしまうため。
    const latest = readStateFn(invDeps);
    if (latest.corrupt) {
      // 壊れたファイルへ書き戻すと他の枝の記録まで消える。往復は記録せず警告に留める。
      writeErr(`[cross-review] 状態ファイルを読めません (JSON 不正)。往復を記録しません: ${latest.path}\n`);
      return null;
    }
    const updated = nextState(latest.state, { branch, sha: headSha, reviewer: opts.reviewer });
    // 状態を書けなかったら往復番号が確定しないので、レビュー出力も保存しない
    // (次回の実行で同じ番号のファイルを上書きしてしまうため)。
    if (!writeStateFn(updated, invDeps)) return null;
    return branchStateOf(updated, branch).round;
  };
  // レビュー出力 (codex / claude) か、サブエージェントへ渡したプロンプト (subagent) を
  // `.cross-review/` へ保存する。往復番号が確定したときだけ保存し、失敗しても警告に留める。
  const nowIso = () => (deps.now ? String(deps.now()) : new Date().toISOString());
  const saveRound = (round, { body, isPrompt, via, truncated }) => {
    if (round == null) return;
    const names = roundFileNames(round, opts.reviewer);
    // 保持量の上限で先頭を捨てていたら、保存本文の先頭に注記を入れ、メタにも印を残す。
    // 保存ファイルの先頭に注記を入れ、保存ファイルだけを見ても全文でないと分かるようにする。
    // outputTruncated は保存ファイル先頭の注記に対応するメタ情報で、`comment` では参照しない。
    // 切り詰めていないときはキーごと書かない (無ければ全文、という読み方を保つ)。
    const text = truncated ? `${OUTPUT_TRUNCATED_NOTICE}\n\n${String(body == null ? '' : body)}` : body;
    saveRoundArtifacts({
      branch,
      round,
      reviewer: opts.reviewer,
      body: text,
      bodyName: isPrompt ? names.prompt : names.review,
      meta: {
        reviewer: opts.reviewer,
        via,
        base: { ref: baseSelection.ref, source: baseSelection.source },
        diffKb: Number(diffKb.toFixed(1)),
        headSha,
        recordedAt: nowIso(),
        ...(truncated ? { outputTruncated: true } : {}),
      },
    }, invDeps);
  };
  // reviewerInvocation も解決後の opts で揃える (現状 baseRef は参照しないが、プロンプトの
  // スコープ表記と起動引数が将来食い違わないよう、解決後の値だけを下流に渡す)。
  const inv = reviewerInvocation(resolvedOpts, invDeps);
  if (inv.error) {
    // 定義ファイルの codex_sandbox が --fix の有無と食い違う。レビューのみで書き込み可能な
    // 定義を使わせないため、レビュアーを起動せずエラー終了する (引数エラーと同じ終了コード 2)。
    writeErr(`[cross-review] ${inv.error}\n`
      + '  定義ファイルの codex_sandbox を直すか、--codex-agent で適切な定義を指定してください。\n');
    process.exitCode = 2;
    return null;
  }
  if (inv.emit) {
    // subagent: 外部プロセスを起動せず、組み立てたプロンプト本文だけを stdout に出す。
    // 通知は stderr に分けて、stdout を「そのまま客観サブエージェントへ渡せるプロンプト」に保つ。
    writeErr(inv.notice);
    writeOut(prompt + '\n');
    // 保存するのは「渡したプロンプト」。レビュー結果を round-<N>-subagent.md へ貼る場合は
    // ローカルの記録として残すためで、`comment` はそのファイルを読まない。
    saveRound(recordRound(), { body: prompt, isPrompt: true, via: 'subagent' });
    return null;
  }
  // レビュアーを起動し、終了コードで「bridge 未導入」「利用上限」を切り分ける。
  // 起動を関数にするのは、bridge 未導入のときに同じプロンプトで直接起動をやり直すため。
  const start = (invocation) => {
    writeOut(invocation.notice);
    return spawnFn(invocation.cmd, invocation.args, prompt, (result) => {
      const exit = result || {};
      // bridge が未導入 (codex コマンドや定義が無い)、または bash 自体が無い場合は直接起動へ戻す。
      // 往復はやり直した後の結果で数えるので、ここでは記録しない。
      // bridge の切り替えは codex 経路だけの仕組み (claude は via が 'agent' にならない)。
      const bridgeUnavailable = exit.code === CODEX_AGENT_EXIT_MISSING
        || (exit.error && exit.error.code === 'ENOENT');
      if (resolvedOpts.reviewer === 'codex' && invocation.via === 'agent' && bridgeUnavailable) {
        writeErr('[cross-review] bridge が未導入のため直接起動へ切り替えます。\n');
        start(reviewerInvocation({ ...resolvedOpts, codexAgent: false }, invDeps));
        return;
      }
      if (exit.code === 0) {
        // レビュアーが最後まで走った。ここで初めて 1 往復として数え、出力を保存する
        // (bridge のやり直しがあった場合は、やり直した後の実行経路を記録する)。
        saveRound(recordRound(), {
          body: exit.output,
          isPrompt: false,
          via: invocation.via || 'direct',
          truncated: !!exit.truncated,
        });
        return;
      }
      // 上限フォールバックは codex 経路だけの仕組み (claude CLI 経路は対象外。subagent はここに来ない)。
      if (resolvedOpts.reviewer !== 'codex') return;
      if (opts.noFallback) return; // --no-fallback は従来どおり失敗終了 (終了コードはそのまま)。
      if (!isUsageLimitExit({ via: invocation.via, code: exit.code, outputTail: exit.outputTail })) return;
      // 往復は記録しない。CLI はサブエージェントがレビューを終えたかを観測できないので、
      // 書き出した時点で記録すると、プロンプトを渡さずに再実行したとき未レビューの差分が
      // 「差分なし」になって再試行できなくなる。記録は `state --mark` で利用者が行う。
      emitFallbackPrompt(prompt, opts, {
        err: writeErr,
        writeFile: deps.writeFile,
        tmpdir: deps.tmpdir,
        pid: deps.pid,
      });
    });
  };
  return start(inv);
}

// `state` サブコマンド。現在の枝の記録を JSON で表示し、--reset ならその枝の記録を消し、
// --mark なら往復を 1 回分記録する (round を 1 増やし、直前レビュー SHA を現在の HEAD にする)。
// --mark があるのは、利用上限フォールバックのように CLI がレビューの成立を観測できない経路で、
// レビューを終えた利用者が往復を進められるようにするため。
// deps は runReview と同じ流儀で gitRun / 出力 / 状態ファイルの読み書きを差し替えられる。
function runStateCommand(opts, deps = {}) {
  const gitRun = deps.gitRun || defaultGitRunner;
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const stateDeps = deps.warn ? deps : { ...deps, warn: writeErr };
  const readStateFn = deps.readState || readState;
  const writeStateFn = deps.writeState || writeState;
  const branch = currentBranchName(gitRun);
  if (!branch) {
    writeErr('[cross-review] 現在のブランチ名を取得できません (git リポジトリの中で実行してください)。\n');
    process.exitCode = 1;
    return null;
  }
  const loaded = readStateFn(stateDeps);
  if (loaded.corrupt) {
    // 壊れたファイルへ書き戻すと他の枝の記録まで消えるので、読み書きどちらも行わない。
    writeErr(`[cross-review] 状態ファイルを読めません (JSON 不正)。手で確認するか削除してください: ${loaded.path}\n`);
    process.exitCode = 1;
    return null;
  }
  if (opts.mark) {
    // 直前に読んだ状態へ 1 往復分の遷移を適用する。SHA を取れなければ nextState が
    // lastReviewedSha を据え置くので、往復だけが進む。
    // --uncommitted 付きなら SHA を据え置く (レビュー実行の --uncommitted と同じ規則。作業ツリー差分の
    // レビューは「この SHA 以降の増分」の意味を持たず、HEAD まで進めると未レビューのコミットが
    // 次回の既定差分から抜けるため)。
    const headSha = opts.mode === 'uncommitted' ? null : currentHeadSha(gitRun);
    const updated = nextState(loaded.state, { branch, sha: headSha });
    // 書けていないのに「記録しました」とは言わない (失敗理由は writeState が警告済み)。
    if (!writeStateFn(updated, stateDeps)) {
      process.exitCode = 1;
      return null;
    }
    const marked = branchStateOf(updated, branch);
    writeErr(`[cross-review] ${branch} の往復を記録しました (${marked.round} 回目 / 直前レビュー SHA: ${marked.lastReviewedSha || 'なし'}): ${loaded.path}\n`);
    return null;
  }
  if (opts.reset) {
    // 書けていないのに「消しました」とは言わない (失敗理由は writeState が警告済み)。
    if (!writeStateFn(withoutBranch(loaded.state, branch), stateDeps)) {
      process.exitCode = 1;
      return null;
    }
    writeErr(`[cross-review] ${branch} の記録を消しました: ${loaded.path}\n`);
    return null;
  }
  const current = branchStateOf(loaded.state, branch);
  writeOut(`${JSON.stringify({ branch, statePath: loaded.path, ...current }, null, 2)}\n`);
  return null;
}

// `dismiss "<要約>"` サブコマンド。現在の枝の非対応指摘へ 1 件足す (重複は足さない)。
function runDismissCommand(opts, deps = {}) {
  const gitRun = deps.gitRun || defaultGitRunner;
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const stateDeps = deps.warn ? deps : { ...deps, warn: writeErr };
  const readStateFn = deps.readState || readState;
  const writeStateFn = deps.writeState || writeState;
  const branch = currentBranchName(gitRun);
  if (!branch) {
    writeErr('[cross-review] 現在のブランチ名を取得できません (git リポジトリの中で実行してください)。\n');
    process.exitCode = 1;
    return null;
  }
  const loaded = readStateFn(stateDeps);
  if (loaded.corrupt) {
    writeErr(`[cross-review] 状態ファイルを読めません (JSON 不正)。手で確認するか削除してください: ${loaded.path}\n`);
    process.exitCode = 1;
    return null;
  }
  const text = String(opts.dismissText == null ? '' : opts.dismissText).trim();
  const before = branchStateOf(loaded.state, branch).dismissed.length;
  const updated = withDismissed(loaded.state, branch, text);
  const after = branchStateOf(updated, branch).dismissed.length;
  if (after === before) {
    writeErr(`[cross-review] 同じ要約が既に記録されています (${branch}): ${text}\n`);
    return null;
  }
  // 書けていないのに「記録しました」とは言わない (失敗理由は writeState が警告済み)。
  if (!writeStateFn(updated, stateDeps)) {
    process.exitCode = 1;
    return null;
  }
  writeErr(`[cross-review] 非対応と判断した指摘を記録しました (${branch}): ${text}\n`);
  return null;
}

// `.cross-review/` から `round-<N>-<reviewer>.json` を探し、その往復のレビュアー名を列挙する。
// メタ情報 (json) を目印にするのは、レビュー出力 (md) が subagent 経路では後から人の手で
// 置かれるのに対し、メタ情報は CLI が必ず書くため。
function detectRoundReviewers(dir, round, deps = {}) {
  const readdir = deps.readdir || ((p) => fs.readdirSync(p));
  let entries;
  try {
    entries = readdir(dir);
  } catch {
    return []; // ディレクトリが無い = まだ 1 度もレビューを保存していない。
  }
  const pattern = new RegExp(`^round-${round}-(.+)\\.json$`);
  const found = [];
  for (const entry of entries || []) {
    const matched = pattern.exec(String(entry));
    if (matched) found.push(matched[1]);
  }
  return found.sort();
}

// 旧形式の平置き出力に一致するファイル名だけを判定する。正の往復番号を要求し、
// ディレクトリ名や別用途のファイル名は対象にしない。
function isLegacyArtifactName(name) {
  const matched = /^round-(\d+)-.+\.(?:md|json)$/.exec(String(name));
  if (!matched) return false;
  const round = parseNonNegativeInt(matched[1]);
  return round != null && round > 0;
}

// `artifacts --clean-legacy` は移行時に残った平置きファイルだけを掃除する。
// ブランチ別ディレクトリへは再帰せず、対象外のファイルとディレクトリを残す。
function runArtifactsCommand(opts, deps = {}) {
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const dir = resolveReviewDir(deps);
  const readdir = deps.readdir || ((p, options) => fs.readdirSync(p, options));
  const removeFile = deps.removeFile || deps.unlinkFile || deps.unlink || deps.rm || ((p) => fs.unlinkSync(p));
  let entries;
  try {
    entries = readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    writeErr(`[cross-review] 旧形式の出力一覧を読めません: ${dir} (${(err && err.message) || 'read error'})\n`);
    process.exitCode = 1;
    return null;
  }
  const deleted = [];
  let failed = false;
  for (const entry of entries || []) {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    if (!isLegacyArtifactName(name)) continue;
    const target = path.join(dir, String(name));
    let isFile = true;
    if (entry && typeof entry.isFile === 'function') {
      try {
        isFile = entry.isFile();
      } catch (err) {
        writeErr(`[cross-review] 旧形式の出力を確認できません: ${target} (${(err && err.message) || 'stat error'})\n`);
        failed = true;
        continue;
      }
    } else if (typeof deps.isFile === 'function') {
      try {
        isFile = !!deps.isFile(target);
      } catch (err) {
        writeErr(`[cross-review] 旧形式の出力を確認できません: ${target} (${(err && err.message) || 'stat error'})\n`);
        failed = true;
        continue;
      }
    } else if (typeof deps.stat === 'function') {
      try {
        const stat = deps.stat(target);
        isFile = !!(stat && typeof stat.isFile === 'function' && stat.isFile());
      } catch (err) {
        writeErr(`[cross-review] 旧形式の出力を確認できません: ${target} (${(err && err.message) || 'stat error'})\n`);
        failed = true;
        continue;
      }
    }
    if (!isFile) continue;
    try {
      removeFile(target);
      deleted.push(target);
      writeOut(`${target}\n`);
    } catch (err) {
      writeErr(`[cross-review] 旧形式の出力を削除できません: ${target} (${(err && err.message) || 'delete error'})\n`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  return deleted;
}

// 外部呼び出しからも、オプションを組み立てず旧平置き掃除を実行できる入口を提供する。
function cleanLegacyArtifacts(deps = {}) {
  return runArtifactsCommand({ cleanLegacy: true }, deps);
}

// `comment --round <N>` サブコマンド。保存済みのメタ情報、主セッションが書いた判断ファイル、
// 検証出力を定型に整形し、`gh pr comment --body-file` へ渡すファイルを書き出す。
// `--post` を付けたときは本文を先に保存してから gh へ投稿し、失敗時に保存本文を削除する。
// deps で出力、ファイル読み書き、gh の呼び出しを差し替えられる (runReview と同じ流儀)。
function runCommentCommand(opts, deps = {}) {
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const gitRun = deps.gitRun || defaultGitRunner;
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const writeReviewFile = deps.writeReviewFile || defaultReviewFileWriter;
  const round = opts.round;
  let branch;
  try {
    branch = currentBranchName(gitRun);
  } catch {
    branch = null;
  }
  if (!branch) {
    writeErr('[cross-review] 現在のブランチ名を取得できません (git リポジトリの中で実行してください)。\n');
    process.exitCode = 1;
    return null;
  }
  const dir = resolveBranchReviewDir(branch, deps);
  const outPath = opts.outPath || path.join(dir, roundFileNames(round, '').comment);
  const usesDefaultOut = !opts.outPath;
  let outputWritten = false;
  const removeFile = deps.removeFile || deps.unlinkFile || deps.unlink || deps.rm || ((p) => fs.unlinkSync(p));
  const removeOutput = () => {
    try {
      if (!exists(outPath)) return null;
      removeFile(outPath);
      return null;
    } catch (err) {
      return err;
    }
  };
  // 既定出力だけは入力検査前に消し、失敗した実行後に前回本文を再利用できないようにする。
  // 明示された --out は任意の既存ファイルを指し得るため、本文を書ける段階まで変更しない。
  const oldOutputError = usesDefaultOut ? removeOutput() : null;
  if (oldOutputError) {
    writeErr(`[cross-review] 以前の PR コメント本文を削除できません: ${outPath} (${oldOutputError.message || 'delete error'})\n`);
    process.exitCode = 1;
    return null;
  }
  const fail = (message) => {
    const cleanupError = (usesDefaultOut || outputWritten) ? removeOutput() : null;
    writeErr(message);
    if (cleanupError) {
      writeErr(`[cross-review] 失敗後の PR コメント本文を削除できません: ${outPath} (${cleanupError.message || 'delete error'})\n`);
    }
    process.exitCode = 1;
    return null;
  };

  // レビュアーは明示が無ければメタ情報から自動で決める。複数あるときに黙って片方を選ぶと、
  // 別のレビュアーの出力を貼ったコメントができてしまうのでエラーにする。
  let reviewer = opts.reviewerName;
  if (!reviewer) {
    const found = detectRoundReviewers(dir, round, deps);
    if (found.length === 0) {
      return fail(`[cross-review] ${round} 往復目のレビュアーのメタ情報が見つかりません: ${path.join(dir, `round-${round}-<reviewer>.json`)}\n`
        + '  レビューを実行すると保存されます (--no-state では保存しません)。\n');
    }
    if (found.length > 1) {
      return fail(`[cross-review] ${round} 往復目のレビュアーが複数あります: ${found.join(' / ')}\n`
        + '  --reviewer <name> でどれを使うか指定してください。\n');
    }
    reviewer = found[0];
  }
  const names = roundFileNames(round, reviewer);

  // メタ情報は実行経路と base を確定する入力なので、無い、読めない、形式が不正な場合は失敗にする。
  const metaPath = path.join(dir, names.meta);
  let metaText;
  try {
    if (!exists(metaPath)) {
      return fail(`[cross-review] メタ情報がありません: ${metaPath}\n`);
    }
    metaText = String(readFile(metaPath));
  } catch (err) {
    return fail(`[cross-review] メタ情報を読めません: ${metaPath} (${(err && err.message) || 'read error'})\n`);
  }
  let meta;
  try {
    meta = JSON.parse(metaText);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('JSON object required');
  } catch (err) {
    return fail(`[cross-review] メタ情報を読めません (JSON 不正): ${metaPath} (${(err && err.message) || 'parse error'})\n`);
  }

  // 判断ファイルが無ければ雛形だけを保存して終了する。未確認の指摘を含む本文を生成しない。
  const triagePath = path.join(dir, names.triage);
  let hasTriage;
  try {
    hasTriage = exists(triagePath);
  } catch (err) {
    return fail(`[cross-review] 判断ファイルを確認できません: ${triagePath} (${(err && err.message) || 'stat error'})\n`);
  }
  if (!hasTriage) {
    try {
      writeReviewFile(triagePath, `${TRIAGE_TEMPLATE}\n`);
    } catch (err) {
      return fail(`[cross-review] 判断ファイルの雛形を書けません: ${triagePath} (${(err && err.message) || 'write error'})\n`);
    }
    writeErr(`[cross-review] 判断ファイルがありません: ${triagePath}\n`
      + '  雛形を書き出したので、指摘ごとの裏取りと対応を書いてから再実行してください。\n');
    process.exitCode = 1;
    return null;
  }
  let triage;
  try {
    triage = String(readFile(triagePath));
  } catch (err) {
    return fail(`[cross-review] 判断ファイルを読めません: ${triagePath} (${(err && err.message) || 'read error'})\n`);
  }

  // 検証出力は明示指定なので、読めないときは黙って省かずエラーにする。
  let verify = null;
  if (opts.verifyPath) {
    try {
      verify = String(readFile(opts.verifyPath));
    } catch (err) {
      return fail(`[cross-review] --verify のファイルを読めません: ${opts.verifyPath} (${(err && err.message) || 'read error'})\n`);
    }
  }

  let body;
  try {
    body = buildRoundComment({ round, reviewer, meta, triage, verify });
  } catch (err) {
    return fail(`[cross-review] PR コメント本文を生成できません: ${outPath} (${(err && err.message) || 'build error'})\n`);
  }
  if (body.length > COMMENT_SIZE_WARN_LIMIT) {
    writeErr(`[cross-review] 生成した本文が ${groupDigits(body.length)} 文字あります`
      + ' (GitHub のコメント上限 65,536 文字を超えると投稿できません)。\n'
      + '  判断ファイルか --verify の出力を削ってから投稿してください。\n');
  }
  // 投稿経路でも本文を先に保存する。gh へ渡す本文はこのメモリ上の値を使い、
  // 保存ファイルを読み返さない。投稿に失敗した場合は fail がこの出力先を削除する。
  try {
    writeReviewFile(outPath, body);
    outputWritten = true;
  } catch (err) {
    return fail(`[cross-review] PR コメント本文を書けません: ${outPath} (${(err && err.message) || 'write error'})\n`);
  }
  if (opts.postNumber != null) {
    const ghRun = deps.ghRun || defaultGhRunner;
    let result;
    try {
      result = normalizeGhResult(ghRun(
        ['pr', 'comment', String(opts.postNumber), '--body-file', '-'],
        { input: body, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      ));
    } catch (err) {
      return fail(`[cross-review] PR コメントを投稿できません: ${err.message || 'gh error'}\n`);
    }
    if (!result || result.status !== 0) {
      const detail = result
        ? (result.error || result.stderr || result.stdout || `exit ${result.status}`)
        : 'gh の実行結果を取得できません';
      return fail(`[cross-review] PR コメントを投稿できません: ${detail}\n`);
    }
    writeErr(`[cross-review] PR #${opts.postNumber} へコメントを投稿しました: ${outPath}\n`);
    return outPath;
  }
  const prInfoOf = deps.prInfo || createPrInfoReader(deps, isNoFetch(deps.env));
  let prInfo;
  try {
    prInfo = prInfoOf();
  } catch (err) {
    return fail(`[cross-review] PR 情報を取得できません: ${err.message || 'gh error'}\n`);
  }
  const prNumber = prInfo && prInfo.known && prInfo.present && prInfo.number ? String(prInfo.number) : '<PR番号>';
  // パスは二重引用符で囲む。空白を含むパスでもそのまま貼れるようにする。
  writeErr(`[cross-review] PR コメントの本文を生成しました: ${outPath}\n`
    + `  gh pr comment ${prNumber} --body-file "${outPath}"\n`);
  return outPath;
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
  if (opts.command === 'state') {
    runStateCommand(opts);
    return;
  }
  if (opts.command === 'dismiss') {
    runDismissCommand(opts);
    return;
  }
  if (opts.command === 'comment') {
    runCommentCommand(opts);
    return;
  }
  if (opts.command === 'artifacts') {
    runArtifactsCommand(opts);
    return;
  }
  runReview(opts);
}

module.exports = {
  parseArgs,
  codexExecArgs,
  reviewerInvocation,
  resolveCodexAgentScript,
  codexAgentNameFor,
  codexAgentInvocation,
  frontMatterValue,
  codexAgentSandboxOf,
  readCodexAgentDefinition,
  checkCodexAgentSandbox,
  scriptPinsApprovalNever,
  isUsageLimitExit,
  resolveFallbackPromptPath,
  emitFallbackPrompt,
  collectReviewDiff,
  resolveBaseRef,
  resolveBaseSelection,
  resolveMaxDiffKb,
  resolveMaxFileDiffKb,
  summarizeLargeFileDiffs,
  shrinkDiffToFit,
  buildReviewPrompt,
  buildDismissedSection,
  joinReviewerNotes,
  resolveStatePath,
  emptyBranchState,
  normalizeState,
  branchStateOf,
  nextState,
  withDismissed,
  withoutBranch,
  readState,
  writeState,
  currentBranchName,
  currentHeadSha,
  commitExists,
  isNoFetch,
  runReview,
  runStateCommand,
  runDismissCommand,
  runArtifactsCommand,
  cleanLegacyArtifacts,
  runCommentCommand,
  buildRoundComment,
  buildMetaSummary,
  reviewerDisplayName,
  baseSourceLabel,
  roundFileNames,
  resolveReviewDir,
  safeBranchDirName,
  resolveBranchReviewDir,
  isLegacyArtifactName,
  saveRoundArtifacts,
  detectRoundReviewers,
  normalizeGhResult,
  defaultGhRunner,
  readPrInfo,
  createPrInfoReader,
  loadChecklist,
  loadInstructions,
  loadIgnorePatterns,
  toExcludePathspecs,
  resolveReviewerCommandForSpawn,
  createStreamCollector,
  CHECKLIST_FILENAME,
  IGNORE_FILENAME,
  STATE_FILENAME,
  REVIEW_DIR_NAME,
  VERIFY_TAIL_LINES,
  COMMENT_SIZE_WARN_LIMIT,
  OUTPUT_CAPTURE_LIMIT,
  OUTPUT_TRUNCATED_NOTICE,
  tailChars,
  TRIAGE_TEMPLATE,
  DIFF_SHRINK_STEPS,
  NO_FETCH_ENV,
  CODEX_AGENT_REVIEW_NAME,
  CODEX_AGENT_FIX_NAME,
  CODEX_AGENT_EXIT_MISSING,
  CODEX_SANDBOX_READ_ONLY,
  CODEX_SANDBOX_WORKSPACE_WRITE,
  USAGE_LIMIT_EXIT_CODE,
  DEFAULT_EXCLUDE_PATTERNS,
  GENERIC_CHECKLIST,
  REVIEW_ONLY_INSTRUCTION,
  FIX_INSTRUCTION,
  REVIEWER_NOTES_HEADER,
  DISMISSED_HEADER,
  USAGE,
};

if (require.main === module) main();
