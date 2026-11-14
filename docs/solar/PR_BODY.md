## What does this PR do?

Integrates Person 3 solar generation with constant-load battery dispatch,
reserve and power limits, unmet energy, electrical outages, and an explicit
power/communication requirements score. Adds tested fixed-panel/site grid search,
landing-delay worst cases, cancellation, shared settings and replayable exports.

Visibility remains owned by the existing astronomy/horizon modules. Incomplete
cases remain unknown; preliminary terrain never receives a validated mission
grade. Optimizers report the best tested choices, preserving missing-case reasons.
See docs/solar/MISSION_MODEL.md for assumptions and module handoffs.

## How was it tested?

- 94 Node regression tests, including analytical dispatch cases and seeded
  energy-conservation checks, passed.
- Type-check and production build passed.
- Browser checks cover settings validation, battery results, nominal/robust
  optimization, delay reports, applying results, cancellation and JSON export.

## Checklist

- [ ] CI passes
- [x] No DEMs / SPICE kernels / large data files committed
- [x] Angles, UTC clocks, Wh/W and derived event offsets documented
