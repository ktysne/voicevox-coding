<#
.SYNOPSIS
    VOICEVOX Coding のフックを Claude Code と Codex に登録する。

.DESCRIPTION
    フッククライアントを %USERPROFILE%\.voicevox-coding\ に配置し、
    Claude Code の settings.json と Codex の hooks.json に登録する。
    既存の設定は必ずバックアップしたうえでマージする（上書きしない）。

    フックはデーモンに転送するだけで、読み上げるかどうかの判断は
    すべてデーモン側の設定が持つ。したがってイベントは一度登録すれば
    以後は管理コンソールだけで運用でき、フック定義を触る必要はない。
    Codex はフック定義のハッシュで信頼を管理するため、これは重要な性質。

.PARAMETER IncludeToolEvents
    ツール実行前後（PreToolUse / PostToolUse）も登録する。
    ツール呼び出しのたびにプロセスが起動するので、必要なときだけ。

.PARAMETER RegisterStartup
    Windows のスタートアップにデーモンを登録する。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -IncludeToolEvents -RegisterStartup
#>

[CmdletBinding()]
param(
    [switch]$IncludeToolEvents,
    [switch]$SkipClaude,
    [switch]$SkipCodex,
    [switch]$RegisterStartup
)

$ErrorActionPreference = 'Stop'

# ConvertFrom-Json -AsHashtable は PowerShell 6 以降にしかない。
# Windows PowerShell 5.1 で起動された場合は pwsh に引き継ぐ。
if ($PSVersionTable.PSVersion.Major -lt 6) {
    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if (-not $pwsh) {
        Write-Error 'このスクリプトには PowerShell 7 (pwsh) が必要です。https://aka.ms/powershell からインストールしてください。'
        exit 1
    }
    $forward = @()
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        if ($kv.Value -is [switch]) {
            # 明示的な -Name:$false も失わずに転送する（未指定と明示 false の区別を
            # pwsh 側でも保つ。-File への -Name:$false 渡しは PowerShell が公式に対応）
            $forward += "-$($kv.Key):`$$($kv.Value.IsPresent)"
        } else {
            $forward += "-$($kv.Key)"
            $forward += [string]$kv.Value
        }
    }
    & $pwsh.Source -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @forward
    exit $LASTEXITCODE
}

$RepoRoot     = Split-Path -Parent $PSScriptRoot
$InstallDir   = Join-Path $env:USERPROFILE '.voicevox-coding'
$HookScript   = Join-Path $InstallDir 'hook-client.js'
$ManifestPath = Join-Path $InstallDir 'install.json'
$ClaudeDir    = Join-Path $env:USERPROFILE '.claude'
$CodexDir     = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }

function Write-Step($msg)  { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  警告 $msg" -ForegroundColor Yellow }

function Get-NodePath {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'node.exe が PATH に見つかりません。Node.js をインストールしてください。' }
    return $cmd.Source
}

<#
  Claude Code 用のコマンド文字列。
  シェル経由で実行されるので、空白を含むパスも引用しておけば安全に通る。
#>
function New-ClaudeHookCommand([string]$nodePath, [string]$target) {
    return '"{0}" "{1}" {2}' -f $nodePath, $HookScript, $target
}

<#
  Codex 用のコマンド文字列。
  Codex は command の先頭（実行ファイル）を引用符付きで書くと解決に失敗する
  （"D:\Program Files\nodejs\node.exe" ... は起動できない）。
  引数側の引用は効くので、実行ファイルは PATH 上の `node` を素の名前で指定する。
#>
function New-CodexHookCommand([string]$target) {
    return 'node "{0}" {1}' -f $HookScript, $target
}

