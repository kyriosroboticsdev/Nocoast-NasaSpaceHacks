# Lunar Landing Site Navigator — full session report

What follows is a complete record of the repo audit and the Person 2 integration work done against
`kyriosroboticsdev/Nocoast-NasaSpaceHacks`: what was found across every branch, what was tried, what was
built, what was validated, and what's still open. Written for anyone picking this up cold.

---

## 1. Starting point: what the repo actually looked like

The repo was cloned fresh and every branch inspected. At the time of this audit (2026‑11‑14):

| Branch | Ahead of `main` | What it is |
| --- | --- | --- |
| `main` | — (0 commits) | One README line. The trunk. |
| `setup/pr-workflow` | +1 | PR #1 (open) — CI (`ci.yml`) + Claude auto-review (`claude-review.yml`) + `CLAUDE.md` + PR template. Branched straight off `main`; carries **none** of the app code. |
| `vracton/terrain` | +2 | Person 1's base Three.js/Vite polar-terrain viewer (LOLA DEM rendering). The foundation every other branch builds on. |
| `person2/integration` | +3 | Person 2's Python/FastAPI science backend + a simple dashboard UI. Branched from the same point as `solar-integration`. |
| `solar-integration` | +19 | A parallel TypeScript science/decision stack (ephemeris, power model, assess/search/windows, skyline + timeline viz) and a separate `docs/solar/` spec. Same branch point as `person2/integration`. |
| `preview` | +23 | Continues directly from `solar-integration` (confirmed via `git compare`: shares a merge-base 5 commits before `preview`'s tip). The most complete, demo-ready integration — README, RUNBOOK.md, IMPLEMENTATION_SUMMARY.md, REQUIREMENTS_AUDIT.md all live here. |

All ahead/behind numbers came from GitHub's compare API (`gh api repos/.../compare/<base>...<head>`), not estimates.

**The one open PR (#1)** was green (CI pass, mergeable) but had no review decision, and — critically —
doesn't include any of the lunar-navigator app code. Merging it only adds process scaffolding.

**The team's own `REQUIREMENTS_AUDIT.md`** (on `preview`) scored the NASA challenge requirements at
27 Implemented / 6 Partial / 2 Deferred out of 35. Partial/deferred items included: only two sites (CR1,
SR1) had real LOLA terrain, everywhere else fell back to an idealized sphere horizon; live JPL Horizons
fetch was disabled (`allowLive: false`); no on-demand terrain for arbitrary points; no antenna
pointing/link-quality model; Quest/VR runtime was export-only.

**The core structural problem identified:** `person2/integration`'s Python backend and `solar-integration`
→ `preview`'s TypeScript pipeline were built in parallel to solve the *same* problem (Sun/Earth
positioning, terrain horizons, communication windows) and were never reconciled. `preview` — the branch
everyone demos from — doesn't include the Python backend at all.

A full write-up of this audit was rendered as a status report (branch lineage diagram, requirement
coverage, open gaps, recommended order of operations) before any code was touched.

---

## 2. The task handed over

The user supplied the team's own task breakdown, split by person, with NASA-challenge priority tags
(P0 = must-have, P1 = should-have, P2 = stretch):

```
Lunar terrain — Person 1
[ ] P0 Download NASA LOLA elevation data for two landing sites.
[ ] P0 Convert elevation data into optimized 3D terrain meshes.
[ ] P0 Preserve accurate coordinates, scale, and orientation.
[ ] P0 Calculate a 360° terrain horizon profile at each site.
[ ] P1 Add lunar surface textures and terrain-based shadows.
[ ] P1 Show local slopes and elevation.
[ ] P2 Support arbitrary landing locations.

Sun, Earth & communication — Person 2
Astronomical positioning
[ ] P0 Calculate Sun and Earth azimuth/elevation using JPL Horizons or SPICE.
[ ] P0 Generate positions over a selectable date range.
[ ] P0 Determine whether terrain obstructs the Sun or Earth.
[ ] P0 Export time-series data to the Quest application.
Communication windows
[ ] P0 Calculate when direct line-of-sight communication with Earth is possible.
[ ] P0 Determine communication start and end times.
[ ] P0 Calculate continuous communication windows and blackout durations.
[ ] P0 Determine the longest continuous blackout during a mission.
[ ] P0 Calculate total communication availability as a percentage of mission time.
[ ] P1 Support minimum Earth elevation constraints for antenna operation.
[ ] P1 Calculate simultaneous sunlight and communication windows.
[ ] P2 Simulate directional antenna pointing and simplified link quality.

Solar power & mission simulation — Person 3
[ ] P0 Calculate solar irradiance and panel power generation.
[ ] P0 Account for Sun direction and solar panel orientation.
[ ] P0 Account for terrain obstruction.
[ ] P0 Generate power production over time.
[ ] P1 Simulate battery charging/discharging and base power consumption.
[ ] P1 Allow users to adjust panel orientation, area, and efficiency.
[ ] P1 Calculate energy shortages and longest power outages.
[ ] P1 Combine communication and power requirements into a mission viability score.
[ ] P2 Optimize panel orientation and landing-site selection.
[ ] P2 Simulate landing delays and evaluate worst-case outcomes.
```

The request was to work on **integration for Person 2** and get the missing pieces plugged back in. The
work below is scoped to that — Person 1 and Person 3 were read and are reported on for completeness
(section 7), but not modified.

---

## 3. What was found, file by file, for Person 2

Reading `person2/integration`'s `backend/` module against the checklist showed it was already almost
entirely built:

| File | What it does |
| --- | --- |
| `backend/config.py` | Loads `contract/lunar-navigator.v0.1.json` (frame, sites, time rules, horizon bands, visibility models) as the single source of truth; URLs for JPL kernels, PGDA 5 m tiles, LOLA 80 m/240 m mosaics. |
| `backend/ephem.py` | Skyfield + JPL DE421 + NAIF lunar body-fixed frame `MOON_ME_DE421`. `sun_earth()` returns topocentric az/el, angular radius, distance, and ENU unit vectors for Sun and Earth from any (lat, lon). Validated against JPL Horizons to ~1e‑4° in `tests/test_ephemeris.py`. |
| `backend/terrain.py` | Real 360° horizon profiles from PGDA 5 m site tiles (0–5 km), falling back to LOLA 80 m (5–100 km) and 240 m (100–400 km) bands — for **any south-polar point**, not just the two study sites. Flags `terrainQuality: "fallback"` when a coarser band was used, `"none"` when there's no DEM coverage at all (anywhere outside the south-polar mosaics). |
| `backend/analysis.py` | `analyze()`: visibility state machine (`sunVisible`/`earthVisible`, strict `>` against horizon + margin), rise/set events bracketed to 60 s, communication windows/blackouts/longest-gap/percent-of-mission, simultaneous sun∩Earth windows. `landing_sweep()`: scores candidate landing days. `solar_input()`: a handoff envelope for Person 3's power model. |
| `backend/export.py` | CLI (`python -m backend.export`) — the actual "export time-series data to the Quest application" deliverable, writing `exports/<site>_<start>_<end>.json`. |
| `backend/app.py` | FastAPI routes: `/api/contract`, `/api/sites`, `/api/analyze`, `/api/export/{site_id}`, `/api/solar_input/{site_id}`, `/api/sweep`, `/api/local_terrain`, `/api/polar_map*`. |
| `vite.config.mjs` (on `person2/integration`) | Already proxies `/api` → `http://127.0.0.1:8765` for the FastAPI backend, alongside a Node middleware that streams LOLA mosaic windows. |
| `run.sh` / `run.ps1` | One-command start: venv + `pip install` + `scripts/fetch_data.py` + `uvicorn` + `npm run dev`, together. |
| `tests/test_ephemeris.py`, `test_terrain.py`, `test_communication.py`, `test_solar_input.py` | 25 tests total on that branch, covering ephemeris accuracy, horizon convergence, window/gap tiling, antenna-elevation constraints. |

Mapped against the Person 2 checklist, **every P0 and P1 item already had a real implementation** on
`person2/integration`:

| Item | Status on `person2/integration` |
| --- | --- |
| P0 Sun/Earth az/el via JPL Horizons or SPICE | ✅ Skyfield + JPL DE421 |
| P0 Positions over a selectable date range | ✅ any window inside the contract's supported year |
| P0 Terrain obstruction of Sun/Earth | ✅ `analysis.evaluate()` against `terrain.horizon_profile()` |
| P0 Export time-series for Quest | ✅ `backend/export.py` + `/api/export/{site}` |
| P0 Direct LOS communication windows | ✅ |
| P0 Communication start/end times | ✅ rise/set events, 60 s bracketed |
| P0 Continuous windows + blackout durations | ✅ `_runs()` |
| P0 Longest continuous blackout | ✅ `summary.longestGapSeconds` |
| P0 Comm availability as % of mission | ✅ `summary.percentOfMission` |
| P1 Minimum Earth elevation for antenna | ✅ `antennaMinElevationDeg` param |
| P1 Simultaneous sunlight + comm windows | ✅ `sunAndCommunication` block |
| **P2 Directional antenna pointing / link quality** | ❌ **the only gap** — not implemented anywhere, on any branch |

**The actual problem was never "Person 2 didn't build this."** It was: this work sat on an orphaned
branch. `preview` — the branch with the real Planner/Learn UI — had none of it, and instead used:
- a client-side **sphere horizon** fallback for every site except CR1/SR1
- **bundled JSON** ephemeris precomputed for a fixed date range, with a disabled live-JPL-Horizons path
  as a secondary option
- its own Node/Vite middleware for streaming terrain mosaics, unrelated to Person 2's backend

Confirmed directly: `grep -rn "/api\\|fetch(" src/` on `preview` showed zero references to Person 2's
FastAPI routes anywhere in the frontend.

---

## 4. The integration plan

Rather than rewriting either pipeline, the backend was wired in as an **additive, fail-soft top tier**:

1. Bring `person2/integration`'s backend files into a new branch based on `preview` (so the rich
   Planner/Learn UI is the base, not person2's simple dashboard).
2. Add the `/api` proxy to `preview`'s `vite.config.mjs` alongside its existing terrain-mosaic middleware
   (the two are unrelated and coexist fine).
3. Write a small TypeScript client (`src/science/backend.ts`) that calls `/api/analyze` and adapts the
   response into the shapes the existing frontend already expects (`HorizonProfile`, `EphemerisProvider`)
   — so nothing downstream (metrics, skyline, timeline, ranking, JSON export) needs to know the data came
   from a different source.
4. In `computeSlot()` (the one function in `src/app.ts` where horizon + ephemeris + assessment are tied
   together per site), try the backend first for south-polar coordinates; fall through to the existing
   bundled/sphere/analytic chain on any failure, out-of-coverage response, or if the backend isn't running
   at all. This preserves the static-deploy / offline-demo path exactly as it was.
5. Implement the one real gap (antenna pointing / link quality) as a small, honestly-labeled addition to
   the backend, since that's squarely Person 2's remit and had zero prior implementation.

---

## 5. What was built (3 commits, on branch `integration/person2-backend`)

### Commit 1 — `Bring in Person 2's science backend (Python/FastAPI)`
Copied, unmodified, from `person2/integration`: `backend/` (8 files), `contract/lunar-navigator.v0.1.json`,
`scripts/fetch_data.py`, `requirements.txt`, `pyproject.toml`, `run.sh`, `run.ps1`,
`tests/test_ephemeris.py`, `tests/test_communication.py`, `tests/test_terrain.py`,
`tests/test_solar_input.py`, `docs/PERSON2_COMMS.md`. Kept as its own commit so the wiring diff in commit 2
reads cleanly on top of it.

### Commit 2 — `Wire the Person 2 backend into the frontend as a live top-tier source`
- **`vite.config.mjs`**: added the `/api` proxy (`target: process.env.SCIENCE_API ?? 'http://127.0.0.1:8765'`),
  kept `preview`'s existing terrain-window middleware untouched.
- **`src/science/backend.ts`** (new): `fetchBackendAnalysis()` — calls `/api/analyze`, in-memory cached per
  exact query, fails soft to `null` on any network error or non-OK response, with a 2.5 s timeout so a
  missing backend never stalls the UI. `backendHorizonProfile()` — converts the backend's horizon array
  into a `HorizonProfile`, tagged `model: 'lola_terrain'` (real DEM data, whether full 5 m PGDA or a
  coarser LOLA fallback band — both rank above sphere). `backendEphemerisProvider()` — wraps the backend's
  Sun/Earth az/el series as an `EphemerisProvider`, reusing the existing `interpolateSeries()` helper.
- **`src/app.ts`**:
  - `computeSlot()` now attempts the backend first when `!useAdopted && coords.latitudeDeg <= -75`
    (matching the backend's actual south-polar DEM coverage), using the mission's own
    `thresholds.minEarthElevationDeg` as the antenna constraint. Falls through unchanged otherwise.
  - Added `lastPrimaryHorizon` (module-level, mirroring the file's existing pattern for `cachedHorizon` /
    `assessA` / `adoptedSearchHorizon`) so the skyline ribbon always paints the *exact* horizon the current
    Site A assessment used — including the backend case. Before this, the skyline was re-derived
    independently via `loadHorizonProfile()`, which would have silently shown the wrong (sphere/bundled)
    horizon once the backend path went live. Caught by re-reading the full `computeSlot()` → `cachedHorizon`
    data flow before wiring anything in, not after.
  - `horizonFlagText()` gained a branch so a backend-sourced horizon reads as "Horizon: LOLA live (Person 2
    backend)" instead of being silently mislabeled.
- **`.gitignore`**: merged in Person 2's Python ignores (`data/`, `exports/`, `__pycache__/`, `.venv/`,
  `.pytest_cache/`, `.ruff_cache/`, `.env`).

