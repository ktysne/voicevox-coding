// 設定の読み込み・保存・既定値マージ。
// 保存先は %USERPROFILE%\.voicevox-coding\config.json。
// ファイルを直接編集した場合もウォッチャーが拾って即座に反映する。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { EVENTS, eventsForTarget, VOICE_PARAMS } from './catalog.js';

export const CONFIG_DIR = path.join(os.homedir(), '.voicevox-coding');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const CACHE_DIR = path.join(CONFIG_DIR, 'cache');
export const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');

function defaultVoice() {
  const v = {};
  for (const p of VOICE_PARAMS) v[p.key] = p.default;
  return v;
}

function defaultEvents(target) {
  const out = {};
  for (const e of eventsForTarget(target)) {
    out[e.name] = { ...e.defaults };
  }
  return out;
}

function defaultTextFilter() {
  return {
    // コードブロック: read（読む） / placeholder（定型語に置換） / omit（削除）
    codeBlock: 'placeholder',
    codeBlockPlaceholder: 'コードは省略',
    // インラインコード: read / strip（記号だけ外す） / omit
    inlineCode: 'strip',
    // URL: read / placeholder / omit
    url: 'placeholder',
    urlPlaceholder: 'リンク',
    // ファイルパス: read / basename（ファイル名だけ） / omit
    filePath: 'basename',
    // 表: read / omit
    table: 'omit',
    // 以下は true で除去
    markdownSymbols: true,
    listMarkers: true,
    headings: false, // true にすると見出し行ごと削除
    emoji: true,
    thinkingBlocks: true,
    htmlTags: true,
    // 長さ制限。0 は無制限（全文読み上げ）
    maxChars: 0,
    maxSentences: 0,
    truncationSuffix: '以下省略',
    // 空白・改行の正規化
    collapseWhitespace: true,
  };
}

function defaultProfile(target) {
  return {
    enabled: true,
    speaker: 3, // 3 = ずんだもん（ノーマル）
    voice: defaultVoice(),
    events: defaultEvents(target),
    toolFilter: {
      mode: 'all', // all / allowlist / denylist
      allow: [],
      deny: [],
    },
    textFilter: defaultTextFilter(),
    // 読み上げない本文の正規表現。整形前の本文がどれかに部分一致したら発話ごと飛ばす。
    // 既定は空（今までどおり全部読む）。
    ignorePatterns: [],
    queue: {
      // 新しい発話が来たときの挙動: enqueue（並べる） / replace（現在の発話を止めて差し替え） / drop（無視）
      // 途中経過を読み上げる場合、replace だと次の説明文が来るたびに前が切れるので enqueue が既定。
      policy: 'enqueue',
      maxQueue: 5,
      // 同一テキストの連続再生を抑止する秒数。
      // 途中経過の最後のまとまりと Stop の本文は同じ内容になるため、ここで二重読みを防ぐ。
      dedupeWindowSec: 10,
    },
  };
}

export function defaultConfig() {
  return {
    version: 1,
    engine: {
      baseUrl: 'http://127.0.0.1:50021',
      // VOICEVOX アプリ（GUI）を常駐させずに、同梱のエンジンだけを起動するためのパス。
      // 空にしておくと起動時に自動検出する。
      // 例: F:\\VOICEVOX\\vv-engine\\run.exe
      enginePath: '',
      autoStart: true,
      // デーモン終了時に、自分で起動したエンジンも止める
      stopOnExit: true,
      // 落ちていたら起動し直す間隔（秒）。0 で無効
      healthCheckSec: 60,
      // エンジンが応答するまでの待ち時間。初回はモデル読み込みで長くかかる
      startTimeoutSec: 90,
      useGpu: false,
      loadAllModels: false,
      cpuNumThreads: 0, // 0 でエンジンの既定に任せる
      timeoutSec: 120,
    },
    daemon: {
      port: 7591,
      logLevel: 'info', // debug / info / warn / error
      cacheEnabled: true,
      cacheMaxEntries: 300,
      // タスクトレイに常駐する
      tray: true,
    },
    dictionary: {
      // 合成前のテキスト置換。両ターゲット共通。
      replacements: [
        { pattern: 'Codex', replacement: 'コーデックス', regex: false, enabled: true },
        { pattern: 'Claude Code', replacement: 'クロードコード', regex: false, enabled: true },
        { pattern: '->', replacement: 'から', regex: false, enabled: true },
        { pattern: '→', replacement: 'から', regex: false, enabled: true },
      ],
      // VOICEVOX ENGINE のユーザー辞書に登録する単語。アクセント込みで矯正できる。
      engineWords: [],
      syncEngineDict: true,
    },
    targets: {
      claudeCode: defaultProfile('claudeCode'),
      codex: defaultProfile('codex'),
    },
  };
}

