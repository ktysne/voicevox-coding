# VOICEVOX Coding の導入手順

この文書は、VOICEVOX Coding を導入する AI（Claude Code など）が読む手順書である。
人が読んで手で進めることもできる。

## 進め方の決まり

- `install.ps1`、`update.ps1`、`uninstall.ps1`、`npm run doctor`、共通手順 3 のデーモン起動コマンドは、通常の PowerShell から実行する。
  AI が Codex Desktop 内で動いている場合、AI はこれらのコマンドを実行せず、実行するコマンドと事前確認を開発者へ渡し、その結果を受け取ってから続ける。
  コマンドを実行する PowerShell で、実行前に `$env:CODEX_HOME` の値を確認する。
  値がある場合はそのディレクトリ、空の場合は `%USERPROFILE%\.codex\` が Codex の設定先である。
  設定先の絶対パスは、通常の PowerShell で次のコマンドを実行して確認する。

  ```powershell
  $codexHome = if ($env:CODEX_HOME) {
      [System.IO.Path]::GetFullPath($env:CODEX_HOME)
  } else {
      Join-Path $env:USERPROFILE '.codex'
  }
  "CODEX_HOME=$env:CODEX_HOME"
  Join-Path $codexHome 'hooks.json'
  ```

- `install.ps1` にドライランはないため、実行前に AI は書き込み先、登録イベント、フックコマンド、バックアップ、対象外にする連携先の既存フックを解除する動作を開発者に示し、確認を得る。
  書き込み先は `%USERPROFILE%` と `$env:CODEX_HOME` を解決した実パスで示す。
  `CODEX_HOME` が空なら `%USERPROFILE%\.codex\hooks.json`、値があればコマンドで解決した Codex 設定先に `hooks.json` を結合した絶対パスを示す。
  常に `%USERPROFILE%\.voicevox-coding\hook-client.js` と `%USERPROFILE%\.voicevox-coding\install.json` を配置する。
  Claude Code を対象にする場合は `%USERPROFILE%\.claude\settings.json`、Codex を対象にする場合は上記の `hooks.json` も変更対象として示す。
  `-RegisterStartup` を指定する場合は `%USERPROFILE%\.voicevox-coding\start-daemon.vbs` と Windows のスタートアップフォルダーにある `VOICEVOX Coding.vbs` も示す。
  `install.ps1` は `-RegisterStartup` を指定した場合だけ `start-daemon.vbs` を作成する。
  登録イベントは、Claude Code が `Stop`、`MessageDisplay`、`Notification`、`SessionStart`、`SessionEnd`、`SubagentStop`、`UserPromptSubmit`、`PreCompact`、Codex が `Stop`、`PermissionRequest`、`SessionStart`、`SessionEnd`、`SubagentStop`、`UserPromptSubmit`、`PreCompact` である。
  `-IncludeToolEvents` を指定すると、両方に `PreToolUse` と `PostToolUse` も登録する。
  Claude Code のフックコマンドは `"node.exe の実パス" "hook-client.js の実パス" claudeCode`、Codex は `node "hook-client.js の実パス" codex` の形である。
  既存の `settings.json` または `hooks.json` を変更する場合は、変更前に `.bak-<yyyyMMdd-HHmmss>` 形式のバックアップを作成する。
  既存内容と同じ場合はバックアップも設定ファイルへの書き込みも行わない。
  書き込んだ後は対象ファイルごとに直近 5 世代のバックアップを残し、それより古いものを削除する。
- `-SkipClaude` または `-SkipCodex` を指定すると、対象連携先の設定から VOICEVOX Coding の既存フックも解除する。
- 既存の設定はマージし、VOICEVOX Coding 以外のフックは残す。
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
| Node.js | 20 以上（`node --version`）。Codex のフックは PATH 上の素の `node` で起動するため、システムの `PATH` から `node` を解決できる必要がある |
| VOICEVOX | インストールが必要。VOICEVOX アプリを起動しておく必要はない |
| PowerShell 7 | セットアップ、更新、アンインストールに必要（[入手先](https://aka.ms/powershell)） |
| Git | リポジトリの取得と `update.ps1` に使用する |
| Claude Code / Codex | 利用する連携先だけを用意する。途中経過の読み上げ対象は Codex Desktop（`sourceKinds: vscode`）のセッションであり、読み上げる場合は `codex` CLI を PATH から起動できる必要がある。`npm run doctor` も Codex のフックの信頼状態を `codex` CLI で問い合わせる |

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
インストールスクリプトはフッククライアントを `%USERPROFILE%\.voicevox-coding\` に配置し、選んだ連携先の設定ファイルにデーモンへ転送するフックを登録する。
実行前に「進め方の決まり」に従って変更内容を示し、開発者の確認を得る。
Codex の `hooks.json` は、確認した `$env:CODEX_HOME` が設定されていればそのディレクトリに書き込む。
未設定の場合は `%USERPROFILE%\.codex\hooks.json` を使う。

### 3. デーモンを起動する

AI はデーモンを前面で起動しない。
`install.ps1` は `-RegisterStartup` を指定した場合だけ `%USERPROFILE%\.voicevox-coding\start-daemon.vbs` を作成するため、そのファイルがあれば `wscript.exe` 経由で起動し、なければリポジトリ内の `src\daemon\main.js` を `node` で非表示起動する。

```powershell
$daemonVbs = Join-Path $env:USERPROFILE '.voicevox-coding\start-daemon.vbs'
if (Test-Path -LiteralPath $daemonVbs) {
    Start-Process wscript.exe -ArgumentList "`"$daemonVbs`""
} else {
    $mainJs = (Resolve-Path 'src\daemon\main.js').Path
    Start-Process node -ArgumentList "`"$mainJs`"" -WindowStyle Hidden
}
```

起動後、`npm run doctor` の `デーモン` が稼働中と表示されるか、`http://127.0.0.1:7591/api/state` が応答することを確認する。
起動直後はデーモンが VOICEVOX ENGINE を起動している途中で、`VOICEVOX ENGINE` が NG になることがある。数十秒おいて `npm run doctor` を再実行する。
`start-daemon.vbs` は作成した時点のリポジトリと `node` のパスで起動するため、その後にリポジトリを移動していると起動に失敗する。この場合は `install.ps1` を再実行する。
管理コンソールは `http://127.0.0.1:7591/` から開く。

