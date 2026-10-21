// ストリーミング中のアシスタントメッセージを組み立てる。
//
// MessageDisplay は「新しく確定した行のまとまり」ごとに発火する。つまり 1 つの
// メッセージにつき何度も呼ばれる。断片のまま読むと文の途中で切れて聞き取れないので、
// message_id ごとに溜めて final で 1 つの発話にまとめる。
//
// フックは非同期で実行されるため到着順は保証されない。index を鍵にして並べ替える。

const DEFAULT_GRACE_MS = 400;
const DEFAULT_TTL_MS = 120_000;
// 番号は認証の無い入口から届く。欠番の検出と連結の処理量を番号の大きさに縛られないよう上限で捨てる。
const MAX_DELTA_INDEX = 10_000;

// final のフラッシュは delta が空のことがあり欠番と区別できないので、final の番号は欠番に数えない。
function getMissingRanges(indices, finalIndex) {
  const missing = [];
  let rangeStart = 0;

  for (const index of indices) {
    if (index >= finalIndex) break;
    if (index > rangeStart) {
      const rangeEnd = index - 1;
      missing.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);
    }
    rangeStart = index + 1;
  }

  if (rangeStart < finalIndex) {
    const rangeEnd = finalIndex - 1;
    missing.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);
  }

  return missing.join(',');
}

export class MessageAccumulator {
  /**
   * @param {(info: {target:string, messageId:string, text:string, payload:object}) => void} onComplete
   * @param {object} [options]
   */
  constructor(onComplete, { graceMs = DEFAULT_GRACE_MS, ttlMs = DEFAULT_TTL_MS, logger } = {}) {
    this.onComplete = onComplete;
    this.graceMs = graceMs;
    this.ttlMs = ttlMs;
    this.log = logger;
    this.buffers = new Map(); // messageId -> { target, deltas:Map<index,string>, finalIndex, timer, updatedAt, payload }
    this.sweeper = setInterval(() => this.#sweep(), 30_000);
    this.sweeper.unref?.();
  }

  /**
   * 1 回分のフラッシュを受け取る。
   * @returns {{ buffering: true } } 常にバッファリング扱いで返し、完成時は onComplete で通知する
   */
  push(target, payload) {
    const messageId = payload?.message_id ?? payload?.turn_id ?? 'unknown';
    const rawIndex = payload?.index;
    const index = Number.isInteger(rawIndex) ? rawIndex : 0;
    if (Number.isInteger(rawIndex) && (index < 0 || index > MAX_DELTA_INDEX)) {
      this.log?.debug(`MessageDisplay: 範囲外の断片 index ${index} を破棄しました (message ${messageId})`);
      return { buffering: true };
    }
    const delta = typeof payload?.delta === 'string' ? payload.delta : '';
    const isFinal = payload?.final === true;

    let buf = this.buffers.get(messageId);
    if (!buf) {
      buf = { target, deltas: new Map(), finalIndex: null, timer: null, updatedAt: Date.now(), payload };
      this.buffers.set(messageId, buf);
    }
    buf.updatedAt = Date.now();
    buf.payload = payload;
    if (delta) buf.deltas.set(index, delta);

    if (isFinal) {
      buf.finalIndex = index;
      // 遅れて届く断片を少しだけ待ってから確定する
      clearTimeout(buf.timer);
      buf.timer = setTimeout(() => this.#complete(messageId), this.graceMs);
    }

    return { buffering: true };
  }

  #complete(messageId) {
    const buf = this.buffers.get(messageId);
    if (!buf) return;
    this.buffers.delete(messageId);
    clearTimeout(buf.timer);

    const indices = [...buf.deltas.keys()].sort((a, b) => a - b);
    if (buf.finalIndex !== null) {
      const missingRanges = getMissingRanges(indices, buf.finalIndex);
      if (missingRanges) {
        this.log?.debug(`MessageDisplay: 断片 ${missingRanges} が届きませんでした (message ${messageId})`);
      }
    }

    const text = indices.map((i) => buf.deltas.get(i)).join('');
    if (!text.trim()) return;

    this.onComplete({ target: buf.target, messageId, text, payload: buf.payload });
  }

  /** final が来ないまま放置されたバッファを捨てる（中断されたターンなど）。 */
  #sweep() {
    const now = Date.now();
    for (const [id, buf] of this.buffers) {
      if (now - buf.updatedAt < this.ttlMs) continue;
      clearTimeout(buf.timer);
      this.buffers.delete(id);
      this.log?.debug(`MessageDisplay: 未完了のバッファを破棄しました (message ${id})`);
    }
  }

  get pending() {
    return this.buffers.size;
  }

  dispose() {
    clearInterval(this.sweeper);
    for (const buf of this.buffers.values()) clearTimeout(buf.timer);
    this.buffers.clear();
  }
}
