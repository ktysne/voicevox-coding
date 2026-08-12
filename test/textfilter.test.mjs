// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterText, renderTemplate, stripListBoundaries, mapListSegments, LIST_BOUNDARY } from '../src/daemon/textfilter.js';
import { chunkText } from '../src/daemon/queue.js';
import { applyReplacements, validateEngineWord } from '../src/daemon/dictionary.js';
import { resolveUtterance, resetIgnoreMatchState, IGNORE_MATCH_BUDGET_MS, IGNORE_MATCH_PATTERN_MS } from '../src/daemon/events.js';
import { defaultConfig } from '../src/daemon/config.js';
import { wavDurationMs } from '../src/daemon/player.js';

const F = defaultConfig().targets.claudeCode.textFilter;

test('コードブロックは定型語に置き換わる', () => {
  const { text } = filterText('前\n```js\nconst x = 1;\n```\n後', F);
  assert.match(text, /コードは省略/);
  assert.doesNotMatch(text, /const x/);
});

test('コードブロックを read にすると中身が残る', () => {
  const { text } = filterText('```js\nconst x = 1;\n```', { ...F, codeBlock: 'read', markdownSymbols: false });
  assert.match(text, /const x = 1/);
});

test('URL は定型語に置き換わる', () => {
  const { text } = filterText('詳細は https://example.com/a/b を参照', F);
  assert.match(text, /リンク/);
  assert.doesNotMatch(text, /example\.com/);
});

test('URL 直後に空白なしで句点と本文が続いても後続文は残る（AUD-07）', () => {
  const { text } = filterText('詳細は https://example.com。次の文です。', F);
  assert.match(text, /リンク/);
  assert.match(text, /次の文です/);
  assert.doesNotMatch(text, /example\.com/);
});

test('URL 直後に読点や閉じ括弧が続いても巻き込まない', () => {
  const { text } = filterText('参照先は https://example.com、後で確認してください', F);
  assert.match(text, /リンク/);
  assert.match(text, /後で確認してください/);

  const { text: text2 } = filterText('リンク「https://example.com」を開く', F);
  assert.match(text2, /リンク/);
  assert.match(text2, /を開く/);
});

test('括弧内の URL も括弧の外側の本文を巻き込まない', () => {
  const { text } = filterText('（https://example.com/path）を参照', F);
  assert.match(text, /リンク/);
  assert.match(text, /を参照/);
  assert.doesNotMatch(text, /example\.com/);
});

test('空白区切りやクエリ付き URL は従来どおり丸ごと消える', () => {
  const { text } = filterText('参照 https://example.com/path?a=1&b=2 です', F);
  assert.match(text, /リンク/);
  assert.match(text, /です/);
  assert.doesNotMatch(text, /example\.com/);
});

test('パスに生の日本語を含む URL は丸ごと置き換わる（クロスレビューで検出した回帰）', () => {
  const { text } = filterText('参照 https://ja.wikipedia.org/wiki/日本語 を確認', F);
  assert.match(text, /リンク/);
  assert.match(text, /を確認/);
  assert.doesNotMatch(text, /日本語/);
  assert.doesNotMatch(text, /wikipedia/);
});

test('国際化ドメイン名の URL も丸ごと置き換わる', () => {
  const { text } = filterText('参照 https://例え.テスト/ です', F);
  assert.match(text, /リンク/);
  assert.match(text, /です/);
  assert.doesNotMatch(text, /例え/);
});

test('繰り返し記号や全角英数字を含むパスも丸ごと置き換わる（クロスレビューで検出した回帰）', () => {
  const { text: text1 } = filterText('参照 https://example.com/佐々木 です', F);
  assert.match(text1, /リンク/);
  assert.doesNotMatch(text1, /佐々木/);

  const { text: text2 } = filterText('参照 https://example.com/商品Ａ です', F);
  assert.match(text2, /リンク/);
  assert.doesNotMatch(text2, /商品Ａ/);
});

test('対応する括弧を含む URL は括弧ごと置き換わり、外側の括弧は残る（クロスレビューで検出した回帰）', () => {
  const { text } = filterText('参照 https://en.wikipedia.org/wiki/Go_(programming_language) です', F);
  assert.match(text, /リンク/);
  assert.match(text, /です/);
  assert.doesNotMatch(text, /wikipedia/);

  const { text: text2 } = filterText('リンク(https://example.com)を開く', F);
  assert.match(text2, /リンク\(リンク\)を開く/);
});

test('URL 直後に空白なしで ASCII の読点が続いても後続の日本語文は残る（クロスレビューで検出した回帰）', () => {
  const { text } = filterText('参照 https://example.com,次へ進む', F);
  assert.match(text, /リンク/);
  assert.match(text, /次へ進む/);
  assert.doesNotMatch(text, /example\.com/);
});

