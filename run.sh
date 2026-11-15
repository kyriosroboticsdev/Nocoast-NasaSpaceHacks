#!/usr/bin/env sh
# One-command local start (macOS/Linux): sets up venv + data on first run.
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install -q -r requirements.txt
.venv/bin/python -m scripts.fetch_data
echo "Open http://127.0.0.1:8765"
exec .venv/bin/python -m uvicorn backend.app:app --port 8765