起動時に VOICEVOX エンジンが動いていなければ、実行ファイルを自動検出して起動する。
`-RegisterStartup` を指定した場合は、次のサインイン以降に自動で起動する。
多重起動した場合、2 つ目のデーモンはポートの重複を検出して終了する。
導入後は、選んだ連携先を普段どおり使うと読み上げが始まる。

開発者が自分のターミナルで前面起動する場合は `npm run console` も使えるが、ターミナルを閉じるとデーモンも終了する。

## パターン 1

### 登録の仕方

Claude Code と Codex の両方に登録する。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

自動起動も設定する場合は `-RegisterStartup` を追加する。
ツール実行前後のイベントも読み上げたい場合は `-IncludeToolEvents` を追加する。

### 確認

「進め方の決まり」に従い、通常の PowerShell から `$env:CODEX_HOME` を確認してから次を実行する。
Codex Desktop 内のターミナルでは、別の `CODEX_HOME` が使われる場合があるため、導入状態を正しく確認できない。

```powershell
npm run doctor
```

VOICEVOX ENGINE とデーモンが稼働中で、Claude Code と Codex のフックが登録済みと表示されればよい。
Codex を起動して `/hooks` を開き、VOICEVOX Coding のフックを承認してから `npm run doctor` を再実行する。
`Codex 信頼状態` が「N 件すべて承認済み」と表示され、`Codex 無効化` の警告が出ないことを確認する。
`codex` CLI が無い環境では `Codex 信頼状態` が「codex app-server から取得できませんでした」と警告されるが、これは許容する。
その場合は開発者に Codex の `/hooks` 画面で、VOICEVOX Coding のフックが承認済みで有効になっていることを確かめてもらう。
Codex の `/hooks` で個別にオフにしたフックは、承認済みでも実行されない。
`-RegisterStartup` を指定しなかった場合に `スタートアップ` が未登録と警告されるのは正常である。

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
`Codex` の行が OK で、詳細に `対象外（導入時に -SkipCodex を指定）` と表示され、Codex への問い合わせは行われない。
`-RegisterStartup` を指定しなかった場合に `スタートアップ` が未登録と警告されるのは正常である。

## パターン 3

### 登録の仕方