/** プレーンオブジェクトのみ深くマージする（配列は置き換え）。 */
function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * ターゲットごとの設定を正規化する。
 * カタログに存在しないイベント名を落として新設イベントには既定値を補い、
 * 手編集で型が崩れうる項目を直す。カタログの更新や手編集で既存の config.json が
 * 壊れないようにするための処理。
 */
function reconcileProfiles(config) {
  for (const target of Object.keys(config.targets ?? {})) {
    const profile = config.targets[target];
    if (!profile || typeof profile !== 'object') continue;
    const valid = eventsForTarget(target);
    const next = {};
    for (const e of valid) {
      next[e.name] = { ...e.defaults, ...(profile.events?.[e.name] ?? {}) };
    }
    profile.events = next;
    // 無視パターンは文字列の配列。手編集でオブジェクトや数値が入っても読み上げ側を壊さない
    profile.ignorePatterns = Array.isArray(profile.ignorePatterns)
      ? profile.ignorePatterns.filter((p) => typeof p === 'string')
      : [];
  }
  return config;
}

export class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this.config = defaultConfig();
    this.watcher = null;
    this.suppressWatchUntil = 0;
  }

  load() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    let stored = {};
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      } catch (err) {
        // 壊れた設定で起動不能にはしない。退避して既定値で立ち上げる。
        const backup = `${CONFIG_PATH}.broken-${Date.now()}`;
        try {
          fs.renameSync(CONFIG_PATH, backup);
        } catch {}
        this.emit('error', new Error(`設定ファイルを読めませんでした。${backup} に退避しました: ${err.message}`));
        stored = {};
      }
    }
    this.config = reconcileProfiles(deepMerge(defaultConfig(), stored));
    if (!fs.existsSync(CONFIG_PATH)) this.save();
    return this.config;
  }

  save(next = this.config) {
    this.config = reconcileProfiles(deepMerge(defaultConfig(), next));
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // 自分の書き込みでウォッチャーが発火してループしないよう短時間抑止する
    this.suppressWatchUntil = Date.now() + 500;
    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
    this.emit('change', this.config);
    return this.config;
  }

  /** パッチを深くマージして保存する。 */
  patch(partial) {
    return this.save(deepMerge(this.config, partial));
  }

  watch() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(CONFIG_DIR, (_event, filename) => {
        if (filename !== 'config.json') return;
        if (Date.now() < this.suppressWatchUntil) return;
        // エディタの書き込みが完了するまで少し待つ
        clearTimeout(this._reloadTimer);
        this._reloadTimer = setTimeout(() => {
          try {
            const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            this.config = reconcileProfiles(deepMerge(defaultConfig(), stored));
            this.emit('change', this.config);
            this.emit('externalChange', this.config);
          } catch {
            // 編集途中の不正な JSON は無視して次の変更を待つ
          }
        }, 150);
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  close() {
    this.watcher?.close();
    this.watcher = null;
  }

  profile(target) {
    return this.config.targets?.[target] ?? null;
  }
}

export { EVENTS };
