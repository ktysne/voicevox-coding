// 読み上げテキストの整形。「どの要素を読む / 読まない」の実体。
// 適用順は依存関係で決まっている。URL を先に退避しないとファイルパス判定が誤爆する、など。

const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INDENTED_CODE = /^(?: {4}|\t).+$/gm;
const THINKING = /<(thinking|antml:thinking)>[\s\S]*?<\/\1>/gi;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
// URL の開始位置の目印。実際にどこまでが URL 本体かは scanUrlLength() が 1 文字ずつ判定する。
const URL_START = /https?:\/\/|\bwww\./g;

// URL の内部としては扱わず、見つかった時点で URL を打ち切る単独文字（対応関係を持たないもの）。
// 日本語の句読点・引用符は、常に URL の外側（後続の日本語文）だと判断してよい。
// Unicode ブロックまるごとの除外はしない。ひらがな・カタカナ・漢字そのもの、
// 々 のような繰り返し記号、全角英数字は対象に含めない。
// `https://ja.wikipedia.org/wiki/日本語` のようにパスへ生の日本語を含む URL や
// 国際化ドメイン名、全角英数字を含むパスが実在するため、ブロック単位で除外すると
// URL の一部が欠けたり後続本文が読み上げから消えたりする（クロスレビューで検出した回帰）。
const URL_STOP_CHAR = new Set([
  '、', '。', // 、。
  '，', '．', // ，．
  '！', '？', // ！？
]);
for (let c = 0x2018; c <= 0x201f; c++) URL_STOP_CHAR.add(String.fromCharCode(c)); // 引用符 “”‘’ など

// ひらがな・カタカナ・漢字、および上記の日本語句読点。
// 対応の無い閉じ括弧や ASCII 記号の直後にこれらが続くときだけ
// 「日本語文へ切り替わった」とみなす判定に使う。
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
// 検証済みの既知の限界：クエリ値そのものに日本語を生で埋め込み、かつ区切りに
// ASCII の `,` `;` を使う URL（`?q=英語,日本語` 等）は、この判定と区別が付かず
// 誤って打ち切られる。この曖昧さは文字単位の判定では解消できないため許容する。
const ASCII_SOFT_STOP = new Set([',', ';']);

// 開き括弧と閉じ括弧の対応表（ASCII・全角の両方）。開いた分だけ閉じを URL の一部として許可する。
// `https://en.wikipedia.org/wiki/Go_(programming_language)` や `.../商品（赤）` のように
// 対応が取れている括弧は URL 内に残す。
const BRACKET_OPEN_TO_CLOSE = {
  '(': ')', '[': ']', '{': '}',
  '「': '」', '『': '』', '【': '】', '〈': '〉', '《': '》', '（': '）',
};
const BRACKET_CLOSE_TO_OPEN = {};
for (const [open, close] of Object.entries(BRACKET_OPEN_TO_CLOSE)) BRACKET_CLOSE_TO_OPEN[close] = open;

/** text の start 位置から始まる URL 本体の長さを 1 文字ずつ走査して求める。 */
function scanUrlLength(text, start) {
  const openDepth = {};
  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch) || URL_STOP_CHAR.has(ch)) break;

    if (BRACKET_OPEN_TO_CLOSE[ch]) {
      openDepth[ch] = (openDepth[ch] || 0) + 1;
      continue;
    }
    const open = BRACKET_CLOSE_TO_OPEN[ch];
    if (open) {
      if (openDepth[open] > 0) {
        openDepth[open]--;
        continue;
      }
      // 対応する開き括弧が URL 内に無い。外側の括弧を閉じているだけなら打ち切り、
      // `?q=a)b` のように後ろへ普通の URL 本体が続くならそのまま含める。
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next) || isJapaneseText(next)) break;
      continue;
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
// 箇条書き項目の 1 行。記号を外す前にどの行が項目だったかを控えるために使う。
// `- - -` `* * *` のような区切り線は、記号と空白しか残らないので項目とみなさない。
const LIST_ITEM_LINE = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+(?![-*_ \t]*$).*$/gm;
const BLOCKQUOTE = /^\s*>+\s?/gm;
const HR = /^\s*(?:[-*_]\s*){3,}$/gm;
const INLINE_CODE = /`([^`\n]+)`/g;
const MD_EMPHASIS = /(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g;
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;
const BOX_DRAWING = /[─-╿▀-▟]/g;

// パス要素から常に除外する文字。区切り文字、Windows のパスに使えない文字
// （: * ? " < > |）、空白、日本語の句読点、Markdown のバッククォート、
// URL 退避の目印 § と、日本語文の区切りに使われる ASCII の , ; 。
const PATH_EXCLUDE = String.raw`\\/:*?"<>|\s\x60§,;、。，．！？…`;
// ひらがな・カタカナ・漢字。相対パスの判定でだけ追加で除外する。
const JP_EXCLUDE = String.raw`\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー々〆`;

