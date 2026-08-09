// 管理コンソール。
// 設定は data-path 属性で config のパスに紐づけ、入力イベントを委譲で拾って
// 部分更新する。テキスト入力中に再描画してフォーカスが飛ぶのを避けるため、
// 再描画は「行の追加・削除」「タブ切り替え」など構造が変わるときだけ行う。

const state = {
  config: null,
  catalog: null,
  speakers: [],
  engine: null,
  activeTab: 'claudeCode',
};

const SAMPLE_TEXT = `## 実装が完了しました

\`src/daemon/queue.js\` にキュー処理を追加しました。詳細は https://example.com/docs を参照してください。

\`\`\`js
const x = 1;
\`\`\`

- 1つ目の変更点
- 2つ目の変更点

**注意**: D:\\Desktop\\Develop\\project\\src\\index.ts も更新が必要です 🎉`;

// ---------------------------------------------------------------- ユーティリティ

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o === undefined || o === null ? o : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

// ---------------------------------------------------------------- 保存

let saveTimer;
let savePending = false;

function scheduleSave() {
  savePending = true;
  $('#save-indicator').textContent = '編集中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  if (!savePending) return;
  savePending = false;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(state.config) });
    $('#save-indicator').textContent = '保存しました';
    setTimeout(() => {
      if (!savePending) $('#save-indicator').textContent = '';
    }, 1800);
  } catch (err) {
    $('#save-indicator').textContent = '';
    toast(`保存に失敗しました: ${err.message}`, true);
  }
}

/**
 * data-path を持つ入力の変更を config に反映する（委譲ハンドラ）。
 * input と change の両方を購読しているので、要素ごとにどちらか一方だけを採用する。
 */
function onInputChange(event) {
  const el = event.target.closest('[data-path]');
  if (!el) return;

  const isToggle = el.type === 'checkbox' || el.tagName === 'SELECT';
  if (isToggle && event.type !== 'change') return;
  if (!isToggle && event.type !== 'input') return;

  const path = el.dataset.path;
  let value;
  if (el.type === 'checkbox') value = el.checked;
  else if (el.type === 'number' || el.type === 'range') value = Number(el.value);
  else value = el.value;

  if (el.dataset.cast === 'int') value = parseInt(value, 10) || 0;
  setPath(state.config, path, value);

  const out = el.parentElement?.querySelector('output');
  if (out && (el.type === 'range' || el.type === 'number')) out.textContent = formatNumber(value);

  if (el.dataset.rerender === 'true') renderActivePanel();
  scheduleSave();
}

