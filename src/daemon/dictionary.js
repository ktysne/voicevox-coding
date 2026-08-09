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
  // 作業用のコピー。外部 API が成功するたびにここを更新し、その都度 state へ書き戻す
  const owned = { ...(state.words ?? {}) };
  const result = { added: 0, updated: 0, removed: 0, skipped: [] };

  const valid = [];
  const seen = new Set();
  for (const w of engineWords) {
    if (w?.enabled === false) continue;
    const errors = validateEngineWord(w);
    if (errors.length) {
      result.skipped.push({ surface: w?.surface ?? '(不明)', errors });
      continue;
    }
    // 所有権は surface 単位で持つため、重複を通すと 2 件目以降の uuid が管理外になる
    if (seen.has(w.surface)) {
      result.skipped.push({ surface: w.surface, errors: ['表記が重複しています'] });
      continue;
    }
    seen.add(w.surface);
    valid.push(w);
  }

  // ENGINE 側に実在する uuid を確認しておく（手動削除との齟齬を解消する）。
  // ここを空辞書で代用すると所有語をすべて未登録とみなして重複登録するので、同期ごと中止する
  let existing;
  try {
    existing = await engine.userDict();
  } catch (err) {
    throw new Error(`ユーザー辞書の一覧を取得できないため同期を中止しました: ${err.message}`);
  }

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
      // uuid は変わらないので、途中で失敗しても所有は保たれる
      await engine.updateUserDictWord(uuid, payload);
      result.updated += 1;
    } else {
      const newUuid = await engine.addUserDictWord(payload);
      owned[w.surface] = newUuid;
      // 追加のたびに保存する。以降の語で失敗しても、この uuid を後から更新、削除できる
      writeState({ ...state, words: { ...owned } });
      result.added += 1;
    }
  }

  // 設定から消えた単語を ENGINE 側からも消す
  for (const [surface, uuid] of Object.entries({ ...owned })) {
    if (seen.has(surface)) continue;
    if (existing[uuid]) {
      try {
        await engine.deleteUserDictWord(uuid);
        result.removed += 1;
      } catch {
        // 消せなくても致命ではない。所有は残して次回の同期で消し直す
        continue;
      }
    }
    delete owned[surface];
  }

  // 削除結果をまとめて反映する。owned は既存の所有をコピーしたものなので、
  // 途中で例外が出ても未処理分の uuid が state から消えることはない
  writeState({ ...state, words: owned });
  return result;
}