function Backup-File([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$path.bak-$stamp"
    # 同一秒内の再実行（update の install 再実行など）で既存の世代を上書きしない。
    # 既にあるなら -2, -3 … を付けて一意化する（世代整理の正規表現もこの形を対象に含む）
    $n = 2
    while (Test-Path -LiteralPath $backup) {
        $backup = "$path.bak-$stamp-$n"
        $n += 1
    }
    Copy-Item -LiteralPath $path -Destination $backup -Force
    return $backup
}

<#
  対象ファイルのバックアップ世代を整理する。
  「<ファイル名>.bak-yyyyMMdd-HHmmss（同一秒の一意化 -N を含む）」に完全一致する
  ものだけを対象にし、新しい順（名前の降順）に $Keep 件だけ残して古いものを削除する。
  削除に失敗しても install 全体は失敗させず、警告だけ出して続行する。
#>
function Remove-OldBackups([string]$path, [int]$Keep = 5) {
    $dir  = Split-Path -Parent $path
    $name = Split-Path -Leaf $path
    if (-not (Test-Path -LiteralPath $dir)) { return }

    $pattern = '^' + [regex]::Escape($name) + '\.bak-\d{8}-\d{6}(-\d+)?$'
    # 並びは「タイムスタンプの降順 → 同一秒の枝番の数値降順」。名前の文字列降順だと
    # 枝番が二桁になったとき -9 が -10 より新しい扱いになり、最新の世代を消してしまう
    $backups = @(
        Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match $pattern } |
            ForEach-Object {
                [void]($_.Name -match '\.bak-(\d{8}-\d{6})(?:-(\d+))?$')
                # ?? は PowerShell 7 専用。5.1 は自己再起動より前にファイル全体を
                # パースするため、ここで使うと -File 起動が構文エラーで壊れる
                $seq = if ($Matches[2]) { [int]$Matches[2] } else { 1 }
                [pscustomobject]@{ File = $_; Stamp = $Matches[1]; Seq = $seq }
            } |
            Sort-Object -Property Stamp, Seq -Descending
    )

    if ($backups.Count -le $Keep) { return }

    foreach ($old in $backups[$Keep..($backups.Count - 1)]) {
        try {
            Remove-Item -LiteralPath $old.File.FullName -Force
        } catch {
            Write-Warn2 "古いバックアップを削除できませんでした: $($old.File.FullName) ($($_.Exception.Message))"
        }
    }
}

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return @{} }
    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
    return $raw | ConvertFrom-Json -AsHashtable
}

function ConvertTo-JsonText($obj) {
    return $obj | ConvertTo-Json -Depth 30
}

function Get-RawFileContent([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return Get-Content -LiteralPath $path -Raw -Encoding UTF8
}

function Write-JsonFile([string]$path, [string]$json) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # ConvertTo-Json は BOM なし UTF-8 で書く（既定の Set-Content が pwsh7 では BOM なし）
    Set-Content -LiteralPath $path -Value $json -Encoding UTF8 -NoNewline
}

<#
  対象イベントに我々のフックを 1 つだけ登録する。
  同じフックが既にあれば置き換え、他のフック（codegraph など）はそのまま残す。
#>
function Merge-Hook {
    param(
        [hashtable]$Root,
        [string]$EventName,
        [string]$Command,
        [string]$Matcher,
        [switch]$Async,
        [int]$TimeoutSec = 0
    )

    if (-not $Root.ContainsKey('hooks') -or $Root.hooks -isnot [hashtable]) { $Root['hooks'] = @{} }
    $hooks = $Root['hooks']
    if (-not $hooks.ContainsKey($EventName) -or $hooks[$EventName] -isnot [System.Collections.IEnumerable]) {
        $hooks[$EventName] = @()
    }

    $handler = [ordered]@{ type = 'command'; command = $Command }
    if ($TimeoutSec -gt 0) { $handler['timeout'] = $TimeoutSec }
    if ($Async)            { $handler['async']   = $true }

    $group = [ordered]@{}
    if ($Matcher) { $group['matcher'] = $Matcher }
    $group['hooks'] = @($handler)

    # 既存グループから我々のフックだけを取り除く
    $kept = @()
    foreach ($g in @($hooks[$EventName])) {
        if ($null -eq $g) { continue }
        $inner = @()
        foreach ($hk in @($g.hooks)) {
            if ($null -eq $hk) { continue }
            $cmdText = [string]$hk.command
            if ($cmdText -like '*hook-client.js*') { continue }   # 我々のもの → 捨てて再登録
            $inner += $hk
        }
        if ($inner.Count -gt 0) {
            $ng = [ordered]@{}
            if ($g.matcher) { $ng['matcher'] = $g.matcher }
            $ng['hooks'] = $inner
            $kept += $ng
        }
    }

    $hooks[$EventName] = @($kept) + @($group)
    return $Root
}