// ドライブレター起点のパス要素として認める 1 文字。ASCII に限らず、
// 日本語のユーザー名やディレクトリ名（C:\Users\山田\... など）も 1 要素として扱う。
const PATH_CHAR = `[^${PATH_EXCLUDE}]`;

// 空白をパス要素の内側とみなしてよい条件。直後の語（次の空白までの連なり）が
// ASCII 英字か区切り文字を含むときだけ許す。全角空白も同じ扱いにする。
// `Program Files`、`Program Files (x86)`、`日本 語\file.txt` は 1 つのパスとして拾い、
// `app.log と logs\err.log` の「と」のような助詞では打ち切る。
// 日本語は語の区切りに空白を使わないため、この条件で本文との境界をほぼ言い当てられる。
// 既知の限界：`C:\temp and see src\a.js` のように英単語だけで文を続けると
// パスの一部として飲み込む。日本語を前提とする読み上げでは実害が小さいため許容する。
const PATH_SPACE = String.raw`[ 　](?=[^\s]*[A-Za-z\\/])`;
const PATH_SEG = `${PATH_CHAR}+(?:${PATH_SPACE}${PATH_CHAR}+)*`;

// 相対パスの要素。ドライブレターという目印が無いぶん保守的に扱い、
// 空白も日本語の文字も含めない。日本語は語間に空白を置かないため、
// `詳細は2024/08/09の記録` のように地の文が直結すると、どこからがパスかを
// 文字種以外では判別できない。
const REL_CHAR = `[^${PATH_EXCLUDE}${JP_EXCLUDE}]`;

// 絶対パスの最終セグメント。次の順に試す。
//   1. 空白を含んでよいが `.ext` で終わるもの（`release notes.txt`）
//   2. 空白も日本語も含まないもの（`app.logを確認` の「を確認」を残す）
//   3. 日本語だけのディレクトリ名（`C:\Users\山田`）
// 1 は末尾が拡張子であることを後読みで確かめるので、
// `C:\logs\app.log is missing` の後続本文を飲み込まずに済む。
// 拡張子の直後がまだパス要素なら（`file.test-case` の `-`）打ち切らない。
// 途中で確定すると `file.test` と `-case` に割れてしまう。
const LAST_SEG = `(?:${PATH_SEG}(?<=\\.[A-Za-z0-9]{1,10})(?!${REL_CHAR})|${REL_CHAR}+|${PATH_CHAR}+)`;

// ドライブレター起点の Windows パスと UNC パス（\\server\share）。
// 途中のセグメントには空白を許すぶん寛容に扱う。
// 区切りは `\` と `/` の混在も認める（Node.js も Windows も混在パスを解決できる）。
// 既知の限界：`C:\temp and see src\a.js` のように英単語だけで文を続けると
// 途中のセグメントとして飲み込む。空白を含むディレクトリ名との区別が付かないため許容する。
const ABS_PATH = new RegExp(
  String.raw`(?:[A-Za-z]:[\\/](?:${PATH_SEG}[\\/])*|\\\\(?:${PATH_SEG}[\\/])+)${LAST_SEG}[\\/]?`,
  'gu',
);

