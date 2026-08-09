// 用語辞書。誤読の訂正を 2 層で行う。
//   1) 置換ルール … 合成前にテキストを書き換える。速く、確実。
//   2) ENGINE ユーザー辞書 … 読みとアクセントを形態素解析器に教える。活用形にも効く。

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const STATE_PATH = path.join(CONFIG_DIR, 'engine-dict-state.json');

/** 正規表現の特殊文字をエスケープする。 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 置換ルールを適用する。
 * 長い surface から順に当てて、短い語が先に食い潰すのを防ぐ。
 */
export function applyReplacements(text, replacements = []) {
  const active = replacements
    .filter((r) => r && r.enabled !== false && typeof r.pattern === 'string' && r.pattern.length > 0)
    .sort((a, b) => b.pattern.length - a.pattern.length);

  let out = text;
  for (const rule of active) {
    try {
      const re = rule.regex
        ? new RegExp(rule.pattern, 'g')
        : new RegExp(escapeRegExp(rule.pattern), 'gi');
      out = out.replace(re, rule.replacement ?? '');
    } catch {
      // 不正な正規表現は黙って飛ばす。UI 側で検証済みのはずだが、手編集もありうる
    }
  }
  return out;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { words: {} }; // surface -> uuid
  }
}

function writeState(state) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

const KATAKANA_ONLY = /^[ァ-ヴー]+$/;

export function validateEngineWord(w) {
  const errors = [];
  if (!w || typeof w.surface !== 'string' || w.surface.trim() === '') errors.push('表記が空です');
  if (!w || typeof w.pronunciation !== 'string' || w.pronunciation.trim() === '') errors.push('読みが空です');
  else if (!KATAKANA_ONLY.test(w.pronunciation)) errors.push('読みは全角カタカナのみで指定してください');
  const accent = Number(w?.accentType ?? 0);
  if (!Number.isInteger(accent) || accent < 0) errors.push('アクセント位置は 0 以上の整数です');
  return errors;
}

/**
 * config の engineWords と ENGINE 側ユーザー辞書を突き合わせて同期する。
 * このツールが登録した単語だけを管理対象にする（state ファイルで所有権を持つ）。
 * @returns {{added:number, updated:number, removed:number, skipped:Array}}
 */
export async function syncEngineDictionary(engine, engineWords = []) {
  const state = readState();
  const owned = state.words ?? {};
  const result = { added: 0, updated: 0, removed: 0, skipped: [] };

  const valid = [];
  for (const w of engineWords) {
    if (w?.enabled === false) continue;
    const errors = validateEngineWord(w);
    if (errors.length) {
      result.skipped.push({ surface: w?.surface ?? '(不明)', errors });
      continue;
    }
    valid.push(w);
  }

  // ENGINE 側に実在する uuid を確認しておく（手動削除との齟齬を解消する）
  let existing = {};
  try {
    existing = await engine.userDict();
  } catch {
    existing = {};
  }

  const nextOwned = {};
  for (const w of valid) {
    const payload = {
      surface: w.surface,
      pronunciation: w.pronunciation,
      accentType: Number(w.accentType ?? 0),
      wordType: w.wordType || 'PROPER_NOUN',
      priority: Number.isInteger(w.priority) ? w.priority : 8,
    };
    const uuid = owned[w.surface];
    if (uuid && existing[uuid]) {
      await engine.updateUserDictWord(uuid, payload);
      nextOwned[w.surface] = uuid;
      result.updated += 1;
    } else {
      const newUuid = await engine.addUserDictWord(payload);
      nextOwned[w.surface] = newUuid;
      result.added += 1;
    }
  }

  // 設定から消えた単語を ENGINE 側からも消す
  for (const [surface, uuid] of Object.entries(owned)) {
    if (nextOwned[surface]) continue;
    if (!existing[uuid]) continue;
    try {
      await engine.deleteUserDictWord(uuid);
      result.removed += 1;
    } catch {
      // 消せなくても致命ではない
    }
  }

  writeState({ words: nextOwned });
  return result;
}
