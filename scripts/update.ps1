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
      3. install.ps1 を再実行し、フック定義とスタートアップ登録を作り直す
         （スタートアップは登録済みかどうかを自動判定して引き継ぐ）
      4. デーモンが稼働していた場合は起動し直す

.PARAMETER IncludeToolEvents
    install.ps1 にそのまま引き継ぐ。導入時に指定していた場合は更新時にも指定する。

.PARAMETER SkipPull
    git pull を省略する（取得済みの状態から適用だけ行う）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\update.ps1
    powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -IncludeToolEvents
#>

[CmdletBinding()]
param(
    [switch]$IncludeToolEvents,
    [switch]$SkipClaude,
    [switch]$SkipCodex,
    [switch]$SkipPull
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
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 3
        return $true
    } catch {
        return $false
    }
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

if ($wasRunning) {
    Write-Step "稼働中のデーモンを停止します (port=$port)"

    # 停止 API はトークン必須。デーモンが起動時に書き出す runtime.json から読む。
    # 旧バージョンのデーモン（runtime.json を書かない）はトークンなしで受け付ける。
    $headers = @{}
    try {
        $rt = Get-Content $RuntimeJson -Raw | ConvertFrom-Json
        if ($rt.token) { $headers['X-VoiceVox-Coding-Token'] = [string]$rt.token }
    } catch {}

    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/shutdown" -Method Post -Headers $headers -TimeoutSec 5
    } catch {
        Write-Warn2 "停止 API の呼び出しに失敗しました: $($_.Exception.Message)"
    }

    # ポートが空くまで待つ
    $stopped = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-DaemonRunning $port)) { $stopped = $true; break }
    }

    if (-not $stopped) {
        # 最後の手段としてポートの所有プロセスを直接止める
        $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($ownerPid in $owners) {
            Write-Warn2 "停止 API が効かないため、プロセス $ownerPid を強制終了します"
            Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
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

    $started = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-DaemonRunning $port) { $started = $true; break }
    }
    if ($started) {
        Write-Ok "デーモンが起動しました: http://127.0.0.1:$port/"
    } else {
        Write-Warn2 'デーモンの起動を確認できませんでした。npm run doctor で点検してください。'
    }
} else {
    Write-Ok 'デーモンは停止したままにします（更新前も稼働していなかったため）'
}

Write-Host ''
Write-Host '更新を適用しました。動作の点検は npm run doctor で行えます。' -ForegroundColor White