// 相対パス。先頭のセグメントも含めないと src/daemon/queue.js が「src」と「queue.js」に割れる。
const REL_PATH = new RegExp(String.raw`${REL_CHAR}+(?:[\\/]${REL_CHAR}+)+[\\/]?`, 'gu');

const NUMERIC_SEG = /^\d+(?:\.\d+)?$/;
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
const RELATIVE_PREFIX = /^\.{1,2}[\\/]/;
const HAS_ASCII_ALNUM = /[A-Za-z0-9]/;

function pathSegments(m) {
  return m.split(/[\\/]/).filter(Boolean);
}

/**
 * 相対パスらしさの判定。ドライブレターという明確な目印が無いぶん保守的に扱い、
 * 日付（2024/08/09）や `A/B テスト` のような表記をパスとみなさない。
 */
function isLikelyRelativePath(m) {
  const parts = pathSegments(m);
  if (parts.length < 2) return false;
  if (RELATIVE_PREFIX.test(m)) return true; // ./src ../lib は明確なパス表現
  if (parts.every((p) => NUMERIC_SEG.test(p))) return false; // 日付や分数
  if (EXTENSION.test(parts[parts.length - 1])) return true; // 拡張子付きならパス
  const seps = (m.match(/[\\/]/g) || []).length;
  if (seps >= 2 && HAS_ASCII_ALNUM.test(m)) return true; // src/daemon/ など
  // 区切りが 1 つだけのときは `CI/CD` `A/B` `and/or` のような略語や併記と区別が付かない。
  // 各要素が 2 文字以上で、かつ `.` `_` `-` を含むもの（node_modules/pkg など）だけ通す。
  return parts.every((p) => p.length >= 2) && /[._-]/.test(m);
}

// パスの外側にある括弧。`(src/daemon/app.js)` の括弧はパスの一部ではないので、
// 短縮の対象から外して元のまま残す。`Program Files (x86)` のような内側の括弧は残す。
const BRACKET_OPEN_TO_CLOSE_PATH = { '(': ')', '[': ']', '{': '}', '（': '）', '「': '」', '【': '】' };
const BRACKET_CLOSE_TO_OPEN_PATH = {};
for (const [o, c] of Object.entries(BRACKET_OPEN_TO_CLOSE_PATH)) BRACKET_CLOSE_TO_OPEN_PATH[c] = o;

function countChar(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** s 全体が先頭の開き括弧とその対応する閉じ括弧で囲まれているか。 */
function isBracketWrapped(s) {
  const open = s[0];
  const close = BRACKET_OPEN_TO_CLOSE_PATH[open];
  if (!close || s[s.length - 1] !== close) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i === s.length - 1;
  }
  return false;
}

/** マッチ文字列を「外側の括弧」「パス本体」「外側の括弧」へ分ける。 */
function splitOuterBrackets(m) {
  let start = 0;
  let end = m.length;
  for (;;) {
    const core = m.slice(start, end);
    if (core.length < 2) break;
    const last = core[core.length - 1];
    const openOfLast = BRACKET_CLOSE_TO_OPEN_PATH[last];
    if (openOfLast && countChar(core, openOfLast) < countChar(core, last)) {
      end--; // 対応する開き括弧を持たない閉じ括弧
      continue;
    }
    const first = core[0];
    const closeOfFirst = BRACKET_OPEN_TO_CLOSE_PATH[first];
    if (closeOfFirst && countChar(core, closeOfFirst) < countChar(core, first)) {
      start++; // 対応する閉じ括弧を持たない開き括弧
      continue;
    }
    if (isBracketWrapped(core)) {
      start++;
      end--;
      continue;
    }
    break;
  }
  return { lead: m.slice(0, start), core: m.slice(start, end), trail: m.slice(end) };
}

// URL を一時退避するときの目印。区切り文字も \w も含まないので、
// パス判定にも Markdown 記号の除去にも巻き込まれない。
const PARK_OPEN = '§';
const PARK_CLOSE = '§';
const PARK_RE = /§(\d+)§/g;

const SENTENCE_END = /(?<=[。．.!?！？])\s*/;