<#
  対象イベントから我々のフックだけを取り除く。他のフックは残し、
  空になったイベントキーは消す。-IncludeToolEvents を外した更新で、
  以前に登録した高頻度フック（PreToolUse / PostToolUse）が
  発火し続けないようにするために使う。
#>
function Remove-OurHook {
    param(
        [hashtable]$Root,
        [string]$EventName
    )
    if (-not $Root.ContainsKey('hooks') -or $Root.hooks -isnot [hashtable]) { return $Root }
    $hooks = $Root['hooks']
    if (-not $hooks.ContainsKey($EventName)) { return $Root }

    $kept = @()
    foreach ($g in @($hooks[$EventName])) {
        if ($null -eq $g) { continue }
        $inner = @()
        foreach ($hk in @($g.hooks)) {
            if ($null -eq $hk) { continue }
            if ([string]$hk.command -like '*hook-client.js*') { continue }
            $inner += $hk
        }
        if ($inner.Count -gt 0) {
            $ng = [ordered]@{}
            if ($g.matcher) { $ng['matcher'] = $g.matcher }
            $ng['hooks'] = $inner
            $kept += $ng
        }
    }
    if ($kept.Count -gt 0) { $hooks[$EventName] = @($kept) } else { $hooks.Remove($EventName) }
    return $Root
}

<#
  「期待する導入構成」を manifest (install.json) に保存する。
  update.ps1 はこれを読み、明示指定されなかったオプションを引き継ぐ。
  doctor.mjs はこれを読み、導入形態に応じて検査の要否を判定する。
  一時ファイルへ書いてから置き換えるので、書き込み中に落ちても既存の manifest は壊れない。
