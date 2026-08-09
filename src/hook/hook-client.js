#!/usr/bin/env node
// フックから呼ばれる薄いクライアント。
// stdin のイベント JSON をデーモンに転送するだけ。判断もフィルタもデーモン側が持つ。
//
// この中身を薄く保つのは意図的:
//   ・Codex はフック定義のハッシュで信頼を管理するため、定義を変えずに済ませたい
//   ・読み上げの失敗が Claude Code / Codex 本体を止めてはいけない
//
// 使い方: node hook-client.js <target>     target = claudeCode | codex

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TARGET = process.argv[2] ?? 'claudeCode';
const CONFIG_PATH = path.join(os.homedir(), '.voicevox-coding', 'config.json');
const DEFAULT_PORT = 7591;
const TIMEOUT_MS = 2000;

function resolvePort() {
  const env = Number(process.env.VOICEVOX_CODING_PORT);
  if (Number.isInteger(env) && env > 0) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const p = Number(cfg?.daemon?.port);
    if (Number.isInteger(p) && p > 0) return p;
  } catch {}
  return DEFAULT_PORT;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // stdin が閉じない事故で固まらないようにする
    setTimeout(() => resolve(data), TIMEOUT_MS);
  });
}

async function main() {
  const text = await readStdin();
  if (!text.trim()) return;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    await fetch(`http://127.0.0.1:${resolvePort()}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: TARGET, payload }),
      signal: ac.signal,
    });
  } catch {
    // デーモンが起動していないだけ。黙って終わる
  } finally {
    clearTimeout(timer);
  }
}

main().finally(() => process.exit(0));