function formatNumber(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// ---------------------------------------------------------------- 共通パーツ

function checkboxRow(label, path, hint) {
  return h(
    'div',
    { class: 'row' },
    h('label', {}, ''),
    h('label', { style: 'min-width:auto;display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--text)' },
      h('input', { type: 'checkbox', 'data-path': path, ...(getPath(state.config, path) ? { checked: true } : {}) }),
      label),
    hint ? h('span', { class: 'hint', style: 'margin:0' }, hint) : null,
  );
}

function selectRow(label, path, options, { rerender = false, hint } = {}) {
  const value = getPath(state.config, path);
  return h(
    'div',
    { class: 'row' },
    h('label', {}, label),
    h('select', { 'data-path': path, 'data-rerender': rerender ? 'true' : null },
      options.map((o) => h('option', { value: o.value, ...(String(o.value) === String(value) ? { selected: true } : {}) }, o.label))),
    hint ? h('span', { class: 'hint', style: 'margin:0' }, hint) : null,
  );
}

function textRow(label, path, { placeholder, width = '320px', hint } = {}) {
  return h(
    'div',
    { class: 'row' },
    h('label', {}, label),
    h('input', { type: 'text', 'data-path': path, value: getPath(state.config, path) ?? '', placeholder, style: `width:${width}` }),
    hint ? h('span', { class: 'hint', style: 'margin:0' }, hint) : null,
  );
}

function numberRow(label, path, { min, max, step = 1, hint } = {}) {
  return h(
    'div',
    { class: 'row' },
    h('label', {}, label),
    h('input', { type: 'number', 'data-path': path, value: getPath(state.config, path) ?? 0, min, max, step, style: 'width:110px' }),
    hint ? h('span', { class: 'hint', style: 'margin:0' }, hint) : null,
  );
}

function sliderRow(param, basePath) {
  const path = `${basePath}.${param.key}`;
  const value = getPath(state.config, path) ?? param.default;
  return h(
    'div',
    { class: 'slider-row' },
    h('span', {}, param.label),
    h('input', { type: 'range', 'data-path': path, min: param.min, max: param.max, step: param.step, value }),
    h('output', {}, `${formatNumber(value)}${param.unit}`),
  );
}

// ---------------------------------------------------------------- ターゲット用パネル

function renderTargetPanel(targetId) {
  const targetMeta = state.catalog.targets.find((t) => t.id === targetId);
  const base = `targets.${targetId}`;
  const profile = state.config.targets[targetId];
  const panel = h('div', {});

  // --- 基本 ---
  panel.append(
    h('section', { class: 'card' },
      h('h2', {}, `${targetMeta.label} の読み上げ`),
      h('p', { class: 'card-desc' }, 'このターゲットの読み上げ全体を切り替えます。オフにするとフックを受け取っても何も喋りません。'),
      checkboxRow('読み上げを有効にする', `${base}.enabled`),
      renderSpeakerRow(base, profile),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('label', {}, '声の調整'),
        h('div', { style: 'flex:1;display:grid;gap:8px;min-width:320px' },
          state.catalog.voiceParams.map((p) => sliderRow(p, `${base}.voice`)))),
      h('div', { class: 'row' },
        h('label', {}, ''),
        h('button', { class: 'btn btn-sm', onclick: () => preview(targetId, 'このくらいの速さで読み上げます。調整してみてください。', true) }, '試聴'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => resetVoice(targetId) }, '既定値に戻す')),
    ),
  );

  // --- イベント ---
  panel.append(renderEventsCard(targetId, targetMeta, base));

  // --- ツールフィルタ ---
  panel.append(renderToolFilterCard(targetId, base, profile));

  // --- 読み上げ要素フィルタ ---
  panel.append(renderTextFilterCard(base));

  // --- キュー ---
  panel.append(
    h('section', { class: 'card' },
      h('h2', {}, '発話の重なり方'),
      h('p', { class: 'card-desc' },
        '読み上げ中に次のイベントが来たときの挙動です。'
        + '途中経過を読み上げる場合は「順番に並べて全部読む」でないと、次の説明文が来るたびに前が切れます。'),
      selectRow('新しい発話が来たら', `${base}.queue.policy`, [
        { value: 'replace', label: '現在の読み上げを止めて差し替える' },
        { value: 'enqueue', label: '順番に並べて全部読む' },
        { value: 'drop', label: '読み上げ中なら無視する' },
      ]),
      numberRow('キューの最大数', `${base}.queue.maxQueue`, { min: 1, max: 50 }),
      numberRow('同一文の抑止時間', `${base}.queue.dedupeWindowSec`, { min: 0, max: 120, hint: '秒。この時間内の同じ文は読み飛ばします（0 で無効）' }),
    ),
  );

  // --- プレビュー ---
  panel.append(renderPreviewCard(targetId));

  return panel;
}

function renderSpeakerRow(base, profile) {
  const options = [];
  if (state.speakers.length === 0) {
    options.push({ value: profile.speaker, label: `話者 ID ${profile.speaker}（エンジン未接続のため一覧を取得できません）` });
  } else {
    for (const s of state.speakers) {
      for (const st of s.styles) {
        options.push({ value: st.id, label: `${s.name}（${st.name}）` });
      }
    }
  }
  const value = profile.speaker;
  return h(
    'div',
    { class: 'row' },
    h('label', {}, '話者'),
    h('select', { 'data-path': `${base}.speaker`, 'data-cast': 'int', style: 'min-width:280px' },
      options.map((o) => h('option', { value: o.value, ...(String(o.value) === String(value) ? { selected: true } : {}) }, o.label))),
    h('button', { class: 'btn btn-sm btn-ghost', onclick: refreshSpeakers }, '一覧を更新'),
  );
}

