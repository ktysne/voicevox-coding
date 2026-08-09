<#
.SYNOPSIS
    VOICEVOX Coding を最新化し、更新を適用する。

.DESCRIPTION
    git pull だけでは更新は反映されない。
    デーモンは常駐プロセスとして旧コードのまま動き続け、
    フック定義とスタートアップ登録も install.ps1 が生成した時点の内容のままだからである。

    このスクリプトは次をまとめて行う。
      1. git pull --ff-only でリポジトリを最新化する
      2. 稼働中のデーモンを停止する（/api/shutdown。トークンは runtime.json から読む）
         停止トークンを取得できない場合（初回更新時など、runtime.json を書き出さない版の
         デーモンが稼働している場合）は、本デーモンのプロセスだと確認したうえで停止する
      3. install.ps1 を再実行し、フック定義とスタートアップ登録を作り直す
         （スタートアップは登録済みかどうかを自動判定して引き継ぐ）
      4. デーモンが稼働していた場合は起動し直す

.PARAMETER IncludeToolEvents
    install.ps1 にそのまま引き継ぐ。導入時に指定していた場合は更新時にも指定する。

.PARAMETER SkipPull
    git pull を省略する（取得済みの状態から適用だけ行う）。

.PARAMETER Force
    停止トークンを取得できているにもかかわらず、停止 API でデーモンを止められないときに
    限り必要になる。本デーモンのプロセスだと確認できた場合のみ強制終了して続行する。
    指定しない場合は中断し、トレイの「終了」による停止を案内する。
    なお、停止トークンを取得できなかった場合（初回更新時など）は、本デーモンのプロセスだと
    確認できていれば -Force を付けなくても自動的に停止して続行する。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\update.ps1
    powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -IncludeToolEvents
#>

[CmdletBinding()]
param(
    [switch]$IncludeToolEvents,
    [switch]$SkipClaude,
    [switch]$SkipCodex,
    [switch]$SkipPull,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# install.ps1 と同じく PowerShell 7 を前提にする（5.1 なら pwsh へ引き継ぐ）
if ($PSVersionTable.PSVersion.Major -lt 6) {
    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if (-not $pwsh) {
        Write-Error 'このスクリプトには PowerShell 7 (pwsh) が必要です。https://aka.ms/powershell からインストールしてください。'
        exit 1
    }
    $forward = @()
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        if ($kv.Value -is [switch] -and -not $kv.Value.IsPresent) { continue }
        $forward += "-$($kv.Key)"
        if ($kv.Value -isnot [switch]) { $forward += [string]$kv.Value }
    }
    & $pwsh.Source -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @forward
    exit $LASTEXITCODE
}

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$ConfigDir  = Join-Path $env:USERPROFILE '.voicevox-coding'
$RuntimeJson = Join-Path $ConfigDir 'runtime.json'

function Write-Step([string]$m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn2([string]$m){ Write-Host "  [!] $m" -ForegroundColor Yellow }

function Get-DaemonPort {
    try {
        $cfg = Get-Content (Join-Path $ConfigDir 'config.json') -Raw | ConvertFrom-Json
        $p = [int]$cfg.daemon.port
        if ($p -gt 0) { return $p }
    } catch {}
    return 7591
}

function Test-DaemonRunning([int]$port) {
    # /api/state は ENGINE の状態取得を待つため、ENGINE が無応答だとデーモンが生きていても
    # タイムアウトしうる。外部プロセスに依存しない /api/config で確認する。
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/config" -TimeoutSec 3
        return $true
    } catch {
        return $false
    }
}

