// ファイルとメモリの両方に残すロガー。
// メモリ側は管理コンソールの「ログ」タブがそのまま読む。
//
// ファイル側は fs.createWriteStream を 1 本開いて使い回す非同期書き込みにしている。
// 1 行ごとに open/write/close する同期 appendFileSync はイベントループを止めてしまうため。
// サイズ超過は起動時だけでなく稼働中にも監視し、超えたら現在のファイルを .1 へ退避する。

import fs from 'node:fs';
import { LOG_PATH } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_MEMORY_LINES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// ローテーション中に rename が失敗し続ける場合の無限ループ対策。
// この回数だけ試して駄目なら諦め、しばらく間を置いてから試し直す。
const MAX_ROTATE_ATTEMPTS = 3;
// 諦めたあとに試し直すまでの間隔。これが無いと、rename が失敗し続ける間
// （ログビューアが掴んだまま等）、1 行書くたびに end → rename → 再オープンの
// 一巡が走ってしまう。
const ROTATE_RETRY_DELAY_MS = 60_000;

export class Logger {
  constructor(getLevel = () => 'info', { path = LOG_PATH, maxBytes = MAX_FILE_BYTES } = {}) {
    this.getLevel = getLevel;
    this.path = path;
    this.maxBytes = maxBytes;
    this.lines = [];
    this.listeners = new Set();

    this.stream = null;
    this.bytes = 0;
    this.rotating = false;
    this.pending = [];
    this.closed = false;
    this.retryRotateAt = 0;
    this._closePromise = null;

    // 起動時にすでに上限を超えていたら、従来どおり開く前に先にローテーションしておく
    try {
      if (fs.existsSync(this.path) && fs.statSync(this.path).size > this.maxBytes) {
        try {
          fs.rmSync(`${this.path}.1`, { force: true });
          fs.renameSync(this.path, `${this.path}.1`);
        } catch {}
      }
    } catch {}
    this.#open();
  }

  /** 書き込み用ストリームを（再）オープンする。失敗しても例外は投げない。 */
  #open() {
    try {
      let size = 0;
      try {
        size = fs.statSync(this.path).size;
      } catch {
        size = 0; // ファイルが無ければ 0
      }
      this.bytes = size;
      const stream = fs.createWriteStream(this.path, { flags: 'a' });
      stream.on('error', () => {
        // 書き込みに失敗した。ストリームを捨ててメモリのみのログに落とす。
        // 再オープンは次のローテーション契機（バイトカウンタが上限を超えたとき）に任せる。
        this.stream = null;
      });
      this.stream = stream;
    } catch {
      this.stream = null;
    }
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
    // メモリ側の記録・配信は、ファイル側がローテーション中やエラーで止まっていても続ける
    this.#writeToFile(`${entry.ts} [${level}] ${entry.message}\n`);
  }

  /** ファイルへの実書き込み。ローテーション中は pending に溜めるだけにする。 */
  #writeToFile(line) {
    if (this.rotating) {
      this.pending.push(line);
      return;
    }
    if (this.stream) {
      try {
        // stream.write() の戻り値（backpressure）は無視する。
        // ログの量はもともと少なく、あふれても Node 内部バッファに乗るだけ。
        // ここで待つと、ログ出力のために本体の処理を止めることになってしまう。
        this.stream.write(line, 'utf8');
      } catch {
        this.stream = null;
      }
    }
    // stream が無い間（エラー後など）も試行バイト数としては数えておく。
    // これが積み重なって上限を超えると #rotate() 経由で再オープンを試みる。
    this.bytes += Buffer.byteLength(line, 'utf8');
    // close() 後は回さない（閉じたはずのストリームを開き直さない）。
    // 直前のローテーションが失敗している間は、間を置いてから試し直す。
    if (this.bytes > this.maxBytes && !this.closed && Date.now() >= this.retryRotateAt) {
      this.#rotate().catch(() => {});
    }
  }

  /** pending に溜めた行を現在の stream へ書き出す。#rotate() の中からだけ呼ぶ。 */
  #flushPending() {
    const toFlush = this.pending;
    this.pending = [];
    for (const line of toFlush) {
      if (this.stream) {
        try {
          this.stream.write(line, 'utf8');
        } catch {
          this.stream = null;
        }
      }
      this.bytes += Buffer.byteLength(line, 'utf8');
    }
  }

  /**
   * 稼働中のローテーション。Windows では開いたままの rename が不安定なため、
   * 「end で flush 完了を待つ → rename → 開き直す → pending を flush する」を直列に行う。
   * 多重に走らないよう rotating フラグで防ぐ。
   */
  async #rotate() {
    if (this.rotating || this.closed) return;
    this.rotating = true;
    let failure = null;
    try {
      for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS && this.bytes > this.maxBytes; attempt++) {
        const oldStream = this.stream;
        this.stream = null;
        if (oldStream) {
          await new Promise((resolve) => {
            oldStream.once('close', resolve);
            oldStream.once('error', resolve);
            oldStream.end();
          });
        }
        try {
          fs.rmSync(`${this.path}.1`, { force: true });
          fs.renameSync(this.path, `${this.path}.1`);
          this.retryRotateAt = 0;
          failure = null;
        } catch (err) {
          // ログビューアが掴んでいる等で rename に失敗しても継続する
          failure = err;
        }
        this.#open();
        this.#flushPending();
      }
    } finally {
      this.rotating = false;
    }
    if (failure && this.bytes > this.maxBytes) {
      // 全試行が失敗した。書き込みのたびに一巡し直さないよう間を置き、
      // 黙り続けないよう memory ログへ 1 行だけ残す
      // （rotating を下ろした後なので、この warn は pending に滞留しない）。
      this.retryRotateAt = Date.now() + ROTATE_RETRY_DELAY_MS;
      this.warn(`ログのローテーションに失敗しました（しばらくしてから再試行します）: ${failure.message}`);
    }
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

  /** pending を書き切り、stream を確実に flush してから閉じる。二重呼び出しに耐える。 */
  async close() {
    // 以後の書き込みでストリームを開き直さない（メモリ側のログは動き続ける）
    this.closed = true;
    if (!this._closePromise) this._closePromise = this.#doClose();
    return this._closePromise;
  }

  async #doClose() {
    // ローテーションの途中なら完了を待ってから閉じる
    while (this.rotating) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.#flushPending();
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    await new Promise((resolve) => {
      stream.once('close', resolve);
      stream.once('error', resolve);
      stream.end();
    });
  }
}
