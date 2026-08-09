// 読み上げテキストの整形。「どの要素を読む / 読まない」の実体。
// 適用順は依存関係で決まっている。URL を先に退避しないとファイルパス判定が誤爆する、など。

const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INDENTED_CODE = /^(?: {4}|\t).+$/gm;
const THINKING = /<(thinking|antml:thinking)>[\s\S]*?<\/\1>/gi;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
// URL の開始位置の目印。実際にどこまでが URL 本体かは scanUrlLength() が 1 文字ずつ判定する。
const URL_START = /https?:\/\/|\bwww\./g;

// URL の内部としては扱わず、見つかった時点で URL を打ち切る単独文字。
// 日本語の句読点・全角括弧・引用符は、常に URL の外側（後続の日本語文）だと判断してよい。
// Unicode ブロックまるごとの除外はしない。ひらがな・カタカナ・漢字そのもの、
// 々 のような繰り返し記号、全角英数字は対象に含めない。
// `https://ja.wikipedia.org/wiki/日本語` のようにパスへ生の日本語を含む URL や
// 国際化ドメイン名、全角英数字を含むパスが実在するため、ブロック単位で除外すると
// URL の一部が欠けたり後続本文が読み上げから消えたりする（クロスレビューで検出した回帰）。
const URL_STOP_CHAR = new Set([
  '、', '。', // 、。
  '，', '．', // ，．
  '！', '？', // ！？
  '「', '」', '『', '』', // 「」『』
  '【', '】', // 【】
  '〈', '〉', '《', '》', // 〈〉《》
  '（', '）', // （）
]);
for (let c = 0x2018; c <= 0x201f; c++) URL_STOP_CHAR.add(String.fromCharCode(c)); // 引用符 “”‘’ など

// ひらがな・カタカナ・漢字、および上記の日本語句読点。
// ASCII 記号の直後にこれらが続くときだけ「日本語文へ切り替わった」とみなす判定に使う。
function isJapaneseText(ch) {
  if (!ch) return false;
  if (URL_STOP_CHAR.has(ch)) return true;
  const c = ch.codePointAt(0);
  return (
    (c >= 0x3040 && c <= 0x30ff) || // ひらがな・カタカナ
    (c >= 0x3400 && c <= 0x4dbf) || // CJK 統合漢字拡張 A
    (c >= 0x4e00 && c <= 0x9fff) // CJK 統合漢字
  );
}

// 直後に日本語文が続くときだけ URL の終端とみなす ASCII 記号。
// 例：`https://example.com,次へ進む` のように、区切りの空白を置かずに
// ASCII の読点相当の記号越しへ日本語文を続ける表記がある。
// `.` `/` `?` `:` `!` などクエリ文字列やパス構造に必須な記号は対象にしない。
const ASCII_SOFT_STOP = new Set([',', ';']);

// 対応する開き括弧が URL 内に現れた分だけ、閉じ括弧を URL の一部として許可する。
// `https://en.wikipedia.org/wiki/Go_(programming_language)` のような URL を保つ一方、
// `リンク(https://example.com)を開く` のように外側の括弧を閉じるだけの `)` では打ち切る。
const ASCII_CLOSE_TO_OPEN = { ')': '(', ']': '[', '}': '{' };

/** text の start 位置から始まる URL 本体の長さを 1 文字ずつ走査して求める。 */
function scanUrlLength(text, start) {
  const openDepth = { '(': 0, '[': 0, '{': 0 };
  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch) || URL_STOP_CHAR.has(ch)) break;

    if (ch === '(' || ch === '[' || ch === '{') {
      openDepth[ch]++;
      continue;
    }
    const open = ASCII_CLOSE_TO_OPEN[ch];
    if (open) {
      if (openDepth[open] > 0) {
        openDepth[open]--;
        continue;
      }
      break; // 対応する開き括弧が URL 内に無いので、ここで打ち切る
    }
    if (ASCII_SOFT_STOP.has(ch) && isJapaneseText(text[i + 1])) break;
  }
  return i - start;
}

/** text 中の URL 区間 ({ start, end, text }) をすべて洗い出す。 */
function findUrls(text) {
  const matches = [];
  URL_START.lastIndex = 0;
  let m;
  while ((m = URL_START.exec(text))) {
    const start = m.index;
    const len = scanUrlLength(text, start);
    if (len <= 0) {
      URL_START.lastIndex = start + m[0].length;
      continue;
    }
    const end = start + len;
    matches.push({ start, end, text: text.slice(start, end) });
    URL_START.lastIndex = end;
  }
  return matches;
}

/** text 中の URL 区間を replacer(url) の返り値で置き換える。 */
function replaceUrls(text, replacer) {
  const matches = findUrls(text);
  if (!matches.length) return text;
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + replacer(m.text);
    last = m.end;
  }
  return out + text.slice(last);
}
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
  return replaceUrls(out, () => (mode === 'placeholder' ? placeholder : ' '));
}

/**
 * URL をそのまま読む設定のとき、パス判定が URL の後半を食ってしまうため、
 * 一時的に退避してから戻す。
 */
function applyFilePaths(text, mode) {
  if (mode === 'read') return text;

  const parked = [];
  const guarded = replaceUrls(text, (m) => {
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
