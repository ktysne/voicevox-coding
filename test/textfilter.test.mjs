// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterText, renderTemplate } from '../src/daemon/textfilter.js';
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
// 一度時間切れになったものは次から短い枠で試されるので、テストごとに違う数で作る。
const heavy = (repeats) => `${'a*'.repeat(repeats)}X`;

test('照合が終わらないパターンは時間で打ち切る', () => {
  // 素の RegExp では終わらない書き方。打ち切って読み上げに進むこと。
  // (a+)+$ は繰り返しの入れ子、a*a*X はグループ無しでも計算量が跳ねる例。
  const text = `${'a'.repeat(4000)}!`;
  for (const pattern of ['(a+)+$', '(a|aa)+$', heavy(2), '^a*a*a*a*a*a*a*a*X$']) {
    const started = Date.now();
    const r = resolveStop(text, [pattern]);
    assert.equal(r.speak, true, pattern);
    assert.ok(
      Date.now() - started < IGNORE_MATCH_BUDGET_MS * 3,
      `${pattern} の打ち切りに ${Date.now() - started}ms かかった`,
    );
  }
});

test('打ち切りの予算はパターン全体で共有する', () => {
  // 重いパターンを並べても、1 回の判定にかかる時間は予算の範囲に収まること
  const patterns = Array.from({ length: 5 }, (_, i) => heavy(3 + i));
  const started = Date.now();
  assert.equal(resolveStop(`${'a'.repeat(4000)}!`, patterns).speak, true);
  assert.ok(Date.now() - started < IGNORE_MATCH_BUDGET_MS * 3, `${Date.now() - started}ms かかった`);
});

test('空のパターンが並んでいても予算を超えない', () => {
  // 予算切れの判定を空文字より先に行っていること
  const patterns = [heavy(9), ...Array.from({ length: 10000 }, () => '')];
  const started = Date.now();
  assert.equal(resolveStop(`${'a'.repeat(4000)}!`, patterns).speak, true);
  assert.ok(Date.now() - started < IGNORE_MATCH_BUDGET_MS * 3, `${Date.now() - started}ms かかった`);
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
  const text = `${'a'.repeat(4000)}!`;
  const pattern = heavy(10);
  const first = Date.now();
  const r1 = resolveStop(text, [pattern]);
  const firstMs = Date.now() - first;
  assert.match(r1.problems[0], /時間内に終わりません/);
  assert.ok(firstMs >= IGNORE_MATCH_PATTERN_MS / 2, `${firstMs}ms しかかかっていない`);

  // 2 回目は短い時間で打ち切る。絶対値ではなく初回との比で見る（実行環境の速さに左右されないように）
  const second = Date.now();
  const r2 = resolveStop(text, [pattern]);
  const secondMs = Date.now() - second;
  assert.equal(r2.speak, true);
  assert.match(r2.problems[0], /時間内に終わりません/);
  assert.ok(secondMs < firstMs / 2, `初回 ${firstMs}ms に対して 2 回目が ${secondMs}ms`);

  // 本文が短ければ短い枠でも間に合うので、同じパターンがちゃんと効く
  const short = resolveStop('aaX', [pattern]);
  assert.equal(short.speak, false);
  assert.equal(short.reason, 'ignored-pattern');
  assert.deepEqual(short.problems, []);

  // 短い本文で間に合っても枠は戻さない。長短が交互に来ても毎回止まらないこと
  const third = Date.now();
  assert.equal(resolveStop(text, [pattern]).speak, true);
  assert.ok(Date.now() - third < firstMs / 2, `${Date.now() - third}ms かかった`);
});

test('設定を直したら時間切れの記録は測り直す', () => {
  const text = `${'a'.repeat(4000)}!`;
  const pattern = heavy(12);
  assert.match(resolveStop(text, [pattern]).problems[0], /時間内に終わりません/);

  const shortLeash = Date.now();
  resolveStop(text, [pattern]);
  const shortLeashMs = Date.now() - shortLeash;

  resetIgnoreMatchState();
  const again = Date.now();
  resolveStop(text, [pattern]);
  assert.ok(Date.now() - again > shortLeashMs, '記録を捨てたのに短い枠のままだった');
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
