# AI 相互レビューフロー（Claude ↔ Codex）

Claude と Codex を交互に使う相互レビューの運用ドキュメントです。  
「片方の AI で実装し、もう片方の AI でレビューする」往復を、チャットの中身を手でコピーせずに回します。

> **このドキュメントは汎用の相互レビュー「手順書」です。**  
> 他のリポジトリへはそのままコピーして使えます。  
> コピー先では編集しません（更新は上書きコピーでやり直します）。  
> プロジェクト固有の運用や観点は、コピー先の別ファイルに書きます（レビュー観点は `.cross-review.md`、プロジェクト固有のメモはコピー先の専用 doc）。  
> リポジトリ内のファイルは、置き場所が変わっても壊れないよう、リンクではなくコード表記で示し、節は本文中の名前で参照します。

## 前提と登場ツール

| ツール | 役割 |
|------|------|
| Claude（CLI / アプリ） | Claude 側の実装 / レビュー |
| Codex（CLI / 拡張） | Codex 側の実装 / レビュー |
| `codex` / `claude` スタンドアロン CLI | `npm run review:*` から呼ぶ 1 回限りのレビュー（拡張 / アプリとは別物） |
| Agent ツールの客観サブエージェント | CLI を起動できない環境で、対象レビュアー CLI の代わりにレビューする（同じセッション内。後述「CLI を起動できない環境での代替」節） |
| git ブランチ、コミット、PR | 受け渡しに使う |

CLI 経由（`npm run review:*`）で回すには `codex` / `claude` が PATH にあること。  
拡張 / アプリ内で完結するなら不要です。

> **課金メモ（Claude サブスクプラン）**：Anthropic は **2026-06-15 に施行予定だった「Agent SDK 経由の利用を別建ての月次クレジット枠へ移す」課金変更を、施行当日に保留**しました。現在は `claude -p`（`npm run review:claude` が内部で使うヘッドレス実行）や Agent SDK 経由の利用も、**従来どおりサブスク（Pro / Max / Team / Enterprise）の利用上限から消費**されます（別建ての Agent SDK クレジット枠は無し）。`npm run review:codex*`（OpenAI の Codex CLI）や `subagent`（外部 API を呼ばずプロンプトを出力するだけ）はそもそも対象外です。Anthropic は今後の見直しを予告しており、変更時は事前告知するとしています。CI / 非対話で使う場合の長寿命トークンは `claude setup-token`（→ `CLAUDE_CODE_OAUTH_TOKEN`）。詳細は [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) を参照。

## 基本フロー（4 ステップのループ）

実装担当とレビュー担当を入れ替えながら、次の 4 ステップで回します。

1. **実装**：一方（例：Claude）が作業ブランチで実装し、何を、なぜ変えたかをコミットメッセージに残す。  
   これがレビュアーへの引き継ぎメモになる。  
2. **レビュー**：もう一方（例：Codex）が差分をレビューし、指摘を出す。  
3. **指摘対応**：実装側（Claude）が指摘に対応し、差分とコミットへ反映する。  
4. **妥当性確認**：レビュー側（Codex）が「指摘が解消されたか」「新しい不具合が出ていないか」を、**更新後の差分**で確認する。

向きは対称で、次の 2 通りを使い分けます。

- Claude 実装 → Codex レビュー → Claude 指摘対応 → Codex 妥当性確認
- Codex 実装 → Claude レビュー → Codex 指摘対応 → Claude 妥当性確認

各ステップで渡すのは **差分（と前のステップの指摘）** で、チャットの中身ではありません。

## 実装完了後の起点（Claude 主導、必須）

**Claude が実装や修正を一区切りしたら、作業を完了にする前に、必ず次の 3 択を `AskUserQuestion` で示します。**  
「コミットして終わり」「PR を作って終わり」と勝手に締めません。  
何回かに分けて直すときも、区切りごとに確認します（最後の 1 回だけにしない）。  
手で Codex へ切り替えず、Claude が端末から `npm run review:codex*` を実行し、出力を読んで先まで自分で進めます。

**ブランチ、PR の運用（必須）**：改修は `main` へ直接ではなく **feature ブランチ**で行います（`main` にいるなら着手時に切る）。  
A / B でレビューを回す前に **PR を作ります**（無ければ先に作る）。  
以降は PR を共有ログにし、**各往復の指摘、対応、妥当性確認を、その都度 `gh pr comment` で PR に記録します**（チャットだけに残さない。詳細は後述「PR を共有ログにする」節）。  
リモートが無い等で PR を作れないときだけ省略し、その旨を一言添えます。

| 選択肢 | 何が起きるか |
|--------|--------------|
| **A. Codex にレビューを依頼** | Codex は**レビューだけ**（ファイルは変えない）。Claude が結果を読み、修正を適用する。 |
| **B. Codex にレビューと修正を依頼** | Codex が**レビューと修正を作業ツリーへ直接適用**する。Claude が Codex の修正内容をレビューする。 |
| **C. 何もしない** | レビューを回さず終了。 |

> **CLI を起動できない環境（クラウド実行など）**では Codex CLI を起動できません。  
> このとき A / B のレビュアーを「Codex」から「Claude の客観的なサブエージェント」に読み替えます（C は同じ）。  
> 詳細は後述「CLI を起動できない環境での代替」節。

