# 接続元確認ワーカー。stdin の "<id> <クライアントポート> <サーバーポート>" に、その接続を張ったプロセスの SID を返す。
# プロセスを開けないとき(他のユーザーのプロセス)は ERR denied、表の取得などの失敗は ERR lookup を返す。
# どちらもデーモン側で拒否される。stdin が閉じたら終了する。

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class TcpOwner {
  [DllImport("iphlpapi.dll", SetLastError=true)]
  static extern uint GetExtendedTcpTable(IntPtr t, ref int size, bool order, int af, int cls, uint reserved);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int FindPid(int localPort, int remotePort) {
    int size = 0;
    uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0);
    if (result != 122) throw new Exception("table-size");
    for (int attempt = 0; attempt < 3; attempt++) {
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        result = GetExtendedTcpTable(buf, ref size, false, 2, 5, 0);
        if (result == 122) continue;
        if (result != 0) throw new Exception("table");
        int count = Marshal.ReadInt32(buf);
        int matches = 0, pid = 0;
        for (int i = 0; i < count; i++) {
          IntPtr row = IntPtr.Add(buf, 4 + i * 24);
          int state = Marshal.ReadInt32(row);
          uint localAddress = unchecked((uint)Marshal.ReadInt32(row, 4));
          int local = (Marshal.ReadByte(row, 8) << 8) | Marshal.ReadByte(row, 9);
          uint remoteAddress = unchecked((uint)Marshal.ReadInt32(row, 12));
          int remote = (Marshal.ReadByte(row, 16) << 8) | Marshal.ReadByte(row, 17);
          if (state == 5 && localAddress == 0x0100007F && remoteAddress == 0x0100007F
              && local == localPort && remote == remotePort) {
            matches++;
            pid = Marshal.ReadInt32(row, 20);
          }
        }
        if (matches != 1 || pid == 0) throw new Exception("connection");
        return pid;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    throw new Exception("table-changed");
  }
  public static string Sid(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) throw new Exception("process");
    try {
      IntPtr token;
      if (!OpenProcessToken(process, 0x8, out token)) throw new Exception("token");
      try { using (var identity = new WindowsIdentity(token)) return identity.User.Value; }
      finally { CloseHandle(token); }
    } finally { CloseHandle(process); }
  }
}
"@
[Console]::Out.WriteLine("READY " + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
while ($null -ne ($line = [Console]::ReadLine())) {
  if ($line -notmatch '^(\d+) (\d+) (\d+)$') { continue }
  $requestId = $Matches[1]
  try {
    $clientPort = [int]$Matches[2]
    $serverPort = [int]$Matches[3]
    if ($clientPort -lt 1 -or $clientPort -gt 65535 -or $serverPort -lt 1 -or $serverPort -gt 65535) {
      throw 'port'
    }
    $ownerPid = [TcpOwner]::FindPid($clientPort, $serverPort)
    $sid = [TcpOwner]::Sid($ownerPid)
    [Console]::Out.WriteLine("$requestId OK $sid")
  } catch {
    # .NET の例外は MethodInvocationException に包まれて届くので、内側の理由で見分ける
    $inner = $_.Exception
    while ($inner.InnerException) { $inner = $inner.InnerException }
    $reason = if ($inner.Message -in @('process', 'token')) { 'denied' } else { 'lookup' }
    [Console]::Out.WriteLine("$requestId ERR $reason")
  }
}