test('対応の無い閉じ括弧の後に ASCII 本文が続く URL は打ち切られない（クロスレビューで検出した回帰）', () => {
  const { text } = filterText('参照 https://example.com/search?q=a)b です', F);
  assert.match(text, /リンク/);
  assert.match(text, /です/);
  assert.doesNotMatch(text, /example\.com/);
});

test('全角括弧が対応している URL は括弧ごと丸ごと置き換わる（クロスレビューで検出した回帰）', () => {
  const { text } = filterText('参照 https://example.jp/商品（赤） です', F);
  assert.match(text, /リンク/);
  assert.match(text, /です/);
  assert.doesNotMatch(text, /商品/);
  assert.doesNotMatch(text, /example\.jp/);
});

test('ファイルパスはファイル名だけ残る（語頭を食わない）', () => {
  const { text } = filterText('src/daemon/queue.js を更新しました', { ...F, inlineCode: 'read' });
  assert.match(text, /^queue\.js を更新しました$/);
});

test('Windows のフルパスもファイル名だけになる', () => {
  const { text } = filterText('D:\\Desktop\\Develop\\project\\index.ts も要更新', F);
  assert.match(text, /index\.ts/);
  assert.doesNotMatch(text, /Desktop/);
});

test('日本語と空白を含む Windows パスもファイル名だけになる（AUD-08）', () => {
  const { text } = filterText('C:\\Users\\山田\\My Project\\src\\index.ts を更新', F);
  assert.match(text, /index\.ts を更新/);
  assert.doesNotMatch(text, /山田/);
  assert.doesNotMatch(text, /My/);
});

test('Program Files のような空白入りパスもファイル名だけになる（AUD-08）', () => {
  const { text } = filterText('C:\\Program Files\\nodejs\\node.exe を使います', F);
  assert.match(text, /^node\.exe を使います$/);
});

test('括弧と空白を含むパスもファイル名だけになる（AUD-08）', () => {
  const { text } = filterText('C:\\Program Files (x86)\\nodejs\\node.exe', F);
  assert.equal(text, 'node.exe');
});

test('空白を含むリポジトリ名のパスもファイル名だけになる（AUD-08）', () => {
  const { text } = filterText('D:\\repos\\My Awesome Repo\\src\\main.js を確認', F);
  assert.match(text, /^main\.js を確認$/);
});

test('omit なら日本語と空白を含むパスごと消える（AUD-08）', () => {
  const { text } = filterText('C:\\Users\\山田\\My Project\\src\\index.ts を更新', { ...F, filePath: 'omit' });
  assert.equal(text, 'を更新');
});

test('ドライブレター起点のパスが後続の日本語文を巻き込まない（AUD-08）', () => {
  const { text } = filterText('C:\\logs\\app.log と logs\\err.log を確認', F);
  assert.match(text, /^app\.log と err\.log を確認$/);
});

test('空白を含むファイル名も 1 つのパスとして扱う（AUD-08）', () => {
  const { text } = filterText('C:\\logs\\release notes.txt を確認', F);
  assert.match(text, /^release notes\.txt を確認$/);
  const omitted = filterText('C:\\logs\\release notes.txt を確認', { ...F, filePath: 'omit' });
  assert.equal(omitted.text, 'を確認');
});

test('日本語セグメント内の空白もパスとして扱う（AUD-08）', () => {
  const { text } = filterText('C:\\日本 語\\file.txt を確認', F);
  assert.match(text, /^file\.txt を確認$/);
});

test('区切り文字が混在する Windows パスも従来どおり短縮できる（AUD-08）', () => {
  const { text } = filterText('C:\\foo/bar.js を確認', F);
  assert.match(text, /^bar\.js を確認$/);
  const omitted = filterText('C:\\foo/bar.js を確認', { ...F, filePath: 'omit' });
  assert.equal(omitted.text, 'を確認');
});

test('絶対パス直後に日本語が直結しても後続本文は残る（AUD-08）', () => {
  const { text } = filterText('C:\\logs\\app.logを確認', F);
  assert.equal(text, 'app.logを確認');
  const omitted = filterText('C:\\logs\\app.logを確認', { ...F, filePath: 'omit' });
  assert.equal(omitted.text, 'を確認');
});

test('絶対パス直後に英文が続いても後続本文は残る（AUD-08）', () => {
  const { text } = filterText('C:\\logs\\app.log is missing', F);
  assert.equal(text, 'app.log is missing');
  const omitted = filterText('C:\\logs\\app.log is missing', { ...F, filePath: 'omit' });
  assert.equal(omitted.text, 'is missing');
});

test('日本語だけの最終要素は omit でも本文ごと消さない（AUD-08）', () => {
  const { text } = filterText('C:\\Users\\山田\\資料を確認', { ...F, filePath: 'omit' });
  assert.match(text, /を確認/);
});

