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
3. Read sunlight %, Earth LOS %, power proxy, and time-to-sunset / Earthset.
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
src/assess/     sunlight, Earth LOS, blackouts, power proxy, viability
src/viz/        skyline ribbon + Gantt timeline
src/ui/         formatting helpers + Learn narrative
src/app.ts      mode shell + assessment orchestration
src/main.ts     existing Three.js polar terrain viewer (extended, not rewritten)
```

## Terrain notes

The polar overview uses a 320 m LOLA DEM (87°S–90°S). Near the camera, the viewer streams 5–20 m detail when the `/terrain/window` endpoint (or bundled focus windows) is available. In **mesh** mode, latitudes outside the polar cap use a displaced wireframe from NASA SVS **global LDEM 4 ppd** (`public/terrain/global-ldem-4ppd.bin`, ~2 MB). Display lighting is **not** authoritative observer Sun/Earth status — that comes from the science pane.

Regenerate the global LDEM browser asset (downloads ~4 MB TIFF into `.cache/` if needed):

```powershell
npm.cmd run terrain:global-ldem
```

For a fully offline polar mosaic, see the original polar download flow (`node scripts/download-polar.mjs` + `POLAR_LOCAL_ONLY=1`). Bundled overview + CR1/SR1 focus windows + global LDEM 4 ppd are enough for the navigator demo.

## Accuracy policy

- Airless geometry (no refraction).
- Never invent visibility across DEM gaps.
- Sphere-horizon custom points are explicitly optimistic / unknown.
- Cite [Quickmap](https://quickmap.lroc.asu.edu/), [Moon Trek](https://trek.nasa.gov/moon/), [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/), and [CSA Moon Exploration](https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/) as references; computations use Horizons + LOLA.

## Branch

Implementation lives on `preview` (from `vracton/terrain`).
