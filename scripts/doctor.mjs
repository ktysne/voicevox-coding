#!/usr/bin/env node
// 導入状態の点検。どこで詰まっているかを切り分けるためのスクリプト。
//   node scripts/doctor.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.voicevox-coding', 'config.json');
const HOOK_CLIENT = path.join(HOME, '.voicevox-coding', 'hook-client.js');
const MANIFEST_PATH = path.join(HOME, '.voicevox-coding', 'install.json');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const CODEX_HOOKS = path.join(CODEX_HOME, 'hooks.json');

const results = [];
const ok = (name, detail) => results.push({ level: 'ok', name, detail });
const warn = (name, detail) => results.push({ level: 'warn', name, detail });
const fail = (name, detail) => results.push({ level: 'fail', name, detail });

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function checkEngine(baseUrl) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const res = await fetch(`${baseUrl}/version`, { signal: ac.signal });
    clearTimeout(t);
    const v = String(await res.json()).replace(/"/g, '');
    ok('VOICEVOX ENGINE', `${baseUrl} に接続 (version ${v})`);
    return true;
  } catch {
    fail('VOICEVOX ENGINE', `${baseUrl} に接続できません。VOICEVOX を起動してください`);
    return false;
  }
}

async function checkDaemon(port) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: ac.signal });
    clearTimeout(t);
    const s = await res.json();
    ok('デーモン', `127.0.0.1:${port} で稼働中${s.queue?.current ? '（読み上げ中）' : ''}`);
    return true;
  } catch {
    fail('デーモン', `127.0.0.1:${port} が応答しません。node src/daemon/main.js で起動してください`);
    return false;
  }
}

function countOurHooks(root) {
  const events = [];
  for (const [ev, groups] of Object.entries(root?.hooks ?? {})) {
    for (const g of groups ?? []) {
      for (const hk of g?.hooks ?? []) {
        const command = String(hk?.command ?? '');
        if (command.includes('hook-client.js')) {
          events.push({ ev, command, async: hk.async === true, timeout: hk.timeout });
        }
      }
    }
  }
  return events;
}

const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** パス比較用に区切り文字・末尾の区切りをそろえる。 */
export function normalizePathForComparison(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;

  const raw = value.trim();
  const windows = process.platform === 'win32' || WINDOWS_ABSOLUTE_PATH.test(raw);
  const normalized = (windows ? path.win32 : path.posix).normalize(raw);
  // ルート（C:\\ や /）の区切りは残す。
  if (normalized.length > 1 && !/^[A-Za-z]:[\\/]$/.test(normalized)) {
    return normalized.replace(/[\\/]$/, '');
  }
  return normalized;
}

/** doctor と app-server が同じ CODEX_HOME を見ているかを比較する。 */
export function codexHomeMatches(expected, actual) {
  const expectedPath = normalizePathForComparison(expected);
  const actualPath = normalizePathForComparison(actual);
  if (!expectedPath || !actualPath) return false;

  const caseInsensitive = process.platform === 'win32'
    || WINDOWS_ABSOLUTE_PATH.test(expectedPath)
    || WINDOWS_ABSOLUTE_PATH.test(actualPath);
  return caseInsensitive
    ? expectedPath.toLowerCase() === actualPath.toLowerCase()
    : expectedPath === actualPath;
}

/** initialize 応答から app-server が実際に使う CODEX_HOME を取り出す。 */
export function parseCodexInitializeResult(message) {
  const codexHome = message?.result?.codexHome;
  return typeof codexHome === 'string' && codexHome.trim() !== '' ? codexHome : null;
}

/**
 * install.json（導入時の期待構成）と現状の手がかりから、Claude Code / Codex それぞれの
 * 点検方針を決める純関数。
 *
 *   - manifest があれば、対応する skip キー（'skipClaude' | 'skipCodex'）だけで決まる。
 *     true なら 'skip'（導入時に対象外にした＝検査そのものを省略し、中立表示にする）、
 *     false なら 'check'（通常どおり検査する）。
 *   - manifest が無い（install.json 保存に対応する前の旧導入）場合は 'check' が既定。
 *     ただし migrateWhenMissing を立てた対象（Codex）に限り、フックも CLI も
 *     見当たらないなら「そもそも導入していない」とみなして 'warn-uninstalled' にする
 *     （フックが無いだけで fail 扱いにすると、使うつもりがない対象にまで
 *     エラーが出てしまうため）。
 *
 * @param {object|null} manifest install.json の中身（無ければ null）
 * @param {object} opts
 * @param {'skipClaude'|'skipCodex'} opts.skipKey manifest 内でこの対象を指すキー
 * @param {boolean} opts.hooksExist 対象の設定ファイルが存在するか
 * @param {boolean} [opts.cliAvailable] CLI が PATH にあるか（Codex の移行判定にのみ使う）
 * @param {boolean} [opts.migrateWhenMissing] manifest が無いときに未導入への移行判定を行うか
 * @returns {{ mode: 'skip' | 'check' | 'warn-uninstalled' }}
 */
