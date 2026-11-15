# Person 3 mission simulation, version 0.2

Live backend integration uses the visibility owner's refined contact windows.
The bundled fallback retains its sampled approximation. The dashboard can enable
relay contact explicitly; the Navigator uses direct Earth contact. See
[integration notes](../SOLAR_FOLLOWUP.md).

The P0 direct-beam kernel and solar-input 0.1 contract remain unchanged.
`src/power/mission.ts` adds constant-load battery dispatch and an explicit
communication policy. `planning.ts` adds finite orientation/site search and
landing-delay evaluation. `contexts.ts` calls the existing astronomy and
visibility modules at each actual landing time; it does not shift old masks.

The modeled mission is a stay at a fixed landing site: for example, a lander,
rover or visiting crew's equipment operating there for several days or weeks.
It does not assume construction of a permanent base. Select the stay's start
and duration to examine solar output over that interval. Equipment demand and
battery settings add an optional engineering scenario for using that power;
the solar generation estimate itself does not require a crew or a base.

## Try it

Run `npm.cmd run dev`. Set **Landing / stay start (UTC)** and **Stay at landing
site (Earth hours)**. In **Assessment settings**, set the panel and **Equipment
power demand W**, then battery capacity, initial charge and reserve. Expand the
efficiency/rate limits and mission requirements as needed. The two site cards
show unserved energy, electrical outages, first known power loss, stored energy,
powered Earth contact, and a battery chart. Defaults are engineering examples.

In **Test mission resilience**, choose a grid and delays. **Optimize panels +
sites** holds panel area/efficiency, battery, load and requirements fixed. Turn
on **Optimize across all tested delays** for a robust comparison. **Test landing
delays** uses the current panel orientation. Results require an explicit Apply;
Cancel and editing settings discard an unfinished search. Export JSON before
applying/changing settings to retain a report and its replayable source inputs.

## Electrical model and energy accounting

All power is on an ideal DC bus. Energy is Wh; time is physical seconds.
The load is constant throughout the mission. The historical
`thresholds.batteryFloorW` name is retained as a compatibility alias for that
actual consumption, not a separate battery heuristic. Default settings:

| Input | Default |
| --- | ---: |
| Constant consumption | 40 W |
| Battery capacity | 2000 Wh |
| Initial stored fraction | 0.8 |
| Reserve cutoff fraction | 0.1 |
| Charge / discharge efficiency | 0.95 / 0.95 |
| Maximum charge / discharge bus power | 500 W / 500 W |

PV serves load first. Surplus charges at no more than the charge power limit;
stored charge is `bus input Wh × charge efficiency`. Full storage curtails
surplus. Deficits draw at no more than the discharge bus-output limit; stored
energy decreases by `output Wh / discharge efficiency`. Dispatch stops at the
reserve. Initial fraction must be at or above reserve. Zero capacity models
no storage; a zero rate disables that charge/discharge path. Efficiencies must
be positive and at most one.

The PV curve is exactly the P0 interval model: linearly interpolate
**unobstructed** endpoint watts and multiply by the supplied left-held
visibility fraction. Integrate in Wh, split at load/rate crossings, then split
again when storage fills or reaches reserve. Depletion/saturation roots use a
monotonic integral search; mathematical subsecond events are not rounded away.
An interval with mean PV equal to load can still contain an outage.

The tested accounting identities are:

```
PV Wh = PV-to-load Wh + charge-input Wh + curtailed Wh
load Wh = PV-to-load Wh + discharge-output Wh + unserved Wh
initial stored Wh + PV Wh = final stored Wh + served load Wh
                            + curtailed Wh + battery losses Wh
```

An electrical outage is any positive-duration segment with unmet equipment demand,
including insufficient discharge **power** despite ample stored energy.
It differs from a sunlight blackout. Energy sums use floating-point arithmetic;
numeric tolerances never convert a known electrical outage into full availability.
Battery minima and event splits use the modeled continuous curve; chart lines
connect stored-energy endpoints for display.