**Net effect:** every consumer of `computeSlot()`'s output — the metric cards, skyline, timeline,
ranking list, date-slip suggestions, and the "Export JSON" button — transparently gets real NASA-DEM
terrain and live Skyfield/JPL-DE421 ephemeris for *any* south-polar point (not just CR1/SR1) whenever the
backend is running locally, and behaves exactly as before when it isn't. No feature-specific wiring was
needed beyond `computeSlot()` itself.

### Commit 3 — `Add simplified directional antenna pointing / link quality`
- **`backend/analysis.py`**: new `antenna_link_quality(earth_az, earth_el, earth_vis, boresight_az,
  boresight_el, beamwidth_deg)` — great-circle angle between Earth's actual direction and a fixed antenna
  boresight (spherical law of cosines), and a raised-cosine rolloff: 1.0 on boresight, 0.0 at the
  half-power beamwidth edge, forced to 0.0 whenever Earth fails the existing terrain/elevation visibility
  gate regardless of pointing. Wired into `analyze()`'s return as a new `antenna` block, defaulting to
  `{"modeled": false}` when no boresight is supplied (zero behavior change for existing callers).
- **`backend/app.py`**: new optional query params on `/api/analyze` and `/api/export/{site_id}`:
  `antennaBoresightAzimuthDeg`, `antennaBoresightElevationDeg`, `antennaBeamwidthDeg` (default 20°).
