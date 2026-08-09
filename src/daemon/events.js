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

  const filtered = filterText(raw, profile.textFilter);
  if (!filtered.text) return { speak: false, reason: 'filtered-out' };

  const spoken = applyReplacements(filtered.text, dictionary?.replacements ?? []);
  if (!spoken.trim()) return { speak: false, reason: 'filtered-out' };

  return { speak: true, text: spoken, event: eventName, truncated: filtered.truncated };
}