function renderEventsCard(targetId, targetMeta, base) {
  const rows = targetMeta.events.map((ev) => {
    const path = `${base}.events.${ev.name}`;
    const setting = getPath(state.config, path) ?? {};
    const modeOptions = [
      ev.supportsFullText ? { value: 'fullText', label: '本文を読む' } : null,
      { value: 'template', label: '定型文' },
    ].filter(Boolean);

    return h(
      'tr',
      {},
      h('td', { class: 'col-narrow' },
        h('input', { type: 'checkbox', 'data-path': `${path}.enabled`, 'data-rerender': 'true', ...(setting.enabled ? { checked: true } : {}) })),
      h('td', {},
        h('span', { class: 'event-label' }, ev.label),
        h('span', { class: 'event-name' }, ev.name),
        h('span', { class: 'event-desc' }, ev.description)),
      h('td', { class: 'col-mid' },
        h('select', { 'data-path': `${path}.mode`, 'data-rerender': 'true', disabled: !setting.enabled },
          modeOptions.map((o) => h('option', { value: o.value, ...(o.value === setting.mode ? { selected: true } : {}) }, o.label)))),
      h('td', {},
        setting.mode === 'fullText'
          ? h('span', { class: 'hint', style: 'margin:0' }, '本文が取れないときは下の定型文を読みます')
          : null,
        h('input', {
          type: 'text',
          'data-path': `${path}.template`,
          value: setting.template ?? '',
          disabled: !setting.enabled,
          placeholder: ev.placeholders.length ? `例: ${ev.placeholders.join(' ')} が使えます` : '読み上げる定型文',
        })),
    );
  });

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, '読み上げるイベント'),
    h('p', { class: 'card-desc' }, 'どのタイミングで喋るかを選びます。ツール実行前後は発火が多いので、必要なときだけ有効にしてください。'),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { class: 'col-narrow' }, '読む'),
        h('th', {}, 'イベント'),
        h('th', { class: 'col-mid' }, '読み方'),
        h('th', {}, '定型文'))),
      h('tbody', {}, rows)),
  );
}

function renderToolFilterCard(targetId, base, profile) {
  const mode = profile.toolFilter?.mode ?? 'all';
  const listKey = mode === 'allowlist' ? 'allow' : 'deny';
  const list = profile.toolFilter?.[listKey] ?? [];

  const listEditor = mode === 'all'
    ? h('p', { class: 'hint' }, 'すべてのツールを対象にします。')
    : h('div', {},
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'ツール名（* でワイルドカード）'), h('th', { class: 'col-narrow' }, ''))),
          h('tbody', {}, list.map((name, i) => h('tr', {},
            h('td', {}, h('input', { type: 'text', 'data-path': `${base}.toolFilter.${listKey}.${i}`, value: name, placeholder: '例: Bash, mcp__*' })),
            h('td', {}, h('button', { class: 'btn btn-sm btn-danger btn-ghost', onclick: () => removeArrayItem(`${base}.toolFilter.${listKey}`, i) }, '削除')))))),
        h('button', { class: 'btn btn-sm', style: 'margin-top:10px', onclick: () => pushArrayItem(`${base}.toolFilter.${listKey}`, '') }, '+ 追加'));

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'ツールの絞り込み'),
    h('p', { class: 'card-desc' }, 'ツール実行前後・許可待ちのイベントに適用します。'),
    selectRow('対象', `${base}.toolFilter.mode`, [
      { value: 'all', label: 'すべてのツール' },
      { value: 'allowlist', label: '指定したツールだけ読む' },
      { value: 'denylist', label: '指定したツールを読まない' },
    ], { rerender: true }),
    listEditor,
  );
}

