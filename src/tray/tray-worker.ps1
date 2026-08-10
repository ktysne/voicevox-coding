# タスクトレイ常駐アイコン。
# デーモンとは HTTP だけでやり取りする（stdin を使わないので、
# NotifyIcon が要求するメッセージポンプと素直に共存できる）。
#
# 使い方: powershell -File tray-worker.ps1 -Port 7591 -ParentPid 1234 -Token <トークン>

[CmdletBinding()]
param(
    [int]$Port = 7591,
    [int]$ParentPid = 0,
    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Base    = "http://127.0.0.1:$Port"
$LogDir  = Join-Path $env:USERPROFILE '.voicevox-coding'

# ---------------------------------------------------------------- アイコン

# 状態ごとに 1 回だけ作って使い回す。都度生成すると GDI ハンドルが漏れる。
function New-TrayIcon([System.Drawing.Color]$accent) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # スピーカー本体
    $body = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 238, 244))
    $g.FillRectangle($body, 6, 12, 6, 8)
    $cone = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cone.AddPolygon(@(
        (New-Object System.Drawing.Point 12, 12),
        (New-Object System.Drawing.Point 18, 6),
        (New-Object System.Drawing.Point 18, 26),
        (New-Object System.Drawing.Point 12, 20)
    ))
    $g.FillPath($body, $cone)

    # 音波（状態色）
    $pen = New-Object System.Drawing.Pen $accent, 2.4
    $g.DrawArc($pen, 17, 9, 8, 14, -60, 120)
    $g.DrawArc($pen, 15, 5, 14, 22, -55, 110)

    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $pen.Dispose(); $cone.Dispose(); $body.Dispose(); $g.Dispose(); $bmp.Dispose()
    return $icon
}

$Icons = @{
    idle     = New-TrayIcon ([System.Drawing.Color]::FromArgb(74, 222, 128))   # 緑: 待機
    speaking = New-TrayIcon ([System.Drawing.Color]::FromArgb(94, 176, 239))   # 青: 読み上げ中
    muted    = New-TrayIcon ([System.Drawing.Color]::FromArgb(120, 128, 140))  # 灰: 一時停止
    down     = New-TrayIcon ([System.Drawing.Color]::FromArgb(248, 113, 113))  # 赤: エンジン未接続
}

# ---------------------------------------------------------------- HTTP

function Invoke-Daemon([string]$path, [string]$method = 'GET', $body = $null) {
    try {
        $params = @{ Uri = "$Base$path"; Method = $method; TimeoutSec = 3 }
        # 状態変更 API は起動ごとのトークンを要求する (AUD-01)
        if ($Token) {
            $params['Headers'] = @{ 'X-VoiceVox-Coding-Token' = $Token }
        }
        # 状態変更 API は Content-Type: application/json しか受け付けない (AUD-01)。
        # 本文を省いた POST には PowerShell が application/x-www-form-urlencoded を付けてしまい
        # 415 で弾かれるため、本文が無くても空 JSON を明示して送る。
        # Content-Type を付けないのは、そもそも本文を持たない GET / HEAD だけ。
        if ($null -ne $body) {
            $params['Body'] = ($body | ConvertTo-Json -Depth 5 -Compress)
            $params['ContentType'] = 'application/json'
        }
        elseif ($method -ne 'GET' -and $method -ne 'HEAD') {
            $params['Body'] = '{}'
            $params['ContentType'] = 'application/json'
        }
        return Invoke-RestMethod @params
    }
    catch {
        return $null
    }
}

# ---------------------------------------------------------------- メニュー

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen      = $menu.Items.Add('管理コンソールを開く')
$null        = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miSkip      = $menu.Items.Add('今の発話をスキップ')
$miClear     = $menu.Items.Add('すべて停止')
$miMute      = New-Object System.Windows.Forms.ToolStripMenuItem '読み上げを一時停止'
$miMute.CheckOnClick = $false
$null        = $menu.Items.Add($miMute)
$null        = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miEngine    = $menu.Items.Add('VOICEVOX エンジンを起動')
$null        = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miLog       = $menu.Items.Add('設定フォルダを開く')
$miExit      = $menu.Items.Add('終了')

