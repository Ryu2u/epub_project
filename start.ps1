Write-Host "=============================="
Write-Host "  EPUB Library (Rust backend)"
Write-Host "=============================="

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-PortInUse {
    param([int]$Port)
    try {
        $conn = [System.Net.Sockets.TcpClient]::new()
        $result = $conn.BeginConnect("127.0.0.1", $Port, $null, $null)
        $success = $result.AsyncWaitHandle.WaitOne(500)
        if ($success) { $conn.EndConnect($result); return $true }
        return $false
    } catch { return $false } finally { if ($conn) { $conn.Dispose() } }
}

$backendRunning = Test-PortInUse 8001
$frontendRunning = Test-PortInUse 3000

if ($backendRunning) {
    Write-Host "Backend already running on :8001, skipping."
} else {
    Write-Host "Starting Rust backend (axum :8001)..."
    Start-Process -FilePath "cmd" -ArgumentList "/c", "cd /d `"$root\backend-rs`" && cargo run --bin epub-backend-rs" -WindowStyle Normal
}

if ($frontendRunning) {
    Write-Host "Frontend already running on :3000, skipping."
} else {
    Write-Host "Starting frontend (vite :3000, proxy to :8001)..."
    Start-Process -FilePath "cmd" -ArgumentList "/c", "cd /d `"$root\web`" && set VITE_BACKEND_URL=http://localhost:8001 && corepack pnpm dev" -WindowStyle Normal
}

Write-Host ""
Write-Host "Backend: http://localhost:8001"
Write-Host "Frontend: http://localhost:3000"
Write-Host ""