function renderTextFilterCard(base) {
  const f = `${base}.textFilter`;
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, '本文のどこを読むか'),
    h('p', { class: 'card-desc' }, '本文を読み上げるとき、要素ごとに扱いを決めます。下のプレビューで結果を確認できます。'),
    h('div', { class: 'grid-2' },
      h('div', {},
        selectRow('コードブロック', `${f}.codeBlock`, [
          { value: 'placeholder', label: '定型語に置き換える' },
          { value: 'omit', label: '完全に飛ばす' },
          { value: 'read', label: 'そのまま読む' },
        ], { rerender: true }),
        getPath(state.config, `${f}.codeBlock`) === 'placeholder'
          ? textRow('　置き換える語', `${f}.codeBlockPlaceholder`, { width: '200px' })
          : null,
        selectRow('インラインコード', `${f}.inlineCode`, [
          { value: 'strip', label: '記号だけ外して読む' },
          { value: 'omit', label: '飛ばす' },
          { value: 'read', label: 'そのまま読む' },
        ]),
        selectRow('URL', `${f}.url`, [
          { value: 'placeholder', label: '定型語に置き換える' },
          { value: 'omit', label: '飛ばす' },
          { value: 'read', label: 'そのまま読む' },
        ], { rerender: true }),
        getPath(state.config, `${f}.url`) === 'placeholder'
          ? textRow('　置き換える語', `${f}.urlPlaceholder`, { width: '200px' })
          : null,
        selectRow('ファイルパス', `${f}.filePath`, [
          { value: 'basename', label: 'ファイル名だけ読む' },
          { value: 'omit', label: '飛ばす' },
          { value: 'read', label: 'フルパスを読む' },
        ]),
        selectRow('表', `${f}.table`, [
          { value: 'omit', label: '飛ばす' },
          { value: 'read', label: '中身を読む' },
        ]),
      ),
      h('div', {},
        checkboxRow('見出し行ごと飛ばす', `${f}.headings`),
        checkboxRow('箇条書きの記号を外す', `${f}.listMarkers`),
        checkboxRow('Markdown 記号を外す', `${f}.markdownSymbols`),
        checkboxRow('絵文字を外す', `${f}.emoji`),
        checkboxRow('HTML タグを外す', `${f}.htmlTags`),
        checkboxRow('thinking ブロックを外す', `${f}.thinkingBlocks`),
        checkboxRow('連続する空白・改行をまとめる', `${f}.collapseWhitespace`),
      )),
    h('div', { style: 'margin-top:14px;border-top:1px solid var(--border);padding-top:14px' },
      numberRow('最大文字数', `${f}.maxChars`, { min: 0, max: 100000, hint: '0 で無制限（全文読み上げ）' }),
      numberRow('最大文数', `${f}.maxSentences`, { min: 0, max: 500, hint: '0 で無制限。先頭から数文だけ読みたいときに' }),
      textRow('省略時に付ける語', `${f}.truncationSuffix`, { width: '200px' })),
  );
}

function renderPreviewCard(targetId) {
  const textarea = h('textarea', { rows: 10 }, SAMPLE_TEXT);
  const output = h('div', { class: 'preview-out' }, '「整形を確認」を押すと、実際に読み上げるテキストが表示されます。');

  const runFilter = async () => {
    try {
      const r = await api('/api/filter-preview', {
        method: 'POST',
        body: JSON.stringify({ target: targetId, text: textarea.value }),
      });
      output.textContent = r.text || '（読み上げるテキストが残りませんでした）';
      output.append(h('div', { class: 'hint', style: 'margin-top:8px' }, `${r.chars} 文字${r.truncated ? '・省略あり' : ''}`));
    } catch (err) {
      toast(err.message, true);
    }
  };

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'プレビュー'),
    h('p', { class: 'card-desc' }, '応答テキストを貼り付けて、整形結果と実際の読み上げを確認できます。'),
    textarea,
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'btn', onclick: runFilter }, '整形を確認'),
      h('button', { class: 'btn btn-primary', onclick: () => preview(targetId, textarea.value, false) }, '読み上げてみる')),
    output,
  );
}

// ---------------------------------------------------------------- 辞書パネル