- **`tests/test_antenna.py`** (new, 5 tests): on-boresight → full quality while visible; zero quality when
  Earth isn't visible even if perfectly aimed; zero quality outside the beamwidth; monotonic falloff with
  off-boresight angle; default (`modeled: false`) when unconfigured.
- Deliberately **not** a real RF link budget — no antenna gain pattern, no multipath, no DSN scheduling —
  and the response says so verbatim in every reply (`note` field).

---

## 6. What was tried and validated (including what didn't work first)

**Frontend:**
- `npm ci` → clean. `npx tsc --noEmit` → clean. `npm run build` → clean Vite production build
  (655 KB main chunk; a pre-existing chunk-size warning, unrelated to this change).

**Python environment — this took a few attempts:**
- `python3 -m venv .venv` initially created a broken environment (`ModuleNotFoundError: No module named
  'encodings'` — a corrupted interpreter installation under a `uv`-managed Python 3.12).
- Removed it and ran `uv venv .venv` without pinning a version — this silently resolved to a *different*,
  unrelated Homebrew-installed Python 3.14 (confirmed via `pyvenv.cfg`), and `uv pip install -p .venv`
  split packages across *both* a `python3.12` and a `python3.14` `site-packages` directory depending on
  which resolver path it took. Running pytest against this hybrid environment failed with a NumPy ABI
  mismatch (`_multiarray_umath.cpython-312-darwin.so` vs. a 3.14 interpreter) — a compiled-extension
  version mismatch, not a code bug.
