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
Azure resource group (lunarnav-dev-rg, westus2 — Azure for Students only allows westus2/westus/northcentralus/canadacentral/francecentral)
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

## Live setup (2026-11-14)

Provisioned in the **Azure for Students** subscription (University of Illinois tenant), region `westus2`.

- GitHub -> Azure auth: OIDC. Entra app `lunarnav-github-deploy` with federated credentials for pushes to
  `main` and `preview`; repo variable `AZURE_CLIENT_ID`, secrets `AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID`.
  Roles: Contributor on the subscription, User Access Administrator on `lunarnav-dev-rg`.
- `azure-deploy.yml` runs on every push to `main` or `preview`. It looks up the registry name and the Static
  Web App deploy token itself, so no other secrets are needed.

Student-subscription workarounds baked into the templates/workflow:
- **No ACR Tasks** (`TasksOperationsNotAllowed`): the image is built with Docker on the GitHub runner and pushed.
- **Express Container Apps environment**: managed-identity registry pulls are rejected, so the app uses the ACR
  admin password and a storage connection string, both held as Container App secrets.
- Storage account names are capped at 24 chars (`take(..., 24)` in `main.bicep`).

Detailed polar terrain (`/api/terrain/window`, `backend/terrain_window.py`) is served by the backend in
production; locally the Vite dev middleware still answers the same path.

### Resolved: OIDC login on pushes to `preview`

Was failing with `AADSTS700213: No matching federated identity record found for presented assertion
subject 'repo:...:ref:refs/heads/preview'` — fixed since (the federated credential now covers both
`main` and `preview`). Login succeeds reliably as of 2026-11-15.

### Resolved: Container App image pull auth failure on every deploy (2026-11-15)

Every `az containerapp update --image ...` failed with `Authentication failed when pulling container
image ... Provide 'registryCredentials' ...`, even right after a clean `az acr login` + push. Diagnosed
via a temporary debug step in the workflow: ACR public network access is enabled, admin is enabled, the
image tag exists, and the app's registry config is correct — but the credential takes a real,
non-trivial amount of time (tens of seconds) to propagate to the Container Apps pull path on this
Express/Consumption environment, and reconciling immediately after setting it reliably loses that race.
Fixed by retrying the `registry set` + `update` pair up to 5 times with a 30s backoff
(`.github/workflows/azure-deploy.yml`) — confirmed working on 2 consecutive runs since, both succeeding
on the first attempt.

### Open: Static Web App linked-backend returns a genuine Azure-side 500

This is why `/api/*` 404s on the public SWA URL even though the Container App itself is healthy and
directly reachable at its own FQDN. Root-caused, not a config problem on our end:

- `azure-infra.yml` (which would apply `infra/modules/frontend.bicep`'s `linkedBackends` resource) has
  never actually been run — this environment was hand-provisioned via `az` CLI during the
  Azure-for-Students workarounds, so no backend was ever linked (`az staticwebapp backends show`
  returns `[]`).
- Tried linking it directly, including bypassing the CLI with a raw ARM REST `PUT` to the
  `linkedBackends/api` sub-resource (the CLI's failsafe JSON deserialization was hiding the real error
  body). The response is a bare `500` **served by Azure Static Web Apps itself**, not a generic ARM
  error: `"Azure Static Web Apps - 500: Internal Server Error ... we're working on an unexpected error
  right now."` SWA's sku (Standard, correctly) and the Container App's resource ID/region are both
  verified correct going into this call.
- `.github/workflows/azure-deploy.yml` now attempts this link on every deploy (`continue-on-error:
  true` — never blocks a code deploy), so it'll self-heal the moment Azure's side recovers, with no
  further action needed here.
- If it's still failing when you read this: try the Azure Portal's **"Link already deployed backend"**
  button on the Static Web App resource directly (may use a different code path than the CLI/REST call
  that failed here), or open an Azure support ticket citing the 500 above. Workaround in the meantime:
  hit the Container App's own FQDN directly for `/api/*` calls instead of going through the SWA.
