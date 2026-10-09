# VOICEVOX Coding

Claude Code または Codex のイベントを VOICEVOX の音声で知らせ、画面を見ていないときも作業状況を伝える Windows 向け常駐デーモンである。
Node.js の標準モジュールだけで動き、npm パッケージへの依存はない。

## 概要

- **イベントの読み上げ**:応答完了、通知、許可待ちなどを読み上げる。
- **途中経過の読み上げ**:Claude Code の `MessageDisplay` と Codex の `commentary` を読み上げる。
- **管理コンソール**:ブラウザーからイベント、声、読み上げ方、エンジンを設定する。
- **用語辞書**:置換ルールと VOICEVOX ユーザー辞書で読みを調整する。
- **タスクトレイ常駐**:状態の確認、読み上げの一時停止、スキップ、全停止、エンジン操作を行う。

フックはイベントを常駐デーモンへ転送し、設定と読み上げ処理はデーモンに集約する。
構成と機能の詳しい説明は [docs/usage.md](docs/usage.md) にある。

動作要件は Windows、Node.js 20 以上、PowerShell 7、VOICEVOX である。

## 連携できるツール

Claude Code と Codex はどちらか一方だけでも利用できる。
VOICEVOX のインストールは必須である。

| ツール | 概要 | 連携するとできること |
|---|---|---|
| Claude Code | イベントをフックでデーモンへ送る | 応答完了、通知、途中経過、ツール実行などを読み上げる |
| Codex | イベントをフックでデーモンへ送る | 応答完了、許可待ち、ツール実行などを読み上げる。途中経過（`commentary`）は Codex Desktop（`sourceKinds: vscode`）のセッションが対象で、読み上げには `codex` CLI が必要である |

## 導入

導入は AI（Claude Code など）に任せる前提で、手順を [docs/setup.md](docs/setup.md) にまとめている。
AI には次のように依頼する。

> VOICEVOX Coding を導入して。
> 手順は https://raw.githubusercontent.com/ktysne/voicevox-coding/main/docs/setup.md にある。

手順書は共通手順と 3 つの導入パターン、更新、アンインストール、トラブル対応で構成する。
手順書を読んで人が手で進めることもできる。
`~/.claude/settings.json`、`~/.codex/hooks.json`、Windows のスタートアップ登録に加え、`%USERPROFILE%\.voicevox-coding\` 内の `hook-client.js`、`install.json`、`start-daemon.vbs` も導入で確認する対象である。
`start-daemon.vbs` は `-RegisterStartup` を指定した場合に作成される。
これらリポジトリ外のファイルや設定を変更するときは、AI が `CODEX_HOME` を解決した実パスと変更内容を示して確認を求める。

## 導入できたかの確認

共通の確認に加えて、導入したパターンごとの項目を確かめる。
コマンドと期待する結果は [docs/setup.md](docs/setup.md) の各「確認」にある。

| パターン | 確かめること |
|---|---|
| 共通 | `npm run doctor` が通り、`http://127.0.0.1:7591/` で管理コンソールが開く |
| パターン 1 | Claude Code と Codex のフックが登録され、doctor の `Codex 信頼状態` が「N 件すべて承認済み」で、`Codex 無効化` の警告がない |
| パターン 2 | Claude Code のフックが登録され、Codex は `OK Codex 対象外（導入時に -SkipCodex を指定）` と表示される |
| パターン 3 | Codex のフックが登録され、doctor の `Codex 信頼状態` が「N 件すべて承認済み」で、`Codex 無効化` の警告がなく、Claude Code は `OK Claude Code 対象外（導入時に -SkipClaude を指定）` と表示される |

## 開発者向けドキュメント

VOICEVOX Coding 自体を開発するときは [docs/development.md](docs/development.md) から読み始める。

## ライセンス

音声合成に VOICEVOX を利用している。
VOICEVOX 自体は商用でも非商用でも無料だが、キャラクターごとに利用規約がある。
生成した音声を公開したり配布したりする場合は、クレジット表記（例: `VOICEVOX:ずんだもん`）が必要になる。
詳しくは [LICENSE.md](LICENSE.md) と [VOICEVOX 利用規約](https://voicevox.hiroshiba.jp/term/) を確認すること。
