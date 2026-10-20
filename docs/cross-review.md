# AI 相互レビューの案内

これは上流の手順書の案内版です。
運用の正本は [ai-cross-review の手順書](https://github.com/ktysne/ai-cross-review/blob/main/docs/cross-review.md) です。
導入先のルートで次のコマンドを使います。

| 目的 | コマンド |
|---|---|
| Codex にレビューを依頼 | `node tools/cross-review.js codex` |
| Claude にレビューを依頼 | `node tools/cross-review.js claude` |
| 読み取り専用サブエージェント向けのプロンプト | `node tools/cross-review.js subagent` |
| 往復と前回レビューの状態 | `node tools/cross-review.js state` |
| PR コメントの生成 | `node tools/cross-review.js comment --round <N> --outcome <結果>` |
| 同期のドリフト検査 | `node tools/cross-review.js sync --check` |
| 使用中の本体の確認 | `node tools/cross-review.js engine` |

`<結果>` は fixing / converged / halted です。
未コミット差分のレビューには `--uncommitted` を付けます。
旧形式の導入先では同期に `node tools/cross-review.sync.js --check` を使います。

## 状態ファイル（`.cross-review-state.json`）

[正本の「状態ファイル」](https://github.com/ktysne/ai-cross-review/blob/main/docs/cross-review.md#状態ファイルcross-review-statejson) に、往復数、前回レビュー SHA、結論の意味と保存規則があります。

## 取り込み先の CLAUDE.md / AGENTS.md に書くこと（テンプレート）

[正本のテンプレート](https://github.com/ktysne/ai-cross-review/blob/main/docs/cross-review.md#取り込み先の-claudemd--agentsmd-に書くことテンプレート) を使い、検証コマンドと同期の scripts 名を導入先に合わせます。

## 同期スクリプト（tools/cross-review.sync.js）

[正本の同期の説明](https://github.com/ktysne/ai-cross-review/blob/main/docs/cross-review.md#同期スクリプトtoolscross-reviewsyncjs) に、新形式と旧形式の検査、同期のオプションがあります。

## 複数プロジェクトへ一括反映（tools/cross-review.sync-all.js）

[正本の一括反映](https://github.com/ktysne/ai-cross-review/blob/main/docs/cross-review.md#複数プロジェクトへ一括反映toolscross-reviewsync-alljs) に、上流の checkout からの実行方法があります。