/**
 * install.json の中身を検証して返す。形式が不正なら null（manifest なしとして扱う）。
 * "false" のような文字列の bool は truthy に化けて検査や登録を誤って省略するため、
 * schemaVersion が整数であることと、各オプションが本物の boolean であることを確かめる。
 */
export function normalizeInstallManifest(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!Number.isInteger(obj.schemaVersion) || obj.schemaVersion < 1) return null;
  for (const key of ['includeToolEvents', 'skipClaude', 'skipCodex', 'registerStartup']) {
    if (key in obj && typeof obj[key] !== 'boolean') return null;
  }
  return obj;
}

export function resolveTargetPlan(manifest, opts = {}) {
  const { skipKey, hooksExist, cliAvailable, migrateWhenMissing = false } = opts;

  if (manifest) {
    return manifest[skipKey] ? { mode: 'skip' } : { mode: 'check' };
  }
  if (migrateWhenMissing && !hooksExist && cliAvailable !== true) {
    return { mode: 'warn-uninstalled' };
  }
  return { mode: 'check' };
}

/**
 * 導入時に -IncludeToolEvents を指定した（＝ manifest.includeToolEvents が true の）のに、
 * PreToolUse / PostToolUse が実際には登録されていない場合、その不足イベント名を返す。
 * 期待していない場合（manifest が無い、または includeToolEvents が false）は常に空配列。
 *
 * @param {object|null} manifest install.json の中身
 * @param {{ ev: string }[]} ourEvents countOurHooks() が返す、登録済みイベントの一覧
 */
export function missingToolEvents(manifest, ourEvents) {
  if (!manifest?.includeToolEvents) return [];
  const have = new Set((ourEvents ?? []).map((o) => o.ev));
  return ['PreToolUse', 'PostToolUse'].filter((ev) => !have.has(ev));
}

/**
 * codex CLI が PATH 上にあるかを確かめる（where.exe codex 相当）。
 * install.json が無い旧導入で、Codex を使うつもりがあるのかを見分けるための軽い判定に使う。
 * codexHooksList() と違い app-server を起動しないので、ほぼ即座に返る。
 */