### 確認を省略してよい「軽微で明らかにレビュー不要」な例外

次のような変更は、確認を省略してそのまま進めてよいです（ただし省略した旨を一言添える）。

- 誤字脱字 / コメントだけ / ドキュメントの文言調整
- フォーマット、lint 整形だけ（動きを変えない）
- **すでにレビュー済みのパターンを 1 箇所そのまま真似ただけ**の 1〜数行
- 直前のレビュー済みの状態への単純な取り消し（revert）

規模や影響に迷うなら**省略せず確認します**（省略してよいか自体に迷ったら、確認する側に倒す）。

### A.「レビューを依頼」を選んだ場合

1. Claude が `npm run review:codex` を実行する（codex は `-s read-only` でファイルを変えない）。  
2. Claude がレビュー結果を読み、修正を適用する。**ユーザ判断が要る内容は確認してから着手する。**  
3. 修正が終わったら、もう一度 `npm run review:codex` で妥当性確認する（指摘の解消、不具合が無いかの確認）。  
4. **各往復の指摘、対応、妥当性確認を `gh pr comment` で PR に記録する。**

### B.「レビューと修正を依頼」を選んだ場合

1. Claude が `npm run review:codex:fix` を実行する（codex は `-s workspace-write` で問題を直接修正）。  
2. Claude が **Codex の指摘内容と修正差分（`git diff`）、要約をレビューする**。  
   問題なければ採用し、気になる点があれば Codex に再修正を頼むか Claude が直す。  
3. 構文チェック / lint / テストを Claude が実行して整合を確認する。  
4. **Codex の指摘内容、修正差分、Claude のレビュー結果を `gh pr comment` で PR に記録する。**

> `npm run review:codex*` / `npm run review:claude` はレビュアー CLI がネットワーク/API 接続を使うため、サンドボックス内では接続に失敗することがあります。  
> ネットワークを許可し、必要に応じてサンドボックスを無効にして実行してください。
> CLI が PATH で見えていても、API 接続だけがサンドボックスで止まることがあります。  
> 例：`claude --version` は成功するが `claude -p "Reply with OK only."` が無応答 / `ConnectionRefused` になり、ネットワーク許可、サンドボックス外では成功する場合、原因は CLI 不在ではなく実行環境のネットワーク制限です。

## 実装完了後の起点（Codex 主導）

**Codex が実装や修正を一区切りしたら、作業を完了にする前に、A / B / C の確認を行います。**  
Codex app の Plan mode など、構造化された選択 UI を表示できる状態なら、その選択 UI で提示します。  
ただし Codex が自発的に Plan mode へ切り替えることはできません。通常チャット、CLI、`codex exec`、非対話実行では、本文に A / B / C を明記してユーザの返信を待ちます。

**ブランチ、PR の運用（必須）**：Claude 主導と同じく、改修は `main` へ直接ではなく **feature ブランチ**で行います。  
A / B でレビューを回す前に **PR を作ります**（無ければ先に作る）。  
以降は PR を共有ログにし、**各往復の指摘、対応、妥当性確認を、その都度 `gh pr comment` で PR に記録します**。  
リモートが無い等で PR を作れないときだけ省略し、その旨を一言添えます。

| 選択肢 | 何が起きるか |
|--------|--------------|
| **A. Claude にレビューを依頼** | Claude は**レビューだけ**（ファイルは変えない）。Codex が結果を読み、修正を適用する。修正後は再度 Claude が妥当性確認する。 |
| **B. Claude の指摘を Codex が修正まで反映** | まず Claude がレビューし、その指摘をファイル化して Codex に渡し、Codex が修正を適用する。Claude が直接修正する選択肢ではない。 |
| **C. 何もしない** | レビューを回さず終了。 |

### A.「Claude にレビューを依頼」を選んだ場合

1. Codex が `npm run review:claude` を実行する（Claude はレビューのみ）。  
2. Codex がレビュー結果を読み、修正を適用する。**ユーザ判断が要る内容は確認してから着手する。**  
3. 修正が終わったら、もう一度 `npm run review:claude` で妥当性確認する（指摘の解消、不具合が無いかの確認）。  
4. **各往復の指摘、対応、妥当性確認を `gh pr comment` で PR に記録する。**

### B.「Claude の指摘を Codex が修正まで反映」を選んだ場合

1. Codex が `npm run review:claude` を実行する。  
2. Claude のレビュー結果を読み、今回修正する指摘を `review-notes.md` などのファイルに書き出す。  
   この書き出しは手作業です。存在しない / 古い指摘ファイルで `--fix` を走らせないよう、対象指摘を必ず確認してから保存します。  
3. Codex が `node tools/cross-review.js codex --fix --uncommitted --instructions <path>` を実行し、指摘を作業ツリーへ反映する。  
4. Codex が修正差分（`git diff`）を確認し、構文チェック / lint / テストを実行して整合を確認する。  
5. `npm run review:claude` で更新後差分を妥当性確認する（指摘が解消され、新たな不具合が出ていないか）。  
6. **Claude の指摘内容、Codex の対応内容、妥当性確認を `gh pr comment` で PR に記録する。**

