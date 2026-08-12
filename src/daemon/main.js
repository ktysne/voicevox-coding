#!/usr/bin/env node
// 常駐デーモンのエントリポイント。

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore, CONFIG_PATH, CONFIG_DIR } from './config.js';
import { Logger } from './logger.js';
import { VoicevoxEngine } from './voicevox.js';
import { EngineProcess } from './engine-process.js';
import { Player } from './player.js';
import { SpeechQueue } from './queue.js';
import { Tray } from './tray.js';
import { createServer } from './server.js';
import { syncEngineDictionary } from './dictionary.js';
import { CodexCommentaryMonitor } from './codex-commentary-monitor.js';

const args = process.argv.slice(2);
const shouldOpen = args.includes('--open');
const noTray = args.includes('--no-tray');

const store = new ConfigStore();
store.load();
store.watch();

const log = new Logger(() => store.config.daemon?.logLevel ?? 'info');
store.on('error', (err) => log.error(err.message));
store.on('externalChange', () => log.info('config.json の変更を検知して再読み込みしました'));

// プロセス内だけで持つ状態。再起動すると読み上げは有効に戻る（気づかず無音のままにしない）
const runtime = { muted: false };

const engine = new VoicevoxEngine(() => store.config.engine);
const engineProcess = new EngineProcess(() => store.config, engine, log);
const player = new Player(log);
player.start();

const queue = new SpeechQueue(engine, player, () => store.config, log);
queue.on('error', (err) => log.warn(`合成エラー: ${err.message}`));
const commentaryMonitor = new CodexCommentaryMonitor({ log });

let tray = null;
let healthTimer = null;
let shuttingDown = false;

/** 起動時にユーザー辞書を同期する。ENGINE 未起動なら黙って諦める。 */
async function initialDictionarySync() {
  if (store.config.dictionary?.syncEngineDict === false) return;
  const words = store.config.dictionary?.engineWords ?? [];
  if (words.length === 0) return;
  try {
    const r = await syncEngineDictionary(engine, words);
    log.info(`ユーザー辞書を同期しました: 追加${r.added} 更新${r.updated} 削除${r.removed}`);
    for (const f of r.failed) log.warn(`ユーザー辞書「${f.surface}」: ${f.errors.join(' / ')}`);
  } catch (err) {
    log.warn(`ユーザー辞書の同期を見送りました: ${err.message}`);
  }
}

/** エンジンが落ちていたら起動し直す。 */
function startHealthCheck() {
  clearInterval(healthTimer);
  const sec = store.config.engine?.healthCheckSec ?? 60;
  if (!sec || sec <= 0) return;
  healthTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await engineProcess.ensure();
    } catch (err) {
      log.warn(`エンジンの再起動に失敗しました: ${err.message}`);
    }
  }, sec * 1000);
  healthTimer.unref?.();
}

const port = store.config.daemon?.port ?? 7591;

// 状態変更 API 用のトークン。起動ごとに変わり、トレイなどローカルクライアントにだけ渡す
const apiToken = crypto.randomBytes(32).toString('hex');

// 更新スクリプトなど同一ユーザーのローカルツールが /api/shutdown を呼べるよう、
// トークンをファイルにも書き出す（AUD-01 の脅威モデルはブラウザ経由の攻撃であり、
// 同一ユーザーのローカルプロセスは対象外）。
const RUNTIME_PATH = path.join(CONFIG_DIR, 'runtime.json');

function writeRuntimeFile(port) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_PATH, JSON.stringify({ pid: process.pid, port, token: apiToken }, null, 2), 'utf8');
  } catch (err) {
    log.warn(`runtime.json を書き込めません: ${err.message}`);
  }
}

function removeRuntimeFile() {
  try {
    fs.unlinkSync(RUNTIME_PATH);
  } catch {}
}

const server = createServer({
  store,
  engine,
  queue,
  log,
  engineProcess,
  runtime,
  commentaryMonitor,
  onShutdown: () => shutdown(),
  port,
  token: apiToken,
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`ポート ${port} は使用中です。デーモンが既に起動している可能性があります。`);
    if (shouldOpen) {
      // 既に起動しているなら、コンソールを開くだけで用は足りる
      spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}/`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    process.exit(1);
  }
  log.error(`サーバーエラー: ${err.message}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${port}/`;
  log.info(`VOICEVOX Coding デーモンを起動しました: ${url}`);
  log.info(`設定ファイル: ${CONFIG_PATH}`);
  // 前回実行の一時 WAV の掃除は、ポート取得に成功した後で行う。
  // 二重起動した後発プロセスが、稼働中デーモンの再生待ちファイルを消してしまわないため。
  queue.cleanupEphemeral();
  writeRuntimeFile(port);
  commentaryMonitor.start();

  if (store.config.daemon?.tray !== false && !noTray) {
    tray = new Tray(port, log, apiToken);
    tray.start();
  }

  if (shouldOpen) {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  // 前回のデーモンが残したエンジンプロセスを整理してから起動判定に入る
  await engineProcess.reclaimStale();

  let status = await engine.status();
  if (!status.available && store.config.engine?.autoStart) {
    const r = await engineProcess.start();
    if (r.error) log.warn(r.error);
    status = await engine.status();
  }

  if (status.available) {
    log.info(`VOICEVOX ENGINE に接続しました (version ${status.version})`);
    await initialDictionarySync();
  } else {
    log.warn(`VOICEVOX ENGINE に接続できません (${status.baseUrl})。管理コンソールのエンジンタブから起動できます。`);
  }

  startHealthCheck();
});

store.on('change', () => startHealthCheck());

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('デーモンを終了します');
  removeRuntimeFile();
  clearInterval(healthTimer);
  store.close();
  tray?.stop();
  queue.clear();
  commentaryMonitor.stop();

  if (store.config.engine?.stopOnExit !== false) {
    try {
      await engineProcess.stop();
    } catch {}
  }

  try {
    await player.dispose();
  } catch {}

  server.close(async () => {
    await log.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  log.error(`未捕捉の例外: ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', (err) => {
  log.error(`未処理の拒否: ${err?.stack ?? err}`);
});
