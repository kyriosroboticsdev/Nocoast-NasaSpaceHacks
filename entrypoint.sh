#!/usr/bin/env sh
# Container entrypoint: populate data/ (from the Azure Blob cache if configured, else NASA/JPL
# directly — see backend/azure_cache.py), then start the API.
set -e
python -m scripts.fetch_data
exec uvicorn backend.app:app --host 0.0.0.0 --port 8765
