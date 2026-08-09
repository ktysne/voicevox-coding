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
  // 所有 uuid を失うと ENGINE 側の語を管理できなくなる。
  // 直接上書きすると強制終了で壊れた JSON が残るので、config.json と同じく一時ファイル経由で置き換える
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
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

// 追加要求がタイムアウトしても ENGINE 側の処理は続いていることがある。
// この猶予のあいだは同じ語を追加し直さず、後から二重登録になるのを避ける
const PENDING_GRACE_MS = 30_000;

// 半角、全角の差だけを吸収する。文字列全体に NFKC をかけると
// ① と 1、㍍ と メートル のような別表記まで同一視してしまう。
// 濁点付きの半角カタカナをまとめて畳めるよう、連続部分ごとに正規化する
const WIDTH_VARIANTS = /[　！-～｡-ﾟ]+/g;

/** ENGINE 側は表記を全角へ寄せることがあるため、照合前に幅の違いをならす。 */
function normalizeSurface(s) {
  return String(s ?? '').replace(WIDTH_VARIANTS, (run) => run.normalize('NFKC'));
}

/**
 * 所有マップから、この表記に対応する実キーを引く。
 * 所有は表記ごとに 1 件なので、幅違いの表記は同じ語として同じキーに寄せる。
 */
function ownedKeyFor(owned, surface) {
  const key = normalizeSurface(surface);
  if (Object.hasOwn(owned, key)) return key;
  return Object.keys(owned).find((k) => normalizeSurface(k) === key) ?? key;
}

/** 表記と読みが pending と一致する uuid を列挙する。 */
function matchingUuids(dict, target) {
  const surface = normalizeSurface(target?.surface);
  const pronunciation = target?.pronunciation ?? '';
  return Object.entries(dict ?? {})
    .filter(([, word]) => (
      normalizeSurface(word?.surface) === surface
      && (word?.pronunciation ?? '') === pronunciation
    ))
    .map(([uuid]) => uuid);
}

/**
 * ENGINE 側から、この pending の追加で新しく生まれた語を 1 件だけ特定する。
 * 追加前から在った uuid（手動登録の同じ語を含む）は除くので、他人の語を奪わない。
 * @returns {string|null} 特定できた uuid。判断できなければ null
 */
function recoverPendingUuid(dict, pending) {
  const before = new Set(pending?.knownUuids ?? []);
  const fresh = matchingUuids(dict, pending).filter((uuid) => !before.has(uuid));
  return fresh.length === 1 ? fresh[0] : null;
}

/**
 * 追加 API が失敗したあと、ENGINE 側には登録されていないか確かめる。
 * 応答の遅延や切断で reject しても登録自体は成立していることがある。
 * @returns {Promise<string|null>} 拾えた uuid。確認できなければ null
 */
async function findOrphanUuid(engine, pending) {
  let current;
  try {
    current = await engine.userDict();
  } catch {
    return null; // 確認手段がない。pending を残したまま次回の同期で拾い直す
  }
  return recoverPendingUuid(current, pending);
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
  // 追加を試みている語。応答を受け取れないまま落ちても次回の同期で実体を拾えるようにする
  let pending = state.pending ?? null;
  const save = () => writeState({ ...state, words: { ...owned }, pending });
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
    // 所有権は surface 単位で持つため、重複を通すと 2 件目以降の uuid が管理外になる。
    // ENGINE 側は全角へ寄せるので、半角と全角の違いも同じ表記として弾く
    const key = normalizeSurface(w.surface);
    if (seen.has(key)) {
      result.skipped.push({ surface: w.surface, errors: ['表記が重複しています'] });
      continue;
    }
    seen.add(key);
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

  // 前回の同期が追加の応答を受け取れずに終わっていたら、ENGINE 側の実体を所有へ戻す
  let unsettled = null; // 追加が確定せず、今回は手を出せない表記
  if (pending) {
    const pendingKey = ownedKeyFor(owned, pending.surface);
    const recovered = owned[pendingKey] ? null : recoverPendingUuid(existing, pending);
    if (recovered) {
      owned[pendingKey] = recovered;
      pending = null;
    } else if (!owned[pendingKey] && Date.now() - (pending.at ?? 0) < PENDING_GRACE_MS) {
      // 一覧に無くても、ENGINE 側でまだ処理中かもしれない（クライアント側のタイムアウトは
      // ENGINE の処理を止めない）。猶予のあいだは追加し直さず、二重登録を避ける
      unsettled = normalizeSurface(pending.surface);
    } else {
      pending = null;
    }
    save();
  }

  // 今回の同期で扱った所有キー。ここに無い所有語は設定から消えたとみなして削除する
  const keep = new Set();

  for (const w of valid) {
    const key = ownedKeyFor(owned, w.surface);
    keep.add(key);
    if (unsettled !== null && normalizeSurface(w.surface) === unsettled) {
      result.failed.push({ surface: w.surface, errors: ['前回の追加が確定していないため見送りました。しばらくしてから再実行してください'] });
      continue;
    }
    const payload = {
      surface: w.surface,
      pronunciation: w.pronunciation,
      accentType: Number(w.accentType ?? 0),
      wordType: w.wordType || 'PROPER_NOUN',
      priority: Number.isInteger(w.priority) ? w.priority : 8,
    };
    const uuid = owned[key];
    if (uuid && existing[uuid]) {
      // uuid は変わらないので、途中で失敗しても所有は保たれる
      await engine.updateUserDictWord(uuid, payload);
      result.updated += 1;
    } else {
      // 追加前に印を残す。応答も再確認も失敗した場合、次回の同期がこの印で実体を拾う。
      // 追加前から在る同じ表記の uuid を控えておき、回収時に手動登録の語を奪わないようにする
      pending = {
        surface: payload.surface,
        pronunciation: payload.pronunciation,
        knownUuids: matchingUuids(existing, payload),
        at: Date.now(),
      };
      save();
      let newUuid;
      try {
        newUuid = await engine.addUserDictWord(payload);
      } catch (err) {
        // 応答だけ失敗して登録は通っている場合があるので、孤立 uuid を拾ってから中止する
        const orphan = await findOrphanUuid(engine, pending);
        if (orphan) {
          owned[key] = orphan;
          pending = null;
          save();
        }
        throw err;
      }
      owned[key] = newUuid;
      pending = null;
      // 追加のたびに保存する。以降の語で失敗しても、この uuid を後から更新、削除できる
      save();
      result.added += 1;
    }
  }

  // 設定から消えた単語を ENGINE 側からも消す
  for (const [surface, uuid] of Object.entries({ ...owned })) {
    if (keep.has(surface)) continue;
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
  save();
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