test('全角空白を含むパスも 1 つのパスとして扱う（AUD-08）', () => {
  const { text } = filterText('C:\\日本　語\\file.txt を確認', F);
  assert.match(text, /^file\.txt を確認$/);
  const omitted = filterText('C:\\日本　語\\file.txt を確認', { ...F, filePath: 'omit' });
  assert.equal(omitted.text, 'を確認');
});

test('拡張子らしい途中位置でファイル名が割れない（AUD-08）', () => {
  const { text } = filterText('C:\\logs\\file.test-case を確認', F);
  assert.match(text, /^file\.test-case を確認$/);
  const omitted = filterText('C:\\logs\\file.test-case を確認', { ...F, filePath: 'omit' });
  assert.equal(omitted.text, 'を確認');
  const dated = filterText('C:\\logs\\report.2026-08-10 を確認', { ...F, filePath: 'omit' });
  assert.equal(dated.text, 'を確認');
});

test('./ や ../ 起点の相対パスも短縮される（AUD-08）', () => {
  assert.match(filterText('./src を確認', F).text, /^src を確認$/);
  assert.match(filterText('../lib を確認', F).text, /^lib を確認$/);
  assert.match(filterText('./src/index.js を更新', F).text, /^index\.js を更新$/);
});

test('UNC パスもファイル名だけになる（AUD-08）', () => {
  const { text } = filterText('\\\\server\\share\\docs\\a.txt を開く', F);
  assert.match(text, /^a\.txt を開く$/);
  const share = filterText('\\\\server\\share を開く', F);
  assert.match(share.text, /^share を開く$/);
});

test('パスの外側の括弧は短縮対象に含めない（AUD-08）', () => {
  const rel = filterText('参照 (src/daemon/app.js) を確認', F);
  assert.match(rel.text, /^参照 \(app\.js\) を確認$/);
  const abs = filterText('(C:\\logs\\app.log) を確認', F);
  assert.match(abs.text, /^\(app\.log\) を確認$/);
  const omitted = filterText('参照 (src/daemon/app.js) を確認', { ...F, filePath: 'omit' });
  assert.match(omitted.text, /参照/);
  assert.match(omitted.text, /を確認/);
});

test('拡張子の無い 2 要素の相対パスも記号を含めば短縮される（AUD-08）', () => {
  const { text } = filterText('node_modules/pkg を削除', { ...F, markdownSymbols: false });
  assert.match(text, /^pkg を削除$/);
  const dash = filterText('my-app/dist を削除', F);
  assert.match(dash.text, /^dist を削除$/);
});

test('CI/CD のような略語はパスとして短縮しない（AUD-08）', () => {
  const { text } = filterText('CI/CD の設定と TCP/IP の確認', F);
  assert.equal(text, 'CI/CD の設定と TCP/IP の確認');
});

test('日付はパスとして短縮しない（AUD-08）', () => {
  const { text } = filterText('詳細は 2024/08/09 の記録', F);
  assert.equal(text, '詳細は 2024/08/09 の記録');
});

test('日本語が直結した日付もパスとして短縮しない（AUD-08）', () => {
  const { text } = filterText('詳細は2024/08/09の記録', F);
  assert.equal(text, '詳細は2024/08/09の記録');
  const omitted = filterText('詳細は2024/08/09の記録', { ...F, filePath: 'omit' });
  assert.equal(omitted.text, '詳細は2024/08/09の記録');
});

test('日本語が直結した相対パスはパス部分だけ短縮される（AUD-08）', () => {
  const { text } = filterText('src/a.jsを更新', F);
  assert.equal(text, 'a.jsを更新');
  const omitted = filterText('src/a.jsを更新', { ...F, filePath: 'omit' });
  assert.equal(omitted.text, 'を更新');
});

test('A/B のような表記はパスとして短縮しない（AUD-08）', () => {
  const { text } = filterText('A/B テストの結果', F);
  assert.equal(text, 'A/B テストの結果');
  const noSpace = filterText('A/Bテストの結果', F);
  assert.equal(noSpace.text, 'A/Bテストの結果');
  const jp = filterText('入力/出力/変換 の処理', F);
  assert.equal(jp.text, '入力/出力/変換 の処理');
});

test('相対パスの既存挙動は変わらない（AUD-08）', () => {
  const { text } = filterText('test/textfilter.test.mjs と src/daemon/queue.js を更新', { ...F, inlineCode: 'read' });
  assert.match(text, /^textfilter\.test\.mjs と queue\.js を更新$/);
});

test('URL を read にしてもパス判定に食われない', () => {
  const { text } = filterText('参照: https://example.com/docs/guide', { ...F, url: 'read' });
  assert.match(text, /https:\/\/example\.com\/docs\/guide/);
});

test('SCREAMING_SNAKE_CASE の定数名は単語に分けて読む（#50）', () => {
  const { text } = filterText('フラグは MOVEFILE_REPLACE_EXISTING を指定します。', F);
  assert.match(text, /movefile replace existing/);
});

