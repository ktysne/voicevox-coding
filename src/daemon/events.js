// フックのペイロードを「読み上げるテキスト」に変換する。
// ここが「何を読む / 読まない」の判断の中心。

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

/**
 * 繰り返しの入れ子（`(a+)+` のような書き方）を大まかに見つける。
 * この形は入力が少し伸びるだけで照合時間が指数的に増え、デーモンは 1 スレッドなので
 * 読み上げどころか HTTP API ごと止まる。判定は控えめな見当で、取りこぼしも空振りもありうる。
 */
const NESTED_REPEAT = /\((?:[^()\\]|\\.)*(?:[*+]|\{\d+,\})(?:[^()\\]|\\.)*\)(?:[*+]|\{\d+,\})/;

export function ignorePatternError(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return null;
  try {
    new RegExp(pattern);
  } catch (err) {
    return `正規表現として解釈できません: ${err.message}`;
  }
  if (NESTED_REPEAT.test(pattern)) {
    return '繰り返しの入れ子（(a+)+ のような書き方）は照合が極端に遅くなることがあるため使えません';
  }
  return null;
}

/**
 * 無視パターン。整形前の本文がどれかに部分一致したら、その発話ごと飛ばす。
 * フラグは付けないので大文字小文字は区別する（区別したくないときは [Bb] のように書く）。
 */
function ignored(text, patterns) {
  if (!Array.isArray(patterns)) return false; // 手編集で配列以外が入っていても落とさない
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') continue;
    // 不正な正規表現と危険な書き方は黙って飛ばす。UI 側で検証済みのはずだが、手編集もありうる
    if (ignorePatternError(pattern)) continue;
    if (new RegExp(pattern).test(text)) return true;
  }
  return false;
}

/**
 * @returns {{ speak:false, reason:string } | { speak:true, text:string, event:string }}
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
  if (ignored(raw, profile.ignorePatterns)) return { speak: false, reason: 'ignored-pattern' };

  const filtered = filterText(raw, profile.textFilter);
  if (!filtered.text) return { speak: false, reason: 'filtered-out' };

  const spoken = applyReplacements(filtered.text, dictionary?.replacements ?? []);
  if (!spoken.trim()) return { speak: false, reason: 'filtered-out' };

  return { speak: true, text: spoken, event: eventName, truncated: filtered.truncated };
}