function isCodexCliAvailable() {
  try {
    const r = spawnSync('where.exe', ['codex'], { windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Codex の app-server に hooks/list を投げて、実際に読み込まれているかと信頼状態を見る。 */
function codexHooksList() {
  return new Promise((resolve) => {
    try {
    // Windows の codex は .cmd ラッパ。Node 24 は .cmd を直接 spawn できず、
    // shell: true は引数をエスケープしないため、cmd.exe を明示的に噛ませる。
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'codex', 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let codexHome = null;
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 20000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        if (!line.includes('"id":1') && !line.includes('"id":2')) continue;
        try {
          const j = JSON.parse(line);
          if (j.id === 1) {
            codexHome = parseCodexInitializeResult(j);
            continue;
          }
          if (j.id !== 2) continue;
          clearTimeout(timer);
          child.kill();
          const listed = j.result?.data?.[0] ?? null;
          resolve(listed ? { ...listed, codexHome } : null);
          return;
        } catch {}
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'voicevox-coding-doctor', title: 'doctor', version: '0.1.0' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    setTimeout(() => {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: {} })}\n`);
      } catch {
        resolve(null);
      }
    }, 1200);
    } catch {
      resolve(null);
    }
  });
}

async function main() {
  console.log('\nVOICEVOX Coding — 導入状態の点検');
  console.log('='.repeat(56));

  // --- 設定 ---
  const config = readJson(CONFIG_PATH);
  if (config) ok('設定ファイル', CONFIG_PATH);
  else warn('設定ファイル', `${CONFIG_PATH} がありません（デーモン初回起動時に作られます）`);

  // --- 導入構成（install.ps1 が保存した期待構成） ---
  const rawManifest = readJson(MANIFEST_PATH);
  const manifest = normalizeInstallManifest(rawManifest);
  if (manifest) ok('導入構成', `${MANIFEST_PATH} を期待構成として使用します`);
  else if (rawManifest) warn('導入構成', `${MANIFEST_PATH} の形式が不正なため無視します（scripts\\install.ps1 の再実行で作り直せます）`);

  const port = config?.daemon?.port ?? 7591;
  const baseUrl = config?.engine?.baseUrl ?? 'http://127.0.0.1:50021';

  // --- フッククライアント ---
  if (fs.existsSync(HOOK_CLIENT)) ok('フッククライアント', HOOK_CLIENT);
  else fail('フッククライアント', `${HOOK_CLIENT} がありません。scripts\\install.ps1 を実行してください`);

  // --- エンジン・デーモン ---
  const engineUp = await checkEngine(baseUrl);
  const daemonUp = await checkDaemon(port);

  if (daemonUp) {
    try {
      const s = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
      if (s.engineProcess?.managed) ok('エンジンのプロセス', `このデーモンが起動 (PID ${s.engineProcess.pid})`);
      else if (engineUp) warn('エンジンのプロセス', '別プロセス（VOICEVOX アプリなど）が起動しています。デーモンからは停止できません');
      if (s.muted) warn('読み上げ', '一時停止中です。トレイまたはコンソールから再開してください');
    } catch {}
  }

  // --- 常駐 ---
  const startupVbs = path.join(
    process.env.APPDATA ?? '',
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'VOICEVOX Coding.vbs',
  );
  if (fs.existsSync(startupVbs)) ok('スタートアップ', 'サインイン時に自動起動します');
  else warn('スタートアップ', '未登録です。scripts\\install.ps1 -RegisterStartup で登録できます');

  if (config?.daemon?.tray === false) warn('タスクトレイ', '設定で無効になっています');
  else if (daemonUp) ok('タスクトレイ', '常駐が有効です');

  // --- Claude Code ---
  const claude = readJson(CLAUDE_SETTINGS);
  const claudeOurs = claude ? countOurHooks(claude) : [];
  const claudePlan = resolveTargetPlan(manifest, { skipKey: 'skipClaude', hooksExist: fs.existsSync(CLAUDE_SETTINGS) });

  if (claudePlan.mode === 'skip') {
    ok('Claude Code', '対象外（導入時に -SkipClaude を指定）');
    // 対象外なのにフックが残っていると読み上げが動き続ける。盲点にしない
    if (claudeOurs.length > 0) {
      warn('Claude Code', `対象外の設定ですがフックが ${claudeOurs.length} 件残っています。解除するには scripts\\uninstall.ps1 を実行してください`);
    }
  } else if (!claude) {
    warn('Claude Code', `${CLAUDE_SETTINGS} を読めません`);
  } else {
    const others = Object.entries(claude.hooks ?? {}).length;
    if (claudeOurs.length === 0) fail('Claude Code', 'フックが登録されていません。scripts\\install.ps1 を実行してください');
    else ok('Claude Code', `${claudeOurs.length} イベント登録済み: ${claudeOurs.map((o) => o.ev).join(', ')}（他 ${others} 種のイベントキーと共存）`);

    const missing = missingToolEvents(manifest, claudeOurs);
    if (missing.length > 0) {
      fail(
        'Claude Code (ツールイベント)',
        `導入時に -IncludeToolEvents を指定していますが登録されていません: ${missing.join(', ')}。scripts\\install.ps1 を実行し直してください`,
      );
    }
  }

  // --- Codex ---
  // manifest が無い（旧導入）場合の「未導入かどうか」の判定は、hooks.json が無いときに
  // 限って CLI の有無を確認する。フックが既にあるなら、CLI 探索をするまでもなく検査対象。
  const codexRoot = readJson(CODEX_HOOKS);
  const codexOurs = codexRoot ? countOurHooks(codexRoot) : [];
  const codexHooksFileExists = fs.existsSync(CODEX_HOOKS);
  const codexCliAvailable = (!manifest && !codexHooksFileExists) ? isCodexCliAvailable() : undefined;
  const codexPlan = resolveTargetPlan(manifest, {
    skipKey: 'skipCodex',
    hooksExist: codexHooksFileExists,
    cliAvailable: codexCliAvailable,
    migrateWhenMissing: true,
  });

  if (codexPlan.mode === 'skip') {
    ok('Codex', '対象外（導入時に -SkipCodex を指定）');
    if (codexOurs.length > 0) {
      warn('Codex', `対象外の設定ですがフックが ${codexOurs.length} 件残っています。解除するには scripts\\uninstall.ps1 を実行してください`);
    }
  } else if (codexPlan.mode === 'warn-uninstalled') {
    warn('Codex', '未導入のようです（使う場合は scripts\\install.ps1 を実行してください）');
  } else if (!codexRoot) {
    fail('Codex', `${CODEX_HOOKS} がありません。scripts\\install.ps1 を実行してください`);
  } else {
    const asyncOnes = codexOurs.filter((o) => o.async);
    if (codexOurs.length === 0) fail('Codex', 'フックが登録されていません');
    else ok('Codex', `${codexOurs.length} イベント登録済み: ${codexOurs.map((o) => o.ev).join(', ')}`);
    if (asyncOnes.length > 0) {
      fail('Codex (async)', `async: true のフックは Codex に無視されます: ${asyncOnes.map((o) => o.ev).join(', ')}`);
    }
    // Codex は command 先頭の実行ファイルを引用符付きで書くと解決に失敗する。
    // エラーにならず「Failed」とだけ出るので、静かに壊れる。
    const quoted = codexOurs.filter((o) => o.command.trimStart().startsWith('"'));
    if (quoted.length > 0) {
      fail(
        'Codex (引用符)',
        `command の先頭が引用符で始まっています（${quoted.map((o) => o.ev).join(', ')}）。` +
          'Codex では実行ファイルを引用できません。scripts\\install.ps1 を実行し直してください',
      );
    }

    const missing = missingToolEvents(manifest, codexOurs);
    if (missing.length > 0) {
      fail(
        'Codex (ツールイベント)',
        `導入時に -IncludeToolEvents を指定していますが登録されていません: ${missing.join(', ')}。scripts\\install.ps1 を実行し直してください`,
      );
    }
  }

  // --- Codex の読み込み・信頼状態 ---
  // 対象外（skip）・未導入と推定（warn-uninstalled）の場合は、app-server への問い合わせ
  // （最大 20 秒）も含めて Codex 関連の検査を一切行わない。
  if (codexPlan.mode === 'check') {
    console.log('\n  Codex に問い合わせています…');
    const listed = await codexHooksList().catch(() => null);
    if (!listed) {
      warn('Codex 信頼状態', 'codex app-server から取得できませんでした（codex が PATH にあるか確認してください）');
    } else {
      for (const w of listed.warnings ?? []) warn('Codex 警告', w);
      for (const e of listed.errors ?? []) fail('Codex エラー', String(e));
      if (listed.codexHome && !codexHomeMatches(CODEX_HOME, listed.codexHome)) {
        warn(
          'Codex 信頼状態',
          `app-server の CODEX_HOME (${listed.codexHome}) が doctor の期待値 (${CODEX_HOME}) と異なるため、判定不能（通常PowerShellで実行）`,
        );
      } else {
        const mine = (listed.hooks ?? []).filter((h) => String(h.command).includes('hook-client.js'));
        if (mine.length === 0) {
          fail('Codex 読み込み', 'フックが 1 件も読み込まれていません');
        } else {
          const untrusted = mine.filter((h) => h.trustStatus !== 'trusted');
          if (untrusted.length > 0) {
            const states = [...new Set(untrusted.map((h) => h.trustStatus))].join('/');
            warn(
              'Codex 信頼状態',
              `${untrusted.length}/${mine.length} 件が未承認です (${states})。codex を起動して /hooks から承認してください`,
            );
          } else {
            ok('Codex 信頼状態', `${mine.length} 件すべて承認済み`);
          }
          // /hooks で個別にオフにされたものは、承認済みでも実行されない
          const disabled = mine.filter((h) => h.enabled === false);
          if (disabled.length > 0) {
            warn('Codex 無効化', `${disabled.map((h) => h.eventName).join(', ')} が /hooks でオフになっています`);
          }
        }
      }
    }
  }

  // --- 出力 ---
  console.log('');
  const icon = { ok: '  OK  ', warn: ' 警告 ', fail: ' NG   ' };
  for (const r of results) {
    console.log(`${icon[r.level]}${r.name.padEnd(20, ' ')} ${r.detail}`);
  }

  const failed = results.filter((r) => r.level === 'fail').length;
  console.log('');
  console.log(failed === 0 ? '  問題は見つかりませんでした。' : `  ${failed} 件の問題があります。`);
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