B は、確定した指摘をクリーンな文脈で機械的に適用したい場合や、対話駆動で Codex に自動修正させたい場合に選びます。  
ループ内の Codex がそのまま作業ツリーを直接編集できるなら、通常は A で足ります。

> `npm run review:claude` は `claude` スタンドアロン CLI と API 接続が必要です。  
> B の `codex --fix` も、Codex が動いている環境からさらに `codex` スタンドアロン CLI を起動できる必要があります。  
> CLI を起動できない、またはネットワーク/API 接続ができない場合は、後述の `subagent` 代替へ切り替えます。

## CLI を起動できない環境での代替（subagent）

クラウド実行やリモートコントロール環境では、手元の `codex` / `claude` CLI を起動できないことがあります（PATH に無い、起動できない）。  
また、CLI は起動できても、ネットワーク/API 接続が許可されずレビュー結果が返らないことがあります。  
このときは、対象レビュアー CLI を直接呼ぶ代わりに `subagent` でレビュープロンプトを出力し、呼び出し側が利用できる客観レビュー用エージェントへ渡します。

**見分け方**：対象レビュアー CLI（`codex` または `claude`）が PATH で見つからない（`Get-Command <cli>` / `which <cli>` が失敗する）か、クラウド実行だと分かっているとき。  
`npm run review:codex*` / `npm run review:claude` が CLI 不在、ネットワーク不可、API 接続不可で失敗したときも、この代替に切り替えます。
CLI と API 接続を切り分ける場合は、まず `Get-Command claude` / `claude --version`（または `codex --version`）で CLI 可視性を確認し、次に `claude -p "Reply with OK only."` のような最小 API 呼び出しを通常環境とネットワーク許可環境で比較します。

**仕組み**：プロンプトを組み立てる部分（観点の解決、差分の収集、モード別の指示付け）は **node と git だけ**で動くので、クラウド環境でもそのまま使えます。  
外部 CLI を起動する部分だけを「Agent ツール等の客観レビュー用エージェント」に置き換えます。  
レビュアー `subagent` は外部プロセスを起動せず、組み立てたレビュー用プロンプトを **stdout に出すだけ**です（人向けの通知は stderr に分けるので、stdout はそのままサブエージェントへ渡せます）。

1. レビュー用プロンプトを stdout に出す（外部 CLI は起動しない）：

   ```bash
   node tools/cross-review.js subagent                 # main との差分 (A 相当、レビューのみ)
   node tools/cross-review.js subagent --uncommitted   # 未コミット差分 (tracked + untracked)
   node tools/cross-review.js subagent --fix           # 修正指示付きプロンプト (Claude 起点 B 相当。Codex 起点では使わない)
   ```

2. その stdout を **Agent ツールで起動する客観レビュー用サブエージェント**への指示として渡す。  
   サブエージェントには「実装者から独立した第三者レビュアーとして、実装の意図に引きずられず差分そのものを批判的に確かめる」よう役割を与える。  
   レビューだけ（A 相当）なら読み取り系（`Explore` など）で十分。`--fix`（Claude 起点 B 相当）で修正まで任せるなら**書き込み権限のあるサブエージェント**を使う（Codex 起点では `subagent` はレビューのみで、修正は Codex が行う。後述「起点 3 択（A / B / C）との対応」を参照）。  
3. サブエージェントのレビュー結果（または修正差分）を呼び出し側が読み、A / B と同じく先（修正の適用、妥当性確認）へ進める。  
   妥当性確認も同じく `subagent` のプロンプトとサブエージェントで回す。  
   往復は最大 3 回までの数え方も変わらない。

**起点 3 択（A / B / C）との対応**：クラウドでも 3 択の意味は変わらず、直接起動できないレビュアー CLI だけを客観レビュー用エージェントに置き換えます。ただし B の対応は起点で異なります。  
Claude 起点（B = レビュアー Codex がレビュー + 修正）では、A → `subagent`（修正なし）を読み取り系へ、B → `subagent --fix` を書き込み権限ありへ、C → そのまま。  
Codex 起点（B = レビュアー Claude はレビューのみ、修正は Codex）では、A、B とも `subagent`（レビューのみ）を読み取り系へ渡して Claude の指摘を得て、修正は Codex（直接編集または `codex --fix --instructions`）が行う（`subagent --fix` は使わない＝Claude が直接修正する選択肢ではないため）。C はそのまま。  
Codex 起点でこの代替を使った場合は、「Claude を直接実行できないため（CLI 不在 / 接続不可）subagent 代替で確認した」ことを PR コメントに残します。

> 同じ種類の AI が実装とレビューを兼ねる場合でも、サブエージェントは**別の文脈**で差分だけを見るので、「客観的な第三者レビュー」の利点（実装時の思い込みに引きずられない）は保てます。  
> `codex` / `claude` CLI が使える環境では、これまでどおり対象レビュアー CLI を優先します。この代替は、CLI を起動できない、接続できないときの代わりです。

### レビュアーの指摘を渡して直させる（`--instructions`）

**「片方のレビュアー（または直前のレビュー結果）で、すでに具体的な指摘が出ていて、それを Codex に直接修正させたい」** ときの基本フローです。  
Codex に一から再レビューさせるのではなく、確定した指摘を渡して `--fix` で直させます。

