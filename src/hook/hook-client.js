#!/usr/bin/env node
// フック本文は runtime.json の共有トークンで暗号化し、デーモンだけが復号できる形で送る。
// インストール先へ単体でコピーするため、暗号処理もこのファイル内に持つ。
// 失敗しても呼び出し元を止めず、全体を 2 秒以内に終了する。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TARGET = process.argv[2] ?? 'claudeCode';
const CONFIG_PATH = path.join(os.homedir(), '.voicevox-coding', 'config.json');
const RUNTIME_PATH = path.join(os.homedir(), '.voicevox-coding', 'runtime.json');
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
  const token = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'))?.token;
  if (typeof token !== 'string' || !token) return;
  const text = await readStdin();
  if (!text.trim()) return;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }

  const context = 'voicevox-coding-hook-v1';
  const key = crypto.hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.alloc(0), context, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(JSON.stringify({ target: TARGET, payload, ts: Date.now() }), 'utf8'), cipher.final()]);
  const body = { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    await fetch(`http://127.0.0.1:${resolvePort()}/hook/sealed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch {
  } finally {
    clearTimeout(timer);
  }
}

setTimeout(() => process.exit(0), TIMEOUT_MS);
main().catch(() => {}).finally(() => process.exit(0));
