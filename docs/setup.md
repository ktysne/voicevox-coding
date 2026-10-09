# VOICEVOX Coding の導入手順

この文書は、VOICEVOX Coding を導入する AI（Claude Code など）が読む手順書である。
人が読んで手で進めることもできる。

## 進め方の決まり

- `~/.claude/settings.json`、`~/.codex/hooks.json`、Windows のスタートアップ登録は、リポジトリの外にある設定である。
  `install.ps1` が書き込む前に、AI は変更内容を開発者に示して確認を得る。
- 既存の設定はバックアップしたうえでマージし、VOICEVOX Coding 以外のフックは残す。
  書き込む内容が既存の設定と同じ場合は、バックアップも書き込みも行わない。
- Codex は未承認のフックを実行しない。
  `/hooks` での承認は開発者が行い、AI は操作場所と手順を案内する。
- スタートアップ登録は、このリポジトリの現在の場所を参照する。
  登録後にリポジトリを移動または削除すると自動起動できなくなるため、長く置いておく場所に配置する。

## パターンの選び方

Claude Code と Codex は、どちらか一方だけでも導入できる。

| パターン | 導入する連携 | `install.ps1` のオプション |
|---|---|---|
| 1 | Claude Code と Codex の両方 | なし |
| 2 | Claude Code だけ | `-SkipCodex` |
| 3 | Codex だけ | `-SkipClaude` |

次のオプションはどのパターンにも追加できる。

| オプション | 効果 |
|---|---|
| `-RegisterStartup` | サインイン時にデーモンを自動起動し、タスクトレイに常駐させる |
| `-IncludeToolEvents` | ツール実行の前後（`PreToolUse` / `PostToolUse`）も登録する。呼び出しのたびにプロセスが起動するため、必要な場合だけ指定する |

`-SkipClaude` または `-SkipCodex` を指定すると、その連携先に登録済みの VOICEVOX Coding フックも解除する。
スタートアップ登録を設定した後にリポジトリを移動した場合は、`scripts\install.ps1` を再実行して登録を更新する。

## 共通手順

### 前提

