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

test('ファイルパスはファイル名だけ残る（語頭を食わない）', () => {
  const { text } = filterText('src/daemon/queue.js を更新しました', { ...F, inlineCode: 'read' });
  assert.match(text, /^queue\.js を更新しました$/);
});

test('Windows のフルパスもファイル名だけになる', () => {
  const { text } = filterText('D:\\Desktop\\Develop\\project\\index.ts も要更新', F);
  assert.match(text, /index\.ts/);
  assert.doesNotMatch(text, /Desktop/);
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
