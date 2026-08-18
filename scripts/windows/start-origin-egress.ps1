# Starts the local TypeMoon CONNECT proxy and Oracle reverse SSH if they are down.
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$hostName = if ($env:REDSTM_ORACLE_HOST) { $env:REDSTM_ORACLE_HOST } else { "158.179.169.191" }
$key = if ($env:REDSTM_ORACLE_KEY) { $env:REDSTM_ORACLE_KEY } else {
    Join-Path $env:USERPROFILE ".ssh\ssh-key-2026-01-09.key"
}
$listen = "127.0.0.1"
$port = 18080

function Test-LocalListen {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $client.Connect($listen, $port)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

function Test-ReverseTunnel {
    $match = "18080:127.0.0.1:18080"
    return [bool](
        Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($match) }
    )
}

if (-not (Test-Path -LiteralPath $key)) {
    throw "Oracle SSH key is missing: $key"
}

if (Test-LocalListen) {
    Write-Host "origin-egress already listening on ${listen}:${port}"
} else {
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) {
        throw "uv is not on PATH"
    }
    Start-Process -FilePath $uv.Source -WorkingDirectory $repo -WindowStyle Hidden -ArgumentList @(
        "run", "python", "-m", "scripts.origin_egress", "--listen", "${listen}:${port}"
    ) | Out-Null
    $ready = $false
    foreach ($unused in 1..20) {
        Start-Sleep -Milliseconds 250
        if (Test-LocalListen) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        throw "origin-egress did not start on ${listen}:${port}"
    }
    Write-Host "origin-egress started on ${listen}:${port}"
}

if (Test-ReverseTunnel) {
    Write-Host "reverse SSH tunnel already running"
} else {
    Start-Process -FilePath "ssh" -WindowStyle Hidden -ArgumentList @(
        "-N",
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=4",
        "-o", "ConnectTimeout=12",
        "-i", $key,
        "-R", "${listen}:${port}:${listen}:${port}",
        "ubuntu@${hostName}"
    ) | Out-Null
    Start-Sleep -Seconds 1
    if (-not (Test-ReverseTunnel)) {
        throw "reverse SSH tunnel did not start"
    }
    Write-Host "reverse SSH tunnel started"
}
