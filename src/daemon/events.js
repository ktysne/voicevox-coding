// フックのペイロードを「読み上げるテキスト」に変換する。
// ここが「何を読む / 読まない」の判断の中心。

import vm from 'node:vm';
import { EVENT_BY_NAME } from './catalog.js';
import { filterText, renderTemplate } from './textfilter.js';
import { applyReplacements } from './dictionary.js';

/** ツール名フィルタ。PreToolUse / PostToolUse / 許可待ちに適用する。 */
function toolAllowed(toolName, filter) {
  if (!toolName) return true;
  const mode = filter?.mode ?? 'all';
  if (mode === 'all') return true;
  const list = (mode === 'allowlist' ? filter?.allow : filter?.deny) ?? [];
  const hit = list.some((pattern) => {
    if (!pattern) return false;
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      return re.test(toolName);
    }
    return pattern.toLowerCase() === toolName.toLowerCase();
  });
  return mode === 'allowlist' ? hit : !hit;
}

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);

// 無視パターンの照合に使ってよい時間の合計。1 回の判定でこれを超えたら、残りは見ずに読み上げる。
export const IGNORE_MATCH_BUDGET_MS = 200;

// 照合は vm の時間制限付きで走らせる。書き方によっては照合が事実上終わらない正規表現
// （`(a+)+$` や `a*a*X` など）があり、デーモンは 1 スレッドなので、素で実行すると
// 読み上げどころか HTTP API ごと固まる。vm なら時間切れで打ち切れる。
// スクリプトとコンテキストは使い回す（1 回あたり 0.2 ミリ秒ほど）。
const MATCH_SCRIPT = new vm.Script('new RegExp(pattern).test(text)');
const MATCH_CONTEXT = vm.createContext({ pattern: '', text: '' });

// 一度時間切れになったパターンに、毎回 200 ミリ秒を使うわけにはいかない。
// かといって以後ずっと使わないのも乱暴で、本文が短ければ同じパターンでも一瞬で終わる。
// そこで 2 回目からは短い時間で試し、間に合えば元に戻す。
export const IGNORE_MATCH_RETRY_MS = 5;
const timedOutPatterns = new Set();
// 覚えっぱなしで際限なく増やさない。数が増えたら忘れて、また測り直す
const TIMED_OUT_LIMIT = 50;

/** ログに載せるための短縮。設定はいくらでも長く書けるので、そのまま出さない。 */
function preview(pattern) {
  return pattern.length > 40 ? `${pattern.slice(0, 40)}…` : pattern;
}

/**
 * 無視パターン。整形前の本文がどれかに部分一致したら、その発話ごと飛ばす。
 * フラグは付けないので大文字小文字は区別する（区別したくないときは [Bb] のように書く）。
 *
 * 使えなかったパターンは problems に理由を積む。飛ばしたことを黙っていると
 * 「書いたのに効かない」が無通知になるので、呼び出し側でログに出す。
 * @param {string[]} problems 使えなかったパターンの説明を受け取る配列
 */