Codex だけに登録する。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipClaude
```

自動起動も設定する場合は `-RegisterStartup` を追加する。
ツール実行前後のイベントも読み上げたい場合は `-IncludeToolEvents` を追加する。

### 確認

「進め方の決まり」に従い、通常の PowerShell から `$env:CODEX_HOME` を確認してから次を実行する。
Codex Desktop 内のターミナルでは、別の `CODEX_HOME` が使われる場合があるため、導入状態を正しく確認できない。

```powershell
npm run doctor
```

VOICEVOX ENGINE とデーモンが稼働中で、Codex のフックが登録済みと表示されればよい。
Codex で `/hooks` を開いて VOICEVOX Coding のフックを承認し、`npm run doctor` を再実行する。
`Codex 信頼状態` が「N 件すべて承認済み」と表示され、`Codex 無効化` の警告が出ないことを確認する。
`codex` CLI が無い環境では `Codex 信頼状態` が「codex app-server から取得できませんでした」と警告されるが、これは許容する。
その場合は開発者に Codex の `/hooks` 画面で、VOICEVOX Coding のフックが承認済みで有効になっていることを確かめてもらう。
`Claude Code` の行が OK で、詳細に `対象外（導入時に -SkipClaude を指定）` と表示される。
`-RegisterStartup` を指定しなかった場合に `スタートアップ` が未登録と警告されるのは正常である。

## 更新するとき

「進め方の決まり」の確認ルールは更新時にも適用する。
通常の PowerShell で `$env:CODEX_HOME` を確認し、Codex の `hooks.json` を含む変更見込みを開発者に示して確認を得る。

更新は次のコマンド 1 つで完了する。
事前に `git pull` を実行しておく必要はない。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update.ps1
```

PowerShell のプロンプトから実行する。
エクスプローラからダブルクリックで実行すると、エラーが起きてもコンソール窓が閉じてしまい内容を確認できない。

`update.ps1` のオプションは次のとおりである。

| オプション | 効果 |
|---|---|
| `-SkipPull` | `git pull --ff-only` を省略し、取得済みのリポジトリから更新を適用する |
| `-Force` | デーモンの通常終了が失敗し、スクリプトが VOICEVOX Coding のプロセスだと確認できた場合に限り、強制終了して続行する |
| `-IncludeToolEvents` | ツール実行前後のフックも登録する |
| `-SkipClaude` | Claude Code を対象外にし、既存の VOICEVOX Coding フックを解除する |
| `-SkipCodex` | Codex を対象外にし、既存の VOICEVOX Coding フックを解除する |

`-RegisterStartup` は `update.ps1` のオプションではない。
更新スクリプトは Windows のスタートアップフォルダーに既存の登録がある場合だけ、その登録を引き継ぐ。

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
`install.json` が無い旧導入の環境では、`npm run doctor` は `hooks.json` と `codex` CLI のどちらも見つからない場合に限り Codex を「未導入」として警告にとどめ、それ以外は通常どおり検査する。
npm パッケージへの依存はないので、`npm install` は不要である。

停止トークンを取得できない場合（`runtime.json` を書き出さない版のデーモンからの初回更新など）は、VOICEVOX Coding のデーモンのプロセスだと確認したうえで自動的に停止して続行する。
この場合、エンジンなどの後始末は次回のデーモン起動時に行われる。
トークンを取得できているにもかかわらず停止 API でデーモンを止められない場合は、スクリプトが中断し、トレイの「終了」による停止を案内する。
VOICEVOX Coding のデーモンのプロセスだと確認できた場合に限り、`-Force` を付ければ強制終了して続行できる。

`update.ps1` を使わず手動で更新する場合は、まず `git pull --ff-only` を実行する。
次に開発者へタスクトレイの「終了」を依頼し、`npm run doctor` の `デーモン` が応答しない状態になったことを確かめてから次へ進む。
デーモンが応答しなくなった後、同じオプションで `install.ps1` を実行し、共通手順 3 の方法でデーモンを起動する。

フック定義そのものが変わる更新では、Codex の再承認が必要になることがある。
更新後に `npm run doctor` を実行すると、承認状態も含めて点検できる。

`settings.json` と `hooks.json` のバックアップ（`<ファイル名>.bak-日時`）は、書き込む内容が既存ファイルと変わらない更新では作られない。
作られた場合も対象ファイルごとに直近 5 世代だけが残り、それより古いものは自動で削除される。

## アンインストール

アンインストールの前に、開発者へタスクトレイの「終了」を依頼する。
`npm run doctor` の `デーモン` が応答しない状態になったことを確認してから、次へ進む。
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
