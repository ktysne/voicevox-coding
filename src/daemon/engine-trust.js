// 同じ OS ユーザーは設定や PID ファイルも変更できるため、待受の所有者 SID を信頼の境界とする。
// 利用者が手動で起動したエンジンも使えるよう、実行ファイルのパスでは制限しない。
import { execFile } from 'node:child_process';

export const NO_LISTENERS_REASON = 'ENGINE の待受プロセスがありません';

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]' || isLoopbackV4(host);
}

function isLoopbackV4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function splitAddress(address) {
  const colon = address.lastIndexOf(':');
  return [address.slice(0, colon), address.slice(colon + 1)];
}

export function parseNetstatListeners(output, port) {
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'TCP' || columns.length !== 5) continue;
    const [host, localPort] = splitAddress(columns[1]);
    const [, remotePort] = splitAddress(columns[2]);
    const pid = Number(columns.at(-1));
    if (Number(localPort) !== Number(port) || remotePort !== '0') continue;
    if (!isLoopbackV4(host) && !['0.0.0.0', '[::1]', '[::]'].includes(host)) continue;
    if (/^\d+$/.test(columns.at(-1)) && Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export function listListeners(port) {
  return new Promise((resolve, reject) => {
    execFile('netstat.exe', ['-ano'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parseNetstatListeners(String(stdout), port));
    });
  });
}

export function queryProcessOwner(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve('unknown');
  const script = "$ErrorActionPreference = 'Stop'; try { "
    + `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; `
    + "if (!$p) { 'unknown'; exit }; "
    + '$owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; '
    + "if ($owner.ReturnValue -ne 0 -or !$owner.Sid) { 'unknown' } "
    + "elseif ($owner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { 'same' } "
    + "else { 'other' } } catch { 'unknown' }";
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        const result = String(stdout ?? '').trim();
        resolve(!err && ['same', 'other'].includes(result) ? result : 'unknown');
      });
  });
}

export class EngineTrust {
  constructor({ listListeners: list = listListeners, queryProcessOwner: query = queryProcessOwner } = {}) {
    this.listListeners = list;
    this.queryProcessOwner = query;
    this.managedPids = () => [];
    this.owners = new Map();
    this.pending = new Map();
  }

  setManagedPids(fn) {
    this.managedPids = fn;
  }

  async listeners(baseUrl) {
    const url = new URL(baseUrl);
    if (!isLoopback(url.hostname)) return null;
    return this.listListeners(Number(url.port) || (url.protocol === 'https:' ? 443 : 80));
  }

  async check(baseUrl) {
    let pids;
    try {
      pids = await this.listeners(baseUrl);
    } catch (err) {
      this.owners.clear();
      this.pending.clear();
      return { trusted: false, pids: [], reason: `ENGINE の待受を確認できません: ${err.message}` };
    }
    if (pids === null) return { trusted: true, skipped: true, pids: [] };
    for (const pid of this.owners.keys()) {
      if (!pids.includes(pid)) this.owners.delete(pid);
    }
    // 消えた PID の照会結果を、再利用された PID のキャッシュへ戻さない。
    for (const pid of this.pending.keys()) {
      if (!pids.includes(pid)) this.pending.delete(pid);
    }
    if (!pids.length) return { trusted: false, pids, reason: NO_LISTENERS_REASON };
    const managed = this.managedPids();
    const results = await Promise.all(pids.map(async (pid) => {
      if (managed.includes(pid)) return 'same';
      if (this.owners.has(pid)) return this.owners.get(pid);
      let pending = this.pending.get(pid);
      if (!pending) {
        pending = Promise.resolve().then(() => this.queryProcessOwner(pid)).catch(() => 'unknown');
        this.pending.set(pid, pending);
      }
      const owner = await pending;
      if (this.pending.get(pid) === pending) {
        this.pending.delete(pid);
        if (owner === 'same' || owner === 'other') this.owners.set(pid, owner);
      }
      return owner;
    }));
    const denied = results.findIndex((owner) => owner !== 'same');
    if (denied === -1) return { trusted: true, pids };
    const reason = results[denied] === 'other'
      ? `ENGINE の待受は別ユーザーのプロセスです (PID ${pids[denied]})`
      : `ENGINE の待受プロセスの所有者を確認できません (PID ${pids[denied]})`;
    return { trusted: false, pids, reason };
  }
}
