import { listListeners as defaultListListeners, queryProcessOwner as defaultQueryProcessOwner } from './engine-trust.js';

/** 待受プロセスすべての所有者を照会し、確認できない場合は同一ユーザーとみなさない。 */
export async function describePortHolder({ port, listListeners = defaultListListeners, queryProcessOwner = defaultQueryProcessOwner }) {
  let pids;
  try {
    pids = await listListeners(port, '127.0.0.1');
  } catch {
    return { owner: 'unknown', pids: [] };
  }
  if (!pids.length) return { owner: 'unknown', pids };
  const owners = await Promise.all(pids.map(async (pid) => {
    try {
      return await queryProcessOwner(pid);
    } catch {
      return 'unknown';
    }
  }));
  const owner = owners.includes('other') ? 'other' : owners.every((value) => value === 'same') ? 'same' : 'unknown';
  return { owner, pids };
}