test('複数の定数名がそれぞれ変換される（#50）', () => {
  const { text } = filterText('環境変数 VOICEVOX_CODING_PORT と HTTP_PROXY を確認。', F);
  assert.match(text, /voicevox coding port/);
  assert.match(text, /http proxy/);
});

test('インラインコード内の定数名も変換される（#50）', () => {
  const { text } = filterText('`ERROR_ACCESS_DENIED` が返る。', F);
  assert.match(text, /error access denied/);
});

test('数字混じりの定数名も変換される（#50）', () => {
  const { text } = filterText('バージョンは ISO_8601 に従う。', F);
  assert.match(text, /iso 8601/);
});

test('単独の大文字語はスペルアウトのまま変換しない（#50）', () => {
  const { text } = filterText('HTTP と JSON を使う。', F);
  assert.match(text, /HTTP/);
  assert.match(text, /JSON/);
});

test('constantCase を read にすると従来どおり Markdown 記号の除去で連結される（#50）', () => {
  const { text } = filterText('フラグは MOVEFILE_REPLACE_EXISTING を指定します。', { ...F, constantCase: 'read' });
  assert.match(text, /MOVEFILEREPLACEEXISTING/);
});

test('URL を read にしても URL 中の大文字は壊さない（#50）', () => {
  const { text } = filterText('詳細は https://example.com/API_DOC を参照。', { ...F, url: 'read' });
  assert.match(text, /https:\/\/example\.com\/API_DOC/);
});

test('強調記号で囲まれた URL は装飾だけ外れて URL は壊れない（#50）', () => {
  const bold = filterText('**https://example.com/API_DOC** を参照。', { ...F, url: 'read' });
  assert.match(bold.text, /https:\/\/example\.com\/API_DOC/);
  assert.doesNotMatch(bold.text, /\*/);
  const italic = filterText('_https://example.com/API_DOC_ を参照。', { ...F, url: 'read' });
  assert.match(italic.text, /https:\/\/example\.com\/API_DOC/);
  assert.doesNotMatch(italic.text, /API_DOC_/);
  const strike = filterText('~~https://example.com/API_DOC~~ を参照。', { ...F, url: 'read' });
  assert.match(strike.text, /https:\/\/example\.com\/API_DOC/);
  assert.doesNotMatch(strike.text, /~/);
});

test('_ 強調で囲まれた定数名も単語に分けて読む（#50）', () => {
  const single = filterText('_MOVEFILE_REPLACE_EXISTING_ を指定します。', F);
  assert.match(single.text, /movefile replace existing/);
  assert.doesNotMatch(single.text, /MOVEFILE/);
  const double = filterText('__MOVEFILE_REPLACE_EXISTING__ を指定します。', F);
  assert.match(double.text, /movefile replace existing/);
  assert.doesNotMatch(double.text, /MOVEFILE/);
});

test('小文字混じりの識別子の大文字部分は変換しない（#50）', () => {
  const { text } = filterText('error_CODE_X は対象外。', { ...F, markdownSymbols: false });
  assert.match(text, /error_CODE_X/);
});

test('markdownSymbols を無効にすると強調の _ は残したまま定数名だけ変換する（#50）', () => {
  const { text } = filterText('_MOVEFILE_REPLACE_EXISTING_ を指定します。', { ...F, markdownSymbols: false });
  assert.match(text, /_movefile replace existing_/);
});

test('表の行は落ちる', () => {
  const { text } = filterText('前\n| 項目 | 値 |\n| --- | --- |\n| a | b |\n後', F);
  assert.doesNotMatch(text, /項目/);
  assert.match(text, /前/);
  assert.match(text, /後/);
});

test('見出し記号は外れるが本文は残る', () => {
  const { text } = filterText('## 実装完了', F);
  assert.equal(text, '実装完了');
});

test('見出し行ごと落とす設定', () => {
  const { text } = filterText('## 見出し\n本文', { ...F, headings: true });
  assert.equal(text, '本文');
});

test('箇条書きの記号と強調記号が外れる', () => {
  const { text } = filterText('- **重要** な項目', F);
  assert.equal(text, '重要 な項目');
});

test('箇条書きの項目の切れ目が marked に残る (#15)', () => {
  const { text, marked } = filterText('- 項目1\n- 項目2\n- 項目3', F);
  // 読み上げ・表示に使う text には印を残さない
  assert.equal(text, '項目1\n項目2\n項目3');
  assert.doesNotMatch(text, new RegExp(LIST_BOUNDARY));
  // 項目の切れ目は marked 側にだけ残る。末尾には続く項目が無いので印は付かない
  assert.equal(marked.split(LIST_BOUNDARY).length - 1, 2);
  assert.equal(stripListBoundaries(marked), text);
});

test('番号付きリストと入れ子の項目にも切れ目が付く (#15)', () => {
  const { marked } = filterText('1. 一つ目\n2. 二つ目\n  - 子項目', { ...F, codeBlock: 'read' });
  assert.equal(marked.split(LIST_BOUNDARY).length - 1, 2);
});

