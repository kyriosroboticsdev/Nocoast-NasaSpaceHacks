# Person 2: Sun, Earth & communication (science API)

Sun/Earth positioning, terrain obstruction, and direct-to-Earth communication windows for the team's
lunar landing-site app. It implements **team contract v0.1** (`contract/lunar-navigator.v0.1.json`), which is the
single source of truth for every frame, convention, sampling setting and threshold used here.

## Run

```powershell
./run.ps1          # starts this API (:8765) and the website (:5173)
```
Website: http://127.0.0.1:5173 (Vite proxies /api to :8765) · Tests: `.venv/Scripts/python -m pytest` (25 tests, ~35 s)

## Quest export (P0: "export time-series data to the Quest application")

```powershell
.venv/Scripts/python -m backend.export                       # both contract sites, default window
.venv/Scripts/python -m backend.export --site shackleton-rim-sr1 `
    --start 2027-03-01T00:00:00Z --end 2027-04-30T00:00:00Z --antenna-min-elevation 1
.venv/Scripts/python -m backend.export --site connecting-ridge-cr1 --horizon path/to/person1_profile.json
```
This writes `exports/<siteId>_<start>_<end>.json`. The same data is available over HTTP at
`GET /api/export/{siteId}?startUtc=&endUtc=&antennaMinElevationDeg=`.

| Key | Contents |
|---|---|
| `series.timesUtc` | 600 s grid, start-inclusive, end-exclusive, `YYYY-MM-DDTHH:mm:ssZ` |
| `series.{sun,earth}{Azimuth,Elevation,Horizon}Deg` | topocentric az (clockwise from north) / el, and terrain horizon at that azimuth |
| `series.{sun,earth}Visible` | contract visibility state (`true`/`false`, `null` = missing terrain) |
| `series.{sun,earth}Enu` | unit vectors, ENU basis. **Unity** (x=east, y=up, z=north): `new Vector3(e, u, n)`. **GLB** (z=south): `(e, u, -n)` |
| `communication.windows` / `.blackouts` | `{startUtc, endUtc, durationSeconds, truncatedAtMissionStart/End}` |
| `communication.summary` | `percentOfMission`, `longestGapSeconds` (longest blackout), `longestWindowSeconds`, `windowCount` |
| `sun.*`, `sunAndCommunication.*` | the same structure for sunlight and for simultaneous Sun+comm |
| `events` | rise/set for Sun and Earth, `timeUtc` bracketed to 60 s (`bracketStartUtc`) |
| `horizon.elevationDeg` | 1440-sample terrain horizon (0.25° step) used for the obstruction test |

## Models (from the contract)

- **Frame**: `MOON_ME_DE421`. Ephemeris is JPL DE421 + the NAIF lunar orientation kernel via Skyfield.
  `tests/test_ephemeris.py` checks Sun/Earth az/el against JPL Horizons, with observed agreement around 1e-4°.
  This is a regression check, not a physical accuracy claim (the contract's `physicalAngularAccuracyClaim` is null).
- **Sun**: `center-binary-v1`. Visible when `sunEl > horizon(sunAz) + terrainClearanceMarginDeg`.
- **Earth**: `earth-center-line-of-sight-proxy-v1`. Visible when
  `earthEl > max(horizon(earthAz) + margin, antennaMinElevationDeg)`. The antenna minimum is adjustable
  (P1 item). The model does not cover link budget or DSN scheduling.
- Comparisons are strict `>`. A missing horizon gives `null`, and any summary that touches missing time is `null`.
  Earth eclipses of the Sun are not modelled.
- **Events**: states are computed every 600 s. Each 600 s bracket where a state changes is resampled every 60 s.
- **Horizon**: rays are cast to 400 km in three bands: PGDA 5 m tiles (0–5 km), LOLA 80 m (5–100 km) and
  LOLA 240 m (100–400 km). The elevation angle is exact on a sphere of radius 1737.4 km, with the observer
  2 m above ground. The 5 m bilinear height at CR1 and SR1 reproduces the contract `surfaceElevationM` exactly.
  If a band has to fall back to a coarser DEM, the profile is marked `terrainQuality: "fallback"` and is
  excluded from ranking (`allowFallbackInTerrainRanking: false`).

## Project decisions not set by the contract

| Decision | Value | Why |
|---|---|---|
| Ray step | 5 m band sampled every 0.625 m (pixel/8); 80 m and 240 m bands every pixel | Near the observer the elevation angle changes quickly with distance. With this step, halving it changes no CR1/SR1 sample by more than 0.025°, half the contract's 0.05° target (`test_horizon_convergence`). |
| Minimum ray distance | 5 m (one 5 m pixel) | The DEM cannot resolve terrain any closer. |
| Horizon at body azimuth | linear interpolation between 0.25° samples; `null` if a neighbouring sample is missing | |
| Landing-date explorer | 600 s sampling, no event refinement | Speed; labelled as such in the API response. |

## Interface with Person 1 (terrain)

`terrain.load_profile()` / `--horizon` accept a profile JSON with
`{azimuthStartDeg: 0, azimuthStepDeg: 0.25, sampleCount: 1440, elevationDeg: [...]}` and reject other grids.
Comparing Person 1's profile against `GET /api/analyze` (`horizon.elevationDeg`) for CR1/SR1 is a good
cross-check between the two pipelines.

## Layout

```
contract/  team contract JSON (source of truth)
backend/   config (reads contract), ephem, terrain, analysis, export CLI, FastAPI app, polar map
src/dashboard/  website home page (dashboard); terrain.html + src/main.ts = Person 1 explorer
scripts/   fetch_data.py: DEMs, PGDA tiles, SPICE kernels
tests/     ephemeris / terrain / communication tests
```

## 3D sky view support (Overview tab)

- `GET /api/local_terrain?latitudeDeg&longitudeEastDeg&halfExtentM=6000&n=241`: an `n x n` height grid on the site's
  tangent plane (rows south to north, columns west to east), giving each point's height above the site's local
  horizontal in metres, with Moon curvature included. Same sources as the horizons: PGDA 5 m, else LOLA 80/240 m.
- `series.earthNorthPoleEnu` / `series.earthPrimeMeridianEnu` (extensions, not in contract v0.1): Earth's spin axis
  and prime-meridian direction as local ENU unit vectors at each sample, so a viewer (web or Quest) can draw
  Earth with the correct face towards the Moon. Checked against Skyfield's sub-Moon point (within 0.3°).

## Solar power handoff (Person 3)

- `GET /api/solar_input/{siteId}?startUtc&endUtc` returns the `solar-input` 0.1.0 envelope from Person 3's
  `docs/solar/INPUT_CONTRACT.md` (branch `solar-integration`): 600 s samples, 60 s samples around every Sun
  rise/set, and the exact end boundary. Each carries Sun az/el, observer-to-Sun range (AU) and the center-binary
  terrain visibility. Sources are DE421 for any 2027 date and the contract-quality horizon.
- `src/power/model.mjs` / `model.d.mts` are copied **unchanged** from `solar-integration`. The dashboard runs
  `simulate()` in the browser with the user's panel settings.
- Checked: Person 3's `validateScenario` accepts our input for CR1/SR1, with 100% coverage and terrain eligible.
- The P0 model supports CR1/SR1 only, so custom map sites show no power estimate.
