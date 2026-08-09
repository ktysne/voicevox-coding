// 読み上げテキストの整形。「どの要素を読む / 読まない」の実体。
// 適用順は依存関係で決まっている。URL を先に退避しないとファイルパス判定が誤爆する、など。

const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INDENTED_CODE = /^(?: {4}|\t).+$/gm;
const THINKING = /<(thinking|antml:thinking)>[\s\S]*?<\/\1>/gi;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const URL = /https?:\/\/\S+|\bwww\.\S+/g;
const MD_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
const MD_IMAGE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const TABLE_ROW = /^\s*\|.*\|\s*$/gm;
const TABLE_SEP = /^\s*\|?[\s:|-]{3,}\|?\s*$/gm;
const HEADING_LINE = /^\s{0,3}#{1,6}\s+.*$/gm;
const HEADING_MARK = /^\s{0,3}#{1,6}\s+/gm;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm;
const BLOCKQUOTE = /^\s*>+\s?/gm;
const HR = /^\s*(?:[-*_]\s*){3,}$/gm;
const INLINE_CODE = /`([^`\n]+)`/g;
const MD_EMPHASIS = /(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g;
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;
const BOX_DRAWING = /[─-╿▀-▟]/g;

// パス「らしい」文字列。区切りが 1 つ以上ある連なりを 1 つのパスとして捉える。
// 先頭のセグメントも含めないと src/daemon/queue.js が「src」と「queue.js」に割れる。
const FILE_PATH = /(?:[A-Za-z]:[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)+[\\/]?/g;

// URL を一時退避するときの目印。区切り文字も \w も含まないので、
// パス判定にも Markdown 記号の除去にも巻き込まれない。
const PARK_OPEN = '§';
const PARK_CLOSE = '§';
const PARK_RE = /§(\d+)§/g;

const SENTENCE_END = /(?<=[。．.!?！？])\s*/;

function applyCodeBlocks(text, mode, placeholder) {
  if (mode === 'read') return text;
  const rep = mode === 'placeholder' ? `。${placeholder}。` : ' ';
  return text.replace(FENCED_CODE, rep).replace(INDENTED_CODE, rep);
}

function applyInlineCode(text, mode) {
  if (mode === 'read') return text;
  if (mode === 'omit') return text.replace(INLINE_CODE, ' ');
  return text.replace(INLINE_CODE, '$1'); // strip: バッククォートだけ外す
}

function applyUrls(text, mode, placeholder) {
  // Markdown リンクはラベルを残し、URL 部分だけを対象にする
  const out = text.replace(MD_IMAGE, ' ').replace(MD_LINK, '$1 ');
  if (mode === 'read') return out;
  return out.replace(URL, mode === 'placeholder' ? placeholder : ' ');
}

/**
 * URL をそのまま読む設定のとき、パス判定が URL の後半を食ってしまうため、
 * 一時的に退避してから戻す。
 */
function applyFilePaths(text, mode) {
  if (mode === 'read') return text;

  const parked = [];
  const guarded = text.replace(URL, (m) => {
    parked.push(m);
    return PARK_OPEN + (parked.length - 1) + PARK_CLOSE;
  });

  const replaced = guarded.replace(FILE_PATH, (m) => {
    if (mode === 'omit') return ' ';
    const parts = m.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : ' ';
  });

  return replaced.replace(PARK_RE, (_m, i) => parked[Number(i)] ?? '');
}

function applyTables(text, mode) {
  if (mode === 'read') {
    // 読む場合でも区切り行だけは意味がないので落とす
    return text.replace(TABLE_SEP, ' ').replace(/\|/g, ' ');
  }
  return text.replace(TABLE_ROW, ' ');
}

function limitSentences(text, max) {
  if (!max || max <= 0) return { text, truncated: false };
  const sentences = text.split(SENTENCE_END).filter((s) => s.trim().length > 0);
  if (sentences.length <= max) return { text, truncated: false };
  return { text: sentences.slice(0, max).join(''), truncated: true };
}

function limitChars(text, max) {
  if (!max || max <= 0 || text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/**
 * @param {string} input 生テキスト
 * @param {object} f     textFilter 設定
 * @returns {{ text: string, truncated: boolean }}
 */
export function filterText(input, f = {}) {
  if (typeof input !== 'string') return { text: '', truncated: false };
  let t = input;

  if (f.thinkingBlocks !== false) t = t.replace(THINKING, ' ');

  t = applyCodeBlocks(t, f.codeBlock ?? 'placeholder', f.codeBlockPlaceholder ?? 'コードは省略');
  t = applyTables(t, f.table ?? 'omit');

  if (f.htmlTags !== false) t = t.replace(HTML_TAG, ' ');

  t = applyUrls(t, f.url ?? 'placeholder', f.urlPlaceholder ?? 'リンク');
  t = applyFilePaths(t, f.filePath ?? 'basename');
  t = applyInlineCode(t, f.inlineCode ?? 'strip');

  if (f.headings) t = t.replace(HEADING_LINE, ' ');
  else t = t.replace(HEADING_MARK, '');

  if (f.listMarkers !== false) t = t.replace(LIST_MARKER, '');

  t = t.replace(HR, ' ').replace(BLOCKQUOTE, '');

  if (f.markdownSymbols !== false) {
    t = t.replace(MD_EMPHASIS, '$2');
    t = t.replace(/[*_`~>|#]/g, '');
  }

  if (f.emoji !== false) t = t.replace(EMOJI, ' ');
  t = t.replace(BOX_DRAWING, ' ');

  if (f.collapseWhitespace !== false) {
    t = t.replace(/[ \t　]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n');
  }
  t = t.trim();

  const bySentence = limitSentences(t, f.maxSentences);
  const byChar = limitChars(bySentence.text, f.maxChars);
  const truncated = bySentence.truncated || byChar.truncated;
  let out = byChar.text.trim();
  if (truncated && f.truncationSuffix) out += `。${f.truncationSuffix}。`;

  return { text: out, truncated };
}

/** テンプレート内の {field} をペイロードの値で置換する。 */
export function renderTemplate(template, payload = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    const v = payload[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : String(v);
  });
}