1. 指摘をファイル（例：`review-notes.md`）に Markdown で書く。  
   各項目に「修正する / 判断を保留する」と優先度を付け、対象ファイル、行、期待する直し方を具体的に書く。  
2. 次を実行する（`--fix` と `--instructions` を併用）：

   ```bash
   # 未コミットの作業ツリーを対象に、指摘を渡して Codex に直接修正させる
   node tools/cross-review.js codex --fix --uncommitted --instructions review-notes.md
   # コミット済みの差分が対象なら --uncommitted を外す（既定 = main との差分）
   ```

3. `--instructions` の中身は **観点 `.cross-review.md` を置き換えず**、「レビュアーからの申し送り、重点指摘」としてプロンプトに追加されます（観点はこれまでどおり自動で付きます）。  
   **この用途で `CROSS_REVIEW_CHECKLIST` を使い回さない**でください（観点が消えます。手で連結したり env を差し替えたりする必要はありません）。  
4. 修正後は `git diff` で内容をレビューし、`npm run lint` / `npm test` などを実行して整合を確認する。

補足：
- 申し送りファイルは**リポジトリの外か `.gitignore` 済みのパス**に置くのが無難です（`--uncommitted` の未追跡ファイル収集に紛れ込まないため）。  
  もしリポジトリ内の未追跡の場所に置いても、`--instructions` のファイル自体はレビュー差分から自動で除外されます（`tools/cross-review.js` の `collectReviewDiff`）。  
- 「Codex に自分でもレビューさせたうえで、さらに重点指摘も渡したい」場合も、同じく `--instructions` を足すだけです。

## レビューと修正の往復は最大 3 回まで（無限ループ防止、必須）

レビュー ↔ 指摘対応のループは **最大 3 往復**までです。  
**1 往復 = 実装（または前回の指摘への対応）→ レビュー → 結果確認 まで**です（= レビュー 1 回とその結果確認で 1 往復。修正が続くかは問わない）。

- 数えるのは **blocker / 要修正** です。  
  `提案` は任意で、見送ってもループを続ける理由にはしません。  
- **3 往復しても blocker / 要修正 が残るなら、ループを止めて、まとめを示しユーザの判断を仰ぎます。**  
  まとめには「残っている指摘（重大度付き）と未解決の理由」「各往復で試したことと結果」「収束しない理由の推測」「選択肢（方針変更 / 直接対応 / 別 Issue へ見送り / 中止 など）」を含めます。  
- 同じ指摘が往復のたびに**揺り戻す**（直すと別の指摘が出て元に戻る等）と判断したら、3 往復を待たずに止めてユーザに相談してよいです。  
- 往復の回数は会話の中で数えます（CLI は 1 回ごとのレビュー実行だけで、往復の状態は持ちません）。

## 各ステップの実際の操作

### 実装

ふだんどおり実装し、ブランチへコミットします。  
意図をコミットメッセージ本文に書きます。  
これが引き継ぎメモになります。

### レビュー、妥当性確認

対象はどちらも**更新後の差分**なので、同じ手段で実行できます。  
やり方は 2 通りです。

- **拡張 / アプリ内で完結**：レビュアー側のツールに「現在のブランチ（main との差分）をレビューして」と頼む。  
  会話しながら回すならこちら。  
  妥当性確認も同じセッションで頼める（前回の指摘が文脈に残るのが利点）。  
- **1 回限りの CLI**：端末から 1 コマンドで回す。

```bash
npm run review:codex                     # 現在のブランチ (main との差分) を Codex がレビュー (read-only)
npm run review:codex:fix                 # 同上 + 見つかった問題を Codex が作業ツリーへ直接修正 (workspace-write)
npm run review:claude                    # 現在のブランチを Claude がレビュー (read-only)
npm run review:codex -- --uncommitted    # 未コミット差分 (tracked + untracked) をレビュー
npm run review:claude -- --base develop  # 比較先ブランチを変更
npm run review:codex:fix -- --instructions review-notes.md  # レビュアーの指摘 (ファイル) を渡して直させる
node tools/cross-review.js subagent      # CLI を起動せずレビュー用プロンプトを stdout に出力 (CLI を使えない環境用)
```

`--uncommitted` は **未追跡（git に未 add）の新規ファイルも含めます**（コミット前のチェックでも取りこぼさない）。  
`--fix` は **codex / subagent で使えます**。  
レビューに加えて問題の修正まで依頼します（codex は workspace-write で直接修正、subagent は FIX 指示付きでプロンプト出力。`claude` CLI 経路の自動修正は未対応）。  
`--instructions <path>` は**レビュアーからの申し送り、重点指摘**をプロンプトに足します（観点 `.cross-review.md` は置き換えず追加。指摘を渡して直させる用途。詳細は前述「レビュアーの指摘を渡して直させる」）。

### 指摘対応

実装側のツールに戻り、指摘（PR コメントか端末出力）を渡して修正し、再コミットします。

## CLI ブリッジ（tools/cross-review.js）

`git` の差分をレビュアー CLI へ渡す橋渡しです。  
依存の追加はありません（Node 標準 API のみ、CommonJS）。

