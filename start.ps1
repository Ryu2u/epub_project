Write-Host "=============================="
Write-Host "  EPUB Library"
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
    } catch { return $false } finally { $conn?.Dispose() }
}

$backendRunning = Test-PortInUse 8000
$frontendRunning = Test-PortInUse 5173

if ($backendRunning) {
    Write-Host "Backend already running on :8000, skipping."
} else {
    Write-Host "Starting backend (uvicorn :8000)..."
    Start-Process -FilePath "cmd" -ArgumentList "/c", "cd /d `"$root\backend`" && uv run uvicorn epub_backend.main:app --reload --port 8000" -WindowStyle Normal
}

if ($frontendRunning) {
    Write-Host "Frontend already running on :5173, skipping."
} else {
    Write-Host "Starting frontend (vite :5173)..."
    Start-Process -FilePath "cmd" -ArgumentList "/c", "cd /d `"$root\web`" && corepack pnpm dev" -WindowStyle Normal
}

Write-Host ""
Write-Host "Backend: http://localhost:8000"
Write-Host "Frontend: http://localhost:5173"
Write-Host ""
if ((-not $backendRunning) -or (-not $frontendRunning)) {
    Write-Host "Close the cmd windows to stop, or press Ctrl+C here."
    Pause
}