function renderDictionaryPanel() {
  const panel = h('div', {});
  const reps = state.config.dictionary.replacements ?? [];
  const words = state.config.dictionary.engineWords ?? [];

  panel.append(
    h('section', { class: 'card' },
      h('h2', {}, '置換ルール'),
      h('p', { class: 'card-desc' }, '合成する前にテキストを書き換えます。Claude Code と Codex の両方に適用されます。長い表記から順に適用されます。'),
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'col-narrow' }, '有効'),
          h('th', {}, '対象の表記'),
          h('th', {}, '読ませたい表記'),
          h('th', { class: 'col-narrow' }, '正規表現'),
          h('th', { class: 'col-narrow' }, ''))),
        h('tbody', {}, reps.map((r, i) => h('tr', {},
          h('td', {}, h('input', { type: 'checkbox', 'data-path': `dictionary.replacements.${i}.enabled`, ...(r.enabled !== false ? { checked: true } : {}) })),
          h('td', {}, h('input', { type: 'text', 'data-path': `dictionary.replacements.${i}.pattern`, value: r.pattern ?? '', placeholder: 'Codex' })),
          h('td', {}, h('input', { type: 'text', 'data-path': `dictionary.replacements.${i}.replacement`, value: r.replacement ?? '', placeholder: 'コーデックス' })),
          h('td', {}, h('input', { type: 'checkbox', 'data-path': `dictionary.replacements.${i}.regex`, ...(r.regex ? { checked: true } : {}) })),
          h('td', {}, h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: () => removeArrayItem('dictionary.replacements', i) }, '削除')))))),
      h('button', { class: 'btn btn-sm', style: 'margin-top:10px', onclick: () => pushArrayItem('dictionary.replacements', { pattern: '', replacement: '', regex: false, enabled: true }) }, '+ ルールを追加'),
      h('p', { class: 'hint' }, '正規表現をオフにすると大文字小文字を区別せず一致します。オンのときは JavaScript の正規表現として解釈します。')),
  );

  panel.append(
    h('section', { class: 'card' },
      h('h2', {}, 'VOICEVOX ユーザー辞書'),
      h('p', { class: 'card-desc' }, 'エンジンの形態素解析器に読みとアクセントを教えます。置換と違って活用形にも効くため、固有名詞の誤読はこちらが確実です。'),
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'col-narrow' }, '有効'),
          h('th', {}, '表記'),
          h('th', {}, '読み（全角カタカナ）'),
          h('th', { class: 'col-narrow' }, 'アクセント'),
          h('th', { class: 'col-mid' }, '品詞'),
          h('th', { class: 'col-narrow' }, '優先度'),
          h('th', { class: 'col-narrow' }, ''))),
        h('tbody', {}, words.map((w, i) => h('tr', {},
          h('td', {}, h('input', { type: 'checkbox', 'data-path': `dictionary.engineWords.${i}.enabled`, ...(w.enabled !== false ? { checked: true } : {}) })),
          h('td', {}, h('input', { type: 'text', 'data-path': `dictionary.engineWords.${i}.surface`, value: w.surface ?? '', placeholder: 'VOICEVOX' })),
          h('td', {}, h('input', { type: 'text', 'data-path': `dictionary.engineWords.${i}.pronunciation`, value: w.pronunciation ?? '', placeholder: 'ボイスボックス' })),
          h('td', {}, h('input', { type: 'number', 'data-path': `dictionary.engineWords.${i}.accentType`, value: w.accentType ?? 0, min: 0, max: 30, style: 'width:60px' })),
          h('td', {}, h('select', { 'data-path': `dictionary.engineWords.${i}.wordType` },
            [['PROPER_NOUN', '固有名詞'], ['COMMON_NOUN', '一般名詞'], ['VERB', '動詞'], ['ADJECTIVE', '形容詞'], ['SUFFIX', '語尾']]
              .map(([v, l]) => h('option', { value: v, ...((w.wordType ?? 'PROPER_NOUN') === v ? { selected: true } : {}) }, l)))),
          h('td', {}, h('input', { type: 'number', 'data-path': `dictionary.engineWords.${i}.priority`, value: w.priority ?? 8, min: 0, max: 10, style: 'width:60px' })),
          h('td', {}, h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: () => removeArrayItem('dictionary.engineWords', i) }, '削除')))))),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn btn-sm', onclick: () => pushArrayItem('dictionary.engineWords', { surface: '', pronunciation: '', accentType: 0, wordType: 'PROPER_NOUN', priority: 8, enabled: true }) }, '+ 単語を追加'),
        h('button', { class: 'btn btn-sm btn-primary', onclick: syncDictionary }, 'エンジンに反映')),
      h('p', { class: 'hint' }, 'アクセント位置は 0 で平板、1 以上でその番目のモーラの直後に下がります。反映にはエンジンの起動が必要です。')),
  );

  return panel;
}

// ---------------------------------------------------------------- エンジンパネル