test('中身が残らなかった項目には間を置かない (#15)', () => {
  // 絵文字だけの項目は読むものが無いので、そこに間を置いても無音が伸びるだけ。
  // 空白をまとめる設定のあるなしで、間の数が変わらないこと。
  const input = '- 項目1\n- 🎉\n- 項目3';
  const count = (f) => filterText(input, f).marked.split(LIST_BOUNDARY).length - 1;
  assert.equal(count(F), 1);
  assert.equal(count({ ...F, collapseWhitespace: false }), 1);
});

test('全角スペース区切りの箇条書きにも切れ目が付く (#15)', () => {
  // 記号を外す LIST_MARKER は \s なので全角スペースも拾う。印の判定も揃える。
  const { marked, text } = filterText('-　項目1\n-　項目2', F);
  assert.equal(marked.split(LIST_BOUNDARY).length - 1, 1);
  assert.equal(text, '項目1\n項目2');
});

test('箇条書き以外の行には切れ目が付かない (#15)', () => {
  const { marked } = filterText('普通の文です。\n次の行です。\n---', F);
  assert.equal(marked.includes(LIST_BOUNDARY), false);
});

test('listPauseSec が 0 なら切れ目を付けない (#15)', () => {
  const { text, marked } = filterText('- 項目1\n- 項目2', { ...F, listPauseSec: 0 });
  assert.equal(marked.includes(LIST_BOUNDARY), false);
  assert.equal(marked, text);
});

test('切れ目の印を入れても読み上げるテキストは変わらない (#15)', () => {
  // 印は空白ではないので、対策しないと行末の空白の畳み込みと trim を素通りさせてしまう。
  // 行末の絵文字・Markdown の 2 スペース改行・中身が全部消える項目が実例。
  const inputs = [
    '- 完了しました 🎉\n- 次の項目です',
    '- 項目1  \n- 項目2',
    '- 🎉\n- 完了',
    // 中身が消える項目が続くと、先頭に残った印が trim を遮る
    '- 🎉\n- 🎉\n- 項目',
    '- 🎉\n- 🎉\n普通の文です。',
    '- 項目1\n- 🎉\n- 項目3',
    '1. 一つ目 \n2. 二つ目',
    '本文です。\n- 項目1\n- 項目2\n続きの本文です。',
  ];
  // 空白をまとめない設定でも、文数の上限と併用しても変わらないこと
  const variants = [F, { ...F, collapseWhitespace: false }, { ...F, maxSentences: 2 }];
  for (const input of inputs) {
    for (const base of variants) {
      const withPause = filterText(input, base);
      const without = filterText(input, { ...base, listPauseSec: 0 });
      assert.equal(withPause.text, without.text, `印の有無で整形結果が変わりました: ${JSON.stringify(input)}`);
    }
  }
});

test('切れ目の印は辞書の置換ルールの当たり方を変えない (#15)', () => {
  // 印が行末に居座ると `…$` のような正規表現ルールが一致しなくなる。
  // 実際の読み上げと同じ経路（切れ目で区切ってから置換）で一致することを確かめる。
  const rules = [
    { pattern: '項目$', replacement: 'アイテム', regex: true, enabled: true },
    { pattern: 'ました\\n', replacement: 'ました。', regex: true, enabled: true },
  ];
  const input = '- 完了しました\n- 次の項目';
  const withPause = filterText(input, F);
  const without = filterText(input, { ...F, listPauseSec: 0 });
  const applied = stripListBoundaries(mapListSegments(withPause.marked, (s) => applyReplacements(s, rules)));
  assert.equal(applied, applyReplacements(without.text, rules));
  assert.match(applied, /アイテム/);
});

test('空白が長く続く入力でも整形が遅くならない (#15)', () => {
  // 項目の判定・区切り線の判定・印を入れる位置のどれかに後戻りが残ると、
  // この形の入力で入力長の二乗に劣化する（デーモンは 1 スレッドなので全体が止まる）。
  const inputs = [
    `- 項目\n${' '.repeat(20000)}\n- 次の項目`, // 空白だけの行
    `- ${' '.repeat(20000)}x`, // 記号のあとに長い空白が続き、行末は空白でない
    `-${' '.repeat(20000)}- -`, // 区切り線と紛らわしい形
  ];
  for (const input of inputs) {
    const started = Date.now();
    filterText(input, F);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `整形に時間がかかりすぎです (${input.length} 文字): ${elapsed}ms`);
  }
});

test('切れ目の印は最大文字数の数えかたも変えない (#15)', () => {
  const input = '- 完了 🎉\n- 次の項目';
  const withPause = filterText(input, { ...F, maxChars: 6 });
  const without = filterText(input, { ...F, maxChars: 6, listPauseSec: 0 });
  assert.equal(withPause.text, without.text);
  assert.equal(withPause.truncated, without.truncated);
});