Temperature, degradation, self-discharge, variable demand and converter dynamics
are excluded. The source solar model separately records its exclusions, including
eclipses, dust, self-shadowing and constant panel efficiency. Parameter meanings
are informed by [NASA's power subsystem overview](https://www.nasa.gov/smallsat-institute/sst-soa/power-subsystems/)
and [SAM's battery dispatch documentation](https://samrepo.nlr.gov/help/battery_dispatch_fom.html).
The example numbers and dispatch/score policies are project choices.

## Unknown data and time conventions

Input frames, site coordinates, observer height, UTC sample timestamps, W and
Wh remain the shared team conventions. A missing solar interval makes the
battery state unknown from that point forward; later sunlight does not create
an invented restart. Full final charge, shortages and outage duration remain
null, while known shortages are retained as a subtotal. A communication gap
does not disable known solar/battery arithmetic, but makes the full mission
score unknown. Empty/incomplete cases cannot enter a claimed robust optimum.

Derived battery events use **offset seconds from the artifact's `startUtc`**.
Offsets can be fractional. Thus canonical UTC sample timestamps remain whole
seconds without sacrificing event duration or implying rounded event times.
Numerical event precision is distinct from physical accuracy: upstream sampled
terrain visibility is not event-refined.

`src/assess/visibility.ts` exports the visibility owner's midpoint transition
convention for Earth contact, including unknown states. Mission communication
availability agrees with that owner's existing windows. Powered Earth contact
intersects electrical availability with those segments. PV energy retains the
P0 left-held sunlight convention. These approximations and ownership are
explicit; no independent raycasting or ephemeris calculation is added here.

## Requirements and score

Defaults require power for 100% of the mission, Earth contact for at least 50%,
and no known communication blackout longer than 24 hours. All are configurable.
Full data is required to evaluate the score. The policy is:

```
power factor = min(actual power availability / required fraction, 1)
contact factor = min(actual contact availability / required fraction, 1)
blackout factor = min(allowed blackout / longest actual blackout, 1)
score = 100 × power factor × contact factor × blackout factor
```

A zero contact-fraction requirement contributes factor one. Zero actual
blackout contributes factor one. Requirements pass/fail is checked separately
from the score, so rounding a score never makes a failed requirement pass.
It is a planning policy, not a probability of mission success or NASA standard.
GO/CAUTION/NO-GO reflects the calculated requirements using complete measured
terrain inputs. An upstream terrain-validation declaration is not required.
Missing solar or contact coverage remains UNKNOWN. Validation metadata is
retained as provenance and does not alter the calculated grade.

## P2: tested choices and worst cases

Power inputs now support coordinate-based locations when matching Sun and terrain
metadata is available. The finite P2 study uses the currently selected Site A and Site B, including
custom points. Each delay reevaluates the actual chosen coordinates. Tilt spans 0–180° and bearing 0–360°
exclusive, with configurable 5/15/30/45/90° grid spacing. Duplicate horizontal
normals are removed. The current orientation is always included, even off-grid.
No automatic change to area, efficiency, battery or consumption is allowed.

Compare candidates lexicographically: least worst-case unserved Wh, shortest
worst electrical outage, highest minimum policy score, highest minimum final
stored Wh, then highest minimum harvested Wh. The best is only the best among
tested choices. Complete preliminary inputs can support an explicitly conditional
engineering comparison; they do not become validated mission recommendations.
Unknown site/delay cases are excluded with reasons. A missing delay makes that
site's full worst case unknown; a separately labeled known-scenarios subtotal
does not replace it. Reports identify which delay causes each adverse metric;
different metrics can come from different scenarios.

Delays always include zero and the exact maximum without overshoot, in whole
seconds. Each case has the same mission duration and initial battery fraction
at the **actual landing**; pre-landing energy consumption is not modeled.
Limits are 336 hours maximum delay, 25 offsets, 10,000 scenario evaluations and
100,000 source samples across an analysis. Jobs yield between chunks, support
cancellation and reject excessive requests rather than returning partial optima.
No guarantee is made for untested landing times or continuous orientations.

## Artifacts and replay

`siteA.mission` / `siteB.mission` are version 0.2 artifacts alongside unchanged
0.1 solar artifacts. They contain settings, source power ID, energy dispatch
segments, outage/contact windows, event offsets, coverage and score components.
The source solar artifact in the same export retains the astronomy/horizon
provenance. Settings, including planning controls, round-trip through shared URLs.

`panelSiteOptimization` and `landingDelayAnalysis` include exact source contexts,
not just screenshots or scores. JSON is compact to limit repeated-source size.
With a saved report, replay without network access:

```ts
const replay = analyzeDelays(report.sourceContexts, report.panel,
  report.parameters.baseLoadW, report.parameters);
// For optimization use sourceContexts, originalPanel, grid.stepDeg and parameters
// with optimizeMission(). The original ephemeris/horizon masks are retained.
```

The test suite covers hand-calculated cases, subsecond events, changing-power
crossings, rate/capacity/reserve bounds, seeded energy conservation checks,
unknown propagation, policy scoring, real-sample integration, source replay,
finite grid selection, cancellation, delay exclusions and shared settings.
