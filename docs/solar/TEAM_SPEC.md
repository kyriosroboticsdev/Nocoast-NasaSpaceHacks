# Lunar navigator team specification, version 0.1

Research date: November 14, 2026. Status: recommended implementation contract for the five-person team; no application implementation is included.

Published facts are cited. Site selection, numerical sampling settings, date limits, observer height, and module assignments below are project decisions. They are not NASA requirements or statements of mission approval.

Implementation extension (2026-11-15): CR1/SR1 remain the original reference
sites. Power scenarios now also accept other catalog IDs and custom coordinates
when actual observer-specific Sun range/direction and terrain visibility are
available. The frame, 2 m observer, time, units and missing-data requirements below
continue to apply. The input contract documents the coordinate extension.

## 1. Original reference sites and stable IDs

The initial two published illumination-study points retain their coordinates without snapping to a DEM pixel or moving to a nearby maximum:

| Project ID | Display name | Published label | Latitude, degrees north | Longitude, degrees east | PGDA tile |
| --- | --- | --- | ---: | ---: | --- |
| `connecting-ridge-cr1` | Connecting Ridge CR1 | CR1 | -89.4555 | 222.6192 | Site01 |
| `shackleton-rim-sr1` | Shackleton Rim SR1 | SR1 | -89.7742 | 203.4952 | Site04 |