test('項目の切れ目は最大文字数に数えない (#15)', () => {
  const withList = filterText('- あああああ\n- いいいいい', { ...F, maxChars: 11 });
  // 「あああああ\nいいいいい」の 11 文字ちょうど。印のぶん短く切られていないこと
  assert.equal(stripListBoundaries(withList.marked), 'あああああ\nいいいいい');
  assert.equal(withList.truncated, false);
});

test('絵文字が外れる', () => {
  const { text } = filterText('完了しました 🎉', F);
  assert.equal(text.trim(), '完了しました');
});

test('thinking ブロックは読まれない', () => {
  const { text } = filterText('<thinking>内心</thinking>本文', F);
  assert.doesNotMatch(text, /内心/);
  assert.match(text, /本文/);
});

test('最大文字数で切って省略語が付く', () => {
  const { text, truncated } = filterText('あ'.repeat(200), { ...F, maxChars: 50 });
  assert.equal(truncated, true);
  assert.match(text, /以下省略/);
  assert.ok(text.length < 70);
});

test('最大文数で切る', () => {
  const { text, truncated } = filterText('一文目。二文目。三文目。', { ...F, maxSentences: 2 });
  assert.equal(truncated, true);
  assert.match(text, /^一文目。二文目。/);
  assert.doesNotMatch(text, /三文目/);
});

test('maxChars 0 は全文読み上げ', () => {
  const long = 'これは長い文章です。'.repeat(30);
  const { text, truncated } = filterText(long, { ...F, maxChars: 0 });
  assert.equal(truncated, false);
  assert.equal(text.length, long.length);
});

test('テンプレートのプレースホルダが展開される', () => {
  assert.equal(renderTemplate('{tool_name} を実行します', { tool_name: 'Bash' }), 'Bash を実行します');
  assert.equal(renderTemplate('{missing} です', {}), ' です');
});

test('置換ルールは長い表記から適用される', () => {
  const rules = [
    { pattern: 'Claude', replacement: 'クロード', enabled: true },
    { pattern: 'Claude Code', replacement: 'クロードコード', enabled: true },
  ];
  assert.equal(applyReplacements('Claude Code を使う', rules), 'クロードコード を使う');
});

test('無効な置換ルールは適用されない', () => {
  const rules = [{ pattern: 'Codex', replacement: 'X', enabled: false }];
  assert.equal(applyReplacements('Codex', rules), 'Codex');
});

test('壊れた正規表現があっても他のルールは生きる', () => {
  const rules = [
    { pattern: '[', replacement: 'x', regex: true, enabled: true },
    { pattern: 'Codex', replacement: 'コーデックス', enabled: true },
  ];
  assert.equal(applyReplacements('Codex', rules), 'コーデックス');
});

test('ユーザー辞書の読みはカタカナのみ許可', () => {
  assert.deepEqual(validateEngineWord({ surface: 'VOICEVOX', pronunciation: 'ボイスボックス', accentType: 0 }), []);
  assert.ok(validateEngineWord({ surface: 'X', pronunciation: 'ぼいすぼっくす', accentType: 0 }).length > 0);
  assert.ok(validateEngineWord({ surface: '', pronunciation: 'ア', accentType: 0 }).length > 0);
});

test('長文は文の切れ目でチャンクに割れる', () => {
  const chunks = chunkText('一文目です。二文目です。三文目です。', 12);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.text.length <= 14));
  assert.equal(chunks.map((c) => c.text).join(''), '一文目です。二文目です。三文目です。');
});

test('1 文が長すぎる場合は読点で割る', () => {
  const chunks = chunkText('あああああ、いいいいい、ううううう、えええええ', 12);
  assert.ok(chunks.length >= 2);
});

test('短い文は割らない', () => {
  assert.deepEqual(chunkText('短い文です。', 100), [{ text: '短い文です。', pauseAfter: false }]);
});

test('無効なイベントは読み上げない', () => {
  const profile = defaultConfig().targets.claudeCode;
  const r = resolveUtterance({
    eventName: 'PreToolUse',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
    profile,
    dictionary: { replacements: [] },
  });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'event-disabled');
});

test('Stop は本文を読み上げる', () => {
  const profile = defaultConfig().targets.claudeCode;
  const r = resolveUtterance({
    eventName: 'Stop',
    payload: { hook_event_name: 'Stop', last_assistant_message: '## 完了\n作業が終わりました。' },
    profile,
    dictionary: { replacements: [] },
  });
  assert.equal(r.speak, true);
  assert.match(r.text, /作業が終わりました/);
});

test('表示用の text には印を残さず、発話用の speechText にだけ残す (#15)', () => {
  const profile = defaultConfig().targets.claudeCode;
  const r = resolveUtterance({
    eventName: 'Stop',
    payload: { hook_event_name: 'Stop', last_assistant_message: '- 項目1\n- 項目2' },
    profile,
    dictionary: { replacements: [] },
  });
  assert.equal(r.speak, true);
  assert.equal(r.text, '項目1\n項目2');
  assert.equal(r.speechText.includes(LIST_BOUNDARY), true);
  assert.equal(stripListBoundaries(r.speechText), r.text);
});

