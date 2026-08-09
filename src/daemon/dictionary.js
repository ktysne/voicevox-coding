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
 * 追加 API が失敗したあと、ENGINE 側には登録されていないか確かめる。
 * 応答の遅延や切断で reject しても登録自体は成立していることがあり、
 * uuid を拾えないと次の同期で同じ語を二重登録してしまう。
 * @returns {Promise<string|null>} 拾えた uuid。確認できなければ null
 */
async function findOrphanUuid(engine, surface, knownUuids) {
  let current;
  try {
    current = await engine.userDict();
  } catch {
    return null; // 確認手段がない。ここは諦めて次回の同期に任せる
  }
  const added = Object.entries(current ?? {}).filter(([uuid]) => !knownUuids.has(uuid));
  const matched = added.find(([, word]) => word?.surface === surface);
  if (matched) return matched[0];
  // ENGINE 側で表記が正規化される場合があるので、増えた uuid が 1 件だけならそれとみなす
  return added.length === 1 ? added[0][0] : null;
}

/**
 * config の engineWords と ENGINE 側ユーザー辞書を突き合わせて同期する。
 * このツールが登録した単語だけを管理対象にする（state ファイルで所有権を持つ）。
 * @returns {Promise<{added:number, updated:number, removed:number, skipped:Array, failed:Array}>}
 */
async function runSync(engine, engineWords) {
  const state = readState();
  // 作業用のコピー。外部 API が成功するたびにここを更新し、その都度 state へ書き戻す
  const owned = { ...(state.words ?? {}) };
  // skipped は入力エラー、failed は ENGINE 側の処理に失敗した語（呼び出し元が警告する）
  const result = { added: 0, updated: 0, removed: 0, skipped: [], failed: [] };

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

  // 追加で発行された uuid を追う。孤立 uuid の判定に使う
  const knownUuids = new Set(Object.keys(existing));

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
      let newUuid;
      try {
        newUuid = await engine.addUserDictWord(payload);
      } catch (err) {
        // 応答だけ失敗して登録は通っている場合があるので、孤立 uuid を拾ってから中止する
        const orphan = await findOrphanUuid(engine, w.surface, knownUuids);
        if (orphan) {
          owned[w.surface] = orphan;
          writeState({ ...state, words: { ...owned } });
        }
        throw err;
      }
      knownUuids.add(newUuid);
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
      } catch (err) {
        // 消せなくても致命ではないが、黙って成功扱いにはしない。
        // 所有は残して次回の同期で消し直す
        result.failed.push({ surface, errors: [`ENGINE から削除できませんでした: ${err.message}`] });
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

// 同期は state と ENGINE 一覧を読んでから書き戻すまでに間があるため、
// 並行実行すると同じ表記に別々の uuid が発行され、片方が管理外に落ちる。
// 起動時同期と /api/dictionary/sync は重なりうるので、プロセス内で直列化する。
let syncChain = Promise.resolve();

/**
 * config の engineWords と ENGINE 側ユーザー辞書を突き合わせて同期する（直列実行）。
 * @returns {Promise<{added:number, updated:number, removed:number, skipped:Array, failed:Array}>}
 */
export function syncEngineDictionary(engine, engineWords = []) {
  const run = syncChain.then(() => runSync(engine, engineWords));
  syncChain = run.then(() => undefined, () => undefined); // 失敗しても後続を止めない
  return run;
}
