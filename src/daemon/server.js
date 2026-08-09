// HTTP サーバー。フック受信 API と管理コンソール（静的 UI + 設定 API）を兼ねる。
// 127.0.0.1 のみで待ち受ける。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS, VOICE_PARAMS, TARGETS, eventsForTarget } from './catalog.js';
import { resolveUtterance } from './events.js';
import { filterText } from './textfilter.js';
import { applyReplacements, syncEngineDictionary, validateEngineWord } from './dictionary.js';
import { CONFIG_PATH } from './config.js';
import { detectEnginePath } from './engine-process.js';
import { MessageAccumulator } from './message-stream.js';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function parseHostname(value) {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * 状態変更リクエスト（GET/HEAD 以外）の受け入れ判定。
 * 外部 Web ページからのドライブバイ操作（CSRF / DNS リバインディング）を副作用の前に拒否する。
 *
 * 経路ごとの扱い:
 *   - ブラウザ（Origin ヘッダーあり）… 自オリジンのみ許可。Origin はブラウザが強制付与するため
 *     攻撃ページには偽装できない。管理 UI の sendBeacon はヘッダーを追加できないので、
 *     この経路はトークンではなく Origin で判定する。
 *   - ブラウザ以外のローカルクライアント（Origin なし）… /api/* は起動ごとのトークンを要求する。
 *     /hook だけはフック定義を変えずに済ませるためトークン不要（JSON の Content-Type は必須）。
 *   - クロスオリジンの application/json はプリフライトが必要になり、CORS 応答を返さないため
 *     ブラウザ側で遮断される。text/plain などの単純リクエストは Content-Type 検証で拒否する。
 *
 * 脅威モデルは「外部 Web ページからの CSRF / DNS リバインディング」。同一ユーザーの
 * ローカルプロセスは対象外とする（トークンも設定ファイルも同じ権限で読めるため、
 * ここで防いでも境界にならない）。
 */
export function checkMutationRequest({ pathname, headers = {}, port, token }) {
  const hostname = parseHostname(headers.host);
  if (!hostname || !LOCAL_HOSTNAMES.has(hostname)) {
    return { ok: false, status: 403, error: 'ローカル以外の Host からの要求は受け付けません' };
  }

  // media type は厳密に比較する（application/jsonp などの JSON 風 MIME を通さない）
  const contentType = headers['content-type'];
  const mediaType = contentType?.split(';')[0].trim().toLowerCase();
  if (contentType !== undefined && mediaType !== 'application/json') {
    return { ok: false, status: 415, error: 'Content-Type は application/json のみ受け付けます' };
  }
  // 本文を読む /hook は Content-Type の省略も認めない（トークン免除の代わりの必須条件）
  if (pathname === '/hook' && contentType === undefined) {
    return { ok: false, status: 415, error: '/hook は Content-Type: application/json が必要です' };
  }

  const origin = headers.origin;
  if (origin !== undefined) {
    let allowed = false;
    try {
      const o = new URL(origin);
      allowed = o.protocol === 'http:'
        && LOCAL_HOSTNAMES.has(o.hostname)
        && String(o.port || 80) === String(port);
    } catch {
      allowed = false;
    }
    if (!allowed) return { ok: false, status: 403, error: '許可されていない Origin からの要求です' };
    return { ok: true };
  }

  if (pathname === '/hook') return { ok: true };
  if (!token || headers['x-voicevox-coding-token'] !== token) {
    return { ok: false, status: 403, error: '認証トークンが一致しません' };
  }
  return { ok: true };
}

export function createServer({ store, engine, queue, log, engineProcess, runtime, commentaryMonitor, onShutdown, port, token }) {
  const sseClients = new Set();

  /** 整形して発話キューに積む。ターゲットの設定に従う。 */
  const speak = (target, eventName, payload) => {
    const profile = store.profile(target);
    const decision = resolveUtterance({
      eventName,
      payload,
      profile,
      dictionary: store.config.dictionary,
    });

    if (runtime?.muted) {
      log.debug(`[${target}] ${eventName}: 一時停止中のため読み上げなし`);
      return { spoken: false, reason: 'muted' };
    }
    if (!decision.speak) {
      log.debug(`[${target}] ${eventName}: 読み上げなし (${decision.reason})`);
      return { spoken: false, reason: decision.reason };
    }

    const result = queue.enqueue({
      target,
      event: eventName,
      text: decision.text,
      speaker: profile.speaker,
      voice: profile.voice,
      queuePolicy: profile.queue,
    });
    log.info(
      `[${target}] ${eventName}: ${result.accepted ? '読み上げ' : `見送り(${result.reason})`}`
        + ` — ${decision.text.slice(0, 60)}`,
    );
    return { spoken: result.accepted, reason: result.reason ?? null, text: decision.text };
  };

  // ストリーミング中のメッセージは断片で届くので、組み立て終わってから読む
  const accumulator = new MessageAccumulator(
    ({ target, text, payload }) => {
      speak(target, 'MessageDisplay', { ...payload, message: text });
    },
    { logger: log },
  );

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {}
    }
  };

  queue.on('update', (state) => broadcast('queue', state));
  store.on('change', (cfg) => broadcast('config', cfg));
  log.subscribe((entry) => broadcast('log', entry));
  commentaryMonitor?.on('commentary', (payload) => speak('codex', 'Commentary', payload));

  const serveStatic = (req, res, pathname) => {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(UI_DIR, rel);
    if (!file.startsWith(UI_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname } = url;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const verdict = checkMutationRequest({ pathname, headers: req.headers, port, token });
      if (!verdict.ok) {
        log.warn(`要求を拒否しました: ${req.method} ${pathname} — ${verdict.error}`);
        json(res, verdict.status, { error: verdict.error });
        return;
      }
    }

    try {
      // --- フック受信 ---
      if (req.method === 'POST' && pathname === '/hook') {
        const body = await readJson(req);
        const target = body.target;
        const payload = body.payload ?? {};
        const eventName = payload.hook_event_name ?? body.event;

        // 途中経過は 1 メッセージにつき何度も届く。組み立てが終わるまでは何もしない。
        if (eventName === 'MessageDisplay') {
          const profile = store.profile(target);
          if (!profile || profile.events?.MessageDisplay?.enabled === false) {
            json(res, 200, { spoken: false, reason: 'event-disabled' });
            return;
          }
          accumulator.push(target, payload);
          json(res, 200, { spoken: false, reason: 'buffering' });
          return;
        }

        json(res, 200, speak(target, eventName, payload));
        return;
      }

      // --- 状態 ---
      if (req.method === 'GET' && pathname === '/api/state') {
        const engineStatus = await engine.status();
        json(res, 200, {
          engine: engineStatus,
          engineProcess: engineProcess?.status ?? { managed: false, pid: null, starting: false },
          queue: queue.state,
          muted: Boolean(runtime?.muted),
          configPath: CONFIG_PATH,
        });
        return;
      }

      // --- 読み上げの一時停止 ---
      if (req.method === 'POST' && pathname === '/api/mute') {
        const body = await readJson(req);
        const next = body.muted === undefined ? !runtime.muted : Boolean(body.muted);
        runtime.muted = next;
        if (next) queue.clear();
        log.info(next ? '読み上げを一時停止しました' : '読み上げを再開しました');
        broadcast('runtime', { muted: next });
        json(res, 200, { muted: next });
        return;
      }

      // --- エンジンのプロセス管理 ---
      if (req.method === 'POST' && pathname === '/api/engine/start') {
        if (!engineProcess) {
          json(res, 501, { error: 'エンジンのプロセス管理が無効です' });
          return;
        }
        const r = await engineProcess.start();
        json(res, r.error ? 503 : 200, r);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/engine/stop') {
        if (!engineProcess) {
          json(res, 501, { error: 'エンジンのプロセス管理が無効です' });
          return;
        }
        json(res, 200, await engineProcess.stop());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/engine/detect') {
        const detected = await detectEnginePath();
        if (detected) store.patch({ engine: { enginePath: detected } });
        json(res, 200, { enginePath: detected });
        return;
      }

      // --- デーモンの終了（トレイの「終了」から呼ばれる） ---
      if (req.method === 'POST' && pathname === '/api/shutdown') {
        json(res, 200, { ok: true });
        log.info('終了要求を受け取りました');
        setTimeout(() => onShutdown?.(), 100);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/catalog') {
        json(res, 200, {
          targets: Object.values(TARGETS).map((t) => ({
            ...t,
            events: eventsForTarget(t.id).map((e) => ({
              name: e.name,
              label: e.label,
              description: e.description,
              supportsFullText: e.supportsFullText,
              placeholders: e.placeholders,
            })),
          })),
          voiceParams: VOICE_PARAMS,
          allEvents: EVENTS.map((e) => ({ name: e.name, label: e.label })),
        });
        return;
      }

      // --- 設定 ---
      if (req.method === 'GET' && pathname === '/api/config') {
        json(res, 200, store.config);
        return;
      }

      if ((req.method === 'PUT' || req.method === 'POST') && pathname === '/api/config') {
        const body = await readJson(req);
        const next = req.method === 'PUT' ? store.save(body) : store.patch(body);
        log.info('設定を更新しました');
        json(res, 200, next);
        return;
      }

      // --- 話者一覧 ---
      if (req.method === 'GET' && pathname === '/api/speakers') {
        try {
          json(res, 200, { speakers: await engine.speakers() });
        } catch (err) {
          json(res, 503, { error: err.message, speakers: [] });
        }
        return;
      }

      // --- 整形プレビュー（合成せずにテキストだけ確認する） ---
      if (req.method === 'POST' && pathname === '/api/filter-preview') {
        const { target, text } = await readJson(req);
        const profile = store.profile(target);
        if (!profile) {
          json(res, 400, { error: 'unknown target' });
          return;
        }
        const filtered = filterText(text ?? '', profile.textFilter);
        const spoken = applyReplacements(filtered.text, store.config.dictionary?.replacements ?? []);
        json(res, 200, { text: spoken, truncated: filtered.truncated, chars: spoken.length });
        return;
      }

      // --- 試聴 ---
      if (req.method === 'POST' && pathname === '/api/preview') {
        const { target, text, raw } = await readJson(req);
        const profile = store.profile(target);
        if (!profile) {
          json(res, 400, { error: 'unknown target' });
          return;
        }
        let spoken = text ?? '';
        if (!raw) {
          const filtered = filterText(spoken, profile.textFilter);
          spoken = applyReplacements(filtered.text, store.config.dictionary?.replacements ?? []);
        }
        if (!spoken.trim()) {
          json(res, 200, { spoken: false, reason: 'empty' });
          return;
        }
        const result = queue.enqueue({
          target,
          event: 'Preview',
          text: spoken,
          speaker: profile.speaker,
          voice: profile.voice,
          queuePolicy: { ...profile.queue, dedupeWindowSec: 0 },
        });
        json(res, 200, { spoken: result.accepted, reason: result.reason ?? null, text: spoken });
        return;
      }

      // --- 再生制御 ---
      if (req.method === 'POST' && pathname === '/api/skip') {
        queue.skip();
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/clear') {
        queue.clear();
        json(res, 200, { ok: true });
        return;
      }

      // --- 辞書 ---
      if (req.method === 'POST' && pathname === '/api/dictionary/validate') {
        const { words } = await readJson(req);
        const results = (words ?? []).map((w) => ({ surface: w?.surface, errors: validateEngineWord(w) }));
        json(res, 200, { results });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/dictionary/sync') {
        try {
          const result = await syncEngineDictionary(engine, store.config.dictionary?.engineWords ?? []);
          log.info(`ユーザー辞書を同期しました: 追加${result.added} 更新${result.updated} 削除${result.removed}`);
          for (const f of result.failed) log.warn(`ユーザー辞書「${f.surface}」: ${f.errors.join(' / ')}`);
          json(res, 200, result);
        } catch (err) {
          // トーストは消えてしまうので、後から原因を追えるようログにも残す
          log.warn(`ユーザー辞書の同期に失敗しました: ${err.message}`);
          json(res, 503, { error: err.message });
        }
        return;
      }

      // --- ログ ---
      if (req.method === 'GET' && pathname === '/api/logs') {
        json(res, 200, { lines: log.recent(Number(url.searchParams.get('limit') ?? 200)) });
        return;
      }

      // --- SSE ---
      if (req.method === 'GET' && pathname === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {}
        }, 20000);
        req.on('close', () => {
          clearInterval(keepAlive);
          sseClients.delete(res);
        });
        return;
      }

      if (req.method === 'GET') {
        serveStatic(req, res, pathname);
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error(`API エラー ${req.method} ${pathname}: ${err.message}`);
      json(res, 500, { error: err.message });
    }
  });

  return server;
}
