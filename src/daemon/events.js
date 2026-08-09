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
 * グループ全体を繰り返す書き方（`(a+)+`、`(a|aa)+`、`(\s*x){2,}` など）を見つける。
 * 照合時間が入力の長さに対して指数的に伸びるのは、繰り返しが入れ子になったときで、
 * それには必ずグループへの繰り返しが要る。デーモンは 1 スレッドなので、これを踏むと
 * 読み上げどころか HTTP API ごと固まる。個別の危なさを見分けるのは難しいので、
 * グループの繰り返しは一律で断る（`(abc)?` のように繰り返さないものは通す）。
 */
export function hasRepeatedGroup(pattern) {
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      i += 1; // エスケープされた 1 文字は読み飛ばす
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === ')' && '*+{'.includes(pattern[i + 1] ?? '')) return true;
  }
  return false;
}

/** 無視パターンとして使えるか。使えないときは理由を返す。 */
export function ignorePatternError(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return null;
  try {
    new RegExp(pattern);
  } catch (err) {
    return `正規表現として解釈できません: ${err.message}`;
  }
  if (hasRepeatedGroup(pattern)) {
    return 'グループ全体を繰り返す書き方（(a+)+ や (a|aa)+ など）は照合が極端に遅くなることがあるため使えません';
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