function Get-PortOwnerPids([int]$port) {
    @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Wait-PortReleased([int]$port, [int]$attempts = 20) {
    for ($i = 0; $i -lt $attempts; $i++) {
        if ((Get-PortOwnerPids $port).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (Get-PortOwnerPids $port).Count -eq 0
}

function Confirm-DaemonProcess([int]$ownerPid, $runtime) {
    # 強制終了は、本デーモンのプロセスだと確認できた場合に限る。
    # runtime.json の PID 一致、または「node が src\daemon\main.js を実行している」ことで判定する。
    if ($runtime -and [int]$runtime.pid -eq $ownerPid) { return $true }
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid"
        if ($proc -and $proc.Name -match '^node(\.exe)?$' -and $proc.CommandLine -match 'daemon[\\/]main\.js') {
            return $true
        }
    } catch {}
    return $false
}

# --- 1. リポジトリの最新化 ---
if (-not $SkipPull) {
    Write-Step 'リポジトリを最新化します'
    git -C $RepoRoot pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'git pull に失敗しました。ローカルの変更を退避（git stash など）してから再実行してください。'
        exit 1
    }
    Write-Ok (git -C $RepoRoot log -1 --format='%h %s')
}

# --- 2. デーモンの停止 ---
$port = Get-DaemonPort
$wasRunning = Test-DaemonRunning $port

$oldRuntime = $null
if ($wasRunning) {
    Write-Step "稼働中のデーモンを停止します (port=$port)"

    # 停止 API はトークン必須。デーモンが起動時に書き出す runtime.json から読む。
    # runtime.json を書かない版のデーモンに対しては、トークンなしで試みる。
    $headers = @{}
    try {
        $oldRuntime = Get-Content $RuntimeJson -Raw | ConvertFrom-Json
        if ($oldRuntime.token) { $headers['X-VoiceVox-Coding-Token'] = [string]$oldRuntime.token }
    } catch {}

    # 停止 API を呼ぶ前の待受 PID を控えておく。停止に成功すると後からは取得できなくなる。
    $ownersBefore = Get-PortOwnerPids $port

    # 「トークンを持っていた（＝止まるはずだった）のに止まらない」ことだけをハングの
    # 証拠として扱う。トークンを一度も持てていない（runtime.json が無い／token が無い／
    # pid が実際の待受プロセスと不一致＝クラッシュ後に残った古いファイル）場合は、
    # 止まらないことがハングを意味しないため、後続で自動停止の対象にする。
    $tokenTrusted = $false
    if ($oldRuntime -and $oldRuntime.token -and (Get-Member -InputObject $oldRuntime -Name 'pid' -ErrorAction SilentlyContinue)) {
        $ownerPidsInt = @($ownersBefore | ForEach-Object { [int]$_ })
        if ($ownerPidsInt -contains [int]$oldRuntime.pid) { $tokenTrusted = $true }
    }

    $shutdownAccepted = $false
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/shutdown" -Method Post -Headers $headers -TimeoutSec 5
        $shutdownAccepted = $true
    } catch {
        Write-Warn2 "停止 API の呼び出しに失敗しました: $($_.Exception.Message)"
        if (-not $tokenTrusted) {
            Write-Warn2 'runtime.json から停止トークンを取得できませんでした（runtime.json を書き出さない版のデーモン、または古い runtime.json の可能性があります）。'
        }
    }

    if (-not (Wait-PortReleased $port)) {
        # 停止 API で止まらなかった。強制終了は後始末（エンジン停止など）を飛ばすため、
        # 既定では中断してトレイからの停止を案内する。
        $owners = Get-PortOwnerPids $port
        $unconfirmed = @($owners | Where-Object { -not (Confirm-DaemonProcess $_ $oldRuntime) })

        if ($unconfirmed.Count -gt 0) {
            Write-Error "ポート $port の待受プロセス (PID: $($unconfirmed -join ', ')) を本デーモンと確認できません。別のサービスがこのポートを使っている可能性があります。デーモンの停止と設定 (daemon.port) を確認してから再実行してください。"
            exit 1
        }

        # トークンを持っていた、または停止 API が受理されたのに止まらない場合は、
        # 正常終了処理が遅いだけ（＝ハングの疑い）である可能性があるため、
        # 自動停止の対象にはしない。この 2 つのどちらにも当てはまらない場合だけ、
        # トークンを一度も持てていない＝止まらないことがハングの証拠にならないと言えるため、
        # 本デーモンだと確認できたプロセスに限り自動的に停止してよい。
        $canAutoStop = (-not $tokenTrusted) -and (-not $shutdownAccepted)

        if (-not $canAutoStop -and -not $Force) {
            Write-Error '停止 API でデーモンを止められませんでした。タスクトレイの「終了」で停止してから再実行してください。強制終了して続行する場合は -Force を付けます（エンジンなどの後始末は次回起動時に行われます）。'
            exit 1
        }

        if ($canAutoStop) {
            Write-Warn2 '停止トークンを取得できなかったため停止 API を使えませんでした。本デーモンのプロセスだと確認できたため終了させます。'
            Write-Warn2 'エンジンの停止などの後始末は行われません。次回のデーモン起動時に引き継がれます。'
        }

        # 子プロセス（再生ワーカー、Codex app-server、トレイ）は個別に終了させる必要はない。
        # 再生ワーカーと Codex app-server は node との標準入出力パイプで繋がっており、
        # node が終了して stdin が EOF になれば自力で後始末をして終了する。
        # とりわけ再生ワーカーはこの EOF 経路のほうが再生とストリームの解放を正しく通るため、
        # Stop-Process で個別に殺すとかえって後始末を飛ばしてしまう。
        # トレイも -ParentPid の監視により node の消滅を検知して自力で畳む。
        # VOICEVOX ENGINE は detached で起動しており残り続けるが、次回のデーモン起動時に
        # reclaimStale() が引き継ぐ。以上の理由から、taskkill /T のようなプロセスツリーの
        # 一括終了はしてはならない。落とすのは node 本体だけでよい。
        foreach ($ownerPid in $owners) {
            Write-Warn2 "デーモンのプロセス $ownerPid を強制終了します"
            Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
        }
        if (-not (Wait-PortReleased $port 10)) {
            Write-Error "強制終了後もポート $port が解放されません。手動でプロセスを確認してください。"
            exit 1
        }
    }
    Write-Ok 'デーモンを停止しました'
} else {
    Write-Ok 'デーモンは稼働していません（停止は不要）'
}

