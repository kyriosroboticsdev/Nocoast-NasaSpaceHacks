## What does this PR do?

Replaces the planner's solar power proxy with the shared direct-beam model,
including Sun distance, fixed panel orientation, upstream terrain visibility
and integrated mission energy. Adds panel bearing, data coverage, replayable
JSON input/output and solar regression CI. Based on preview through 6871774.

Missing solar inputs remain unknown. Current terrain estimates remain
preliminary and are excluded from power rankings; the analytic regional search
explains why no solar-qualified candidates exist. Teammate contracts and
remaining upstream work are documented in docs/solar/README.md.

## How was it tested?

- 54 local regression tests passed with npm test.
- Type-check and production build passed with npm run build.
- Browser checks at 1440x1000 and 390x844: panel controls, blocked power,
  partial coverage, invalid efficiency, shared settings and JSON export.

## Checklist

- [ ] CI passes
- [x] No DEMs / SPICE kernels / large data files committed
- [x] Angles documented (degrees vs radians, azimuth convention)
