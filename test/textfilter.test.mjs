// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterText, renderTemplate } from '../src/daemon/textfilter.js';
import { chunkText } from '../src/daemon/queue.js';
import { applyReplacements, validateEngineWord } from '../src/daemon/dictionary.js';
import { resolveUtterance } from '../src/daemon/events.js';
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
  assert.ok(chunks.every((c) => c.length <= 14));
  assert.equal(chunks.join(''), '一文目です。二文目です。三文目です。');
});

test('1 文が長すぎる場合は読点で割る', () => {
  const chunks = chunkText('あああああ、いいいいい、ううううう、えええええ', 12);
  assert.ok(chunks.length >= 2);
});

test('短い文は割らない', () => {
  assert.deepEqual(chunkText('短い文です。', 100), ['短い文です。']);
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
