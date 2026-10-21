// VOICEVOX ENGINE の REST クライアント。
import { MAX_WAV_DURATION_MS, parseWav } from './player.js';

const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_WAV_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 4 * 1024;

export class EngineError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.cause = cause;
  }
}

function responseTooLarge(pathname, method, maxBytes) {
  return new EngineError(`ENGINE ${method} ${pathname} の応答サイズが上限の ${maxBytes} バイトを超えています`);
}

function contentLength(res) {
  const value = res.headers?.get?.('content-length')
    ?? res.headers?.['content-length']
    ?? res.headers?.['Content-Length'];
  const length = Number(value);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

// truncate のときは上限で読むのをやめて先頭だけを返す。エラー応答の本文はメッセージに添えるだけなので、
// 長くても応答のステータスを失わないようにする。
async function readResponseBytes(res, { pathname, method, maxBytes, abortController, raw, truncate = false }) {
  if (!truncate && contentLength(res) > maxBytes) {
    abortController.abort();
    throw responseTooLarge(pathname, method, maxBytes);
  }

  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (totalBytes + chunk.length > maxBytes) {
          reader.cancel().catch(() => {});
          abortController.abort();
          if (!truncate) throw responseTooLarge(pathname, method, maxBytes);
          chunks.push(chunk.subarray(0, maxBytes - totalBytes));
          totalBytes = maxBytes;
          break;
        }
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, totalBytes);
  }

  const bytes = raw
    ? Buffer.from(await res.arrayBuffer())
    : Buffer.from(await res.text(), 'utf8');
  if (bytes.length <= maxBytes) return bytes;
  if (truncate) return bytes.subarray(0, maxBytes);
  throw responseTooLarge(pathname, method, maxBytes);
}

export class VoicevoxEngine {
  constructor(getEngineConfig) {
    this.getEngineConfig = getEngineConfig;
  }

  get baseUrl() {
    return (this.getEngineConfig().baseUrl || 'http://127.0.0.1:50021').replace(/\/+$/, '');
  }

  get timeoutMs() {
    return (this.getEngineConfig().timeoutSec || 120) * 1000;
  }

  async #fetch(pathname, { method = 'GET', body, headers, timeoutMs, raw = false } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        body,
        headers,
        signal: ac.signal,
      });
      if (!res.ok) {
        // 本文は添えるだけなので、読めなくても status を保った EngineError にする(辞書同期が status で拒否を判定する)
        const detail = await readResponseBytes(res, {
          pathname,
          method,
          maxBytes: MAX_ERROR_RESPONSE_BYTES,
          abortController: ac,
          raw: false,
          truncate: true,
        }).then((bytes) => bytes.toString('utf8'), () => '');
        throw new EngineError(`ENGINE ${method} ${pathname} が ${res.status} を返しました: ${detail.slice(0, 300)}`, {
          status: res.status,
        });
      }
      const responseBytes = await readResponseBytes(res, {
        pathname,
        method,
        maxBytes: raw ? MAX_WAV_RESPONSE_BYTES : MAX_JSON_RESPONSE_BYTES,
        abortController: ac,
        raw,
      });
      return raw ? responseBytes : JSON.parse(responseBytes.toString('utf8'));
    } catch (err) {
      if (err instanceof EngineError) throw err;
      if (err.name === 'AbortError') throw new EngineError(`ENGINE ${pathname} がタイムアウトしました`);
      throw new EngineError(`ENGINE に接続できません (${this.baseUrl}): ${err.message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async version() {
    return this.#fetch('/version', { timeoutMs: 3000 });
  }

  async status() {
    try {
      const version = await this.version();
      return { available: true, version: String(version).replace(/"/g, ''), baseUrl: this.baseUrl };
    } catch (err) {
      return { available: false, error: err.message, baseUrl: this.baseUrl };
    }
  }

  /** 話者一覧。UI のプルダウン用に style を平坦化して返す。 */
  async speakers() {
    const list = await this.#fetch('/speakers', { timeoutMs: 10000 });
    return list.map((s) => ({
      name: s.name,
      uuid: s.speaker_uuid,
      styles: (s.styles ?? []).map((st) => ({ id: st.id, name: st.name, type: st.type ?? 'talk' })),
    }));
  }

  /** 音声合成用クエリを生成し、パラメータを上書きして返す。 */
  async audioQuery(text, speaker, voiceParams = {}) {
    const q = await this.#fetch(`/audio_query?speaker=${encodeURIComponent(speaker)}&text=${encodeURIComponent(text)}`, {
      method: 'POST',
      timeoutMs: 30000,
    });
    // voiceParams のキーは ENGINE のクエリのフィールド名と同じ（catalog.js の VOICE_PARAMS）ため、
    // 名前の対応表は要らずそのまま代入できる。
    // 応答に無いフィールドは、その ENGINE が解釈できないフィールドなので送らない
    // （/audio_query と /synthesis のクエリは同じ形）。未知フィールドを無視してくれる
    // かどうかを ENGINE 側の寛容さに頼らずに済み、パラメータを増やしても
    // 古い ENGINE で合成が 422 になったりしない。
    for (const [k, v] of Object.entries(voiceParams)) {
      if (!Object.hasOwn(q, k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) q[k] = v;
    }
    return q;
  }

  /** wav バイナリを返す。 */
  async synthesis(query, speaker) {
    // Depth 制限のある実装で壊れるネストなので、そのまま JSON 化して渡す
    const body = Buffer.from(JSON.stringify(query), 'utf8');
    const pathname = `/synthesis?speaker=${encodeURIComponent(speaker)}`;
    const wav = await this.#fetch(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      raw: true,
    });
    if (!parseWav(wav)) {
      const tooLong = parseWav(wav, { maxDurationMs: Infinity });
      throw new EngineError(tooLong
        ? `ENGINE が返した WAV の再生時間 (${tooLong.durationMs} ms) が上限の ${MAX_WAV_DURATION_MS} ms を超えています (${pathname})`
        : `ENGINE が不正な WAV を返しました (${pathname})`);
    }
    return wav;
  }

  async synthesize(text, speaker, voiceParams) {
    const query = await this.audioQuery(text, speaker, voiceParams);
    const wav = await this.synthesis(query, speaker);
    return { wav, query };
  }

  // --- ユーザー辞書 ---

  async userDict() {
    return this.#fetch('/user_dict', { timeoutMs: 10000 });
  }

  async addUserDictWord({ surface, pronunciation, accentType = 0, wordType = 'PROPER_NOUN', priority = 8 }) {
    const params = new URLSearchParams({
      surface,
      pronunciation,
      accent_type: String(accentType),
      word_type: wordType,
      priority: String(priority),
    });
    const uuid = await this.#fetch(`/user_dict_word?${params}`, { method: 'POST', timeoutMs: 10000 });
    return String(uuid).replace(/"/g, '');
  }

  async updateUserDictWord(uuid, { surface, pronunciation, accentType = 0, wordType = 'PROPER_NOUN', priority = 8 }) {
    const params = new URLSearchParams({
      surface,
      pronunciation,
      accent_type: String(accentType),
      word_type: wordType,
      priority: String(priority),
    });
    await this.#fetch(`/user_dict_word/${encodeURIComponent(uuid)}?${params}`, { method: 'PUT', timeoutMs: 10000 });
  }

  async deleteUserDictWord(uuid) {
    await this.#fetch(`/user_dict_word/${encodeURIComponent(uuid)}`, { method: 'DELETE', timeoutMs: 10000 });
  }
}
