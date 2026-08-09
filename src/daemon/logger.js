// ファイルとメモリの両方に残すロガー。
// メモリ側は管理コンソールの「ログ」タブがそのまま読む。

import fs from 'node:fs';
import { LOG_PATH } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_MEMORY_LINES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class Logger {
  constructor(getLevel = () => 'info') {
    this.getLevel = getLevel;
    this.lines = [];
    this.listeners = new Set();
    try {
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_FILE_BYTES) {
        fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
      }
    } catch {}
  }

  #write(level, message) {
    const threshold = LEVELS[this.getLevel()] ?? LEVELS.info;
    if ((LEVELS[level] ?? 20) < threshold) return;
    const entry = { ts: new Date().toISOString(), level, message: String(message) };
    this.lines.push(entry);
    if (this.lines.length > MAX_MEMORY_LINES) this.lines.splice(0, this.lines.length - MAX_MEMORY_LINES);
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {}
    }
    try {
      fs.appendFileSync(LOG_PATH, `${entry.ts} [${level}] ${entry.message}\n`, 'utf8');
    } catch {}
  }

  debug(m) { this.#write('debug', m); }
  info(m) { this.#write('info', m); }
  warn(m) { this.#write('warn', m); }
  error(m) { this.#write('error', m); }

  recent(limit = 200) {
    return this.lines.slice(-limit);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
