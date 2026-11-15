# Nocoast — NASA Space Apps: Lunar South Pole Site Planner

Tool for comparing lunar landing sites & dates: Sun/Earth position vs. local
horizon → power (illumination) and direct-to-Earth comms windows.

## Conventions
- Angles stored in **degrees**; azimuth measured clockwise from local **north**, elevation above the local horizontal plane.
- Times in UTC ISO-8601 at API boundaries; SPICE computations in TDB (convert explicitly).
- Moon-fixed frame: `MOON_ME` for topography (LOLA), lunar mean radius 1737.4 km.
- Horizon masks: max terrain elevation angle per azimuth, including curvature drop d²/(2R).
- Sun (~0.53°) and Earth (~1.9° from the Moon) are discs; report visible fraction near the horizon.
- Validate ephemeris against JPL Horizons (observer `coord@301`) in tests where possible.

## Repo rules
- Never commit DEMs, SPICE kernels, or other large data; fetch them with a script.
- All changes go through PRs into `main`; CI must pass.
