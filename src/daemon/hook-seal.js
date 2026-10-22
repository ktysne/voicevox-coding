import crypto from 'node:crypto';

const CONTEXT = 'voicevox-coding-hook-v1';

function deriveKey(token) {
  if (typeof token !== 'string' || !token) throw new Error('invalid token');
  return crypto.hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.alloc(0), CONTEXT, 32);
}

/** ローカルの共有トークンでフック本文を認証付き暗号化する。 */
export function sealHookBody(token, { target, payload }, now = Date.now()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(token), iv);
  cipher.setAAD(Buffer.from(CONTEXT));
  const ct = Buffer.concat([cipher.update(JSON.stringify({ target, payload, ts: now }), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** 認証と時刻の検査を通った封筒だけからフック本文を取り出す。 */
export function openSealedHook(token, body, now = Date.now()) {
  try {
    if (!body || body.v !== 1) return { ok: false, reason: 'invalid version' };
    const decoded = {};
    for (const field of ['iv', 'ct', 'tag']) {
      const value = body[field];
      if (typeof value !== 'string' || !value.length) return { ok: false, reason: 'invalid envelope' };
      decoded[field] = Buffer.from(value, 'base64');
      if (decoded[field].toString('base64') !== value) return { ok: false, reason: 'invalid base64' };
    }
    if (decoded.iv.length !== 12 || decoded.tag.length !== 16) return { ok: false, reason: 'invalid length' };
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(token), decoded.iv);
    decipher.setAAD(Buffer.from(CONTEXT));
    decipher.setAuthTag(decoded.tag);
    const plaintext = Buffer.concat([decipher.update(decoded.ct), decipher.final()]);
    const data = JSON.parse(plaintext.toString('utf8'));
    if (!data || !Number.isFinite(data.ts) || !Number.isFinite(now) || Math.abs(data.ts - now) > 60000) {
      return { ok: false, reason: 'invalid timestamp' };
    }
    return { ok: true, target: data.target, payload: data.payload };
  } catch {
    return { ok: false, reason: 'invalid sealed hook' };
  }
}