$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $Icons.down
$notify.Text = 'VOICEVOX Coding'
$notify.ContextMenuStrip = $menu
$notify.Visible = $true

$appContext = New-Object System.Windows.Forms.ApplicationContext

function Stop-Tray {
    $notify.Visible = $false
    $notify.Dispose()
    foreach ($i in $Icons.Values) { $i.Dispose() }
    $appContext.ExitThread()
}

$miOpen.Add_Click({ Start-Process $Base })
$notify.Add_DoubleClick({ Start-Process $Base })
$miSkip.Add_Click({ Invoke-Daemon '/api/skip' 'POST' | Out-Null })
$miClear.Add_Click({ Invoke-Daemon '/api/clear' 'POST' | Out-Null })
$miLog.Add_Click({ Start-Process explorer.exe $LogDir })

$script:muted = $false
$miMute.Add_Click({
    $next = -not $script:muted
    Invoke-Daemon '/api/mute' 'POST' @{ muted = $next } | Out-Null
})

$script:engineUp = $false
$miEngine.Add_Click({
    if ($script:engineUp) {
        $notify.Text = 'VOICEVOX Coding — エンジンを停止しています'
        Invoke-Daemon '/api/engine/stop' 'POST' | Out-Null
    } else {
        $notify.Text = 'VOICEVOX Coding — エンジンを起動しています'
        $notify.ShowBalloonTip(4000, 'VOICEVOX Coding', 'エンジンを起動しています。初回はモデル読み込みに時間がかかります。', [System.Windows.Forms.ToolTipIcon]::Info)
        Invoke-Daemon '/api/engine/start' 'POST' | Out-Null
    }
})

$miExit.Add_Click({
    Invoke-Daemon '/api/shutdown' 'POST' | Out-Null
    Stop-Tray
})

# ---------------------------------------------------------------- 状態の反映

$script:missCount = 0

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
    # 親（デーモン）が消えていたらトレイも畳む
    if ($ParentPid -gt 0) {
        $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
        if (-not $parent) { Stop-Tray; return }
    }

    $state = Invoke-Daemon '/api/state'
    if ($null -eq $state) {
        $script:missCount++
        $notify.Icon = $Icons.down
        $notify.Text = 'VOICEVOX Coding — デーモン停止'
        # 親 PID が分からない構成でも、応答が無い状態が続けば終了する
        if ($ParentPid -le 0 -and $script:missCount -ge 10) { Stop-Tray }
        return
    }
    $script:missCount = 0

    $script:engineUp = [bool]$state.engine.available
    $script:muted    = [bool]$state.muted
    $miMute.Checked  = $script:muted
    $miMute.Text     = if ($script:muted) { '読み上げを再開' } else { '読み上げを一時停止' }
    $miEngine.Text   = if ($script:engineUp) { 'VOICEVOX エンジンを停止' } else { 'VOICEVOX エンジンを起動' }
    # 自分で起動していないエンジン（GUI 版など）は止められないので伏せる
    $miEngine.Enabled = (-not $script:engineUp) -or [bool]$state.engineProcess.managed

    $speaking = $null -ne $state.queue.current

    if (-not $script:engineUp) {
        $notify.Icon = $Icons.down
        $notify.Text = 'VOICEVOX Coding — エンジン未接続'
    }
    elseif ($script:muted) {
        $notify.Icon = $Icons.muted
        $notify.Text = 'VOICEVOX Coding — 一時停止中'
    }
    elseif ($speaking) {
        $notify.Icon = $Icons.speaking
        $queued = @($state.queue.queued).Count
        $suffix = if ($queued -gt 0) { " (待機 $queued)" } else { '' }
        $notify.Text = "VOICEVOX Coding — 読み上げ中$suffix"
    }
    else {
        $notify.Icon = $Icons.idle
        $notify.Text = 'VOICEVOX Coding — 待機中'
    }

    # NotifyIcon.Text は 63 文字までしか受け付けない
    if ($notify.Text.Length -gt 62) { $notify.Text = $notify.Text.Substring(0, 62) }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($appContext)

$timer.Stop()
try { $notify.Dispose() } catch {}
exit 0