- `codex` / `claude` のどちらも、**自分で差分を取り出し**、「観点 + 対象範囲 + 差分本文 + モード別の指示」を stdin で渡して、汎用の `codex exec`（末尾 `-` で stdin をプロンプトにする）/ `claude -p` を起動します。  
- レビュアー `subagent` は**外部 CLI を起動しません**。  
  同じプロンプトを組み立てて **stdout に出すだけ**で、実際のレビューは呼び出し側（Claude）が Agent ツールで起動する客観サブエージェントが行います（CLI を起動できない環境での代替）。  
  通知は stderr、プロンプト本文は stdout に分けます。  
  `--fix` を付けたときは FIX 指示付きで出力します。  
- codex のサンドボックスでモードを切り替えます：
  - レビューだけ（既定）→ `codex exec -s read-only`（ファイルを変えさせない）
  - `--fix` → `codex exec -s workspace-write`（見つかった問題を作業ツリーへ直接修正させる）
- codex は `-c approval_policy=never` で**承認を never に固定**します（非対話の自走が承認待ちで止まらないように）。  
- **専用サブコマンド `codex exec review` は使いません**。  
  codex v0.137.0 で `--uncommitted` / `--base` が `[PROMPT]` と併用できなくなり、観点チェックリストを同時に渡せなくなったため、汎用の `exec` と差分の埋め込みに統一しました。  
- 差分の対象範囲：
  - 既定：`git diff <base>...HEAD`（ブランチ vs base）。**既定の base は `origin/main` を優先解決**します（後述「既定 base の解決と差分サイズのガード」）。
  - `--uncommitted`：tracked（`git diff HEAD`）＋ untracked
    （`git ls-files --others --exclude-standard -z` の各ファイルを `git diff --no-index` で新規ファイル差分にする。`-z`（NUL 区切り）で空白入りパスでも壊れない）
- 申し送り（`--instructions <path>`）：レビュアー個別の重点指摘を**観点とは別系統**で足します（`REVIEWER_NOTES_HEADER` の見出し付きでプロンプトに追加。`.cross-review.md` は置き換えない）。  
  `--uncommitted` の未追跡収集からは、申し送りファイル自体を**絶対パスの突き合わせで除外**します。  
- 差分の間引き：ロックファイル、生成物（`package-lock.json` / `*.min.js` / `*.map` ほか）を**既定で除外**し、巨大なファイル差分は **stat 要約に置換**してトークンを節約します（`.cross-review-ignore` で除外を追加、`--no-exclude` で無効化、`--max-file-diff-kb` で置換しきい値。詳細は後述「差分の除外と要約」）。  
- 引数解析、差分生成、プロンプト生成、観点解決、申し送り注入は `tests/cross-review.test.js`（vitest）が担保します。  
  このテストは**取り込み先では任意**で、vitest を使うときだけ同梱します（同梱しなくても engine の振る舞いは upstream のテストが担保）。

## 既定 base の解決と差分サイズのガード

レビュー差分のトークン消費を抑えるための仕組みです。

### 既定 base は `origin/main` を優先解決する

既定（`--base` 未指定、コミット済み差分モード）では、base を次の順で解決します。

1. `git fetch origin main --quiet` を**ベストエフォート**で実行（10 秒タイムアウト）。  
   リモートが無い、オフライン、タイムアウトのときは stderr に警告 1 行を出して続行します（失敗で止めません）。  
   タイムアウト等で fetch が中断された場合は、**前回取得済みの `origin/main`**（やや古い可能性あり）が使われることがあります（次回の fetch で追いつくため実害は軽微）。
2. `git rev-parse --verify origin/main` が通れば **`origin/main` を base に採用**します（stderr に 1 行通知。`--base` で変更可）。
3. 解決できなければ従来どおりローカル `main` を使います。

`--base` を明示したとき、および `--uncommitted` のときは、この解決を**スキップ**します（fetch もしません）。指定した base / 未コミット差分には介入しません。

**stale なローカル `main` の落とし穴**：ローカル `main` が古いと merge-base が過去にずれ、HEAD が既に取り込んだ `main` 側のコミットまで `git diff main...HEAD` に混入します（実例：89 コミット、792KB に肥大。`git fetch origin main` + `--base origin/main` で 65KB に正常化）。`origin/main` の優先解決はこれを自動で避けるための既定挙動です。手動なら `git fetch origin main` 後に `--base origin/main` を明示しても同じ効果になります。

### 差分サイズの表示とガード

- レビュー差分の収集後、サイズを**常に stderr に 1 行表示**します（例：`[cross-review] レビュー差分サイズ: 65.2KB`）。
- サイズが閾値（KB）を超えると、**レビュアーを起動せず中断**します（`subagent` でもプロンプトを出しません。`process.exitCode = 1`）。  
  エラーメッセージに、原因の候補（stale な `main`、生成物 / lock ファイルの混入）と回避策を出します。
- 閾値の解決順は **`--max-diff-kb <n>`（CLI フラグ）→ 環境変数 `CROSS_REVIEW_MAX_DIFF_KB` → 既定 256KB** です。  
  値 `0` で**ガードを無効化**します（意図的に大きい差分をレビューしたいとき）。

