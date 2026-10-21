import fs from 'node:fs';
import path from 'node:path';

/** 一時ファイルから rename して書く。書きかけの JSON をフックや更新スクリプトに読ませないため。 */
export function writeRuntimeFile(filePath, record) {
  const temporaryPath = `${filePath}.${record.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
}

/** 自分が書いた runtime.json だけを消す。二重起動した後発が消すと、稼働中のデーモンへフックが届かなくなる。 */
export function removeOwnRuntimeFile(filePath, pid) {
  try {
    if (JSON.parse(fs.readFileSync(filePath, 'utf8'))?.pid !== pid) return;
    fs.unlinkSync(filePath);
  } catch {}
}