The coordinates are published by [Glaser et al., 2014](https://www.sciencedirect.com/science/article/pii/S0019103514004278). [Barker et al.](https://ntrs.nasa.gov/api/citations/20205009660/downloads/Mike%20Barker_%20Paper_%20Improved%20Lola.pdf), section 1, relates study sites 1 and 4 to CR1 and SR1. These are historical candidate study points, not claims about a currently selected Artemis touchdown location. PGDA's `Site01`/`Site04` labels identify terrain products; they are not the application's primary IDs.

Direct local DEMs:

- [Site01, 5 m/pixel](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site01/Site01_final_adj_5mpp_surf.tif)
- [Site04, 5 m/pixel](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site04/Site04_final_adj_5mpp_surf.tif)

Both selected points were checked against the actual GeoTIFF headers and lie within their respective 3200 by 3200 pixel tiles. Bilinear interpolation of four source pixels gives the following derived estimates:

| Project ID | Surface elevation above reference sphere | Default observer altitude above reference sphere |
| --- | ---: | ---: |
| `connecting-ridge-cr1` | 1949.608077 m | 1951.608077 m |
| `shackleton-rim-sr1` | 1735.217926 m | 1737.217926 m |

These extra decimals preserve computational reproducibility, not physical accuracy. Display elevations to a sensible precision, such as 0.1 m, with a source/model label. Raw samples, projection metadata, and interpolation details are in [research/terrain-site-checks.json](research/terrain-site-checks.json).

## 2. Coordinates, units, and observer

### Authoritative scientific representation

- **Frame:** DE421 lunar Mean Earth/Polar Axis, identified internally as `MOON_ME_DE421`. Do not substitute an arbitrary `IAU_MOON` or principal-axis frame.
- **Reference sphere:** radius `1737400 m`.
- **Latitude:** planetocentric degrees, north positive; both sites have negative latitude. For the adopted sphere, planetocentric and planetodetic latitude coincide.
- **Longitude:** degrees east in `[0,360)`. Convert west-positive values once at input; store only the canonical convention.
- **Elevation:** radial height in meters above the reference sphere, not sea level, geoid height, or observer height.
- **Scientific arithmetic:** double precision, including lunar body-fixed positions and projection calculations.
- **Local vectors:** right-handed east/north/up (ENU). Azimuth is clockwise from true local north, with N=0, E=90, S=180, W=270 degrees; elevation is relative to the local radial horizontal plane.
- **Exchange units:** meters, seconds, degrees, watts, square meters, and watt-hours. Ratios such as efficiency and visible solar fraction are in `[0,1]`. Convert angles to radians inside trigonometric functions.

The frame is supported by the [NASA terrain metadata](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/) and the [Horizons manual's lunar coordinate definition](https://ssd.jpl.nasa.gov/horizons/manual.html#frames). The reference sphere and height convention follow [USGS lunar interoperability guidance](https://psdi.astrogeology.usgs.gov/moon/standards/data_standards/).

### Observer decision

Use **2.0 m above the interpolated ground**, measured along local radial up. For P0, panel center and antenna reference point are colocated at this observer. This is a project baseline, not a terrain-derived value. Keep `surfaceElevationM`, `observerHeightAboveGroundM`, and `observerAltitudeAboveReferenceSphereM` as separate fields.

The Horizons altitude is `(surfaceElevationM + observerHeightAboveGroundM) / 1000`, in kilometers. Sending only `0.002` km would put the observer near the reference sphere rather than 2 m above the actual site. Terrain horizons must be computed from the identical observer position. Height or position changes invalidate the relevant horizon, ephemeris, and visibility cache entries.

The VR camera may follow the user's tracked head height. It does not silently relocate the simulated panel or antenna. Arbitrary rover/panel placement is outside the fixed-point P0 model.

### Raster projection and geometry

The checked local files have a south-polar stereographic projection, radius 1737400 m, central longitude 0 degrees, pole latitude -90 degrees, pole scale 1, and 5 m pixels. Their upper-left pixel corners are `(-19000,-4000)` m for Site01 and `(-9000,1000)` m for Site04. Columns increase map X; rows decrease map Y. Pixel centers are half a pixel inside these corners.

Equivalent projection specification for a suitable projection library: `+proj=stere +lat_0=-90 +lon_0=0 +k_0=1 +R=1737400 +x_0=0 +y_0=0 +units=m`. Read and validate each file's metadata rather than applying this string indiscriminately to other products. [PROJ stereographic documentation](https://proj.org/en/stable/operations/projections/stere.html)

Reconstruct each terrain point as a lunar body-fixed Cartesian position from latitude, longitude, and radius `R + elevation`; subtract the site's ground position and project into its ENU basis. **Map-grid north is not generally true local north.** Do not simply subtract stereographic X/Y and call those distances east/north. Do not treat the lunar surface as an infinite flat heightfield when calculating the horizon.

### Mesh and Quest orientation

Assume Unity for the Quest adapter; retain engine-independent ENU data so another runtime can be substituted.

| Representation | X | Y | Z | Origin |
| --- | --- | --- | --- | --- |
| Scientific local | East | North | Up | Selected site's ground point |
| Authored GLB | East | Up | South | Same ground point |
| Final Unity scene | East | Up | North | Same ground point |

Author GLB positions as `(E,U,-N)` with one asset unit equal to one meter and no vertical exaggeration. glTF is right-handed and Y-up; Unity is left-handed. The import adapter must produce final `(E,U,N)` scene coordinates, accounting for the chosen importer's conversion exactly once. Do not assume a universal additional axis flip for every importer. [glTF specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units), [Unity orientation documentation](https://docs.unity.com/en-us/engine/6000.0/manual/working-with-gameobjects/gameobject-fundamentals/rotation-orientation/quaternion-and-euler-rotations-in-unity)

Include N/E/U markers in the first test asset. Required checks after import: north is Unity +Z, east +X, up +Y; a 10 m baseline measures 10 scene units. For an azimuth A and elevation e, the body direction in ENU is `(cos(e)sin(A), cos(e)cos(A), sin(e))`; in the final Unity scene it is `(cos(e)sin(A), sin(e), cos(e)cos(A))`. Renderers may require the opposite sign for the direction in which light rays travel.

## 3. Terrain horizon contract

Person 1 owns the numerical horizon and produces it from DEM data, independently of mesh simplification and runtime shadow maps.

Recommended initial settings:

- 1440 azimuth samples: 0 through 359.75 degrees at 0.25-degree spacing; do not add a duplicate 360-degree entry.
- Include the highest obstruction angle along each bearing, relative to the same local horizontal as the ephemerides. Preserve negative horizon angles where applicable.
- Use the local 5 m DEM within 5 km; an 80 m regional DEM from 5 to 100 km; a 240 m regional DEM from 100 to 400 km. These distance bands are project defaults inspired by the nested-grid method in Barker et al., section 5; they are not a promise of complete physical accuracy.
- Obtain regional products such as `LDEM_80S_80MPP_ADJ.TIF` and `LDEM_60S_240MPP_ADJ.TIF` from [NASA PGDA product 90](https://pgda.gsfc.nasa.gov/products/90). Local tiles alone cannot describe all distant obstructions. Check registration in overlap areas before combining older local and newer regional products.
- Include curvature using 3D body-fixed positions. Sample rays no more coarsely than the selected raster scale. Refine azimuth and range where profile convergence tests fail.
- Compare horizons at 100, 200, and 400 km cutoffs and at finer angular sampling. Target changes below 0.05 degrees as a numerical convergence check, not a validated accuracy guarantee. Extend coverage or mark affected bearings incomplete when it fails. Retain maximum range and resolution in output.
- A gap or out-of-coverage ray cannot be treated as empty space. In P0, mark that bearing unknown unless a validated bound demonstrates that the missing area cannot alter the horizon.

Each horizon is keyed by site position, observer height, source dataset versions, and algorithm version. Include per-bearing quality and optional obstruction distance. The VR scene may show a larger horizon silhouette even when distant terrain is not present in the detailed mesh; visual shadows must not contradict the authoritative status at the simulated observer.

## 4. Time and supported dates

These are scope decisions for version 0.1:

| Setting | Decision |
| --- | --- |
| Serialized timestamps | UTC ISO 8601, exactly `YYYY-MM-DDTHH:mm:ssZ` |
| Supported evaluation interval | `[2027-01-01T00:00:00Z, 2028-01-01T00:00:00Z)` |
| Default scenario | `[2027-01-01T00:00:00Z, 2027-01-31T00:00:00Z)` |
| Maximum scenario duration | 60 Earth days, contained within the supported interval |
| Base astronomy grid | Every 600 seconds, aligned to UTC midnight |
| Event refinement | Evaluate at 60-second spacing near crossings/close horizon approaches; bracket detected events to at most 60 seconds |
| Numerical durations | Seconds internally; hours/days in the interface |
| Interval convention | Half-open `[start,end)` for missions and availability windows |

The year is an application limit, not a Horizons limit or a predicted launch schedule. The end boundary may be queried as an extra sample for interpolation even though it is not an included mission instant. Fetch exact mission endpoints if they are off-grid. Never extrapolate beyond downloaded data.

For these modern dates, Horizons `TIME_TYPE='UT'` corresponds to UTC; future leap-second assumptions are documented by JPL. A SPICE implementation must convert UTC through a leap-second kernel and retain kernel provenance rather than treating UTC or Unix seconds as TDB.

Temporal sampling and terrain uncertainty are separate. A 60-second event bracket does not imply physical event accuracy of one minute. A 10-minute series can miss brief events even if its endpoints have the same visibility state. Before reporting comparison metrics as validated, compare representative full missions against a uniform one-minute series and refine further if short events materially change the results. No detection guarantee exists for events shorter than the validated sampling.

VR playback can interpolate normalized direction vectors between valid adjacent samples for smooth rendering. It must not average angles across 359/0 degrees naively or derive new availability windows from visual animation frames. Gaps larger than the declared cadence require explicit refined segments or a gap marker, not silent interpolation.

## 5. Astronomy and authoritative visibility

Person 2 uses Horizons as the P0 source. SPICE is a later interchangeable adapter, not a second independent answer generator.

Verified settings include `CENTER='coord@301'`, `COORD_TYPE='GEODETIC'`, `COMMAND='10'`/`'399'`, `EPHEM_TYPE='OBSERVER'`, `APPARENT='AIRLESS'`, `TIME_TYPE='UT'`, and `QUANTITIES='4,13,20'`. These request direction, angular diameter, and range. Normalize source angular diameter from arcseconds to degrees and record range units. [Horizons API documentation](https://ssd-api.jpl.nasa.gov/doc/horizons.html), [quantity definitions](https://ssd.jpl.nasa.gov/horizons/manual.html#obsquan)

Four successful short reference requests at the actual heights are saved in `research/Site01-sun-horizons-check.json`, `Site01-earth-horizons-check.json`, `Site04-sun-horizons-check.json`, and `Site04-earth-horizons-check.json`. Their source headers report `MEAN_ME (high precision)`, a 1737.4 km spherical lunar model, and DE441 positions. The current position ephemeris and the DE421 mean-Earth coordinate realization are distinct metadata; different labels here do not automatically mean a frame mismatch. The response signature was version 1.2 while the documentation page labels its API version 1.3: record the actual signature and explicitly validate supported response formats.

Use one shared upstream request queue, cache reuse, and error backoff. Supply a product/version/contact User-Agent; the research checks used the project's GitHub issues URL as contact. [JPL fair-use policy](https://ssd-api.jpl.nasa.gov/)

### Visibility rules

Person 2 evaluates the horizon supplied by Person 1 at the body's azimuth and is the **only owner** of these scientific flags:

- `sunCenterTerrainVisible = sunElevationDeg > sunHorizonElevationDeg`
- `earthCenterTerrainVisible = earthElevationDeg > earthHorizonElevationDeg`
- `earthCenterLinkAllowed = earthCenterTerrainVisible AND earthElevationDeg > antennaMinElevationDeg`
- `simultaneousSunAndEarth = sunCenterTerrainVisible AND earthCenterLinkAllowed`

Use circular linear horizon interpolation between valid bins; gaps invalidate interpolation. Apply strict greater-than at equality; a touch at one instant has zero duration. Default `antennaMinElevationDeg=0`. The minimum antenna elevation is measured above local horizontal and is distinct from clearance over terrain. A future terrain-clearance margin must have its own name and default zero.

P0 uses a center-based solar model: `solarVisibleFraction` is 0 or 1, and its metadata says `sunModel='center-binary-v1'`. P1 may replace it with fractional solar-disk exposure, remaining within `[0,1]`, with a new model version. Person 3 consumes this value rather than deciding whether terrain blocks the Sun. Earth angular size may be displayed, but partial Earth-disk exposure must not be reported as proof that a ground station is reachable.

Label communication results **Earth-center line-of-sight proxy**. They do not include a specific ground station, Earth rotation/ground-station scheduling, link budget, or antenna pointing. Label solar estimates as terrain/incidence estimates; P0 excludes eclipse attenuation, reflected light, thermal losses, dust, and hardware aging unless explicitly added. Record these exclusions in metadata.

Person 2 also owns event searches, continuous window segmentation, longest darkness/blackout, time-weighted availability, and simultaneous geometric windows. A next event outside the evaluated range is `null` with `eventStatus='not_found_in_range'`; it is not an infinite countdown. Windows reaching a mission boundary are clipped and marked as boundary-censored.

## 6. Missing data and unavailable terrain

Use JSON `null` plus explicit quality/reason fields. Never use NaN, Infinity, magic numbers such as -9999, or zero as a missing-value marker. Fixed fields remain present.

| Situation | Required representation and behavior |
| --- | --- |
| Valid body below terrain | Visibility `false`; elevation remains its real numeric value |
| Missing ephemeris sample | Relevant angles/range `null`; dependent visibility `null`; reason `ephemeris_missing` |
| Unknown horizon bearing | Horizon elevation and dependent visibility `null`; reason `horizon_missing` or `terrain_coverage_incomplete` |
| Missing terrain mesh only | Show a labeled placeholder; retain scientific calculations if the independently validated horizon is available |
| Missing numerical terrain/horizon | Offer an explicit `local-plane-demo` mode with H=0 degrees; terrain-aware metrics remain unavailable and this mode is excluded from terrain-aware rankings |
| Out-of-supported-range request | Reject with a clear range error; do not clamp silently |
| NASA/API error or `n.a.` | Preserve error provenance; use cached data only if its exact scenario/model key matches |
| No event within valid covered time | Event time `null`, status `not_found_in_range`, separately from missing-data status |

Visibility is tri-state: true, false, or null. For combined predicates, a known false operand establishes false; otherwise any required unknown operand establishes null.

Report known duration, unknown duration, and coverage for each metric. With incomplete coverage, an authoritative availability percentage is `null`; optional bounds are `knownVisibleSeconds / missionSeconds` and `(knownVisibleSeconds + unknownSeconds) / missionSeconds`. Do not normalize to only the known samples and present that as full-mission availability. Observed outages bordering unknown data are lower bounds, not completed outages. Never join windows across gaps.

Unknown illumination makes dependent power unknown, not zero. A stateful battery simulation remains uncertain downstream of a power-data gap unless it has an explicit, justified recovery/reset. Missing results must not improve a site ranking.

## 7. Ownership and file handoffs

| Person | Authoritative ownership | Outputs / consumers |
| --- | --- | --- |
| 1: terrain | DEM ingestion, elevation sampling, geographic transforms, mesh assets, slopes, numerical horizon profiles | `sites.json`, `<siteId>/terrain.glb`, `<siteId>/horizon.json` -> Persons 2, 4, 5 |
| 2: astronomy/visibility | Horizons adapter, UTC handling, Sun/Earth vectors, terrain visibility, communication proxy, geometric event/windows metrics | `<scenarioId>/ephemeris.json`, `<scenarioId>/visibility.json` -> Persons 3, 4, 5 |
| 3: power/mission | Panel normals/incidence, irradiance model, generated power and energy, battery/load state, powered communications overlap | `<scenarioId>/power.json`, `<scenarioId>/mission-metrics.json` -> Persons 4, 5 |
| 4: Quest | Asset import, final orientation, rendering, playback, controls; consumes all scientific values | Quest build; no competing astronomical or terrain-visibility calculation |
| 5: integration/comparison | Contract validation, scenario orchestration, packaging/cache manifest, consistent comparison UI, end-to-end verification | `manifest.json`, reproducible comparison bundles; no duplicate scientific formulas |

The last two assignments are recommendations because the supplied plan only defined Persons 1-3. Person 5 can own Azure hosting and transport if the team uses Azure; backend hosting does not change ownership of scientific functions.

Dependency flow: `terrain -> ephemeris + horizon -> visibility -> power/battery -> mission comparison`. Astronomy needs site elevation and observer metadata, but it does not need the render mesh. Rendering can use fixtures while data processing proceeds.

The power module takes the same Sun direction and `solarVisibleFraction` that the UI shows, applies the panel incidence/area/efficiency model once, and integrates over physical scenario time. Playback speed must never affect energy totals. Person 2 owns sunlight-plus-communication overlap; Person 3 owns sufficient-electrical-power-plus-communication overlap. Those are different metrics.

## 8. Minimum exchange structure

Every JSON artifact carries `schemaVersion`, `artifactId`, `generatedAtUtc`, provenance, and relevant `siteId`, `scenarioId`, `frameId`, observer metadata, source IDs, and algorithm/model versions. Scenario IDs identify immutable configurations rather than just display names. Envelopes declare units and supported temporal coverage.

Required contents:

- **Site:** ID, display name, published label, lat/lon, surface elevation, reference radius/frame, DEM URLs/versions, and sampling method.
- **Horizon:** site/observer key, azimuth step, 1440 elevation values or nulls, parallel quality/reason fields, dataset IDs, max ray distance, and convergence status.
- **Ephemeris sample:** `timeUtc`, Sun and Earth objects with `azimuthDeg`, `elevationDeg`, `angularDiameterDeg`, `rangeAu`, and source quality. Include direction vectors only with an explicit `ENU` basis label.
- **Visibility sample:** `timeUtc`, the horizon angles/clearances used, solar model and visible fraction, Earth terrain-visible and link-allowed flags, simultaneous flag, and quality/reasons. Keep sample values distinct from integrated windows.
- **Window:** `startUtc`, `endUtc`, `durationSeconds`, quality, and start/end boundary-censoring flags. Preserve irregular refined samples separately from the base cadence declaration.
- **Power:** sample timestamps aligned to supplied visibility segments, panel configuration, watts, optional battery watt-hours, and quality/reasons. All model inputs must be recorded.

`TEAM_DEFAULTS.json` records the chosen numerical defaults and initial sites. It is a configuration proposal, not evidence that meshes, horizons, or year-long ephemerides have been generated.

## 9. Checks before integration

1. Site IDs/coordinates match across every artifact; raw tile coverage and interpolated elevations reproduce the saved research evidence.
2. Horizons headers show the expected longitude convention, lunar frame, sphere radius, and DEM-plus-observer altitude. Reference fixtures pass parser checks without treating source flags or trailing CSV commas as numeric columns.
3. The imported mesh passes the N/E/U and 10 m baseline checks. Azimuth zero points north; 90 degrees points east; 90-degree elevation points up.
4. The horizon includes distant terrain, wraps through north correctly, retains negative elevations, and records gaps/convergence limits. Compare representative profiles independently before calling results validated.
5. UTC conversion, half-open boundaries, always-visible/hidden cases, horizon touches, short events, and gaps have explicit expected outcomes. Refined event brackets are separate from physical accuracy claims.
6. Quest sunlight status, power attenuation, and comparison metrics agree at the same site/observer/time. Renderer shadows do not override scientific visibility.
7. Offline bundles declare their exact date coverage. A missing NASA connection cannot silently switch the demo to fabricated scientific data.

Research performed here verifies site coordinates/coverage, local elevation samples, and short Horizons responses. Full terrain downloads, meshes, 360-degree horizons, long time series, numerical convergence, and independent physical validation remain implementation work.
