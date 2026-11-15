# Solar and mission integration (P0–P2)

The Person 3 implementation now includes P0 solar power, P1 constant-load battery
simulation and mission requirements, and P2 finite panel/site optimization and
landing-delay worst cases. The standalone P0 kernel remains in
`src/power/model.mjs`; `adapter.ts` connects the existing visibility output.

See [MISSION_MODEL.md](MISSION_MODEL.md) for the electrical equations, defaults,
score, limitations, delay assumptions, resource limits and replay examples.

## Run and verify

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run dev
```

Use CR1/SR1 and a mission from January 1 through the March 1, 2027 end boundary. Change active panel area (m²),
efficiency (0–1), tilt from face-up horizontal (0–180°), and normal's bearing
(0° true north, 90° east). A vertical panel has tilt 90°. These are fixed
orientations in the site's local frame, not Sun tracking. Both comparison sites
use the same hardware settings. Share URLs preserve these settings.

The solar window reports total Wh, time-weighted mean W, sampled peak W, known-energy
subtotal and data coverage. The mission layer adds battery Wh, unmet load, electrical outages,
first known power loss, powered Earth contact and an explicit policy score. The scrubber reports a nearest sampled instant, not
an exact arbitrary-time solution. The final endpoint brackets the last interval
and contributes no extra mission duration or sampled peak.

Numerical results using existing horizons are **preliminary**. Terrain-owner
validation has not been declared; the app does not rank those results or assign a mission
GO grade. Complete data coverage means all required numeric inputs are present,
not that the underlying terrain model has been independently validated.

## Physics and conventions

`S = 1361 / rangeAu²` W/m², with 1361 W/m² a nominal reference at 1 AU.
`P = S * max(0, dot(panelNormalEnu, sunDirectionEnu)) * areaM2 * efficiency * visibility`.
See the [NASA solar irradiance science page](https://earth.gsfc.nasa.gov/climate/projects/solar-irradiance/science) for the
solar irradiance scale and the [JPL Horizons manual](https://ssd.jpl.nasa.gov/horizons/manual.html)
for airless apparent azimuth/elevation (quantity 4) and observer range (20).
This is an idealized, single-face, constant-efficiency direct-beam estimate.
Temperature, eclipses, dust, reflected light, wiring losses and self-shadowing
are excluded and recorded in every power artifact.

The [team specification](TEAM_SPEC.md), [machine defaults](TEAM_DEFAULTS.json)
and [input contract](INPUT_CONTRACT.md) retain the agreed two site IDs,
`MOON_ME_DE421`, 1737400 m reference radius, true-north clockwise azimuth, ENU,
2 m observer, UTC whole seconds, W/Wh and 600 s baseline. App-internal `.000Z`
timestamps are normalized without rounding physical sample times. Supported
missions are at most 60 days within 2027; actual bundled coverage is
`2027-01-01T00:00:00Z` through `2027-03-01T00:00:00Z` (end boundary included).

Unobstructed endpoint watts are trapezoidally integrated over elapsed hours;
the visibility at the left sample is held on `[start,end)`. Unknown endpoints
or gaps over 600 s produce unknown interval energy. Missing total/mean values
are `null`, never zero; known energy remains a subtotal. There is no second
elevation sine or terrain attenuation after the incidence dot product.

## Ownership and teammate handoff

| Owner | Contract used here |
| --- | --- |
| Terrain | `HorizonProfile`, matching site/frame/surface elevation and 2 m observer; true-north azimuth; gaps remain null. |
| Sun/Earth and visibility | `EphemerisProvider.series.sun` with az/el and `rangeAu`, source/frame/observer metadata and real temporal coverage. `assessInstant` owns the single `sunlit` terrain decision. |
| Solar/mission | Adapter consumes the mask once; kernel computes PV. Mission layer owns battery dispatch, electrical outages, policy score and tested panel/site/delay comparisons. |
| UI/Quest | Read the exported `solarInput` and `solar`; render W/Wh and quality consistently. Renderer lighting never overrides scientific visibility. |

The latest preview includes frame/ray-coverage fixes. After numerical/reference
validation, the terrain owner can add this declaration to generated horizon files:

```json
"validation": { "status": "validated", "algorithmVersion": "<tested algorithm version>" }
```

Absent validation remains pending. This is a provenance declaration, not a
replacement for those checks; do not add it just to enable ranking.
The current mask is explicitly `center-binary-v1` sampled every 10 minutes.
Person 2 still owns event refinement, continuous communications windows and
finite-disk visibility. The kernel accepts fractional exposure when a solar
input explicitly declares a fractional model, but this boolean app adapter
does not claim to calculate solar-disk fractions.

Mission dispatch consumes the same solar intervals, with no extra terrain multiplier.
Power rejects analytic/legacy Sun inputs, invalid geometry, observer/frame/site
mismatch, interpolation across gaps and requests outside the actual source
span. The updated visibility provider returns null outside its covered span. Solar
independently validates actual sample coverage and refuses analytic inputs.
Sun power is calculated independently of Earth coverage: missing Earth data
remains unknown communication availability, without disabling otherwise valid
solar power. Communication-window calculations remain the visibility owner's
implementation, including its midpoint approximation at sampled transitions.

The integration includes `preview` through `6871774`, including regional search,
science fixes, marker synchronization and mesh improvements. See [repo update](REPO_UPDATE.md). Those controls remain, but its arbitrary candidate
IDs, analytic ephemerides and unvalidated overview horizons do not satisfy the
P0 solar contract. Search therefore explains that no solar-qualified candidates
exist rather than ranking fabricated power. Supporting those candidates needs
real position/range and validated horizon data plus an agreed extension to the
two-site contract; it is not implemented by silently accepting analytic data.

## Data refresh and exports

`npm.cmd run science:solar` uses Python's standard library to fetch the two Sun
series sequentially. It adds real AU distance and frame/observer provenance;
validates all 8497 samples per site; caches raw JPL responses in ignored
`.cache/`; and writes no bundles unless both responses pass validation.
It does not change the Earth data, download DEMs or commit raw kernels.
The full `science` command finishes with this refresh so the older az/el-only
fetcher cannot be the final Sun bundle. For solar-only work use `science:solar`.

Export JSON contains the scenario/hardware plus each site's `solarInput` and
`solar` artifacts. The input replays with `simulate(input,panel)`. The power
artifact carries units, model exclusions, provenance, exact panel settings,
sample quality, intervals and coverage. `eligibleForTerrainComparison` in the
app additionally requires terrain validation; the generic kernel only checks
completeness and declared terrain provenance.

The regression suite also covers battery conservation, within-interval outages, reserve/rate limits,
policy scoring, delay replay, complete-case grid selection and cancellation.
P0 tests cover analytical physics, geometry, held visibility,
missing data, gaps, boundary timing, adapter validation, replay, URL hardware
round trips and the bundled NASA sample contract. No network is used by tests.
Browser evidence is in `evidence/`; mission UI evidence is in `mission-evidence/`; it is local validation evidence, not a
scientific validation of terrain.

## Commit only your solar changes

This contribution lives on `solar-integration`, based on `preview` at
`6871774`. A new commit records only our changes relative to that base: the
solar module, adapter, mission model, optimizer, controls/exports, data refresh,
regression tests and integration documentation. P0 was committed as `162caf9`;
the new P1/P2 work is a follow-up on the same branch. Teammates' existing commits remain in history.

Review the changes, then commit locally:

```powershell
cd "C:\Users\serge\Documents\ChatGPT\NasaSpaceHacks\team-integration"
git status --short
git diff --stat
.\docs\solar\COMMIT.ps1
```

[COMMIT.ps1](COMMIT.ps1) verifies the branch, runs tests/build, then stages and
commits the changes. It performs no network operations. The former automatic
publishing script was removed.

When you separately decide to upload the branch:

```powershell
git push --set-upstream origin solar-integration
```

Open a PR into `preview` for this solar contribution, using [PR_BODY.md](PR_BODY.md).
Its diff shows our changes relative to the team's preview work. Committing,
pushing, opening a PR and merging it are separate steps; neither the helper
nor any work performed here merges a feature commit into the shared branch.
