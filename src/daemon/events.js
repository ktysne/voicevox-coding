// フックのペイロードを「読み上げるテキスト」に変換する。
// ここが「何を読む / 読まない」の判断の中心。

import vm from 'node:vm';
import { EVENT_BY_NAME } from './catalog.js';
import { filterText, renderTemplate, stripListBoundaries, mapListSegments } from './textfilter.js';
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
// 1 つのパターンに使ってよい時間。重いパターンが 1 つあっても、後ろのパターンの番が回るようにする。
export const IGNORE_MATCH_PATTERN_MS = 50;

// 照合は vm の時間制限付きで走らせる。書き方によっては照合が事実上終わらない正規表現
// （`(a+)+$` や `a*a*X` など）があり、デーモンは 1 スレッドなので、素で実行すると
// 読み上げどころか HTTP API ごと固まる。vm なら時間切れで打ち切れる。
// スクリプトとコンテキストは使い回す（1 回あたり 0.2 ミリ秒ほど）。
const MATCH_SCRIPT = new vm.Script('new RegExp(pattern).test(text)');
const MATCH_CONTEXT = vm.createContext({ pattern: '', text: '' });

// 一度時間切れになったパターンに、毎回 50 ミリ秒を使うわけにはいかない。
// かといって以後ずっと使わないのも乱暴で、本文が短ければ同じパターンでも一瞬で終わる。
// そこで 2 回目からはずっと短い時間で試す。一度速く終わっても元の枠には戻さない
// （長い本文と短い本文が交互に来ると、そのたびに止まってしまうため）。
export const IGNORE_MATCH_RETRY_MS = 5;
const timedOutPatterns = new Set();
// 覚えっぱなしで際限なく増やさない。あふれたら古いものから 1 つずつ忘れる
const TIMED_OUT_LIMIT = 50;

/** 時間切れの記録を捨てる。設定を編集したときに測り直すため。 */
export function resetIgnoreMatchState() {
  timedOutPatterns.clear();
}

/** ログに載せるための短縮。設定はいくらでも長く書けるので、そのまま出さない。 */
function shorten(pattern) {
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
        // 残りが空欄だけなら、見ていないと言われても直しようがないので黙る
        const rest = patterns.slice(index).filter((p) => typeof p === 'string' && p !== '');
        if (rest.length) problems.push(`無視パターン ${index + 1} 以降の ${rest.length} 件は、照合の時間切れで見ていません`);
        break;
      }
      if (typeof pattern !== 'string' || pattern === '') continue;
      // 前に時間切れになったパターンは短い時間で試す。本文が短ければこれで足りる
      const perPattern = timedOutPatterns.has(pattern) ? IGNORE_MATCH_RETRY_MS : IGNORE_MATCH_PATTERN_MS;
      const timeout = Math.max(1, Math.ceil(Math.min(left, perPattern)));
      MATCH_CONTEXT.pattern = pattern;
      try {
        if (MATCH_SCRIPT.runInContext(MATCH_CONTEXT, { timeout })) return true;
      } catch (err) {
        // 不正な正規表現と、時間内に終わらなかったパターンは飛ばす。
        // 打ち切ったときは「一致しなかった」扱いにする（黙り込むより読み上げるほうが安全）。
        // 不正な正規表現は UI 側で検証済みのはずだが、手編集もありうる。
        // 理由の文面は毎回同じにする（呼び出し側の重複抑止が効くように）。
        // vm の中で起きたエラーは別の realm のものなので、instanceof ではなくコードで見分ける
        if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
          // すでに覚えているパターンなら数は増えない。捨てるのは新しく覚えるときだけ
          if (!timedOutPatterns.has(pattern) && timedOutPatterns.size >= TIMED_OUT_LIMIT) {
            for (const oldest of timedOutPatterns) {
              timedOutPatterns.delete(oldest);
              break;
            }
          }
          timedOutPatterns.add(pattern);
          problems.push(`無視パターン ${index + 1}（${shorten(pattern)}）は、照合が時間内に終わりません`);
        } else {
          problems.push(`無視パターン ${index + 1}（${shorten(pattern)}）は正規表現として解釈できません`);
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
 * text は表示・ログ用、speechText は発話キューへ渡す読み上げ用（項目の切れ目の印つき）。
 * @returns {{ speak:false, reason:string, problems?:string[] }
 *   | { speak:true, text:string, speechText:string, event:string, problems:string[] }}
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

  // 置換は読み上げ用のテキスト（項目の切れ目の印つき）へ掛ける。印を挟んだまま渡すと
  // 正規表現ルールの行頭・行末の判定が狂うので、切れ目で区切って掛ける。
  // 表示・ログ用の text は印を外したもので、印は発話キューへ渡す speechText にだけ残す。
  const spoken = mapListSegments(filtered.marked, (s) => applyReplacements(s, dictionary?.replacements ?? []));
  const display = stripListBoundaries(spoken);
  if (!display.trim()) return { speak: false, reason: 'filtered-out', problems };

  return { speak: true, text: display, speechText: spoken, event: eventName, truncated: filtered.truncated, problems };
}
