# Person 2 -> Person 3 -> Quest handoff

The scientific conventions remain those in [TEAM_SPEC.md](TEAM_SPEC.md). This document fixes the P0 transport format, not a new coordinate convention.

## Ownership

Person 1 owns site elevation and observer-specific terrain horizons. Person 2 owns Sun direction/range, horizon obstruction, and visibility transitions. Person 3 consumes that output to compute irradiance, panel incidence, watts, and energy. Person 4 consumes the exported result. No production terrain-visibility calculation is duplicated in Person 3's module.

If Person 2 maintains separate `ephemeris.json` and `visibility.json`, join them by **UTC timestamp**, after verifying their site coordinates, frame, surface elevation, observer height, and scenario agree. Include geometry at every refined visibility-transition timestamp. Do not zip arrays by index, assign a nearby site's horizon, interpolate across unknown data, or insert a default 1 AU distance when range is missing.

## P0 input envelope

Use the complete, importable [contract-example.json](contract-example.json). Required fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `0.1.0` |
| `artifactType` | `solar-input` |
| `artifactId`, `scenarioId`, `label` | Nonempty identities/name; IDs represent immutable inputs |
| `generatedAtUtc` | Real generation timestamp, `YYYY-MM-DDTHH:mm:ssZ` |
| `frameId` | `MOON_ME_DE421` |
| `siteId` | `connecting-ridge-cr1` or `shackleton-rim-sr1` |
| `site` | Exact shared `latitudeDeg`, `longitudeEastDeg`, interpolated `surfaceElevationM`, `referenceRadiusM:1737400` |
| `observerHeightAboveGroundM` | `2`; ephemeris and horizon must use this same observer |
| `time` | `startUtc`, `endUtc`, `baseStepSeconds:600`, `visibilityInterpolation:"previous-sample-hold"` |
| `provenance.ephemeris` | `provider` plus source request/version metadata |
| `provenance.visibility` | `provider`, `mode`, `sunModel`, and terrain horizon identity when applicable |
| `samples` | Strictly increasing samples including exact mission start **and** end boundary |

Each sample:

```json
{
  "timeUtc": "2027-01-01T00:00:00Z",
  "sun": { "azimuthDeg": 40.504012, "elevationDeg": 1.427953, "rangeAu": 0.98270256371899 },
  "solarVisibleFraction": 1,
  "quality": { "status": "valid", "reason": null }
}
```

`rangeAu` is observer-to-Sun distance from the Sun query's range (`delta`), in AU. Do not confuse it with Earth distance or heliocentric target range. Azimuth is in `[0,360)`, elevation in `[-90,90]`, and visible fraction in `[0,1]`.

Visibility modes:

- `terrain`: real upstream horizon. Requires `horizonArtifactId` and `horizonObserverHeightAboveGroundM:2`. Provider metadata should also retain source DEM/algorithm versions and numerical quality.
- `local-plane-demo`: explicitly artificial H=0-degree comparison. Never eligible for terrain-aware rankings.
- `synthetic-test`: engineering fixtures, not predictions.

Solar models:

- `center-binary-v1`: fraction must be 0, 1, or null.
- `disk-fraction-v1`: upstream supplied disk exposure may be fractional. Person 3 applies a scalar center-ray approximation.
- `fractional-test-v1`: fractional test fixtures only; not a claim of a real disk calculation.

Sample validity:

```json
{
  "timeUtc": "2027-01-01T00:10:00Z",
  "sun": { "azimuthDeg": 40.4, "elevationDeg": 1.4, "rangeAu": 0.9827 },
  "solarVisibleFraction": null,
  "quality": { "status": "missing", "reason": "horizon_missing" }
}
```

Keep missing numeric fields present as null. A missing sample or explicit missing status makes intervals touching it unknown, conservatively. A known blocked sample has fraction 0 and valid quality. Unknown ephemerides/visibility cannot become zero power. The final sample is needed to bracket the last interval; it contributes no extra duration.

Mission windows must lie within `[2027-01-01T00:00:00Z,2028-01-01T00:00:00Z)`, with an optional end-boundary sample exactly at 2028-01-01, and last at most 60 days. Inputs may use finer or irregular event samples, but adjacent samples more than 600 seconds apart create an unknown gap.

## Visibility timing agreement

The interval following sample `i` uses its supplied visibility fraction on `[t_i,t_(i+1))`. Put every resolved shadow transition in the input explicitly. For binary visibility, set the sample at the transition to the state of the following interval; the exact tangency instant has zero duration and follows the team's strict comparison convention. If the upstream data consists only of regular instant evaluations, this is an explicit sampled approximation, not an exact event detector.

Geometry-dependent unoccluded watts are integrated by trapezoid over each interval, then multiplied by that interval's visibility fraction. There is no second sine-of-elevation factor after panel incidence, no second terrain factor, and no interpolation from visible to blocked across the preceding interval.

## Output

`simulate(input,panel)` returns a `power` artifact with:

- Source IDs, site/frame/observer, provenance, model exclusions, units, exact panel parameters, and input time settings.
- Samples: `normalIrradianceWm2`, `incidenceCosine`, `incidenceAngleDeg`, `panelIrradianceWm2`, `unobstructedPowerW`, `powerW`, ENU vectors, and quality.
- Intervals: start/end, physical seconds, energy Wh or null, held visibility, quality/reason, and cumulative **known** energy.
- Summary: total/known energy, known/unknown seconds, coverage, mean power, sampled peak, and terrain-comparison eligibility.

Eligibility only means the required data is complete and declared to use upstream terrain. It is not independent certification of the upstream calculation. `sampledPeakPowerW` is a sample maximum, not a bound on unsampled peaks. Unknown total/mean are null, while known energy remains a subtotal.

For Unity, science vectors are `[east,north,up]`. The agreed final scene direction is `[east,up,north]`. A directional light typically needs the negative ray direction relative to the vector pointing toward the Sun. Do not change the underlying data frame to match the renderer.

No battery, load, communications, or viability score is required for this P0 input. Add those as separately versioned P1 calculations.

The implemented P1/P2 layer is documented in [MISSION_MODEL.md](MISSION_MODEL.md).
It consumes this unchanged P0 contract and exports separately versioned mission artifacts.
