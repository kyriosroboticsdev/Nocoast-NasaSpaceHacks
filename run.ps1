# One-command local start (Windows PowerShell).
# Starts the Person 2 science API (Python, port 8765) and the website (Vite, port 5173).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path .venv)) { python -m venv .venv }
.\.venv\Scripts\python -m pip install -q -r requirements.txt
.\.venv\Scripts\python -m scripts.fetch_data
if (-not (Test-Path node_modules)) { npm.cmd ci }
$api = Start-Process -PassThru -NoNewWindow .\.venv\Scripts\python -ArgumentList "-m", "uvicorn", "backend.app:app", "--port", "8765"
try {
  Write-Host "Website: http://127.0.0.1:5173   (science API on :8765)"
  npm.cmd run dev
} finally {
  Stop-Process -Id $api.Id -ErrorAction SilentlyContinue
}
