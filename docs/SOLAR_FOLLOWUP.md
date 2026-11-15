# Solar and mission follow-up to merged main

Baseline: `main` at `d30718b` (2026-11-15). The team merge already includes the
solar, preview, Person 2 integration, terrain and slope branches. This follow-up
preserves that merged layout, request limit, API routing and deployment workflow.

The dashboard, Navigator and landing-delay studies now consume the backend's
`solarInput` and refined contact windows through the unchanged Person 3 P0/P1
kernels. Solar visibility is consumed once. The Navigator uses direct Earth
contact; the dashboard's explicitly enabled relay adds its own effective contact
windows. The offline fallback retains its documented sampled approximation.

The model describes equipment operating during a stay at a fixed landing site.
CR1 and SR1 remain the supported solar sites. Other locations keep visibility
results but no fabricated power. Missing inputs stay unknown. Mission grades and
the game score require terrain validation; complete preliminary numerical estimates
remain available. No terrain-validation declaration has been invented.

Landing-day verdicts use the exact mission artifact instead of rounded sweep
percentages or assumed continuous contact. Refresh generations reject older
responses after dates, antenna settings or relay settings change. Backend work is
limited to two concurrent requests. Zero battery capacity stays valid without
an invented state-of-charge percentage.

The production terrain endpoint now honors the 129/257 sample dimensions and
source controls used by the frontend. Cache writes use distinct temporary files
for concurrent requests. Existing antenna and relay arguments are retained.

## Local run

Run these commands in the checkout containing this branch. On Windows:

```powershell
.\run.ps1
```

The launcher starts the science API on port 8765 and Vite normally on 5173.
Open the actual URL printed by Vite. `/` is the dashboard, `/navigator.html` the
detailed planner, and `/terrain.html` the standalone terrain explorer. Running
`npm run dev` from a different checkout serves that checkout's branch.

For a built-site preview, run `npm run build`, then:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8767
```

Open `http://127.0.0.1:8767/` while that server is running.

## Verification

- `npm test`: 116 passed, including exact contact windows, qualification, rounded
  threshold failures, queue limits, failure recovery and API cache separation.
- `npm run build`: passed for all three entry pages.
- `python -m ruff check .`: passed.
- `python -m pytest -q`: 109 passed using downloaded NASA data. The two NumPy
  deprecation warnings originate in the astronomy dependency.
- Browser: dashboard and Navigator agree for 2027-01-01 through 2027-01-15 with
  direct contact and matching panel hardware. CR1: 66% sunlight and 26% contact;
  SR1: 100% and 28%. Both label the mission estimate preliminary. The landing-day
  grid completes with preliminary/unknown results as appropriate.

CI builds the frontend before testing production page routes and installs the
HTTP test client through `requirements-dev.txt`. The lint-only `pyproject.toml`
is not installed as a Python package. NASA data, dependency folders, builds,
cache files and local verification logs remain ignored.

The existing direct-beam, constant-load, simplified relay and terrain limitations
still apply; numerical test success does not supply upstream terrain validation.