```bash
node tools/cross-review.js codex --max-diff-kb 512   # 上限を 512KB に引き上げる
node tools/cross-review.js codex --max-diff-kb 0     # ガードを無効化
CROSS_REVIEW_MAX_DIFF_KB=512 npm run review:codex    # 環境変数で指定
```

### 差分の除外と要約（レビュー価値の低い差分でトークンを浪費しない）

レビュー価値が低い差分（ロックファイル、生成物）や、巨大すぎて読まないファイル差分を、レビュアーへ渡す前に間引きます。

**既定除外（ロックファイル、生成物）**：次のファイルは、差分本文から既定で除外します（ファイル名のみのパターンで、どの階層でも一致します）。

```
package-lock.json / npm-shrinkwrap.json / yarn.lock / pnpm-lock.yaml /
bun.lock / bun.lockb / Cargo.lock / Gemfile.lock / poetry.lock / uv.lock /
composer.lock / go.sum / *.min.js / *.min.css / *.map
```

除外は `git diff` のパススペック（`:(exclude,glob,top)**/<pattern>`、include 側は repo ルート `:/`）で適用するので、サブディレクトリの同名ファイルにも効き、cwd がリポ直下でなくても差分スコープは変わりません。  
**除外したが変更のあったファイルは、ファイル名だけプロンプトに残します**（`【レビュー対象外（除外済み）の変更ファイル】` の枠）。レビュアーが必要と判断すれば個別に読めます（差分本文は載りません）。

**追加の除外（`.cross-review-ignore`）**：既定除外に足したいパターンは `.cross-review-ignore` に書きます。  
形式は **1 行 1 パターン、`#` 始まりはコメント、空行は無視**。観点（`.cross-review.md`）と同じ流儀で、`環境変数 CROSS_REVIEW_IGNORE（パス）→ <cwd>/.cross-review-ignore → <スクリプト>/../.cross-review-ignore` の順に探し、見つかった最初の 1 つを読みます（既定パターンと併合）。  
`CROSS_REVIEW_IGNORE` を指定したのに読めないときは、黙って次へ進まず警告を出します。

```text
# .cross-review-ignore の例（既定パターンに追加される）
docs/generated/*.md
*.snap
schema.sql
```

**すべての除外を無効化（`--no-exclude`）**：既定除外も含めてすべての除外を切ります（緊急時の逃げ道。生成物もまとめてレビューしたいとき）。

**巨大ファイル差分の stat 置換（`--max-file-diff-kb`）**：ファイル単位の差分がしきい値（KB）を超えたら、本文を **1 行の stat 要約**（`diff --git` 行＋「<X.X>KB・追加 n 行 / 削除 m 行のため本文を省略」）に置き換えます。  
置換は全体サイズガードの**前**に行うので、置換で縮んだ分は全体ガードに掛かりません（巨大 1 ファイルが置換で縮めばガードを通ります）。置換が起きたら stderr に 1 行通知します。  
しきい値の解決順は **`--max-file-diff-kb <n>`（CLI フラグ）→ 環境変数 `CROSS_REVIEW_MAX_FILE_DIFF_KB` → 既定 64KB**。値 `0` で置換を無効化します。

```bash
node tools/cross-review.js codex --max-file-diff-kb 128  # ファイル単位の置換しきい値を 128KB に
node tools/cross-review.js codex --max-file-diff-kb 0    # stat 置換を無効化
node tools/cross-review.js codex --no-exclude            # 既定除外も含めすべての除外を無効化
```

### 妥当性確認を軽くする（往復のトークンを線形に増やさない）

指摘対応後の妥当性確認で、毎回**全差分**を再送するとトークンが往復ごとに膨らみます。  
レビュー時点の HEAD を控えておき、**前回レビュー以降の増分差分だけ**を送ると線形増加を避けられます。

1. レビュー前に SHA を控える：`git rev-parse HEAD`。
2. 指摘対応後の妥当性確認は、その SHA を base にして増分だけ送る：

   ```bash
   node tools/cross-review.js <reviewer> --base <そのSHA> --instructions <指摘ファイル>
   ```

   `--base` はブランチ名に限らず**任意のコミット**を受けます。これで「前回レビュー以降の増分差分 ＋ 前回指摘」だけがレビュアーへ渡り、毎回の全差分再送を避けられます（往復のトークンが線形に増えない）。

## 同期スクリプト（tools/cross-review.sync.js）

「そのままコピーするファイル」（CLI 本体、この手順書、観点テンプレート、テスト等）を、上流リポジトリから取り込み先プロジェクトへ取り込むスクリプトです。  
手で 1 ファイルずつ上書きコピーする代わりに、マニフェストに従って機械的に同期します（手動コピー運用の置き換え）。  
依存の追加はありません（Node 標準 API のみ、CommonJS）。git だけで取り込み元を取得します。

