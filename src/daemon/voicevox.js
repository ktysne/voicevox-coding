// VOICEVOX ENGINE の REST クライアント。

export class EngineError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.cause = cause;
  }
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
        const detail = await res.text().catch(() => '');
        throw new EngineError(`ENGINE ${method} ${pathname} が ${res.status} を返しました: ${detail.slice(0, 300)}`, {
          status: res.status,
        });
      }
      return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
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
      if (!(k in q)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) q[k] = v;
    }
    return q;
  }

  /** wav バイナリを返す。 */
  async synthesis(query, speaker) {
    // Depth 制限のある実装で壊れるネストなので、そのまま JSON 化して渡す
    const body = Buffer.from(JSON.stringify(query), 'utf8');
    return this.#fetch(`/synthesis?speaker=${encodeURIComponent(speaker)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      raw: true,
    });
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
