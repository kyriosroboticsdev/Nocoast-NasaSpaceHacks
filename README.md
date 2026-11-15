# Lunar Landing Site Navigator

**Pick a landing spot and a date on the Moon's south pole — and find out, in plain English, whether
your lander will have power and a line home.** Built for NASA's Space Apps Challenge, on real NASA
terrain and ephemeris data.

Every crewed and robotic mission near the lunar south pole lives or dies on two things: does the Sun
clear the horizon long enough to charge batteries, and does Earth stay in view long enough to talk to
mission control. Move the landing site a few kilometers, or the launch date by a week, and the answer
can flip completely — a nearby ridge or a few degrees of change in Earth's angle is enough. This tool
lets anyone — a mission planner, a student, or a curious visitor — try different sites and dates and
see the tradeoff immediately, grounded in the same kind of data NASA itself uses for site selection.

## What it does

- **Compare two landing sites side by side** — sunlight, communication windows with Earth, solar
  power, and an overall **GO / RISKY / NO-GO** call for the mission week you pick.
- **See why, not just what.** A plain-English verdict ("the Sun shines nearly the whole time, but
  you lose contact with Earth for up to 2.1 days") sits above the full numeric breakdown, which stays
  one click away behind an **Expert view** toggle — judges and specialists get everything, everyone
  else isn't shown "panel tilt °" before they ask for it.
- **Find a better answer automatically.** *Rank known sites*, *Find best location* across the polar
  cap, or *Suggest better dates* — each one re-scores the problem and lets you adopt the result in a
  click.
- **See it, not just read it.** A real 3D lunar south pole (LOLA elevation data), a 360° horizon
  skyline with the Sun and Earth marked, and a mission timeline showing exactly when you have power,
  communications, or both.
- **Learn mode** tells the same story in plain language for students and the public, with guided
  scenarios (e.g. Apollo 11 vs. a real south-pole candidate site).
- **Screen terrain steepness.** Open **Terrain slopes and area comparison** below the 3D viewer
  to compare estimated area within an adjustable slope limit around Site A and Site B, using
  the same 1.24 km square window. Missing 5 m terrain is reported as unknown. This is preliminary
  slope screening, not a landing-safety certification. See [terrain slope documentation](docs/TERRAIN_SLOPES.md).

## Why the data can be trusted

This isn't illustrative — it's computed from the same classes of data NASA mission planners use:

| Data | Source |
| --- | --- |
| Lunar terrain (elevation, slopes, horizons) | NASA LOLA (Lunar Orbiter Laser Altimeter) — 5 m PGDA site tiles and 80 m/240 m polar mosaics |
| Sun & Earth position | JPL Horizons / JPL DE421 ephemeris, computed via Skyfield in the body-fixed lunar frame |
| Terrain-aware visibility | Real horizon profiles, not an idealized sphere, wherever NASA elevation data covers the point |

Every number in the app is labeled with its real source and accuracy tier — bundled NASA data,
a live-computed backend, or a clearly-flagged simplified fallback — never silently guessed. See
[Accuracy policy](#accuracy-policy) below.

## Try it in under 2 minutes

Requires Node.js 22.12+.

```bash
npm ci
npm run dev
```

Open the printed local URL. The guided tour starts automatically and walks through four questions:
**where, when, power, and can you phone home.**

1. Planner mode opens with **Connecting Ridge (CR1)** vs. **Shackleton Rim (SR1)**, mission week
   starting **15 Jan 2027 UTC**.
2. Read the plain-English verdict and the four big metric cards. Expert view adds panel watts,
   battery energy, unmet load, and coverage.
3. Drag the time slider — watch the Sun/Earth markers move on the 360° skyline and the mission
   timeline below.
4. Switch to **Learn** for the plain-language story and guided scenarios, or flip on **Expert view**
   for the full numeric breakdown judges and specialists want.
5. **Copy shareable link** or **Export time series JSON** to hand the exact scenario to someone else
   (shaped for downstream tools, including a Quest/VR viewer).

## Science data (bundled for offline)

| Product | Path | Notes |
| --- | --- | --- |
| 360° LOLA horizons | `public/science/horizons/{site}.json` | CR1 / SR1 · 0.25° · 5 m near-field + 320 m overview |
| Sun / Earth ephemeris | `public/science/ephemeris/{site}-{sun\|earth}.json` | Precomputed JPL Horizons az/el for Jan 2027 |
| Study sites | `public/terrain/sites.json` | `horizonStatus: ready`, `horizonUrl` set |

Regenerate with `npm run science` when that script is present. Custom lat/lon and non-study sites use an **optimistic sphere horizon**, labeled in the UI.

On the navigator, detailed terrain can come from the local `.cache/polar-full.tif` mosaic or be streamed from NASA. Lock to 5 m keeps the near view at native spacing, and the terrain view shows an FPS readout.

## Architecture

```
src/scenario/     shared Planner <-> Learn state, catalog, URL sync
src/horizon/       load / sphere fallback / elevation-at-azimuth
src/ephemeris/     bundled Horizons + live API client + analytic fallback
src/science/       client for the optional live Person 2 backend (see below)
src/assess/        sunlight, Earth line-of-sight, blackouts, viability
src/power/         solar adapter, battery/load dispatch, panel and landing-delay planning
src/ui/plain.ts     plain-English verdicts and the 4 simple metric cards
src/viz/           360° skyline ribbon + mission timeline
src/app.ts         mode shell + assessment orchestration (navigator)
src/dashboard/     NoCoast front page
src/main.ts        3D Three.js lunar south-pole terrain viewer
backend/           optional Python/FastAPI science service (real Skyfield + JPL DE421 + NASA DEMs)
```

### The optional live backend

A Python/FastAPI service (`backend/`) computes real Sun/Earth ephemeris (Skyfield + JPL DE421) and
real terrain horizons (NASA PGDA 5 m / LOLA 80 m / 240 m DEMs) for **any** south-polar point, not just
the two bundled study sites. The frontend tries it automatically when it's running locally
(`npm run dev` + the backend together — see [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)) and falls
back to the bundled/offline data otherwise, so the app always works without it. Details in
[docs/PERSON2_INTEGRATION_REPORT.md](./docs/PERSON2_INTEGRATION_REPORT.md).

## Accuracy policy

- Airless geometry — no atmospheric refraction, matching the Moon's actual environment.
- Never invents visibility across a gap in elevation data — unmapped terrain shows as **unknown**,
  not assumed clear or assumed blocked.
- Locations outside NASA's detailed elevation coverage use a clearly-labeled, optimistic sphere
  horizon — real terrain there could be worse, and the UI says so.
- Every metric cites its source and accuracy tier (bundled JPL data, live-computed, or analytic
  fallback) in Expert view.
- References: [Quickmap](https://quickmap.lroc.asu.edu/), [Moon Trek](https://trek.nasa.gov/moon/),
  [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/),
  [CSA Moon Exploration](https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/).

## More documentation

| Doc | What's in it |
| --- | --- |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Setup, daily commands, running the optional live backend |
| [docs/REQUIREMENTS_AUDIT.md](./docs/REQUIREMENTS_AUDIT.md) | Line-by-line coverage against the NASA Space Apps challenge brief |
| [docs/IMPLEMENTATION_SUMMARY.md](./docs/IMPLEMENTATION_SUMMARY.md) | What was built, the decision workflow, known limitations |
| [docs/NEXT_LEVEL_PLAN.md](./docs/NEXT_LEVEL_PLAN.md) | The plain-language/accessibility roadmap this build implements (Phases 1-2 done) |
| [docs/TERRAIN_PLAN.md](./docs/TERRAIN_PLAN.md) | The 3D terrain pipeline's build-out plan |
| [docs/PERSON2_COMMS.md](./docs/PERSON2_COMMS.md) | The Python science backend: models, API, run instructions |
| [docs/PERSON2_INTEGRATION_REPORT.md](./docs/PERSON2_INTEGRATION_REPORT.md) | Full record of how the backend was integrated into this app |
| [docs/solar/README.md](./docs/solar/README.md) | Solar input contract, units, and limitations |
| [docs/solar/MISSION_MODEL.md](./docs/solar/MISSION_MODEL.md) | Battery assumptions, score policy, and landing-delay analysis |

Panel generation, battery dispatch, and landing-delay comparisons live in `src/power/`. Visibility owns terrain obstruction; solar consumes that mask once. Missing inputs stay unknown.