- **取り込み元の取得**：`upstream.repo` の `upstream.ref`（ブランチ / タグ / コミット）を一時ディレクトリへ **shallow fetch**（`git init` → `git fetch --depth 1 origin <ref>` → `checkout FETCH_HEAD`）し、そこからファイルをコピーします。SHA 直接指定も拾えるよう `clone --branch` ではなく `fetch <ref>` を使います。一時ディレクトリは実行後に削除します。
- **取り込むファイルの対応付け**：`files[]` の `from`（上流相対）→ `to`（取り込み先相対）で対応付けます。取り込み先の配置が上流と違っても対応できます（例：テストを `tests/tools/` 配下に置く）。**ファイル単位のみ**で、`from` にディレクトリを指定した一括コピーは非対応です。
- **require パス等の機械置換**：`files[].replace`（`{ from, to }` の配列）で**文字列リテラルの全置換**を行います（正規表現ではない）。コピーしたテストの require パスを取り込み先の配置へ合わせる用途です。上流側は書き換えません。
- **取り込み元の記録**：取り込んだ実コミットを `lastSyncedCommit`（と `lastSyncedRef`）へ書き戻します（記録値が変わるときだけ。同一コミットの再同期では書き換えません）。どの版から取り込んだかが履歴に残り、検査の基準にもなります。
- **モード**：
  - 既定（同期）：差分のあるファイルだけ上書きし、取り込み元コミットが変わったときだけマニフェストの `lastSyncedCommit` を更新する。
  - `--check`：書き込まず、上流（ref）との差分（ドリフト）だけを報告する。差分があれば **exit 1**（CI のドリフト検知向け）。
  - `--dry-run`：書き込まず、同期で何が変わるかだけ表示する。
- **そのほかのオプション**：`--ref <ref>`（マニフェストの ref を上書き）/ `--manifest <path>`（マニフェストの場所。既定はスクリプト隣の `cross-review.sync.json`）/ `--root <path>`（取り込み先ルート。既定は `tools/` の 1 つ上 = プロジェクトルート。cwd に依存せず解決）。
- **安全策**：`from` / `to` が取り込み元 / 取り込み先ルートの外を指す場合はエラーにします（マニフェスト由来のパスでルート外へ読み書きする事故を防ぐ）。

マニフェスト（`tools/cross-review.sync.json`）の形：

```json
{
  "upstream": { "repo": "https://github.com/ktysne/ai-cross-review.git", "ref": "main" },
  "lastSyncedCommit": null,
  "files": [
    { "from": "tools/cross-review.js", "to": "tools/cross-review.js" },
    { "from": "tools/cross-review.sync.js", "to": "tools/cross-review.sync.js" },
    { "from": "tools/cross-review.sync-all.js", "to": "tools/cross-review.sync-all.js" },
    { "from": "docs/cross-review.md", "to": "docs/cross-review.md" },
    { "from": ".cross-review.example.md", "to": ".cross-review.example.md" },
    { "from": ".claude/skills/cross-review/SKILL.md", "to": ".claude/skills/cross-review/SKILL.md" },
    {
      "from": "tests/cross-review.test.js",
      "to": "tests/tools/cross-review.test.js",
      "replace": [{ "from": "../tools/cross-review.js", "to": "../../tools/cross-review.js" }]
    }
  ]
}
```

上の `files` は代表例です。配布物一式の雛形は `tools/cross-review.sync.example.json` にあり、こちらが正本です（CLI 本体、同期スクリプト、一括同期ツール `cross-review.sync-all.js`、手順書、観点テンプレート、**Claude Code スキル `.claude/skills/cross-review/SKILL.md`**、各テストを含む）。  
このマニフェスト自体は**取り込み先で編集するファイル**です（上書きコピーの対象に含めない）。  
`.cross-review.md`（観点）や `CLAUDE.md` / `AGENTS.md` などプロジェクト固有のファイルは `files` に入れません（上書きで消えます）。

`.claude/skills/cross-review/SKILL.md`（相互レビューの実行手順スキル）も vendored（上書き更新の対象）です。  
スキルにはプロジェクト固有の運用（検証コマンド、CI、同期スクリプト名など）を書かず、それらは `.cross-review.md` や各リポの doc 側へ分離します。こうすると、上流のスキル更新が取り込み先のカスタマイズと干渉しません。

doc を HTML へ生成する（docs パイプラインを持つ）プロジェクトや、相互レビューの「入口 doc」を別に置きたいプロジェクトでは、`docs/cross-review.md` を `to` で自分のパスへ map し（例：`documents/developer/md/cross-review-flow.md`。これも vendored）、プロジェクト固有の運用は別の **overlay doc**（取り込み先が所有、編集）＋ `.cross-review.md` に分けます。overlay から vendored フロー doc へリンクすれば、汎用フローの再同期と固有運用の編集が干渉しません。同期はファイル内容を上書きするだけなので、`docs:build` 等の**生成は取り込み先の責務**です（再同期後に各自で実行）。

## 複数プロジェクトへ一括反映（tools/cross-review.sync-all.js）

導入プロジェクトが増えると、上流を更新するたびに 1 リポずつ同期するのは手間です。  
`tools/cross-review.sync-all.js` は、ローカルの作業ルート（例：`/Develop`）配下を走査し、**同期マニフェスト `cross-review.sync.json` を持つディレクトリ＝導入プロジェクト**を自動判定して、まとめて同期します。

