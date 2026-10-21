import fs from 'node:fs';
import path from 'node:path';

const RENAME_RETRY_COUNT = 5;
const RENAME_RETRY_INTERVAL_MS = 50;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 一時ファイルから rename して書く。書きかけの JSON をフックや更新スクリプトに読ませないため。 */
export function writeRuntimeFile(filePath, record, { fs: fileSystem = fs, sleep = sleepSync } = {}) {
  const temporaryPath = `${filePath}.${record.pid}.tmp`;
  try {
    fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
    fileSystem.writeFileSync(temporaryPath, JSON.stringify(record, null, 2), 'utf8');
    let renamed = false;
    for (let attempt = 0; attempt <= RENAME_RETRY_COUNT; attempt++) {
      try {
        fileSystem.renameSync(temporaryPath, filePath);
        renamed = true;
        break;
      } catch {
        if (attempt === RENAME_RETRY_COUNT) break;
        sleep(RENAME_RETRY_INTERVAL_MS);
      }
    }
    if (!renamed) {
      try {
        fileSystem.unlinkSync(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      fileSystem.renameSync(temporaryPath, filePath);
    }
  } finally {
    try { fileSystem.unlinkSync(temporaryPath); } catch {}
  }
}

/** 自分が書いた runtime.json だけを消す。二重起動した後発が消すと、稼働中のデーモンへフックが届かなくなる。 */
export function removeOwnRuntimeFile(filePath, pid) {
  try {
    if (JSON.parse(fs.readFileSync(filePath, 'utf8'))?.pid !== pid) return;
    fs.unlinkSync(filePath);
  } catch {}
}