/** Stop イベントの本文を渡して判定させる（無視パターンのテスト用）。 */
function resolveStop(text, ignorePatterns) {
  const profile = { ...defaultConfig().targets.claudeCode, ignorePatterns };
  return resolveUtterance({
    eventName: 'Stop',
    payload: { hook_event_name: 'Stop', last_assistant_message: text },
    profile,
    dictionary: { replacements: [] },
  });
}

test('無視パターンに一致した本文は読み上げない', () => {
  const r = resolveStop('バックグラウンドタスクの実行ログ\n終了コード 0', ['^バックグラウンドタスクの実行ログ']);
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'ignored-pattern');
});

test('無視パターンに一致しない本文は読み上げる', () => {
  const r = resolveStop('作業が終わりました。', ['^バックグラウンドタスクの実行ログ']);
  assert.equal(r.speak, true);
  assert.match(r.text, /作業が終わりました/);
});

test('無視パターンは大文字小文字を区別する', () => {
  assert.equal(resolveStop('BACKGROUND task done', ['background']).speak, true);
  assert.equal(resolveStop('background task done', ['background']).speak, false);
});

test('不正な無視パターンは飛ばして残りで判定する', () => {
  assert.equal(resolveStop('作業が終わりました。', ['[', '(?']).speak, true);
  assert.equal(resolveStop('実行ログ: 完了', ['[', '実行ログ']).reason, 'ignored-pattern');
});

test('無視パターンが未設定でも読み上げる', () => {
  // 既存の config.json にキーが無くても落ちないこと
  assert.equal(resolveStop('作業が終わりました。', undefined).speak, true);
});

test('無視パターンが配列でなくても落ちない', () => {
  // 手編集で型が崩れた config.json を読み込んだ場合
  for (const broken of [{}, 'ログ', 42, null]) {
    assert.equal(resolveStop('作業が終わりました。', broken).speak, true);
  }
  // 配列の中身が文字列でない場合も同じ
  assert.equal(resolveStop('作業が終わりました。', [null, 3, {}]).speak, true);
});

// 照合が終わらないパターン。繰り返しを並べるほど重くなる。
const heavy = (repeats) => `${'a*'.repeat(repeats)}X`;
// 時間切れの記録はモジュールに溜まるので、時間を測るテストは毎回まっさらから始める。
const LONG_TEXT = `${'a'.repeat(4000)}!`;