- **判定**：`cross-review.sync.json` の存在を単一マーカーにします（同期に必須のファイルなので誤検出しにくい）。慣例どおり `tools/cross-review.sync.json` に置かれている前提ですが、ルート直下に置かれていても拾います。
- **同期ロジック**：各プロジェクトに同梱された版ではなく、**この checkout の `cross-review.sync.js`（`runSync`）を再利用**して回します。導入先の sync スクリプトが古くても最新ロジックで一括反映できます。取り込むファイル、上流 ref は各プロジェクトのマニフェストを尊重します（`--ref` で一時上書き可）。
- **独立実行**：1 プロジェクトの失敗（マニフェスト不正、上流取得失敗など）で全体を止めません。各プロジェクトを独立に回し、最後に「更新 / 変更なし / ドリフト / エラー / 対象外」を集計します。終了コードは「いずれかが失敗」または「`--check` でいずれかにドリフト」のとき **1**（CI 向け）。
- **対象外（skip）**：`cross-review.sync.json` という名前でも、**valid JSON だが** 内容が `upstream` / `files` を持たないもの（旧 `{source, ref, commit}` 形式の独自 sync 来歴や、別用途でたまたま同名のファイル）は **同期対象外（対象外）** として skip し、エラーにはしません。`/Develop` に新旧の流儀が混在していても全体を失敗させないためです。
- **破損は skip せず error（exit 1）**：ファイルが **読めない（IO/権限エラー）/ JSON 構文エラー（破損）** の場合は、正式導入先の設定崩れなので対象外で握り潰さず **error** にし、終了コードを **1** にします（CI の `sync-all --check` で検出できるようにするため）。1 件の error でも他プロジェクトの同期は止めず、最後に集計します。
- **走査**：`--depth <n>`（既定 4）で最大深さを調整。`node_modules` / `.git` / 隠しディレクトリはたどりません。

```bash
node tools/cross-review.sync-all.js --root /Develop --list    # 検出したプロジェクトを列挙するだけ
node tools/cross-review.sync-all.js --root /Develop --check   # 各プロジェクトをドリフト検査 (書き込まない)
node tools/cross-review.sync-all.js --root /Develop --dry-run # 各プロジェクトで何が変わるかだけ表示
node tools/cross-review.sync-all.js --root /Develop           # 各プロジェクトを一括同期 (上書き更新)
node tools/cross-review.sync-all.js --root /Develop --ref v1.2.3  # 取り込む ref を全プロジェクト共通で上書き
```

> 引数解析、プロジェクト走査、結果分類、集計、一括同期の配線は `tests/cross-review.sync-all.test.js`（vitest）が担保します（取り込み先では任意。一括同期ツールを入れ、かつ vitest を使うときだけ同梱）。

```bash
node tools/cross-review.sync.js            # 上流から取り込む（差分のあるファイルだけ上書き）
node tools/cross-review.sync.js --check    # ドリフト検査のみ（書き込まない。差分があれば exit 1）
node tools/cross-review.sync.js --dry-run  # 何が変わるかだけ表示（書き込まない）
node tools/cross-review.sync.js --ref v1.2.3   # 取り込む版をマニフェストより優先
```

> 取り込み元の取得は git のネットワークアクセスを使います。  
> サンドボックス内では fetch に失敗することがあるため、必要に応じてネットワークを許可して実行してください。  
> 引数解析、マニフェスト検証、置換、同期プラン算出、同期/検査の配線は `tests/cross-review.sync.test.js`（vitest）が担保します（取り込み先では任意。vitest を使うときだけ同梱）。

## 観点チェックリスト（.cross-review.md）

レビュアーへ渡す観点は、リポジトリ直下の `.cross-review.md` から読み込みます。  
探す順は `環境変数 CROSS_REVIEW_CHECKLIST（パス）→ <cwd>/.cross-review.md → <スクリプト>/../.cross-review.md → 組み込みの汎用観点（GENERIC_CHECKLIST）` です。  
どれも無くても汎用観点で動きます（起動時に stderr へ警告）。  
`CROSS_REVIEW_CHECKLIST` を指定したのに読めないときは、黙って次へ進まず警告を出します。

観点を増やしたり減らしたりしたら `.cross-review.md` を更新します。  
新しいプロジェクトへ導入するときは `.cross-review.example.md` を雛形にします。

## PR を共有ログにする

- 実装がまとまったら PR を作ります。  
  以降は **PR が共有ログ**になります。  
- **指摘、対応、妥当性確認は PR コメントに記録します**（チャットだけに残さない）。  
- CI（テストなど）が機械チェックを回すので、AI レビューは設計、回帰、互換性などの観点に集中できます。

## メンテナンス

- レビュー観点を増やしたり減らしたりしたら `.cross-review.md` を更新します。  
- CLI の対象範囲（`--staged` など）を増やすときは、（テストを同梱しているなら）`tests/cross-review.test.js` も更新します。  
- 同期スクリプトの仕様（マニフェストの形、モード）を変えたら、（同梱しているなら）`tests/cross-review.sync.test.js` も更新します。  
- 運用ルールの要約はコピー先の `CLAUDE.md` / `AGENTS.md`（あれば）に置きます。  
  このドキュメントが正本なので、内容を二重に書きません（要約からはここへリンクします）。
