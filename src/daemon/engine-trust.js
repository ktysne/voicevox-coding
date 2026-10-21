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

// 接続先のホストへの接続を受けうる待受のローカルアドレスか。localhost はどちらのファミリーにも解決しうる。
function acceptsConnectionsTo(localHost, targetHost) {
  const v4 = localHost === '0.0.0.0' || (isLoopbackV4(localHost) && (targetHost === 'localhost' || localHost === targetHost));
  const v6 = localHost === '[::]' || localHost === '[::1]';
  if (targetHost === 'localhost') return v4 || v6;
  if (targetHost === '[::1]' || targetHost === '::1') return v6;
  return v4;
}

export function parseNetstatListeners(output, port, targetHost = 'localhost') {
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'TCP' || columns.length !== 5) continue;
    const [host, localPort] = splitAddress(columns[1]);
    const [, remotePort] = splitAddress(columns[2]);
    const pid = Number(columns.at(-1));
    if (Number(localPort) !== Number(port) || remotePort !== '0') continue;
    if (!acceptsConnectionsTo(host, targetHost)) continue;
    if (/^\d+$/.test(columns.at(-1)) && Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export function listListeners(port, host) {
  return new Promise((resolve, reject) => {
    execFile('netstat.exe', ['-ano'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parseNetstatListeners(String(stdout), port, host));
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
    this.stalePending = new WeakSet();
  }

  setManagedPids(fn) {
    this.managedPids = fn;
  }

  async listeners(baseUrl) {
    const url = new URL(baseUrl);
    if (!isLoopback(url.hostname)) return null;
    return this.listListeners(Number(url.port) || (url.protocol === 'https:' ? 443 : 80), url.hostname);
  }

  async check(baseUrl) {
    let pids;
    try {
      pids = await this.listeners(baseUrl);
    } catch (err) {
      this.owners.clear();
      for (const pending of this.pending.values()) this.stalePending.add(pending);
      this.pending.clear();
      return { trusted: false, pids: [], reason: `ENGINE の待受を確認できません: ${err.message}` };
    }
    if (pids === null) return { trusted: true, skipped: true, pids: [] };
    for (const pid of this.owners.keys()) {
      if (!pids.includes(pid)) this.owners.delete(pid);
    }
    // 照会中に PID が待受から消えた結果は、再利用された PID のものかもしれないので許可にもキャッシュにも使わない
    for (const [pid, pending] of this.pending) {
      if (pids.includes(pid)) continue;
      this.stalePending.add(pending);
      this.pending.delete(pid);
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
      if (this.stalePending.has(pending)) return 'unknown';
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