export function matchesIgnorePattern(text, patterns, problems = []) {
  if (!Array.isArray(patterns)) return false; // 手編集で配列以外が入っていても落とさない
  // 単調時計で期限を決め、要素ごとに必ず確認する（空文字が並んでいても予算を超えない）
  const deadline = performance.now() + IGNORE_MATCH_BUDGET_MS;
  MATCH_CONTEXT.text = text;
  try {
    for (const [index, pattern] of patterns.entries()) {
      const left = deadline - performance.now();
      if (left <= 0) {
        problems.push(`無視パターン ${index + 1} 以降は、照合の時間切れで見ていません`);
        break;
      }
      if (typeof pattern !== 'string' || pattern === '') continue;
      // 前に時間切れになったパターンは短い時間で試す。本文が短ければこれで足りる
      const retrying = timedOutPatterns.has(pattern);
      const timeout = Math.max(1, Math.ceil(retrying ? Math.min(left, IGNORE_MATCH_RETRY_MS) : left));
      MATCH_CONTEXT.pattern = pattern;
      try {
        const hit = MATCH_SCRIPT.runInContext(MATCH_CONTEXT, { timeout });
        if (retrying) timedOutPatterns.delete(pattern); // 間に合ったので元に戻す
        if (hit) return true;
      } catch (err) {
        // 不正な正規表現と、時間内に終わらなかったパターンは飛ばす。
        // 打ち切ったときは「一致しなかった」扱いにする（黙り込むより読み上げるほうが安全）。
        // 不正な正規表現は UI 側で検証済みのはずだが、手編集もありうる。
        // 理由の文面は毎回同じにする（呼び出し側の重複抑止が効くように）。
        // vm の中で起きたエラーは別の realm のものなので、instanceof ではなくコードで見分ける
        if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
          if (timedOutPatterns.size >= TIMED_OUT_LIMIT) timedOutPatterns.clear();
          timedOutPatterns.add(pattern);
          problems.push(`無視パターン ${index + 1}（${preview(pattern)}）は、照合が時間内に終わりません`);
        } else {
          problems.push(`無視パターン ${index + 1}（${preview(pattern)}）は正規表現として解釈できません`);
        }
      }
    }
    return false;
  } finally {
    // 本文もパターンも共有のコンテキストに残さない
    MATCH_CONTEXT.text = '';
    MATCH_CONTEXT.pattern = '';
  }
}

/**
 * problems には無視パターンのうち使えなかったものの説明が入る。呼び出し側でログに出す。
 * @returns {{ speak:false, reason:string, problems?:string[] }
 *   | { speak:true, text:string, event:string, problems:string[] }}
 */
export function resolveUtterance({ eventName, payload, profile, dictionary }) {
  if (!profile) return { speak: false, reason: 'unknown-target' };
  if (profile.enabled === false) return { speak: false, reason: 'target-disabled' };

  const meta = EVENT_BY_NAME.get(eventName);
  if (!meta) return { speak: false, reason: 'unknown-event' };

  const setting = profile.events?.[eventName];
  if (!setting || setting.enabled === false) return { speak: false, reason: 'event-disabled' };

  const toolName = payload?.tool_name ?? payload?.toolName ?? null;
  if (TOOL_EVENTS.has(eventName) && !toolAllowed(toolName, profile.toolFilter)) {
    return { speak: false, reason: 'tool-filtered' };
  }

  let raw = '';
  const mode = setting.mode ?? meta.defaults.mode;

  if (mode === 'fullText' && meta.supportsFullText) {
    for (const field of meta.body) {
      const v = payload?.[field];
      if (typeof v === 'string' && v.trim()) {
        raw = v;
        break;
      }
    }
    // 本文が取れなかったときはテンプレートに落とす（無言で終わるより分かりやすい）
    if (!raw) raw = renderTemplate(setting.template ?? meta.defaults.template, { ...payload, tool_name: toolName });
  } else {
    raw = renderTemplate(setting.template ?? meta.defaults.template, { ...payload, tool_name: toolName });
  }

  if (!raw || !raw.trim()) return { speak: false, reason: 'empty-source' };

  // 整形前の生テキストで判定する。整形後だと記号やコードブロックが消えて、
  // 設定した書き出しと一致しなくなるため。
  const problems = [];
  if (matchesIgnorePattern(raw, profile.ignorePatterns, problems)) {
    return { speak: false, reason: 'ignored-pattern', problems };
  }

  const filtered = filterText(raw, profile.textFilter);
  if (!filtered.text) return { speak: false, reason: 'filtered-out', problems };

  const spoken = applyReplacements(filtered.text, dictionary?.replacements ?? []);
  if (!spoken.trim()) return { speak: false, reason: 'filtered-out', problems };

  return { speak: true, text: spoken, event: eventName, truncated: filtered.truncated, problems };
}