function renderEnginePanel() {
  const panel = h('div', {});

  if (state.engine && !state.engine.available) {
    panel.append(h('div', { class: 'banner banner-warn' },
      `VOICEVOX ENGINE に接続できません（${state.engine.baseUrl}）。VOICEVOX を起動するか、下の接続先を確認してください。`));
  }

  const managed = state.engineProcess?.managed;
  panel.append(
    h('section', { class: 'card' },
      h('h2', {}, 'VOICEVOX エンジン'),
      h('p', { class: 'card-desc' },
        'VOICEVOX アプリ（GUI）は不要です。同梱のエンジン単体を直接起動して使います。'),
      h('div', { class: 'row' },
        h('label', {}, '現在の状態'),
        h('span', {},
          state.engine?.available
            ? `接続中（version ${state.engine.version}）${managed ? ' — このデーモンが起動' : ' — 別プロセスが起動'}`
            : 'エンジンは動いていません'),
        state.engine?.available
          ? h('button', { class: 'btn btn-sm', disabled: !managed, title: managed ? '' : 'このデーモンが起動したエンジンではないため停止できません', onclick: () => engineAction('stop') }, 'エンジンを停止')
          : h('button', { class: 'btn btn-sm btn-primary', onclick: () => engineAction('start') }, 'エンジンを起動')),
      textRow('接続先', 'engine.baseUrl', { width: '320px', placeholder: 'http://127.0.0.1:50021' }),
      h('div', { class: 'row' },
        h('label', {}, 'エンジンの実行ファイル'),
        h('input', { type: 'text', 'data-path': 'engine.enginePath', value: getPath(state.config, 'engine.enginePath') ?? '', placeholder: '空欄なら自動検出します（例: F:\\VOICEVOX\\vv-engine\\run.exe）', style: 'width:480px' }),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: detectEngine }, '自動検出')),
      checkboxRow('デーモン起動時にエンジンも起動する', 'engine.autoStart'),
      checkboxRow('デーモン終了時にエンジンも停止する', 'engine.stopOnExit'),
      checkboxRow('GPU を使う', 'engine.useGpu', '対応環境のみ。切り替え後はエンジンの再起動が必要です'),
      checkboxRow('起動時に全モデルを読み込む', 'engine.loadAllModels', '起動は遅くなりますが、初回の合成が速くなります'),
      numberRow('落ちていたら再起動する間隔', 'engine.healthCheckSec', { min: 0, max: 3600, hint: '秒。0 で無効' }),
      numberRow('起動待ちの上限', 'engine.startTimeoutSec', { min: 10, max: 600, hint: '秒。初回はモデル読み込みで時間がかかります' }),
      numberRow('合成のタイムアウト', 'engine.timeoutSec', { min: 5, max: 600, hint: '秒' }),
      h('div', { class: 'row' },
        h('label', {}, ''),
        h('button', { class: 'btn btn-sm', onclick: refreshState }, '接続を確認'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: refreshSpeakers }, '話者一覧を取得')),
    ),
  );

  panel.append(
    h('section', { class: 'card' },
      h('h2', {}, 'デーモン'),
      h('p', { class: 'card-desc' }, 'ポートを変更した場合はデーモンの再起動が必要です。'),
      numberRow('待ち受けポート', 'daemon.port', { min: 1024, max: 65535 }),
      selectRow('ログの詳細度', 'daemon.logLevel', [
        { value: 'debug', label: 'debug（読み上げをスキップした理由まで残す）' },
        { value: 'info', label: 'info' },
        { value: 'warn', label: 'warn' },
        { value: 'error', label: 'error' },
      ]),
      checkboxRow('合成結果をキャッシュする', 'daemon.cacheEnabled'),
      numberRow('キャッシュ上限', 'daemon.cacheMaxEntries', { min: 0, max: 5000, hint: 'ファイル数' }),
      checkboxRow('タスクトレイに常駐する', 'daemon.tray', '変更にはデーモンの再起動が必要です'),
    ),
  );

  panel.append(
    h('section', { class: 'card' },
      h('h2', {}, '設定ファイル'),
      h('p', { class: 'card-desc' }, '直接編集しても保存した時点で自動的に読み込まれます。'),
      h('code', { style: 'font-family:var(--mono);color:var(--text-dim)' }, state.configPath ?? '%USERPROFILE%\\.voicevox-coding\\config.json')),
  );

  return panel;
}

// ---------------------------------------------------------------- ログパネル

let logView = null;

function renderLogsPanel() {
  logView = h('div', { class: 'log-view' });
  const panel = h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('button', { class: 'btn btn-sm', onclick: loadLogs }, '再読み込み'),
      h('span', { class: 'hint', style: 'margin:0' }, 'デーモンの動作ログ。読み上げをスキップした理由は debug レベルで残ります。')),
    logView);
  loadLogs();
  return panel;
}