// 箇条書き項目の切れ目を、整形後のテキスト上へ残しておくための内部マーカー。
// 制御文字なので本文には現れず、空白とも扱われないため、後段の記号除去・空白の正規化・
// trim をくぐり抜けて位置を保てる。読み上げ側 (発話キュー) はここでチャンクを割り、
// 項目のあいだに無音の間を挟む。
// 本文へ残ってはいけない文字なので、filterText は marked にだけ含めて返し、
// 表示・ログに使う text からは必ず取り除く。
export const LIST_BOUNDARY = '\u0001';
const LIST_BOUNDARY_RE = /\u0001/g;

// 箇条書き項目の切れ目に置く無音の既定の長さ（秒）。
export const DEFAULT_LIST_PAUSE_SEC = 0.3;

/** 項目の切れ目のマーカーを取り除く。 */
export function stripListBoundaries(text) {
  return typeof text === 'string' ? text.replace(LIST_BOUNDARY_RE, '') : '';
}

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

  const shorten = (m, requireLikely) => {
    const { lead, core, trail } = splitOuterBrackets(m);
    if (!core || (requireLikely && !isLikelyRelativePath(core))) return m;
    const parts = pathSegments(core);
    if (!parts.length) return m;
    const last = parts[parts.length - 1];
    // 最終要素が ASCII 英数字を含まない（日本語だけの）場合、ディレクトリ名なのか
    // 直結した地の文なのかを判別できない。omit でも最終要素だけは残し、
    // `C:\Users\山田\資料を確認` の「を確認」ごと消してしまう事故を避ける。
    if (mode === 'omit') return HAS_ASCII_ALNUM.test(last) ? `${lead} ${trail}` : `${lead} ${last}${trail}`;
    return lead + last + trail;
  };

  // 絶対パス（ドライブレターと UNC）を先に処理する。先に相対パスを当てると
  // `C:\a\b` の途中（`a\b`）だけを拾ってしまう。
  // 絶対パス側で拾い切れなかった残りは相対パスとして処理される。
  const replaced = guarded
    .replace(ABS_PATH, (m) => shorten(m, false))
    .replace(REL_PATH, (m) => shorten(m, true));

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
  // 項目の切れ目のマーカーは読み上げない文字なので、それだけの断片は文と数えない。
  const sentences = text.split(SENTENCE_END).filter((s) => stripListBoundaries(s).trim().length > 0);
  if (sentences.length <= max) return { text, truncated: false };
  return { text: sentences.slice(0, max).join(''), truncated: true };
}

function limitChars(text, max) {
  if (!max || max <= 0) return { text, truncated: false };
  // 同じく、マーカーは文字数に数えない。設定した文字数と実際に読む長さをずらさないため。
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === LIST_BOUNDARY) continue;
    count += 1;
    if (count > max) return { text: text.slice(0, i), truncated: true };
  }
  return { text, truncated: false };
}

/**
 * @param {string} input 生テキスト
 * @param {object} f     textFilter 設定
 * @returns {{ text: string, marked: string, truncated: boolean }}
 *   text は表示・ログ用（項目の切れ目のマーカーを含まない）、
 *   marked は読み上げ用（マーカー入り。発話キューがここでチャンクを割る）。
 */
export function filterText(input, f = {}) {
  if (typeof input !== 'string') return { text: '', marked: '', truncated: false };
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

  // 箇条書き項目の切れ目に印を付ける。記号を外したあとでは、どの行が項目だったかを
  // 判別できなくなるので、必ず LIST_MARKER の除去より先に行う。
  // 間を置かない設定 (0 以下) のときは印そのものを付けず、今までと同じ経路に保つ。
  const listPauseSec = Number(f.listPauseSec ?? DEFAULT_LIST_PAUSE_SEC);
  if (Number.isFinite(listPauseSec) && listPauseSec > 0) {
    t = t.replace(LIST_ITEM_LINE, (line) => line + LIST_BOUNDARY);
  }

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

  return { text: stripListBoundaries(out), marked: out, truncated };
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
