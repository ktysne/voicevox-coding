// 読み上げ対象イベントのカタログ。
// デーモンと管理コンソールの両方がこの定義を参照する（UI は /api/catalog 経由）。

/**
 * mode:
 *   template  … 固定文を読む。{tool_name} などのプレースホルダを展開する
 *   fullText  … イベントが運ぶ本文（応答テキストなど）を整形して読む
 *   off       … 読まない（enabled=false と同義だが、UI 上の表現として残す）
 */

export const TARGETS = {
  claudeCode: { id: 'claudeCode', label: 'Claude Code' },
  codex: { id: 'codex', label: 'Codex' },
};

/**
 * 各イベントの定義。
 * targets … そのイベントを発火しうるターゲット
 * body    … fullText モードで読み上げ対象になるペイロードのフィールド（優先順）
 */
export const EVENTS = [
  {
    name: 'Stop',
    label: '応答完了',
    description: 'エージェントが応答を返し終えたとき。読み上げの主役。',
    targets: ['claudeCode', 'codex'],
    supportsFullText: true,
    body: ['last_assistant_message'],
    placeholders: [],
    defaults: { enabled: true, mode: 'fullText', template: '応答が完了しました' },
  },
  {
    name: 'MessageDisplay',
    label: '途中経過（Claude Code）',
    description:
      'ツールを動かしている合間の説明文。応答が streaming で確定するたびに読み上げます。'
      + '応答完了を待たずに進行が分かります。',
    targets: ['claudeCode'],
    supportsFullText: true,
    body: ['message'],
    placeholders: [],
    defaults: { enabled: true, mode: 'fullText', template: '' },
  },
  {
    name: 'Commentary',
    label: '途中経過（Codex）',
    description: 'Codex Desktop が出力した途中経過を、応答完了を待たずに読み上げます。',
    targets: ['codex'],
    supportsFullText: true,
    body: ['message'],
    placeholders: [],
    defaults: { enabled: true, mode: 'fullText', template: '' },
  },
  {
    name: 'Notification',
    label: '通知（Claude Code）',
    description: 'ツール許可待ちなどの通知。matcher で種別を絞れる。',
    targets: ['claudeCode'],
    supportsFullText: true,
    body: ['message'],
    placeholders: ['{message}'],
    defaults: { enabled: true, mode: 'template', template: '許可が必要です' },
  },
  {
    name: 'PermissionRequest',
    label: '許可待ち（Codex）',
    description: 'コマンド実行などの承認待ちで停止したとき。',
    targets: ['codex'],
    supportsFullText: true,
    body: ['message', 'reason'],
    placeholders: ['{message}', '{tool_name}'],
    defaults: { enabled: true, mode: 'template', template: '許可が必要です' },
  },
  {
    name: 'PreToolUse',
    label: 'ツール実行前',
    description: 'ツールを呼び出す直前。発火頻度が高いので既定はオフ。',
    targets: ['claudeCode', 'codex'],
    supportsFullText: false,
    body: [],
    placeholders: ['{tool_name}'],
    defaults: { enabled: false, mode: 'template', template: '{tool_name} を実行します' },
  },
  {
    name: 'PostToolUse',
    label: 'ツール実行後',
    description: 'ツール呼び出しが完了した直後。発火頻度が高いので既定はオフ。',
    targets: ['claudeCode', 'codex'],
    supportsFullText: false,
    body: [],
    placeholders: ['{tool_name}'],
    defaults: { enabled: false, mode: 'template', template: '{tool_name} が完了しました' },
  },
  {
    name: 'UserPromptSubmit',
    label: 'プロンプト送信時',
    description: '自分が入力を送った瞬間。既定はオフ。',
    targets: ['claudeCode', 'codex'],
    supportsFullText: true,
    body: ['prompt'],
    placeholders: [],
    defaults: { enabled: false, mode: 'template', template: '送信しました' },
  },
  {
    name: 'SessionStart',
    label: 'セッション開始',
    description: 'セッションが始まったとき。',
    targets: ['claudeCode', 'codex'],
    supportsFullText: false,
    body: [],
    placeholders: ['{source}'],
    defaults: { enabled: false, mode: 'template', template: 'セッションを開始しました' },
  },
  {
    name: 'SessionEnd',
    label: 'セッション終了',
    description: 'セッションが終わったとき。',
    targets: ['claudeCode', 'codex'],
    supportsFullText: false,
    body: [],
    placeholders: ['{reason}'],
    defaults: { enabled: false, mode: 'template', template: 'セッションを終了しました' },
  },
  {
    name: 'SubagentStop',
    label: 'サブエージェント完了',
    description: 'サブエージェントが処理を終えたとき。',
    targets: ['claudeCode', 'codex'],
    supportsFullText: true,
    body: ['last_assistant_message'],
    placeholders: ['{agent_type}'],
    defaults: { enabled: false, mode: 'template', template: 'サブエージェントが完了しました' },
  },
  {
    name: 'PreCompact',
    label: 'コンテキスト圧縮前',
    description: '会話履歴の圧縮が始まるとき。',
    targets: ['claudeCode', 'codex'],
    supportsFullText: false,
    body: [],
    placeholders: ['{trigger}'],
    defaults: { enabled: false, mode: 'template', template: 'コンテキストを圧縮します' },
  },
];

export const EVENT_BY_NAME = new Map(EVENTS.map((e) => [e.name, e]));

export function eventsForTarget(target) {
  return EVENTS.filter((e) => e.targets.includes(target));
}

/** VOICEVOX の audio_query で調整できるパラメータ。UI のスライダー定義も兼ねる。 */
export const VOICE_PARAMS = [
  { key: 'speedScale', label: '話す速さ', min: 0.5, max: 2.0, step: 0.05, default: 1.0, unit: '倍' },
  { key: 'pitchScale', label: '音の高さ', min: -0.15, max: 0.15, step: 0.01, default: 0.0, unit: '' },
  { key: 'intonationScale', label: '抑揚', min: 0.0, max: 2.0, step: 0.05, default: 1.0, unit: '' },
  { key: 'volumeScale', label: '音量', min: 0.0, max: 2.0, step: 0.05, default: 1.0, unit: '' },
  { key: 'prePhonemeLength', label: '開始の無音', min: 0.0, max: 1.5, step: 0.05, default: 0.1, unit: '秒' },
  { key: 'postPhonemeLength', label: '終了の無音', min: 0.0, max: 1.5, step: 0.05, default: 0.1, unit: '秒' },
];