| 項目 | 内容 |
|---|---|
| OS | Windows |
| Node.js | 20 以上（`node --version`） |
| VOICEVOX | インストールが必要。VOICEVOX アプリを起動しておく必要はない |
| PowerShell 7 | セットアップ、更新、アンインストールに必要（[入手先](https://aka.ms/powershell)） |
| Git | リポジトリの取得と `update.ps1` に使用する |
| Claude Code / Codex | 利用する連携先だけを用意する。Codex の途中経過を読む場合は `codex` CLI も必要 |

VOICEVOX アプリは音声を作るための GUI であり、合成 API は同梱のエンジン（`vv-engine\run.exe`）が持つ。
VOICEVOX Coding はこのエンジンを直接起動するため、アプリを常駐させる必要はない。

Node.js の標準モジュールだけで動くため、`npm install` は不要である。

### 1. リポジトリを置く

```bash
git clone https://github.com/ktysne/voicevox-coding.git
```

取得したディレクトリを、以降のコマンドを実行する場所として使う。
`-RegisterStartup` を使う場合は、このリポジトリを移動しない場所に置く。

### 2. フックを登録する

利用するパターンの「登録の仕方」にあるコマンドで `scripts\install.ps1` を実行する。
インストールスクリプトはフッククライアントを `%USERPROFILE%\.voicevox-coding\` に配置し、Claude Code の `settings.json` と Codex の `hooks.json` にデーモンへ転送するフックを登録する。

Codex の `hooks.json` は、`CODEX_HOME` が設定されていればそのディレクトリに書き込む。
未設定の場合は `%USERPROFILE%\.codex\hooks.json` を使う。

### 3. デーモンを起動する

```bash
npm run console
```

デーモンが起動し、管理コンソールがブラウザーで開く。
以後はタスクトレイのアイコン、または `http://127.0.0.1:7591/` からアクセスする。

起動時に VOICEVOX エンジンが動いていなければ、実行ファイルを自動検出して起動する。
多重起動した場合、2 つ目のデーモンはポートの重複を検出して終了する。

`-RegisterStartup` を指定した場合は、次のサインイン以降に自動で起動する。
スタートアップからの起動と手動起動が重なった場合も、2 つ目のデーモンはポートの重複を検出して終了する。
導入後は、選んだ連携先を普段どおり使うと読み上げが始まる。

## パターン 1

### 登録の仕方

Claude Code と Codex の両方に登録する。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

自動起動も設定する場合は `-RegisterStartup` を追加する。
ツール実行前後のイベントも読み上げたい場合は `-IncludeToolEvents` を追加する。

### 確認

通常の PowerShell から次を実行する。
Codex Desktop 内のターミナルでは、サンドボックス用の別の `CODEX_HOME` が使われるため、導入状態を正しく確認できない。

```powershell
npm run doctor
```

VOICEVOX ENGINE とデーモンが稼働中で、Claude Code と Codex のフックが登録済みと表示されればよい。
Codex のフックが未承認の場合は、Codex を起動して `/hooks` を開き、VOICEVOX Coding のフックを承認する。
Codex の `/hooks` で個別にオフにしたフックは、承認済みでも実行されない。

`npm run doctor` は Codex のフックの読み込み状態と信頼状態も点検する。
`install.json` がない旧導入では、`hooks.json` と `codex` CLI のどちらも見つからない場合に限り「未導入」として警告し、それ以外は従来どおり検査する。

## パターン 2

### 登録の仕方

Claude Code だけに登録する。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipCodex
```

自動起動も設定する場合は `-RegisterStartup` を追加する。
ツール実行前後のイベントも読み上げたい場合は `-IncludeToolEvents` を追加する。

### 確認

```powershell
npm run doctor
```

VOICEVOX ENGINE とデーモンが稼働中で、Claude Code のフックが登録済みと表示されればよい。
Codex は対象外として中立表示になり、Codex への問い合わせは行われない。

## パターン 3

### 登録の仕方

Codex だけに登録する。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipClaude
```

自動起動も設定する場合は `-RegisterStartup` を追加する。
ツール実行前後のイベントも読み上げたい場合は `-IncludeToolEvents` を追加する。

### 確認

通常の PowerShell から次を実行する。
Codex Desktop 内のターミナルでは、サンドボックス用の別の `CODEX_HOME` が使われるため、導入状態を正しく確認できない。

```powershell
npm run doctor
```

VOICEVOX ENGINE とデーモンが稼働中で、Codex のフックが登録済みと表示されればよい。
Codex を起動して `/hooks` を開き、VOICEVOX Coding のフックを承認する。
`npm run doctor` に Codex のフック読み込み状態と信頼状態が表示されれば確認できている。

## 更新するとき

更新は次のコマンド 1 つで完了する。
事前に `git pull` を実行しておく必要はない。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update.ps1
```

PowerShell のプロンプトから実行する。
エクスプローラからダブルクリックで実行すると、エラーが起きてもコンソール窓が閉じてしまい内容を確認できない。

リポジトリを最新化しただけでは、更新は反映されない。
デーモンが常駐プロセスとして旧コードのまま動き続け、フック定義とスタートアップ登録も `install.ps1` が生成した時点の内容のまま残るからである。

次の手順は `update.ps1` の内部処理であり、手動で行う必要はない。

1. `git pull --ff-only` でリポジトリを最新化する
2. 稼働中のデーモンを停止する
3. `install.ps1` を再実行し、フック定義とスタートアップ登録を作り直す
4. 停止したデーモンを起動し直す

スタートアップ登録の有無は自動で判定して引き継ぐ。
`-IncludeToolEvents` / `-SkipClaude` / `-SkipCodex` などのオプションは、導入時に `%USERPROFILE%\.voicevox-coding\install.json` へ記録され、更新時は自動で引き継がれる。
変えたいときだけ、更新時にそのオプションを明示的に指定すればよい。
`install.json` が無い（manifest 保存に対応する前に導入した）場合、初回更新時は現在の `settings.json` / `hooks.json` の登録状況から推定する。
npm パッケージへの依存はないので、`npm install` は不要である。

停止トークンを取得できない場合（`runtime.json` を書き出さない版のデーモンからの初回更新など）は、本デーモンのプロセスだと確認したうえで自動的に停止して続行する。
この場合、エンジンなどの後始末は次回のデーモン起動時に行われる。
トークンを取得できているにもかかわらず停止 API でデーモンを止められない場合は、従来どおりスクリプトは中断してトレイの「終了」による停止を案内する。
本デーモンのプロセスだと確認できた場合に限り、`-Force` を付ければ強制終了して続行できる。

`update.ps1` を使わず手動で更新する場合は、`git pull` の後にトレイの「終了」でデーモンを止め、`install.ps1` を同じオプションで実行し直してから `npm run start` で起動する。

フック定義そのものが変わる更新では、Codex の再承認が必要になることがある。
更新後に `npm run doctor` を実行すると、承認状態も含めて点検できる。

`settings.json` と `hooks.json` のバックアップ（`<ファイル名>.bak-日時`）は、書き込む内容が既存ファイルと変わらない更新では作られない。
作られた場合も対象ファイルごとに直近 5 世代だけが残り、それより古いものは自動で削除される。

## アンインストール

デーモンが動いている場合は、先にタスクトレイの「終了」で停止する。
アンインストールのスクリプトはフックの登録とスタートアップ登録を取り除くだけで、動作中のデーモンは止めない。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

`-RemoveConfig` を付けると、設定とキャッシュも消す。
デーモンの動作中はログやキャッシュのファイルが使用中で消せないことがあるため、この点でも先に停止しておく。

## うまくいかないとき

- Claude Code のデスクトップアプリでフックが発火しない:Windows のデスクトップアプリで `settings.json` のフックが発火しない報告がある。
  まず CLI で確認し、スクリプトの問題かアプリ側の挙動かを切り分ける。
- Codex で `async hooks are not supported yet` と警告されフックが動かない:Codex は `async: true` のフックをサポートしておらず、警告して破棄する（0.145 時点）。
  `npm run doctor` で検出できるため、結果を確認する。
- Codex で `hook: Stop Failed` だけが表示される:Codex は `command` の先頭に引用符付きの実行ファイルを指定すると起動に失敗する。
  実行ファイルは PATH 上の `node` を素の名前で指定し、引数だけを引用する（例: `node "script" codex`）。
  `npm run doctor` でも検出できる。
- フック定義を更新した後に Codex がフックを実行しない:定義のハッシュが変わると再承認が必要になる。
  Codex で `/hooks` を開き、変更されたフックを再承認する。
