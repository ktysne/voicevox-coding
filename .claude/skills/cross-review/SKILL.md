---
name: cross-review
description: 実装を一区切りした後の AI 相互レビュー (Claude↔Codex / 客観サブエージェント) の実行手順。レビュー依頼、指摘対応、妥当性確認の往復を回すとき、または `npm run review:codex*` / `tools/cross-review.js` を使うときに使う。
---

# AI 相互レビューの実行手順

> **汎用 SKILL（vendored）**。`tools/cross-review.sync.js` で upstream
> ([ai-cross-review](https://github.com/ktysne/ai-cross-review)) から**上書き更新される対象**。直接編集せず、
> 変更は upstream に入れて再同期する。**プロジェクト固有の運用**（検証コマンド、CI、同期スクリプト名、
> ファイル配置など）はこの SKILL に書かず、`.cross-review.md`（観点）と各リポの doc（任意の overlay）へ分離する。

**汎用フローの正本**は `docs/cross-review.md`（取り込み先で別名、別配置のことがあるので、パスでなく名前で参照する）。
レビュー観点はリポジトリ直下の `.cross-review.md` が単一ソース（CLI が自動添付する）。

## 実装一区切り後の起点（3 択を提示）

改修（実装、修正）を一区切りしたら、**完了扱いにする前に必ず**次の 3 択を提示する
（「コミットして終わり」「PR を作って終わり」と勝手に締めない。反復改修でも論理的な区切りごとに確認する）。
Claude 主導なら `AskUserQuestion` で提示する（チャット本文の番号付きリストで代用しない）。
Codex desktop で提示するときは、利用可能なツール一覧を確認し、短い選択肢をクリック可能な UI として表示するユーザ入力ツールが利用可能なら必ず優先する。
現在のツール名の例は `request_user_input_async` と `request_user_input` である。
ユーザ入力ツールが利用可能なら、チャット本文の番号付きリストで代用しない。
次の 3 項目を指定された順序と意味でツールへ渡し、ユーザの選択を待つ。
ツールにラベル長の制限がある場合はラベルだけを短縮し、選択後に行う処理を各項目の説明へ一文で記載する。
現在の実行モードでユーザ入力ツールを利用できない場合でも、対話可能なら本文に同じ 3 択を同じ順序・意味で示し、推奨選択肢のラベル末尾に「(推奨)」を付けて返信を待つ。
CLI、`codex exec`、非対話実行などユーザの返信を受け取れない環境では、選択 UI や本文でユーザの回答を待たず、起動元が指定したレビュー経路をそのまま実行する。
並び順は固定です。
主セッションは毎回どれを推奨するかを決め、その選択肢のラベル末尾に必ず「(推奨)」を付けます（付けるのはラベル末尾だけで、並び順は変えません）。
推奨の既定は選択肢 1 です。
軽微な例外に該当するなら 3、別ベンダーの利用上限が近い、または接続できないなら 2 を推奨します。

用語の定義は次のとおり。

- **実装者**：今回の差分を書いたモデルのベンダー。主セッションが自分で書いたならそのベンダー（Claude 主導なら Claude）、実装用サブエージェントへ委譲して GPT 側（Codex）が書いたなら Codex。混在するときは、主セッション（設計と監査を担う側）と別のベンダーをレビュアーに選ぶ。
- **レビュアー**：差分だけを見て指摘を出す側。

主セッションは 3 択を提示する直前に、報告へ「今回の実装者: Claude / Codex」を一言書く。

1. **クロスレビューを依頼する（レビュアー: 実装者と別のベンダー）**
2. **同じベンダーの客観サブエージェントにレビューを依頼する**（別ベンダーの利用上限が近い、または接続できないとき）
3. **クロスレビューを行わない**（後述の軽微な例外に該当するときの既定）

| 実装者 | 選択肢 1（実装者と別のベンダー） | 選択肢 2（同じベンダーの客観サブエージェント） |
|---|---|---|
| Claude | `npm run review:codex` (codex は read-only) | `node tools/cross-review.js subagent` の出力を Claude の客観サブエージェント (Agent ツール、読み取り専用) へ渡す |
| Codex | `node tools/cross-review.js subagent` の出力を Claude の客観サブエージェントへ渡す（Codex が主セッションなら `npm run review:claude`） | `npm run review:codex` |

どの選択肢でも、レビュー結果を読んで修正を適用するのは主セッション（ユーザ判断が要る内容は、推奨の対応方法を添えて確認してから着手）。
修正が終わったら、同じ経路でもう一度レビューを回して妥当性確認する。
レビューを回す前に feature ブランチと PR を用意する。詳細は `docs/cross-review.md`。

`--fix`（`npm run review:codex:fix` / `node tools/cross-review.js codex --fix`）は 3 択に入らない。
主セッションがレビュー結果を裏取りし、直す指摘を確定させたうえで、適用だけを Codex に任せたいときの道具である。

## 実行環境ごとの経路

### ローカル CLI 環境 (codex / claude CLI が PATH にある)

`npm run review:codex*` / `npm run review:claude` はレビュアー CLI がネットワーク/API 接続を使うため **Bash をサンドボックス無効、ネットワーク許可で実行**する。CLI が見えていても API 接続だけ止まることがあるので、`claude -p "Reply with OK only."` のような最小呼び出しで切り分ける。

```bash
npm run review:codex                  # 既定 base との差分をレビュー (read-only)
npm run review:codex:fix              # レビュー + 直接修正 (workspace-write)
npm run review:codex -- --uncommitted # 未コミット差分をレビュー
node tools/cross-review.js codex --fix --instructions notes.md
                                      # レビューの指摘 (notes.md) を渡して修正させる
```

GPT 側が利用上限やモデルの混雑などで使えないときは、subagent 代替のプロンプトが自動でファイルへ書き出され、終了コード 75 で終わる（`codex-agent.sh` は理由を最後の `codex-agent: result=` 行に出す。書き出し先は stderr に出る。既定は一時ディレクトリ、`--fallback-prompt <path>` で変更可）。
その中身をそのまま Agent ツールの客観レビュー用サブエージェント（読み取り専用。`--fix` 時は書込権限付き）へ渡す。
PR コメントに残す案内は、`rate-limited` なら「Codex を直接実行できないため (利用上限) subagent 代替で確認した」、`unavailable` なら「Codex を直接実行できないため (GPT 側の一時的な使用不能) subagent 代替で確認した」、理由不明なら「Codex を直接実行できないため (理由不明の GPT 側使用不能) subagent 代替で確認した」とする（切り替えたくないときは `--no-fallback`）。

既定 base は **前回レビュー SHA (状態ファイル) → PR の base (`gh pr view --json baseRefName`) → `origin/main` → ローカル `main`** の順に解決し、決めた base と解決方法が差分サイズと同じ stderr 行に出る。
**妥当性確認は `--base` を付けずにそのまま実行すればよい**（2 回目以降は前回レビュー SHA が自動で base になり、増分差分だけが送られる）。手で指定するなら従来どおり `--base <SHA>`。

往復回数、直前レビュー SHA、非対応と判断した指摘はブランチ単位で `.cross-review-state.json` に残る（`.gitignore` 済み、`--no-state` で無効化）。
レビュアーの出力、メタ情報、判断ファイル、コメント本文は、レビュー開始時のブランチ名を安全化した `.cross-review/branch-<slug>-<hash>/` に保存する。旧形式の平置き出力は自動で読み込まない。

```bash
node tools/cross-review.js state          # この枝の往復回数 / 直前レビュー SHA / 非対応指摘を表示
node tools/cross-review.js state --reset  # この枝の記録を消す
node tools/cross-review.js state --mark   # 往復を 1 回分記録する (round を 1 増やし、直前レビュー SHA を現在の HEAD にする。--uncommitted 付きなら SHA は据え置く)
node tools/cross-review.js dismiss "<要約>"  # 非対応と判断した指摘を登録 (以降のレビューで再指摘させない)
node tools/cross-review.js artifacts --clean-legacy  # 旧形式の平置き出力だけを削除
```

往復が自動で記録されるのは、`subagent` がプロンプトを stdout に出したときと、レビュアー CLI が終了コード 0 で終わったときだけ。
**GPT 側使用不能のフォールバックでは記録されない**（CLI はサブエージェントのレビュー完了を観測できないため）ので、サブエージェントでのレビューを終えたら `state --mark` で記録する。

差分サイズが閾値を超えたときは、ファイル要約の閾値を 32/16/8KB と下げて縮退を試し、収まらないときだけ中断する（`--strict-diff-guard` で従来の即中断）。
差分ガード `--max-diff-kb` / 巨大ファイル要約 `--max-file-diff-kb` / 除外無効化 `--no-exclude`、fetch と gh の省略 (`CROSS_REVIEW_NO_FETCH=1`)、ロックファイル等の既定除外 (`.cross-review-ignore` / `CROSS_REVIEW_IGNORE`)、bridge (codex-agent.sh) 経由の起動と `--no-codex-agent` は `docs/cross-review.md` 参照。

### リモートコントロール (クラウド実行) 環境

`codex` / `claude` CLI を spawn できない（または API 接続が通らない）ため、レビュアーを **客観サブエージェント** (Agent ツール) に読み替える。

1. `node tools/cross-review.js subagent [--uncommitted|--fix]` を実行する。レビュープロンプト (観点 + スコープ + 差分 + モード指示) が stdout に出る（人向けの通知は stderr）。
2. その出力をそのまま Agent ツールの客観レビュー用サブエージェント（実装意図に引きずられない第三者として枠付け）へ渡してレビューさせる。
   - レビューのみ：読み取り専用の調査として実行させる。
   - `--fix`：書込権限付きサブエージェントに修正まで行わせ、Claude 本体が差分をレビューする。ただし `subagent --fix` は 3 択には現れず、**Claude 主導で主セッションがレビュアーに修正まで任せると決めたときだけ**使う。
3. 以降の往復、妥当性確認はローカル経路と同じ。subagent 代替を使った場合は、その旨（CLI 不在 / 接続不可で subagent で確認した）を PR コメントに残す。

選択肢 1（実装者と別のベンダー）も選択肢 2（同じベンダーの客観サブエージェント）も、この経路では `subagent`（レビューのみ）の出力を読み取り専用のサブエージェントへ渡し、修正は主セッションが適用する。選択肢 3 は変わらない。

## 往復の運用ルール

- **1 往復 = 実装 (または前回指摘への対応) → レビュー → Claude が結果確認 まで**。カウント対象は blocker / 要修正 (「提案」は任意適用でループ継続理由にしない)。
- **サーキットブレーカー: 最大 3 往復**。3 往復到達時の扱いは、残る指摘の重大度で分かれる。
  - 残る指摘に **blocker** が含まれるなら中断し、サマリ (残存指摘、各往復で試したこと、収束しない理由の推測、選択肢) を `AskUserQuestion` で提示してユーザの判断を仰ぐ。
  - 残る指摘が **要修正のみ**で、影響範囲が局所 (1 ファイル内に収まり、既存テストで検証できる) なら、主セッションの判断で対応して収束としてよい。判断の根拠を PR コメントに残す。
  - 局所の条件を満たさない要修正が残る場合は、blocker と同じく中断してユーザの判断を仰ぐ。
  - 要修正のみの収束処理やユーザの判断で 3 往復を超えて続ける場合は、PR コメントの冒頭に「何往復目まで回したか、なぜ続けたか」を書く。
  - 同じ指摘が往復をまたいで揺り戻すなら 3 往復を待たず早期中断してよい。往復回数は CLI がブランチ単位で数え (`.cross-review-state.json` の `round`)、3 回目の実行で stderr に警告が出る (実行は止まらないので、上のルールに沿った判断は主セッションが行う)。`--no-state` の実行は数えられないので会話内で数える。
  - blocker の有無で分けるのは、実害のある指摘の判断をユーザに残し、局所的な要修正の判断は主セッションに委ねるため。
- **指摘、対応、妥当性確認は PR コメントに残す** (チャットログを手コピーしない。受け渡しは git 差分 / PR)。PR 未作成なら先に作る (未作成のままレビューを回すと CLI が stderr で警告する)。
- PR コメントは手で組み立てず、ブランチ別ディレクトリの `round-<N>-triage.md` に書いてから `node tools/cross-review.js comment --round <N> [--verify <検証出力>]` で本文を生成し、`gh pr comment <番号> --body-file <生成物>` で投稿する。`--post <番号>` を付けると生成本文を先に保存し、同じメモリ本文を標準入力で投稿する。投稿に失敗した場合は保存本文を削除する (レビュー出力は往復ごとに同じブランチ別ディレクトリへ自動保存される。`subagent` 経路で出力を `round-<N>-subagent.md` へ貼るのは任意で、記録用。`comment` は読みません。詳細は `docs/cross-review.md`)。
- `comment` は開始時にブランチ名を取得できない場合、平置きへ戻らず失敗する。既定出力先の既存コメント本文は入力検査前に削除するが、`--out` で明示した出力先は入力検査に成功して新しい本文の書き出しを開始するまで変更しない。メタ情報、判断ファイル、検証出力、本文保存、投稿のいずれかが失敗した場合は今回生成した本文を残さない。判断ファイルが無い場合は雛形だけを書き出して終了コード 1 で終わる。
- **指摘対応のコミットは実装コミットと分ける**：`fix(scope): レビュー指摘対応 — <要約>` のように、どの往復の対応かが履歴から追える形にする。

## 省略してよい例外 (省略時は一言添える)

誤字、コメントのみ、ドキュメント文言調整 / フォーマット、lint 整形のみ / 既にレビュー済みパターンを 1 箇所そのまま踏襲した 1〜数行 / 直前のレビュー済み状態への単純 revert。**規模、影響で迷ったら省略せず確認する**。

## 基盤の更新

vendored ファイル (`tools/cross-review.js` / `tools/cross-review.sync.js` / `docs/cross-review.md` / `.cross-review.example.md` / この SKILL) は直接編集せず、**upstream ([ai-cross-review](https://github.com/ktysne/ai-cross-review)) を直して `tools/cross-review.sync.js` で再同期**する（スクリプト名はプロジェクトの `package.json` 次第。例：`npm run sync` / `npm run sync:check`）。

複数の導入プロジェクトへまとめて反映するときは、`/Develop` 等の作業ルート配下を走査して一括同期する `tools/cross-review.sync-all.js` を使う（詳細は `docs/cross-review.md`「複数プロジェクトへ一括反映」）。app-owned / vendored の区分は `docs/cross-review.md` と各リポの doc を参照。

この SKILL 自体をホームの共通配置（`~/.claude/skills/cross-review/`、`~/.codex/skills/` があれば Codex 側にも）へ配るときは `node tools/cross-review.sync-all.js --global-skill`（`--check` で古さの検査、`--dry-run` で確認）。Codex はレビュー時にこの写しを読むので、古いままだと旧ルールで動く。

上流が配り始めたファイルを取り込み先が取りこぼしていないかは `node tools/cross-review.sync.js --check-manifest`（上流の雛形にあって `files[]` に無いエントリを列挙するだけ。`--check` を含意するので書き込みは起きない）。
