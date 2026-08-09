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

## 実装一区切り後の起点（3 択を AskUserQuestion で提示）

Claude が改修（実装、修正）を一区切りしたら、**完了扱いにする前に必ず**次の 3 択を `AskUserQuestion` で提示する
（「コミットして終わり」「PR を作って終わり」と勝手に締めない。反復改修でも論理的な区切りごとに確認する）。

- **A. Codex にレビューを依頼** → `npm run review:codex` (codex は read-only)。結果を Claude が読み、修正を適用 (ユーザ判断が要る内容は確認してから着手)。完了後に再度 `npm run review:codex` で妥当性確認。
- **B. Codex にレビューと検出事項の修正を依頼** → `npm run review:codex:fix` (codex は workspace-write で直接修正)。Claude が検出内容、修正差分 (`git diff`)、要約をレビューし、指摘があれば再修正。
- **C. 何もしない** → レビューを回さず終了。

Codex 起点で Claude からレビューを回す場合は `npm run review:claude`（Claude はレビューのみ）。詳細は `docs/cross-review.md`。

## 実行環境ごとの経路

### ローカル CLI 環境 (codex / claude CLI が PATH にある)

`npm run review:codex*` / `npm run review:claude` はレビュアー CLI がネットワーク/API 接続を使うため **Bash をサンドボックス無効、ネットワーク許可で実行**する。CLI が見えていても API 接続だけ止まることがあるので、`claude -p "Reply with OK only."` のような最小呼び出しで切り分ける。

```bash
npm run review:codex                  # main との差分をレビュー (read-only)
npm run review:codex:fix              # レビュー + 直接修正 (workspace-write)
npm run review:codex -- --uncommitted # 未コミット差分をレビュー
node tools/cross-review.js codex --fix --instructions notes.md
                                      # レビューの指摘 (notes.md) を渡して修正させる
```

差分ガード `--max-diff-kb` / 巨大ファイル要約 `--max-file-diff-kb` / 除外無効化 `--no-exclude`、既定 base の `origin/main` 優先解決、ロックファイル等の既定除外 (`.cross-review-ignore` / `CROSS_REVIEW_IGNORE`) は `docs/cross-review.md` 参照。

### リモートコントロール (クラウド実行) 環境

`codex` / `claude` CLI を spawn できない（または API 接続が通らない）ため、レビュアーを **客観サブエージェント** (Agent ツール) に読み替える。

1. `node tools/cross-review.js subagent [--uncommitted|--fix]` を実行する。レビュープロンプト (観点 + スコープ + 差分 + モード指示) が stdout に出る（人向けの通知は stderr）。
2. その出力をそのまま Agent ツールの客観レビュー用サブエージェント（実装意図に引きずられない第三者として枠付け）へ渡してレビューさせる。
   - レビューのみ：読み取り専用の調査として実行させる。
   - `--fix`：書込権限付きサブエージェントに修正まで行わせ、Claude 本体が差分をレビューする。ただし `subagent --fix` は **Claude 起点 B の代替に限る**（Codex 起点では subagent はレビューのみ、修正は Codex）。
3. 以降の往復、妥当性確認はローカル経路と同じ。subagent 代替を使った場合は、その旨（CLI 不在 / 接続不可で subagent で確認した）を PR コメントに残す。

## 往復の運用ルール

- **1 往復 = 実装 (または前回指摘への対応) → レビュー → Claude が結果確認 まで**。カウント対象は blocker / 要修正 (「提案」は任意適用でループ継続理由にしない)。
- **サーキットブレーカー: 最大 3 往復**。3 往復しても blocker / 要修正が残る場合は中断し、サマリ (残存指摘、各往復で試したこと、収束しない理由の推測、選択肢) を `AskUserQuestion` で提示する。同じ指摘が往復をまたいで揺り戻すなら 3 往復を待たず早期中断してよい。往復回数は会話内で数える (CLI は往復状態を持たない)。
- **指摘、対応、妥当性確認は PR コメントに残す** (チャットログを手コピーしない。受け渡しは git 差分 / PR)。PR 未作成なら先に作る。
- **指摘対応のコミットは実装コミットと分ける**：`fix(scope): レビュー指摘対応 — <要約>` のように、どの往復の対応かが履歴から追える形にする。

## 省略してよい例外 (省略時は一言添える)

誤字、コメントのみ、ドキュメント文言調整 / フォーマット、lint 整形のみ / 既にレビュー済みパターンを 1 箇所そのまま踏襲した 1〜数行 / 直前のレビュー済み状態への単純 revert。**規模、影響で迷ったら省略せず確認する**。

## 基盤の更新

vendored ファイル (`tools/cross-review.js` / `tools/cross-review.sync.js` / `docs/cross-review.md` / `.cross-review.example.md` / この SKILL) は直接編集せず、**upstream ([ai-cross-review](https://github.com/ktysne/ai-cross-review)) を直して `tools/cross-review.sync.js` で再同期**する（スクリプト名はプロジェクトの `package.json` 次第。例：`npm run sync` / `npm run sync:check`）。

複数の導入プロジェクトへまとめて反映するときは、`/Develop` 等の作業ルート配下を走査して一括同期する `tools/cross-review.sync-all.js` を使う（詳細は `docs/cross-review.md`「複数プロジェクトへ一括反映」）。app-owned / vendored の区分は `docs/cross-review.md` と各リポの doc を参照。