# --- 3. フックとスタートアップの再生成 ---
Write-Step 'フック定義とスタートアップ登録を作り直します'

$startupVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'VOICEVOX Coding.vbs'
$installArgs = @{}
if ($IncludeToolEvents) { $installArgs['IncludeToolEvents'] = $true }
if ($SkipClaude)        { $installArgs['SkipClaude'] = $true }
if ($SkipCodex)         { $installArgs['SkipCodex'] = $true }
if (Test-Path $startupVbs) { $installArgs['RegisterStartup'] = $true }

& (Join-Path $PSScriptRoot 'install.ps1') @installArgs
if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
    Write-Error 'install.ps1 の再実行に失敗しました。'
    exit 1
}

# --- 4. デーモンの再起動 ---
if ($wasRunning) {
    Write-Step 'デーモンを起動し直します'
    $vbsPath = Join-Path $ConfigDir 'start-daemon.vbs'
    if (Test-Path $vbsPath) {
        # スタートアップと同じ経路（コンソール窓なし）で起動する
        Start-Process wscript.exe -ArgumentList "`"$vbsPath`""
    } else {
        $mainJs = Join-Path $RepoRoot 'src\daemon\main.js'
        Start-Process node -ArgumentList "`"$mainJs`"" -WindowStyle Hidden
    }

    # 停止時にポートの解放を確認済みなので、ここで応答するのは新しいデーモンに限られる。
    # 念のため runtime.json の PID が世代交代していることも確認する。
    $started = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-DaemonRunning $port) { $started = $true; break }
    }
    if ($started) {
        try {
            $newRuntime = Get-Content $RuntimeJson -Raw | ConvertFrom-Json
            if ($oldRuntime -and [int]$newRuntime.pid -eq [int]$oldRuntime.pid) {
                Write-Warn2 '起動後の runtime.json の PID が更新前と同じです。npm run doctor で点検してください。'
            }
        } catch {}
        Write-Ok "デーモンが起動しました: http://127.0.0.1:$port/"
    } else {
        Write-Warn2 'デーモンの起動を確認できませんでした。npm run doctor で点検してください。'
    }
} else {
    Write-Ok 'デーモンは停止したままにします（更新前も稼働していなかったため）'
}

Write-Host ''
Write-Host '更新を適用しました。動作の点検は npm run doctor で行えます。' -ForegroundColor White
