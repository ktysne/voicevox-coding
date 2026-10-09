# VOICEVOX Coding の開発

VOICEVOX Coding 自体を開発するときの入口である。
導入は [setup.md](setup.md)、導入後の動作と設定は [usage.md](usage.md) にある。

## 最初に読むもの

| 文書 | 内容 |
|---|---|
| [CLAUDE.md](../CLAUDE.md) / [AGENTS.md](../AGENTS.md) | プロジェクトの実装規約と作業手順。2 つは同じ内容に保つ |
| [docs/usage.md](usage.md) | 利用者から見たイベント、設定、運用の挙動とデーモンの構成 |
| [docs/AUDIT_FINDINGS.md](AUDIT_FINDINGS.md) | 監査時点の潜在不具合と対応状況を記録した文書 |
| [docs/cross-review.md](cross-review.md) / [.cross-review.md](../.cross-review.md) | ai-cross-review から同期した手順と、このリポジトリ固有のレビュー観点 |

## ファイル

| パス | 役割 |
|---|---|
| `src/daemon/main.js` | デーモンを構成する。設定、ログ、VOICEVOX ENGINE、音声再生、キュー、タスクトレイ、HTTP サーバーを起動して終了時に停止する |
| `src/daemon/server.js` | フックのイベントを処理し、設定、読み上げ制御、エンジン操作などのローカル HTTP API と管理コンソールを提供する |
| `src/daemon/config.js`、`catalog.js`、`events.js` | 設定の読み書き、イベント一覧、読み上げ対象の判定を扱う |
| `src/daemon/logger.js` | `daemon.log` への出力と退避を扱う |
| `src/daemon/message-stream.js`、`textfilter.js`、`dictionary.js` | 途中経過の集約、本文の整形、置換ルールと VOICEVOX ユーザー辞書を扱う |
| `src/daemon/queue.js`、`player.js`、`player-worker.ps1` | 発話キュー、音声再生、Windows の音声出力ワーカーを扱う |
| `src/daemon/voicevox.js`、`engine-process.js` | VOICEVOX ENGINE への API 呼び出しとエンジンプロセスの起動・停止を扱う |
| `src/daemon/codex-commentary-monitor.js` | Codex Desktop の途中経過を `codex app-server` から監視する |
| `src/daemon/tray.js`、`src/tray/tray-worker.ps1` | デーモンとタスクトレイの間の起動、状態表示、操作を扱う |
| `src/hook/hook-client.js` | Claude Code と Codex のフック入力をデーモンへ転送する |
| `src/ui/` | ブラウザーで開く管理コンソールの HTML、CSS、JavaScript を置く |
| `scripts/install.ps1`、`update.ps1`、`uninstall.ps1` | フックの導入、リポジトリと導入設定の更新、フック登録の解除を行う |
| `scripts/doctor.mjs` | エンジン、デーモン、フック登録、Codex の信頼状態を点検する |
| `test/` | `node:test` による機能テストを置く。PowerShell スクリプトの文字コードやフック登録も確認する |
| `tools/cross-review*.js`、`tools/cross-review.sync*.json` | ai-cross-review の実行、同期、配布対象の設定を扱う。同期対象の実装は直接編集しない |
| `.github/workflows/test.yml` | Windows 上で Node.js 20 と 24 のテストを実行する |

## 検証コマンド

```bash
npm test
npm run doctor
node --test test/queue.test.mjs
```

`npm test` は `node --test` でテスト一式を実行する。
`npm run doctor` は導入環境を点検するため、デーモンと VOICEVOX ENGINE が起動した状態で実行する。
Codex の登録状態を確かめるときは、Codex Desktop 内ではなく通常の PowerShell から実行する。

## ai-cross-review の取り込み

ai-cross-review から取り込んだファイルは、上流への変更を `tools/cross-review.sync.js` で同期する。
同期後は、表示された移行ノートを反映してから検証する。

```bash
npm run sync
npm run sync:check
node tools/cross-review.sync.js --check-manifest
```

## 開発時の注意

Windows PowerShell 5.1 は UTF-8 BOM のない `.ps1` を ANSI として読む。
`install.ps1` と `uninstall.ps1` は PowerShell 7 に引き継ぐ前に 5.1 で解析されるため、`.ps1` は UTF-8 BOM 付きで保存する。

## 文書を直すとき

- 導入の前提、登録パターン、更新、アンインストールを変えたら [setup.md](setup.md) を直す。
- イベント、設定項目、画面操作、読み上げの動作を変えたら [usage.md](usage.md) を直す。
- ツールの概要、連携先、導入への入口を変えたら [README.md](../README.md) を直す。
- 実装の構成、検証方法、開発フローを変えたら、この文書を直す。
- プロジェクト共通の作業規約を変えるときは [CLAUDE.md](../CLAUDE.md) と [AGENTS.md](../AGENTS.md) を同じ内容で直す。
- ai-cross-review から同期したファイルは直接編集せず、上流から同期する。
