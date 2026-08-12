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
// stream が壊れたあとに開き直しを試すまでの間隔。毎行 statSync + createWriteStream を
// 繰り返さないための抑えで、一時的なアクセス拒否が解消すれば自動で復旧する
// （従来の appendFileSync は毎行が再試行を兼ねていた。その復旧性を保つ）。
const STREAM_REOPEN_DELAY_MS = 30_000;
// ローテーション中に溜める行数の上限。ストレージ障害でローテーションが固着しても
// メモリが増え続けないよう、あふれたら古い行から捨てる（メモリ側のログには残る）。
const MAX_PENDING_LINES = 1000;
// end の flush 完了待ちの上限。ストレージ障害で close イベントが来ない場合に
// ローテーションや終了処理を固着させない。
const STREAM_END_TIMEOUT_MS = 5000;

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
    this.reopenAt = 0;
    this.streamFailed = false;
    this._closePromise = null;

    // 起動時にすでに上限を超えていたら、従来どおり開く前に先にローテーションしておく
    try {
      if (fs.existsSync(this.path) && fs.statSync(this.path).size > this.maxBytes) {
        try {
          this.#swapToBackup();
        } catch {}
      }
    } catch {}
    this.#open();
  }

  /**
   * 現在のログを .1 へ退避する。renameSync は宛先があっても置き換えるので、
   * 通常は 1 回の rename で済む。宛先 (.1) 側が掴まれて置き換えに失敗した場合だけ、
   * .1 を一時名へどかしてから移す。現在のログ側が掴まれて移せなかった場合にも
   * 既存の退避世代を失わないよう、.1 の削除はせず rename と復元で行う。
   */
  #swapToBackup() {
    const dest = `${this.path}.1`;
    try {
      fs.renameSync(this.path, dest);
      return;
    } catch {
      // 宛先が掴まれているか、現在のログが掴まれている。切り分けは下の手順に任せる
    }
    const tmp = `${dest}.tmp`;
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // tmp を消せなければ次の rename が失敗して伝播する。ここでは判断しない
    }
    fs.renameSync(dest, tmp);
    try {
      fs.renameSync(this.path, dest);
    } catch (err) {
      // 現在のログを移せなかった。どかした .1 を元へ戻して世代を守る。
      // 復元はこの失敗時に限る。移動が済んだ後の掃除失敗で復元すると、
      // 退避したばかりの最新世代を古い世代で上書きしてしまう。
      try {
        fs.renameSync(tmp, dest);
      } catch {}
      throw err;
    }
    // 最新の退避は dest に載った。どかした古い世代の削除に失敗しても致命ではない
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
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
      stream.on('error', (err) => {
        // 古い世代のストリームの遅延エラーで、開き直した新しいストリームを捨てない
        if (this.stream === stream) this.#streamBroken(err);
      });
      if (this.streamFailed) {
        // 復旧の通知は fd が実際に開けてから出す（createWriteStream は遅延オープンで、
        // アクセス拒否が続いていてもここでは失敗しない）。'open' は次のティック以降に
        // 届くので、#open を呼び出した元の書き込みへ再入してその行を失うこともない。
        stream.once('open', () => {
          if (this.stream !== stream || !this.streamFailed) return;
          this.streamFailed = false;
          this.#emit('info', 'ログファイルへの書き込みを再開しました');
        });
      }
      this.stream = stream;
    } catch (err) {
      this.#streamBroken(err);
    }
  }

  /**
   * stream が使えなくなった。メモリのみのログに落とし、間を置いてから開き直す。
   * 黙ってファイルログを捨て続けないよう、落ちたことを 1 回だけ warn に残す
   * （復旧したら #open が再開を知らせる）。
   */
  #streamBroken(err) {
    this.stream = null;
    this.reopenAt = Date.now() + STREAM_REOPEN_DELAY_MS;
    if (!this.streamFailed) {
      this.streamFailed = true;
      this.#emit('warn', `ログファイルへ書き込めません（しばらくしてから開き直します）: ${err.message}`);
    }
  }

  #write(level, message) {
    const threshold = LEVELS[this.getLevel()] ?? LEVELS.info;
    if ((LEVELS[level] ?? 20) < threshold) return;
    this.#emit(level, message);
  }

  /**
   * レベルの閾値を通さずに記録する。ロガー自身の健全性通知
   * （書き込み不能・flush 失敗・ローテーション失敗・復旧）はこちらを使う。
   * logLevel を error に絞った設定でも「黙って捨て続けない」を守るため。
   */
  #emit(level, message) {
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
      // 障害でローテーションが長引いてもメモリが増え続けないよう、古い行から捨てる
      // （メモリ側のログには残っている）
      if (this.pending.length >= MAX_PENDING_LINES) this.pending.shift();
      this.pending.push(line);
      return;
    }
    // stream が壊れていたら、間を置いてから開き直す
    if (!this.stream && !this.closed && Date.now() >= this.reopenAt) {
      this.#open();
    }
    if (this.stream) {
      try {
        // stream.write() の戻り値（backpressure）は無視する。
        // ログの量はもともと少なく、あふれても Node 内部バッファに乗るだけ。
        // ここで待つと、ログ出力のために本体の処理を止めることになってしまう。
        this.stream.write(line, 'utf8');
      } catch (err) {
        this.#streamBroken(err);
      }
    }
    // stream が無い間（エラー後など）も試行バイト数としては数えておく
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
        } catch (err) {
          this.#streamBroken(err);
        }
      }
      this.bytes += Buffer.byteLength(line, 'utf8');
    }
  }

  /** stream を end し、flush 完了を待つ。障害で close が来ない場合に固着しないよう上限付き。 */
  #endStream(stream) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (kind, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (kind === 'timeout') {
          // flush を待ちきれなかった。ファイルハンドルを残さないよう破棄する
          try {
            stream.destroy();
          } catch {}
        }
        if (kind !== 'close') {
          // flush の失敗・打ち切りを無通知にしない（メモリ側のログには必ず残る）
          this.#emit('warn', `ログの flush を完了できませんでした: ${kind === 'error' ? err?.message : 'タイムアウト'}`);
        }
        resolve();
      };
      const timer = setTimeout(() => finish('timeout'), STREAM_END_TIMEOUT_MS);
      timer.unref?.();
      stream.once('close', () => finish('close'));
      stream.once('error', (err) => finish('error', err));
      stream.end();
    });
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
        if (oldStream) await this.#endStream(oldStream);
        try {
          this.#swapToBackup();
          this.retryRotateAt = 0;
          failure = null;
        } catch (err) {
          // ログビューアが掴んでいる等で退避に失敗しても継続する
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
      this.#emit('warn', `ログのローテーションに失敗しました（しばらくしてから再試行します）: ${failure.message}`);
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
    await this.#endStream(stream);
  }
}