- Fixed by being explicit: `rm -rf .venv && uv venv --python 3.12 .venv`, then `uv pip install -p .venv
  -r requirements.txt pytest`. This produced a consistent environment.
- `scripts/fetch_data.py` was run for real — it downloaded the actual JPL DE421 kernel, the NAIF lunar
  frame/orientation kernels, both LOLA polar mosaics (80 m and 240 m), and both PGDA 5 m site tiles
  (CR1/SR1) from their live NASA URLs. This was not mocked or skipped.
- `pytest tests/ -v` → **32 passed** (27 pre-existing Person 2 tests + 5 new antenna tests), using the real
  downloaded data, in ~11 s.
- Live HTTP smoke test: started `uvicorn backend.app:app` and hit `/api/analyze` with the new antenna
  query params via `curl`. First attempt on port 8765 hit an **unrelated process already bound to that
  port** — a 48-day-old, unrelated `python main.py` process already running on this machine, left alone
  rather than touched. Retried on 8766 and got a correct response: `antenna.modeled: true`, a plausible
  CR1-area surface elevation (~1953.9 m, matching the contract's bilinear-5m-PGDA value), and correct
  communication-window math.
- Two of the five new antenna tests initially failed on first run — not logic bugs, but overly strict test
  tolerances: (a) `arccos(clip(cos_sep, -1, 1))` at an exact 0° separation produces ~1e‑6° of float noise,
  not exactly 0; (b) at equal elevation, a 40° azimuth difference is **not** a 40° great-circle separation
  (constant-elevation circles aren't great circles, same reason latitude circles on Earth aren't). Both
  test assertions were loosened to match correct spherical geometry rather than the code being changed.

**After all of the above, a final clean re-run** (`npm run build` + full `pytest tests/`) confirmed nothing
regressed from the commit process itself.

---

## 7. Person 1 and Person 3: status found, not modified

Read for context (the user's checklist covers all three people), but out of scope for this pass — noted
here so the next session doesn't have to re-derive it.

**Person 1 (terrain)**, from `vracton/terrain` and its own `TERRAIN_PLAN.md`:
- ✅ P0 LOLA elevation download for the two sites, conversion to GLB meshes, coordinate/scale/orientation
  preservation — all done (Pass 1–2 in `TERRAIN_PLAN.md`, marked "Implemented").
- ❌ P0 **"Calculate a 360° terrain horizon profile at each site"** was explicitly *not* done by Person 1's
  own pipeline — `TERRAIN_PLAN.md` Pass 3 ("Next data handoff") says independent numerical horizons were
  still needed as of that document. This is exactly the gap Person 2's backend (`backend/terrain.py`) and,
  separately, `preview`'s bundled LOLA horizon JSON both ended up solving independently — another instance
  of the same cross-branch duplication pattern as the Person 2 backend/frontend split.
- 🟡 P1 textures/shadows, local slope display — partial at best per `REQUIREMENTS_AUDIT.md` (no dedicated
  slope map; shaded-relief/wireframe modes exist).
  **P2 arbitrary landing locations** — effectively met for the *computation* side now that the Person 2
  backend integration (section 5) resolves real horizons for any south-polar point; the 3D terrain *view*
  still has fixed camera presets mostly tuned to CR1/SR1.

**Person 3 (solar power)**, from `solar-integration`'s `src/power/adapter.ts` and `src/power/model.mjs`:
- ✅ P0 irradiance/power calc (`calculatePower()`), panel orientation incl. tilt *and* azimuth
  (`panelFromThresholds()`), `simulate()` producing a time series — this module exists and is more rigorous
  than what's visible in the live app.
- 🟡 P0 "account for terrain obstruction" — the module's own header says *"No ephemeris, terrain horizon,
  or production visibility is calculated here"* — it consumes a sunlit mask from elsewhere rather than
  computing obstruction itself; whether that mask is terrain-aware depends entirely on the caller.
- ❌ **This entire module was never carried into `preview`** (confirmed: no `src/power/` directory exists
  on `preview`). `preview` instead computes a much simpler inline power proxy directly in
  `src/assess/windows.ts` (`irradianceProxy` / `powerW`, panel area × efficiency × solar constant ×
  incidence) — workable for the Planner UI's GO/RISKY/NO-GO gate, but not the same rigor as Person 3's
  dedicated model, and not cross-checked against it.
- ❌ P1 battery charge/discharge simulation, energy-shortage / longest-outage calculation — no function
  matching this was found in `model.mjs` (grepped for `battery|outage|shortage`: no matches). The
  "viability score" that *does* exist (`meanPowerW >= thresholds.batteryFloorW`) is a static threshold
  check, not a simulated battery state over time.
- Not evaluated: P2 optimization, landing-delay/worst-case simulation — no evidence found either way in the
  time available for this pass.

**The pattern holds across all three people's work**: real, often sophisticated implementations exist on
side branches; `preview` — the branch that actually runs — reflects only a subset of it, reimplemented more
simply in several places rather than importing the more rigorous version. The Person 2 integration in this
report fixes that specifically for Sun/Earth/communication. The same fix has **not** been applied for
Person 1's horizon-profile gap or Person 3's power/battery module.

---

## 8. Current repository state

Branch `integration/person2-backend`, based on `preview`, 3 commits ahead, clean working tree,
**not pushed to `origin`** and **no PR opened** — both intentionally left for the user to decide on.

```
backend/                      (new) Person 2 FastAPI service — unmodified from person2/integration,
                               except analysis.py / app.py (antenna extension, commit 3)
contract/lunar-navigator.v0.1.json   (new)
docs/PERSON2_COMMS.md         (new)
pyproject.toml, requirements.txt, run.sh, run.ps1, scripts/fetch_data.py   (new)
tests/test_ephemeris.py, test_communication.py, test_terrain.py,
  test_solar_input.py         (new, from person2/integration)
tests/test_antenna.py         (new, written this session)
src/science/backend.ts        (new) — the frontend's client for the backend
src/app.ts                    (modified) — computeSlot() backend tier, lastPrimaryHorizon, label fix
vite.config.mjs               (modified) — /api proxy
.gitignore                    (modified) — Python ignores
```

## 9. What's still open

- **Not pushed, no PR.** Explicitly left for review first.
- **No UI control for antenna pointing.** The backend supports boresight/beamwidth; nothing in the Planner
  exposes it yet. Pure front-end follow-up.
- **Person 1's horizon-profile gap and Person 3's power/battery module** are not integrated (see §7) —
  same category of problem as Person 2 was, just not actioned this pass.
- **The backend's own south-pole coverage gate (`latitudeDeg <= -75`)** is a pragmatic constant matching
  the bundled LDEM mosaics' documented edge of coverage; it isn't read from the contract dynamically. If
  the mosaics' coverage ever changes, this constant needs updating by hand.
- **No live demo run with both servers up simultaneously** (`run.sh`-style dual dev-server session) was
  recorded end-to-end with a browser — validation so far is: backend unit/integration tests against real
  NASA data (pass), frontend typecheck/build (pass), backend HTTP smoke test via `curl` (pass). A full
  Vite-dev-server + live-backend + browser walkthrough was not performed in this session.
