# Lunar Landing Site Navigator

Demo-ready web app for rapid lunar **south-pole** landing site and date comparison — solar power potential and direct-to-Earth communications — built on the existing Three.js / Vite polar terrain explorer (`vracton/terrain`).

**Modes**

- **Planner** — metrics, A/B compare, skyline, mission timeline, GO / RISKY / NO-GO
- **Learn** — same science engine with plain-language narrative and guided scenarios

## Quick start (demo)

Requires Node.js 22.12+.

```powershell
npm.cmd ci
npm.cmd run dev
```

Open the printed local URL. Default scenario: Connecting Ridge **CR1** vs Shackleton Rim **SR1**, mission week starting **2027-01-15 UTC**.

Cold-path demo (&lt; 2 minutes):

1. Confirm Planner mode → Site A = CR1, Site B = SR1, compare on.
2. Scrub the UTC slider; watch Sun/Earth markers on the 360° skyline and the timeline bars.
3. Read sunlight %, Earth LOS %, panel watts, energy/coverage, and time-to-sunset / Earthset.
4. Toggle **Learn** for the south-pole story and guided CR1 / SR1 / slip scenarios.
5. Optional: **Copy shareable link** or **Export time series JSON** (Quest-ready shape).

`npm.cmd run build` type-checks and builds the client. `npm.cmd run preview` serves the build (terrain window endpoint enabled).

See [RUNBOOK.md](./RUNBOOK.md) for branch process and [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) for validation tests.

## Science data (bundled for offline)

| Product | Path | Notes |
| --- | --- | --- |
| 360° LOLA horizons | `public/science/horizons/{site}.json` | CR1 / SR1 · 0.25° · 5 m near-field + 320 m overview |
| Sun / Earth ephemeris | `public/science/ephemeris/{site}-{sun\|earth}.json` | Precomputed JPL Horizons az/el for Jan 2027 |
| Study sites | `public/terrain/sites.json` | `horizonStatus: ready`, `horizonUrl` set |

Regenerate:

```powershell
npm.cmd run science
```

(`science:horizons` is offline from bundled DEM windows; `science:ephemeris` needs network for Horizons and falls back to analytic series if unreachable.)

Custom lat/lon and non-study curated sites use an **optimistic sphere horizon**, labeled in the UI — not terrain-accurate.

## Architecture

```
src/scenario/   shared Planner ↔ Learn state + catalog + URL sync
src/horizon/    load / sphere fallback / elevation-at-azimuth
src/ephemeris/  bundled Horizons + live API client + analytic fallback
src/assess/     sunlight, Earth LOS, blackouts, assessment orchestration
src/power/      solar adapter + irradiance, battery/load dispatch, panel/site/delay planning
src/viz/        skyline ribbon + Gantt timeline
src/ui/         formatting helpers + Learn narrative
src/app.ts      mode shell + assessment orchestration
src/main.ts     existing Three.js polar terrain viewer (extended, not rewritten)
```

## Terrain notes (unchanged core)

The overview uses a 320 m LOLA polar DEM. Near the camera, the viewer streams 5–20 m detail when the `/terrain/window` endpoint (or bundled focus windows) is available. Display lighting is **not** authoritative observer Sun/Earth status — that comes from the science pane.

For a fully offline terrain mosaic, see the original polar download flow (`node scripts/download-polar.mjs` + `POLAR_LOCAL_ONLY=1`). Bundled overview + CR1/SR1 focus windows are enough for the navigator demo.

## Accuracy policy

- Airless geometry (no refraction).
- Never invent visibility across DEM gaps.
- Sphere-horizon custom points are explicitly optimistic / unknown.
- Cite [Quickmap](https://quickmap.lroc.asu.edu/), [Moon Trek](https://trek.nasa.gov/moon/), [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/), and [CSA Moon Exploration](https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/) as references; computations use Horizons + LOLA.

## Branch

Implementation lives on `preview` (from `vracton/terrain`).

## Solar contribution: `solar-integration`

This branch adds the Person 3 solar and mission modules on top of `preview` at `6871774`.
The new commit contains our solar changes; the team's existing preview commits
are its base.

Integration flow: site/observer metadata + Sun ephemeris → the visibility
module's `sunlit` mask → `src/power/adapter.ts` → `src/power/model.mjs` → panel
watts, battery/load simulation, electrical shortages/outages, mission score,
finite panel/site optimization and landing-delay comparisons in the planner/JSON export. Visibility
owns terrain obstruction; solar consumes its result once and adds panel
orientation, active area, efficiency and Sun distance. Earth availability is
independent of solar generation. Missing inputs stay unknown.

Run `npm.cmd test` and `npm.cmd run build` to verify. The existing panel controls
now include true-north facing bearing, and shared URLs preserve the settings.

See the [solar README and teammate handoff](docs/solar/README.md) for the input
contract, units/frames, source coverage, current limitations and commit-only
instructions. See the [mission model and usage guide](docs/solar/MISSION_MODEL.md)
for battery assumptions, score policy, tested-grid scope and replay examples. [Latest repo updates](docs/solar/REPO_UPDATE.md) are documented
separately. Terrain validation remains qualified in the UI. The P0 kernel is unchanged;
the version 0.2 mission layer adds constant load, bounded storage and explicit requirements.
