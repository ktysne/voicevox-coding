# 常駐再生ワーカー。
# デーモンから stdin で 1 行ずつコマンドを受け取り、stdout で応答する。
# SoundPlayer.Play() は非同期なので、再生中も次のコマンドを読み続けられる。
# これにより「読み上げ中のスキップ」と「連続再生のギャップ最小化」を両立する。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding  = [Text.Encoding]::UTF8

$player = New-Object System.Media.SoundPlayer

# HOLD で使う短い無音 WAV はプロセス内で一度だけ組み立てる。
# ファイルを作らないため、異常終了時に一時ファイルが残る心配がない。
$holdStream = $null
$holding = $false

function Write-Int32LE([System.IO.Stream]$stream, [int]$value) {
    $bytes = [System.BitConverter]::GetBytes($value)
    $stream.Write($bytes, 0, $bytes.Length)
}

function Write-UInt16LE([System.IO.Stream]$stream, [int]$value) {
    $bytes = [System.BitConverter]::GetBytes([uint16]$value)
    $stream.Write($bytes, 0, $bytes.Length)
}

function New-SilenceWavStream {
    # 2 秒の 8 kHz / 16 bit / モノラル。PlayLooping で繰り返すので短くてよい。
    $sampleRate = 8000
    $channels = 1
    $bitsPerSample = 16
    $durationMs = 2000
    $dataSize = [int]([math]::Floor($sampleRate * $durationMs / 1000) * $channels * ($bitsPerSample / 8))
    $byteRate = $sampleRate * $channels * ($bitsPerSample / 8)
    $blockAlign = $channels * ($bitsPerSample / 8)

    $stream = New-Object System.IO.MemoryStream
    $ascii = [Text.Encoding]::ASCII
    $riff = $ascii.GetBytes('RIFF')
    $stream.Write($riff, 0, $riff.Length)
    Write-Int32LE $stream (36 + $dataSize)
    $wave = $ascii.GetBytes('WAVE')
    $stream.Write($wave, 0, $wave.Length)
    $fmt = $ascii.GetBytes('fmt ')
    $stream.Write($fmt, 0, $fmt.Length)
    Write-Int32LE $stream 16
    Write-UInt16LE $stream 1
    Write-UInt16LE $stream $channels
    Write-Int32LE $stream $sampleRate
    Write-Int32LE $stream $byteRate
    Write-UInt16LE $stream $blockAlign
    Write-UInt16LE $stream $bitsPerSample
    $data = $ascii.GetBytes('data')
    $stream.Write($data, 0, $data.Length)
    Write-Int32LE $stream $dataSize
    $silence = New-Object byte[] $dataSize
    $stream.Write($silence, 0, $silence.Length)
    $stream.Position = 0
    return $stream
}

function Stop-Playback {
    try { $player.Stop() } catch {}
    $script:holding = $false
    # SoundLocation/Stream は次の PLAY/HOLD に確実に差し替えられるよう解放する。
    try { $player.Stream = $null } catch {}
    try { $player.SoundLocation = '' } catch {}
}

function Dispose-Playback {
    Stop-Playback
    try { $player.Dispose() } catch {}
    if ($null -ne $script:holdStream) {
        try { $script:holdStream.Dispose() } catch {}
        $script:holdStream = $null
    }
}

$holdStream = New-SilenceWavStream

function Send-Line([string]$s) {
    [Console]::Out.WriteLine($s)
    [Console]::Out.Flush()
}

Send-Line 'READY'

try {
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }

    $sp   = $line.IndexOf(' ')
    $cmd  = if ($sp -lt 0) { $line } else { $line.Substring(0, $sp) }
    $arg  = if ($sp -lt 0) { '' }   else { $line.Substring($sp + 1) }

    try {
        switch ($cmd) {
            'PLAY' {
                if (-not (Test-Path -LiteralPath $arg)) {
                    Send-Line "ERR file not found"
                    break
                }
                Stop-Playback
                $player.SoundLocation = $arg
                $player.Load()
                $player.Play()
                Send-Line 'OK'
            }
            'HOLD' {
                Stop-Playback
                $holdStream.Position = 0
                $player.Stream = $holdStream
                $player.PlayLooping()
                $script:holding = $true
                Send-Line 'OK'
            }
            'STOP' {
                Stop-Playback
                Send-Line 'OK'
            }
            'PING' { Send-Line 'PONG' }
            'EXIT' {
                Dispose-Playback
                Send-Line 'BYE'
                exit 0
            }
            default { Send-Line "ERR unknown command" }
        }
    }
    catch {
        # 再生失敗でワーカーを落とさない。デーモン側は ERR を受けて次に進む
        # HOLD が途中まで成功していた場合も無音ループを残さない。
        try { Stop-Playback } catch {}
        Send-Line ("ERR " + ($_.Exception.Message -replace '\r?\n', ' '))
    }
}
} finally {
    # EOF、未捕捉例外、ワーカー終了のいずれでも再生とストリームを解放する。
    Dispose-Playback
}
exit 0