#>
function Save-InstallManifest {
    param(
        [string]$Path,
        [bool]$IncludeToolEvents,
        [bool]$SkipClaude,
        [bool]$SkipCodex,
        [bool]$RegisterStartup
    )

    $manifest = [ordered]@{
        schemaVersion     = 1
        savedAt           = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        includeToolEvents = $IncludeToolEvents
        skipClaude        = $SkipClaude
        skipCodex         = $SkipCodex
        registerStartup   = $RegisterStartup
    }
    $json = $manifest | ConvertTo-Json -Depth 5

    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8 -NoNewline
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# ------------------------------------------------------------------ 開始

Write-Host ''
Write-Host 'VOICEVOX Coding — フック登録' -ForegroundColor White
Write-Host ('=' * 50)

$node = Get-NodePath
Write-Ok "node.exe: $node"

if ($SkipClaude -and $SkipCodex) {
    Write-Warn2 'フックの登録対象がありません（-SkipClaude と -SkipCodex が両方指定されています）'
}

# --- フッククライアントの配置 ---
Write-Step 'フッククライアントを配置します'
if (-not (Test-Path -LiteralPath $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
$src = Join-Path $RepoRoot 'src\hook\hook-client.js'
if (-not (Test-Path -LiteralPath $src)) { throw "フッククライアントが見つかりません: $src" }
Copy-Item -LiteralPath $src -Destination $HookScript -Force
Write-Ok $HookScript

# 登録するイベント。ツール実行前後は既定で除外する（発火が多いため）
$claudeEvents = @('Stop', 'MessageDisplay', 'Notification', 'SessionStart', 'SessionEnd', 'SubagentStop', 'UserPromptSubmit', 'PreCompact')
$codexEvents  = @('Stop', 'PermissionRequest', 'SessionStart', 'SessionEnd', 'SubagentStop', 'UserPromptSubmit', 'PreCompact')
if ($IncludeToolEvents) {
    $claudeEvents += @('PreToolUse', 'PostToolUse')
    $codexEvents  += @('PreToolUse', 'PostToolUse')
}

# --- Claude Code ---
if (-not $SkipClaude) {
    Write-Step 'Claude Code に登録します'
    $settingsPath = Join-Path $ClaudeDir 'settings.json'

    $settings = Read-JsonFile $settingsPath
    $cmd = New-ClaudeHookCommand $node 'claudeCode'
    foreach ($ev in $claudeEvents) {
        # Claude Code は async をサポートするので読み上げ処理でセッションを待たせない。
        # MessageDisplay は streaming 中に何度も発火するため、同期にすると表示が詰まる。
        $matcher = if ($ev -in @('PreToolUse', 'PostToolUse')) { '*' } else { $null }
        $settings = Merge-Hook -Root $settings -EventName $ev -Command $cmd -Matcher $matcher -Async -TimeoutSec 10
    }
    if (-not $IncludeToolEvents) {
        # 以前の導入で登録したツールイベントが残っていると高頻度で発火し続ける。
        # 今回の指定に合わせて取り除く（他のフックには触れない）
        foreach ($ev in @('PreToolUse', 'PostToolUse')) {
            $settings = Remove-OurHook -Root $settings -EventName $ev
        }
    }

    # 書き込む内容が既存ファイルと完全一致するなら、バックアップも書き込みも行わない。
    # これにより定例の update ではバックアップ世代がそもそも増えない。
    $newJson     = ConvertTo-JsonText $settings
    $existingRaw = Get-RawFileContent $settingsPath
    if ($existingRaw -ceq $newJson) {
        Write-Ok "変更はありません: $settingsPath"
    } else {
        $backup = Backup-File $settingsPath
        if ($backup) { Write-Ok "バックアップ: $backup" }
        Write-JsonFile $settingsPath $newJson
        Write-Ok "$settingsPath ($($claudeEvents.Count) イベント)"
        # 世代整理は新しい設定の書き込みが成功した後に行う（今回のバックアップは必ず残る）
        if ($backup) { Remove-OldBackups $settingsPath }
    }
} else {
    Write-Warn2 'Claude Code はスキップしました'
}

# --- Codex ---
if (-not $SkipCodex) {
    Write-Step 'Codex に登録します'
    $hooksPath = Join-Path $CodexDir 'hooks.json'

    $codexHooks = Read-JsonFile $hooksPath
    $cmd = New-CodexHookCommand 'codex'
    foreach ($ev in $codexEvents) {
        # Codex 0.145 時点で async フックは読み込み時に無視される。必ず同期で登録する。
        # クライアントはデーモンに投げて即座に終了するので、待たされるのは 0.1 秒程度。
        # SessionEnd のタイムアウトは Codex 側で 3 秒に丸められるので最初から 3 にする。
        $matcher = if ($ev -in @('PreToolUse', 'PostToolUse')) { '*' } else { $null }
        $timeout = if ($ev -eq 'SessionEnd') { 3 } else { 5 }
        $codexHooks = Merge-Hook -Root $codexHooks -EventName $ev -Command $cmd -Matcher $matcher -TimeoutSec $timeout
    }
    if (-not $IncludeToolEvents) {
        foreach ($ev in @('PreToolUse', 'PostToolUse')) {
            $codexHooks = Remove-OurHook -Root $codexHooks -EventName $ev
        }
    }

    # 書き込む内容が既存ファイルと完全一致するなら、バックアップも書き込みも行わない。
    $newJson     = ConvertTo-JsonText $codexHooks
    $existingRaw = Get-RawFileContent $hooksPath
    if ($existingRaw -ceq $newJson) {
        Write-Ok "変更はありません: $hooksPath"
    } else {
        $backup = Backup-File $hooksPath
        if ($backup) { Write-Ok "バックアップ: $backup" }
        Write-JsonFile $hooksPath $newJson
        Write-Ok "$hooksPath ($($codexEvents.Count) イベント)"
        # 世代整理は新しい設定の書き込みが成功した後に行う（今回のバックアップは必ず残る）
        if ($backup) { Remove-OldBackups $hooksPath }
    }

    # 素の `node` で起動するため、実際に名前だけで解決できるか確かめる
    $resolved = & cmd.exe /c 'node --version' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $resolved) {
        Write-Warn2 'PATH から `node` を解決できません。Codex のフックは PATH 上の node を使います。'
        Write-Warn2 "node.exe のディレクトリを PATH に追加してください: $(Split-Path -Parent $node)"
    } else {
        Write-Ok "PATH の node: $($resolved.Trim())"
    }
    Write-Warn2 'Codex はフックの信頼を明示的に承認する必要があります。codex を起動して /hooks から承認してください。'
} else {
    Write-Warn2 'Codex はスキップしました'
}

# --- スタートアップ登録 ---
if ($RegisterStartup) {
    Write-Step 'スタートアップに登録します'
    $startupDir = [Environment]::GetFolderPath('Startup')
    $vbsPath    = Join-Path $InstallDir 'start-daemon.vbs'
    $mainJs     = Join-Path $RepoRoot 'src\daemon\main.js'

    # コンソール窓を出さずに起動するための VBS ラッパ。
    # デーモン自身がポート重複を検出して終了するので、多重起動の心配はない。
    $vbs = @"
' VOICEVOX Coding — デーモンをコンソール窓なしで起動する
Set sh = CreateObject("WScript.Shell")
sh.Run """$node"" ""$mainJs""", 0, False
"@
    # PowerShell 7 の -Encoding UTF8 は BOM なしで書くため、Windows Script Host が
    # VBS を ANSI として解釈してしまい、日本語を含むパスが文字化けする。
    # UTF-16LE（Unicode）で保存すると WSH が確実に文字コードを判別できる。
    Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding Unicode
    Copy-Item -LiteralPath $vbsPath -Destination (Join-Path $startupDir 'VOICEVOX Coding.vbs') -Force
    Write-Ok "$startupDir\VOICEVOX Coding.vbs"
    Write-Ok 'サインイン時にデーモンが起動し、タスクトレイに常駐します'
}

# --- 導入構成の記録 ---
# ここまで到達した時点でフック登録はすべて成功している
# （途中で失敗すれば $ErrorActionPreference = 'Stop' によりここには来ない）。
# 失敗した実行で既存の期待構成を壊さないよう、保存は最後にまとめて行う。
Write-Step '導入構成を記録します'
Save-InstallManifest -Path $ManifestPath `
    -IncludeToolEvents $IncludeToolEvents.IsPresent `
    -SkipClaude $SkipClaude.IsPresent `
    -SkipCodex $SkipCodex.IsPresent `
    -RegisterStartup $RegisterStartup.IsPresent
Write-Ok $ManifestPath

Write-Host ''
Write-Host '次の手順' -ForegroundColor White
Write-Host ('-' * 50)
$step = 1
Write-Host "  $step. デーモンを起動する（VOICEVOX アプリは起動しなくて構いません）:"
Write-Host "       node `"$(Join-Path $RepoRoot 'src\daemon\main.js')`" --open" -ForegroundColor Gray
Write-Host '       エンジンが動いていなければ自動で起動します。'
$step++
Write-Host "  $step. タスクトレイのアイコン、または http://127.0.0.1:7591/ から設定する"
if (-not $SkipCodex) {
    $step++
    Write-Host "  $step. codex を起動し /hooks でフックの信頼を承認する" -ForegroundColor Yellow
}
if ($RegisterStartup) {
    Write-Host ''
    Write-Host '  次回サインインからは自動で起動します。' -ForegroundColor Green
}
Write-Host ''
