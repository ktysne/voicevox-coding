<#
.SYNOPSIS
    VOICEVOX Coding のフック登録を解除する。

.DESCRIPTION
    Claude Code の settings.json と Codex の hooks.json から、
    hook-client.js を呼ぶフックだけを取り除く。
    他のフック（codegraph など）はそのまま残す。

.PARAMETER RemoveConfig
    設定ファイルとキャッシュ（%USERPROFILE%\.voicevox-coding）も削除する。
#>

[CmdletBinding()]
param(
    [switch]$RemoveConfig
)

$ErrorActionPreference = 'Stop'

# ConvertFrom-Json -AsHashtable は PowerShell 6 以降にしかない。
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

$InstallDir = Join-Path $env:USERPROFILE '.voicevox-coding'
$ClaudeDir  = Join-Path $env:USERPROFILE '.claude'
$CodexDir   = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }

function Write-Ok($msg)  { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Skip($msg){ Write-Host "  --   $msg" -ForegroundColor DarkGray }

function Remove-OurHooks([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Skip "$path は存在しません"
        return
    }

    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { Write-Skip "$path は空です"; return }
    $root = $raw | ConvertFrom-Json -AsHashtable
    if (-not $root.ContainsKey('hooks')) { Write-Skip "$path にフックはありません"; return }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $path -Destination "$path.bak-$stamp" -Force
    Write-Ok "バックアップ: $path.bak-$stamp"

    $removed = 0
    $hooks = $root['hooks']
    foreach ($ev in @($hooks.Keys)) {
        $kept = @()
        foreach ($g in @($hooks[$ev])) {
            if ($null -eq $g) { continue }
            $inner = @()
            foreach ($hk in @($g.hooks)) {
                if ($null -eq $hk) { continue }
                if ([string]$hk.command -like '*hook-client.js*') { $removed++; continue }
                $inner += $hk
            }
            if ($inner.Count -gt 0) {
                $ng = [ordered]@{}
                if ($g.matcher) { $ng['matcher'] = $g.matcher }
                $ng['hooks'] = $inner
                $kept += $ng
            }
        }
        if ($kept.Count -gt 0) { $hooks[$ev] = @($kept) } else { $hooks.Remove($ev) }
    }
    if ($hooks.Count -eq 0) { $root.Remove('hooks') }

    Set-Content -LiteralPath $path -Value ($root | ConvertTo-Json -Depth 30) -Encoding UTF8 -NoNewline
    Write-Ok "$path からフックを $removed 件取り除きました"
}

Write-Host ''
Write-Host 'VOICEVOX Coding — フック解除' -ForegroundColor White
Write-Host ('=' * 50)

Remove-OurHooks (Join-Path $ClaudeDir 'settings.json')
Remove-OurHooks (Join-Path $CodexDir 'hooks.json')

$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'VOICEVOX Coding.vbs'
if (Test-Path -LiteralPath $startupLnk) {
    Remove-Item -LiteralPath $startupLnk -Force
    Write-Ok 'スタートアップ登録を削除しました'
}

if ($RemoveConfig) {
    if (Test-Path -LiteralPath $InstallDir) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
        Write-Ok "$InstallDir を削除しました"
    }
} else {
    Write-Skip "設定は $InstallDir に残しています（-RemoveConfig で削除）"
}

Write-Host ''
Write-Host '  デーモンが起動中の場合は停止してください。' -ForegroundColor Yellow
Write-Host ''
