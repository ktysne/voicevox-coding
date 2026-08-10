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

# デーモン（src/daemon/tray.js）は子プロセスの stderr を utf8 として読み、警告ログへ転送する。
# [Console]::OutputEncoding の書き換えはコンソールのコードページに依存するので、
# stderr のストリームへ直接 UTF-8（BOM 無し）で書く。
$script:stderrWriter = $null
function Write-Stderr([string]$line) {
    # 通知は best-effort。ここで例外を出すと、呼び出し元（Invoke-Daemon の catch）を
    # 貫通して「終了」の後続処理まで巻き添えにするので、失敗は握りつぶす。
    try {
        if ($null -eq $script:stderrWriter) {
            $script:stderrWriter = New-Object System.IO.StreamWriter -ArgumentList @(
                [Console]::OpenStandardError(),
                (New-Object System.Text.UTF8Encoding -ArgumentList $false)
            )
            $script:stderrWriter.AutoFlush = $true
        }
        $script:stderrWriter.WriteLine($line)
    }
    catch { }
}

# -Action には「発話のスキップ」のような操作名を渡す。失敗したときに stderr へ 1 行出す。
# 省略した場合（既定の空文字）は失敗を通知しない。
# -Ok に [ref] を渡すと成否を受け取れる。戻り値では判定できない
# （本文の無い成功応答も $null になり、失敗と区別が付かない）。
# [ref] 型で宣言すると引数を省略できなくなるため、型は付けずに中で確かめる。
# [CmdletBinding()] は必須。簡易関数のままだと、綴り違いの -Action が
# エラーにならず $args に落ちて消え、通知だけが黙って失われる。
function Invoke-Daemon {
    [CmdletBinding()]
    param(
        [string]$Path,
        [string]$Method = 'GET',
        $Body = $null,
        [string]$Action = '',
        $Ok = $null
    )
    try {
        $params = @{ Uri = "$Base$Path"; Method = $Method; TimeoutSec = 3 }
        # 状態変更 API は起動ごとのトークンを要求する (AUD-01)
        if ($Token) {
            $params['Headers'] = @{ 'X-VoiceVox-Coding-Token' = $Token }
        }
        # 状態変更 API は Content-Type: application/json しか受け付けない (AUD-01)。
        # 本文を省いた POST には PowerShell が application/x-www-form-urlencoded を付けてしまい
        # 415 で弾かれるため、本文が無くても空 JSON を明示して送る。
        # Content-Type を付けないのは、そもそも本文を持たない GET / HEAD だけ。
        if ($null -ne $Body) {
            $params['Body'] = ($Body | ConvertTo-Json -Depth 5 -Compress)
            $params['ContentType'] = 'application/json'
        }
        elseif ($Method -ne 'GET' -and $Method -ne 'HEAD') {
            $params['Body'] = '{}'
            $params['ContentType'] = 'application/json'
        }
        $result = Invoke-RestMethod @params
        if ($Ok -is [ref]) { $Ok.Value = $true }
        return $result
    }
    catch {
        if ($Ok -is [ref]) { $Ok.Value = $false }
        # 失敗を黙って捨てると不具合が長く気づかれない（#31 の 415 がそうだった）。
        # stderr はデーモンの警告ログへ転送されるので、そこへ 1 行残す。
        # ただし 2 秒ごとのポーリング（/api/state）はデーモン停止中に鳴り続けるため、
        # -Action を渡さない呼び出し（＝ユーザー操作起点でないもの）は黙って捨てる。
        if ($Action) {
            # Windows PowerShell 5.1 の Invoke-RestMethod は応答本文を ErrorDetails に載せない。
            # 代わりに例外のメッセージを使う。HTTP エラーなら状態コードが含まれるので、
            # #31 の 415 なら「(415) …」まで分かる（文面は OS の表示言語に従う）。
            $reason = ($_.Exception.Message -replace '\s+', ' ').Trim()
            if ($reason.Length -gt 200) { $reason = $reason.Substring(0, 200) + '…' }
            # ${} で囲まないと、後続の日本語まで変数名として読まれる
            Write-Stderr "${Action}に失敗しました: $reason"
        }
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
$miSkip.Add_Click({ Invoke-Daemon '/api/skip' 'POST' -Action '発話のスキップ' | Out-Null })
$miClear.Add_Click({ Invoke-Daemon '/api/clear' 'POST' -Action '読み上げの全停止' | Out-Null })
$miLog.Add_Click({ Start-Process explorer.exe $LogDir })

$script:muted = $false
$miMute.Add_Click({
    $next = -not $script:muted
    $label = if ($next) { '読み上げの一時停止' } else { '読み上げの再開' }
    Invoke-Daemon '/api/mute' 'POST' @{ muted = $next } -Action $label | Out-Null
})

$script:engineUp = $false
$miEngine.Add_Click({
    if ($script:engineUp) {
        $notify.Text = 'VOICEVOX Coding — エンジンを停止しています'
        Invoke-Daemon '/api/engine/stop' 'POST' -Action 'エンジンの停止' | Out-Null
    } else {
        $notify.Text = 'VOICEVOX Coding — エンジンを起動しています'
        $notify.ShowBalloonTip(4000, 'VOICEVOX Coding', 'エンジンを起動しています。初回はモデル読み込みに時間がかかります。', [System.Windows.Forms.ToolTipIcon]::Info)
        Invoke-Daemon '/api/engine/start' 'POST' -Action 'エンジンの起動' | Out-Null
    }
})

$miExit.Add_Click({
    $accepted = $false
    Invoke-Daemon '/api/shutdown' 'POST' -Action 'デーモンの停止' -Ok ([ref]$accepted) | Out-Null

    # 停止 API はデーモン自身を落とす前に応答を返す実装なので、
    # 応答が返った時点で「受理された」と見なしてよい。
    if ($accepted) { Stop-Tray; return }

    # 停止できなかった。デーモンのプロセスがもう無いなら常駐を続ける意味は無いので畳む。
    # 判定は「確実に消えている」ときだけ畳む向きに倒す。応答の内容（403 や 500）で
    # 判断すると、デーモンが動いているのにトレイだけ消える #35 を作り直してしまう。
    $daemonGone = ($ParentPid -gt 0) -and (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue))
    if ($daemonGone) { Stop-Tray; return }

    # 生きているかもしれない場合はトレイを残す。
    # ここで畳むと、利用者は GUI からの停止手段を失う (#35)。
    # デーモンが応答しないまま落ちたときは、2 秒ごとの監視がトレイを畳む。
    $notify.ShowBalloonTip(
        5000,
        'VOICEVOX Coding',
        'デーモンを停止できませんでした。もう一度お試しください。失敗の理由は管理コンソールのログに残ります。',
        [System.Windows.Forms.ToolTipIcon]::Error
    )
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