function appendLog(entry) {
  if (!logView) return;
  const atBottom = logView.scrollHeight - logView.scrollTop - logView.clientHeight < 40;
  logView.append(h('div', { class: 'log-line' },
    h('span', { class: 'log-ts' }, entry.ts.slice(11, 19)),
    h('span', { class: `log-level ${entry.level}` }, entry.level),
    h('span', { class: 'log-msg' }, entry.message)));
  if (atBottom) logView.scrollTop = logView.scrollHeight;
}

async function loadLogs() {
  if (!logView) return;
  logView.replaceChildren();
  try {
    const { lines } = await api('/api/logs?limit=300');
    for (const l of lines) appendLog(l);
    logView.scrollTop = logView.scrollHeight;
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------- 操作

function pushArrayItem(path, item) {
  const arr = getPath(state.config, path);
  if (!Array.isArray(arr)) setPath(state.config, path, [item]);
  else arr.push(item);
  scheduleSave();
  renderActivePanel();
}

function removeArrayItem(path, index) {
  const arr = getPath(state.config, path);
  if (Array.isArray(arr)) arr.splice(index, 1);
  scheduleSave();
  renderActivePanel();
}

function resetVoice(targetId) {
  const voice = {};
  for (const p of state.catalog.voiceParams) voice[p.key] = p.default;
  state.config.targets[targetId].voice = voice;
  scheduleSave();
  renderActivePanel();
}

async function preview(targetId, text, raw) {
  await saveNow();
  try {
    const r = await api('/api/preview', { method: 'POST', body: JSON.stringify({ target: targetId, text, raw }) });
    if (!r.spoken) toast(`読み上げませんでした（${r.reason ?? '不明'}）`, true);
  } catch (err) {
    toast(err.message, true);
  }
}

async function syncDictionary() {
  await saveNow();
  try {
    const r = await api('/api/dictionary/sync', { method: 'POST' });
    let msg = `辞書を反映しました（追加 ${r.added} / 更新 ${r.updated} / 削除 ${r.removed}）`;
    if (r.skipped?.length) msg += ` — ${r.skipped.length} 件は入力エラーで見送りました`;
    toast(msg, Boolean(r.skipped?.length));
  } catch (err) {
    toast(`反映に失敗しました: ${err.message}`, true);
  }
}

async function engineAction(action) {
  const label = action === 'start' ? '起動' : '停止';
  toast(`エンジンを${label}しています…${action === 'start' ? '（初回はモデル読み込みで時間がかかります）' : ''}`);
  try {
    const r = await api(`/api/engine/${action}`, { method: 'POST' });
    if (r.error) toast(r.error, true);
    else toast(`エンジンを${label}しました`);
  } catch (err) {
    toast(err.message, true);
  }
  await refreshState();
  if (state.engine?.available) {
    try {
      state.speakers = (await api('/api/speakers')).speakers ?? [];
    } catch {}
  }
  renderActivePanel();
}

async function detectEngine() {
  toast('エンジンを探しています…');
  try {
    const r = await api('/api/engine/detect', { method: 'POST' });
    if (!r.enginePath) {
      toast('エンジンの実行ファイルが見つかりませんでした。パスを手入力してください。', true);
      return;
    }
    state.config = await api('/api/config');
    renderActivePanel();
    toast(`検出しました: ${r.enginePath}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function refreshSpeakers() {
  try {
    const r = await api('/api/speakers');
    state.speakers = r.speakers ?? [];
    if (state.speakers.length === 0) toast('話者一覧を取得できませんでした。エンジンを起動してください。', true);
    else toast(`話者を ${state.speakers.length} 件読み込みました`);
    renderActivePanel();
  } catch (err) {
    toast(err.message, true);
  }
}

async function refreshState() {
  try {
    const s = await api('/api/state');
    state.engine = s.engine;
    state.engineProcess = s.engineProcess;
    state.muted = s.muted;
    state.configPath = s.configPath;
    updateEngineBadge();
    updateQueueBadge(s.queue);
    updateMuteButton();
  } catch {
    state.engine = { available: false, error: 'デーモンに接続できません', baseUrl: '' };
    updateEngineBadge();
  }
}

function updateEngineBadge() {
  const el = $('#engine-status');
  if (!state.engine) return;
  if (state.engine.available) {
    el.textContent = `エンジン接続中 v${state.engine.version}`;
    el.className = 'badge badge-ok';
  } else {
    el.textContent = 'エンジン未接続';
    el.className = 'badge badge-err';
    el.title = state.engine.error ?? '';
  }
}

function updateMuteButton() {
  const el = $('#btn-mute');
  if (!el) return;
  el.textContent = state.muted ? '読み上げを再開' : '一時停止';
  el.classList.toggle('btn-primary', Boolean(state.muted));
}

function updateQueueBadge(q) {
  const el = $('#queue-status');
  if (state.muted) {
    el.textContent = '一時停止中';
    el.className = 'badge badge-idle';
    return;
  }
  if (q?.current) {
    el.textContent = `読み上げ中 ${q.current.chunkIndex + 1}/${q.current.chunkCount}${q.queued.length ? `（待機 ${q.queued.length}）` : ''}`;
    el.className = 'badge badge-speaking';
  } else {
    el.textContent = '待機中';
    el.className = 'badge badge-idle';
  }
}

// ---------------------------------------------------------------- 描画制御

function renderActivePanel() {
  const panel = $(`.panel[data-panel="${state.activeTab}"]`);
  if (!panel || !state.config || !state.catalog) return;
  let content;
  if (state.activeTab === 'claudeCode' || state.activeTab === 'codex') content = renderTargetPanel(state.activeTab);
  else if (state.activeTab === 'dictionary') content = renderDictionaryPanel();
  else if (state.activeTab === 'engine') content = renderEnginePanel();
  else if (state.activeTab === 'logs') content = renderLogsPanel();
  panel.replaceChildren(content);
}

function switchTab(tab) {
  state.activeTab = tab;
  for (const t of $$('.tab')) t.classList.toggle('is-active', t.dataset.tab === tab);
  for (const p of $$('.panel')) p.classList.toggle('is-active', p.dataset.panel === tab);
  if (tab !== 'logs') logView = null;
  renderActivePanel();
}

function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('queue', (e) => updateQueueBadge(JSON.parse(e.data)));
  es.addEventListener('runtime', (e) => {
    state.muted = JSON.parse(e.data).muted;
    updateMuteButton();
    updateQueueBadge(null);
  });
  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
  es.addEventListener('config', (e) => {
    // 外部エディタでの編集を反映する。入力中の上書きを避けるため保存待ちのときは無視する
    if (savePending) return;
    state.config = JSON.parse(e.data);
    renderActivePanel();
  });
  es.onerror = () => {
    $('#engine-status').textContent = 'デーモン切断';
    $('#engine-status').className = 'badge badge-err';
  };
}

async function init() {
  document.addEventListener('input', onInputChange);
  document.addEventListener('change', onInputChange);
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchTab(tab.dataset.tab);
  });
  $('#btn-skip').addEventListener('click', () => api('/api/skip', { method: 'POST' }).catch(() => {}));
  $('#btn-clear').addEventListener('click', () => api('/api/clear', { method: 'POST' }).catch(() => {}));
  $('#btn-mute').addEventListener('click', async () => {
    try {
      const r = await api('/api/mute', { method: 'POST', body: JSON.stringify({ muted: !state.muted }) });
      state.muted = r.muted;
      updateMuteButton();
      updateQueueBadge(null);
    } catch (err) {
      toast(err.message, true);
    }
  });
  window.addEventListener('beforeunload', () => {
    if (savePending) navigator.sendBeacon?.('/api/config', new Blob([JSON.stringify(state.config)], { type: 'application/json' }));
  });

  try {
    [state.config, state.catalog] = await Promise.all([api('/api/config'), api('/api/catalog')]);
  } catch (err) {
    document.body.append(h('div', { class: 'banner banner-warn', style: 'margin:20px' }, `デーモンに接続できません: ${err.message}`));
    return;
  }

  await refreshState();
  if (state.engine?.available) {
    try {
      state.speakers = (await api('/api/speakers')).speakers ?? [];
    } catch {}
  }

  renderActivePanel();
  connectStream();
  setInterval(refreshState, 15000);
}

init();
