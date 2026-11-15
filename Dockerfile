# Backend API (FastAPI): terrain-horizon, ephemeris, and pathfinding compute. Deployed to Azure
# Container Apps by .github/workflows/azure-deploy.yml. The frontend is a separate static deploy
# (Azure Static Web Apps) and does not use this image.
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ backend/
COPY contract/ contract/
COPY scripts/fetch_data.py scripts/fetch_data.py
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Populated at container startup by entrypoint.sh: pulled from the Azure Blob cache when
# AZURE_STORAGE_ACCOUNT_URL is set (see backend/azure_cache.py), else fetched fresh from NASA/JPL.
VOLUME ["/app/data"]

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD curl -f http://127.0.0.1:8765/api/sites || exit 1

ENTRYPOINT ["./entrypoint.sh"]
