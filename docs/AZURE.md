# Azure integration

Branch: `infra/azure` (isolated clone — see note at the bottom). Covers the four things asked for:
public hosting, a sponsor-track "uses Azure" story, DEM/kernel data caching, and offloading compute
(terrain horizon + the new pathfinding engine) off a laptop and onto Azure.

## Architecture

```
GitHub (this repo)
  |
  |-- .github/workflows/azure-infra.yml    (manual) --> provisions everything below via infra/main.bicep
  |-- .github/workflows/azure-deploy.yml   (on push) --> builds + ships app code to it
  v
Azure resource group (lunarnav-dev-rg by default)
  |-- Storage Account / "science-data" blob container
  |       <- backend/azure_cache.py: caches the ~240MB of LOLA DEMs + SPICE kernels that
  |          scripts/fetch_data.py downloads from PDS/NAIF/JPL, so repeat cold starts don't re-fetch.
  |
  |-- Container Registry (ACR)
  |       <- holds the backend image built from the repo-root Dockerfile.
  |
  |-- Container Apps environment + Container App ("...-api")
  |       <- runs backend/app.py (FastAPI): terrain horizon, ephemeris/communication analysis
  |          (existing), and the new /api/pathfind route (backend/pathfinding/).
  |       <- system-assigned managed identity: AcrPull on the registry, Storage Blob Data
  |          Contributor on the storage account. No registry or storage secret is stored anywhere.
  |
  |-- Static Web App ("...-web")
  |       <- hosts the built Vite/Three.js frontend (npm run build -> dist/).
  |       <- "linkedBackends" wires /api/* to the Container App at the same origin, so the
  |          frontend's existing relative-path calls (src/app.ts, src/science/backend.ts) work
  |          unmodified in production, the same way Vite's dev proxy makes them work locally.
  |
  +-- Log Analytics + Application Insights
          <- Container App logs/metrics.
```

## What's new in the backend

- `backend/azure_cache.py` — blob read/write for the DEM/kernel cache. A no-op unless
  `AZURE_STORAGE_ACCOUNT_URL` (or `AZURE_STORAGE_CONNECTION_STRING`, for local testing) is set, so local
  dev and the offline demo path are unaffected. Wired into `scripts/fetch_data.py`.
- `backend/pathfinding/` — the Earth<->Moon relay-satellite path search:
  - `graph.py`: generic multi-objective weighted shortest path (non-negative costs). Combines distance,
    sunlit time, Earth-comm time and an obstacle penalty into one scalar cost per edge. Runs Dijkstra,
    or A* when given an (admissible) heuristic — exact either way, but A* expands far fewer nodes as the
    graph grows. Also takes an optional `edge_penalty` to charge costs that depend on the whole segment
    (e.g. a keep-out zone a hop would pierce between two clear waypoints), not just its endpoints. Has
    no notion of Earth/Moon/orbits — fully unit-tested on toy graphs (`tests/test_pathfinding.py`).
  - `earth_moon.py`: builds the concrete graph for this project — a straight Earth-Moon line (from the
    same bundled DE421 kernel already used by `backend/ephem.py`) with a ring of lateral waypoint
    choices at each step, each flagged sunlit/earth-visible/blocked via simple sphere-shadow and
    sphere-occlusion geometry.
  - **This is explicitly a first pass**, in the same spirit as this codebase's existing honesty
    badging (e.g. "optimistic sphere horizon" for non-LOLA sites): no propagated trajectory, no patched
    conics, no real obstacle catalog (debris, radiation belts) yet — `obstacles` is an empty list by
    default and accepts caller-supplied keep-out spheres. Swap the graph builder once real
    mission/orbit data is available; `graph.py` and the `/api/pathfind` route don't change.
  - New route: `GET /api/pathfind?epochUtc=...&layers=...&lateralSteps=...&lateralRings=...&spacing=...&shadowSamples=...&wDarkness=...&wNoComm=...`
    returns the winning path's waypoints plus `sunlitFraction` / `earthCommFraction` / `totalDistanceKm`.
    `lateralRings` adds concentric detour radii for finer paths; `spacing=cosine` clusters layers near
    Earth/Moon where the shadow and comm edges fall; `shadowSamples>1` prices darkness/comms from the
    fraction of each hop in shadow rather than its endpoint flag. The search runs A* (exact).

## What you need to provide

Nothing has been deployed — there's no Azure subscription, resource group, or credentials wired in yet.
To actually stand this up:

1. **An Azure subscription** (and its subscription ID).
2. **A way for GitHub Actions to authenticate**, either:
   - OIDC (recommended, no stored secret): create an Azure AD app registration with a federated
     credential trusting this repo, then set repo **variables** `AZURE_CLIENT_ID`, and **secrets**
     `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`; or
   - Classic: `az ad sp create-for-rbac --sdk-auth` output as the `AZURE_CREDENTIALS` secret.
3. **`AZURE_STATIC_WEB_APPS_API_TOKEN`** secret — generated after the Static Web App resource exists
   (`az staticwebapp secrets list`), used only by the frontend deploy step.
4. Repo **variables** (optional, sensible defaults already in `infra/main.parameters.json` /
   `azure-deploy.yml`): `AZURE_RESOURCE_GROUP`, `AZURE_ACR_NAME`, `AZURE_CONTAINER_APP_NAME`.
5. Any real data for the pathfinding "obstacles" model, and confirmation of what "the satellite" is in
   this context (a lunar relay orbiter? a CLPS lander's comms relay? something else) — the current
   `earth_moon.py` is a reasonable first pass but the real constraints will shape it.

## Deploy steps once the above exists

```sh
# one-time: provision the resource group + all resources
gh workflow run azure-infra.yml

# every time app code changes: build + ship
gh workflow run azure-deploy.yml
# (or just push to this branch — azure-deploy.yml triggers on push to infra/azure)
```

## Note on how this branch was created

This work was built in an isolated clone (`repo-azure/` next to `repo/`) on its own `infra/azure`
branch, specifically so it wouldn't collide with the in-progress `integration/person2-backend` /
`preview` work happening in `repo/` at the same time. Every file this branch touches is either brand
new (`infra/`, `Dockerfile`, `.dockerignore`, `entrypoint.sh`, `.github/workflows/azure-*.yml`,
`backend/pathfinding/`, `backend/azure_cache.py`, `docs/AZURE.md`) or a small, additive diff to a
shared file (`requirements.txt`: two new deps; `scripts/fetch_data.py`: one cache-check call;
`backend/app.py`: one new route) — chosen to keep the merge back into `preview`/`main` low-risk.