/** 経過時間をミリ秒で測る。数ミリ秒を見るので performance.now を使う。 */
function measure(fn) {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

test('照合が終わらないパターンは時間で打ち切る', () => {
  // 素の RegExp では終わらない書き方。打ち切って読み上げに進むこと。
  // (a+)+$ は繰り返しの入れ子、a*a*X はグループ無しでも計算量が跳ねる例。
  resetIgnoreMatchState();
  for (const pattern of ['(a+)+$', '(a|aa)+$', heavy(2), '^a*a*a*a*a*a*a*a*X$']) {
    const { value, ms } = measure(() => resolveStop(LONG_TEXT, [pattern]));
    assert.equal(value.speak, true, pattern);
    assert.ok(ms < IGNORE_MATCH_BUDGET_MS * 3, `${pattern} の打ち切りに ${ms}ms かかった`);
  }
});

test('打ち切りの予算はパターン全体で共有する', () => {
  // 重いパターンを並べても、1 回の判定にかかる時間は予算の範囲に収まること
  resetIgnoreMatchState();
  const patterns = Array.from({ length: 5 }, (_, i) => heavy(3 + i));
  const { value, ms } = measure(() => resolveStop(LONG_TEXT, patterns));
  assert.equal(value.speak, true);
  assert.ok(ms < IGNORE_MATCH_BUDGET_MS * 3, `${ms}ms かかった`);
});

test('空のパターンが並んでいても予算を超えない', () => {
  // 予算切れの判定を空文字より先に行っていること
  resetIgnoreMatchState();
  const patterns = [heavy(9), ...Array.from({ length: 10000 }, () => '')];
  const { value, ms } = measure(() => resolveStop(LONG_TEXT, patterns));
  assert.equal(value.speak, true);
  assert.ok(ms < IGNORE_MATCH_BUDGET_MS * 3, `${ms}ms かかった`);
});

test('使えなかった無視パターンは理由が残る', () => {
  // 黙って飛ばすだけだと「書いたのに効かない」が無通知になる
  const r = resolveStop('作業が終わりました。', ['[']);
  assert.equal(r.speak, true);
  assert.deepEqual(r.problems, ['無視パターン 1（[）は正規表現として解釈できません']);
  assert.equal(resolveStop('作業が終わりました。', ['^実行ログ']).problems.length, 0);
});

test('理由の文面は長いパターンを短く切る', () => {
  // ログに設定の全文を流し込まない
  const long = `^${'あ'.repeat(200)}`;
  const [problem] = resolveStop('作業が終わりました。', [`${long}(`]).problems;
  assert.ok(problem.length < 120, problem);
  assert.match(problem, /…/);
});

test('時間切れになったパターンは次から短い時間で試す', () => {
  resetIgnoreMatchState();
  const pattern = heavy(10);
  const first = measure(() => resolveStop(LONG_TEXT, [pattern]));
  assert.match(first.value.problems[0], /時間内に終わりません/);
  assert.ok(first.ms >= IGNORE_MATCH_PATTERN_MS / 2, `${first.ms}ms しかかかっていない`);

  // 2 回目は短い時間で打ち切る。絶対値ではなく初回との比で見る（実行環境の速さに左右されないように）
  const second = measure(() => resolveStop(LONG_TEXT, [pattern]));
  assert.equal(second.value.speak, true);
  assert.match(second.value.problems[0], /時間内に終わりません/);
  assert.ok(second.ms < first.ms / 2, `初回 ${first.ms}ms に対して 2 回目が ${second.ms}ms`);

  // 本文が短ければ短い枠でも間に合うので、同じパターンがちゃんと効く
  const short = resolveStop('aaX', [pattern]);
  assert.equal(short.speak, false);
  assert.equal(short.reason, 'ignored-pattern');
  assert.deepEqual(short.problems, []);

  // 短い本文で間に合っても枠は戻さない。長短が交互に来ても毎回止まらないこと
  const third = measure(() => resolveStop(LONG_TEXT, [pattern]));
  assert.equal(third.value.speak, true);
  assert.ok(third.ms < first.ms / 2, `${third.ms}ms かかった`);
});

test('記録を捨てると時間切れのパターンをまた測り直す', () => {
  resetIgnoreMatchState();
  const pattern = heavy(12);
  assert.match(resolveStop(LONG_TEXT, [pattern]).problems[0], /時間内に終わりません/);
  const shortLeash = measure(() => resolveStop(LONG_TEXT, [pattern]));

  resetIgnoreMatchState();
  const again = measure(() => resolveStop(LONG_TEXT, [pattern]));
  assert.ok(again.ms > shortLeash.ms * 2, `捨てる前 ${shortLeash.ms}ms、捨てた後 ${again.ms}ms`);
});

test('重いパターンの後ろでも軽いパターンは判定される', () => {
  // 打ち切った後も予算が残るので、後ろのパターンで一致を拾えること。
  // 初回（重いパターンが予算を食う可能性がある）と 2 回目の両方で確かめる
  const text = `${'a'.repeat(4000)}! 実行ログ`;
  for (const attempt of ['初回', '2 回目']) {
    const r = resolveStop(text, [heavy(11), '実行ログ']);
    assert.equal(r.speak, false, attempt);
    assert.equal(r.reason, 'ignored-pattern', attempt);
  }
});

test('ターゲット全体を無効にすると読み上げない', () => {
  const profile = { ...defaultConfig().targets.claudeCode, enabled: false };
  const r = resolveUtterance({
    eventName: 'Stop',
    payload: { hook_event_name: 'Stop', last_assistant_message: 'テスト' },
    profile,
    dictionary: { replacements: [] },
  });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'target-disabled');
});

test('ツールの拒否リストが効く', () => {
  const profile = defaultConfig().targets.claudeCode;
  profile.events.PreToolUse.enabled = true;
  profile.toolFilter = { mode: 'denylist', allow: [], deny: ['Read', 'mcp__*'] };

  assert.equal(resolveUtterance({
    eventName: 'PreToolUse',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Read' },
    profile, dictionary: { replacements: [] },
  }).speak, false);

  assert.equal(resolveUtterance({
    eventName: 'PreToolUse',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'mcp__foo__bar' },
    profile, dictionary: { replacements: [] },
  }).speak, false);

  assert.equal(resolveUtterance({
    eventName: 'PreToolUse',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
    profile, dictionary: { replacements: [] },
  }).speak, true);
});

test('Codex には Notification が無く PermissionRequest がある', () => {
  const cfg = defaultConfig();
  assert.ok(!('Notification' in cfg.targets.codex.events));
  assert.ok('PermissionRequest' in cfg.targets.codex.events);
  assert.ok('Notification' in cfg.targets.claudeCode.events);
  assert.ok(!('PermissionRequest' in cfg.targets.claudeCode.events));
});

test('WAV の再生時間をヘッダから算出できる', () => {
  // 24kHz / 16bit / モノラル で 1 秒ぶん
  const sampleRate = 24000;
  const byteRate = sampleRate * 2;
  const dataSize = byteRate;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  assert.equal(wavDurationMs(buf), 1000);
});
