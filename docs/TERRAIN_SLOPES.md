# Local terrain-slope screening

Integrated with `main` commit `2c59193` (the same tracked content as `preview`
`3284b18`). Open **Terrain slopes and area comparison** below the Planner's 3D
viewer. Choose locations with the existing **Site A** and **Site B** controls;
**Show slope map for** switches the map between them. Change **Screening limit (°)**,
and click/tap or use arrow keys on the map to inspect
samples. **Inspect site center** returns the readout to the selected coordinates.
Changing an inspected sample does not select a different landing site.

**Area within slope limit** estimates the known terrain area at or below the
chosen limit. The map includes a comparison table; the same metric is shown in
the Planner's Site A/B metric cards after opening the section. Turning comparison
off removes Site B from the slope table and selector. All sites use an identical 1.24 by 1.24 km
window and the same slope limit. Unknown area is reported separately. The sum can
include disconnected patches and does not establish the size of a continuous
landing zone or terrain safe for a particular vehicle.

Area is approximate **planimetric area on the local map**, not the corrugated
3D surface area. Each sample represents a footprint halfway to its neighboring
samples, clipped at the window boundary. Interior samples have spacing² area,
boundary samples half that, and corners a quarter. The footprints therefore sum
to exactly (2 × halfExtentM)², or 1,537,600 m² for the default window, rather than
overcounting a node-registered grid as n² full-size cells. Unknown footprints are
excluded from the within-limit total; if all footprints are unknown, that total
is **Unknown**, not zero. The full-window fraction counts only known qualifying
area and uses the entire window as its denominator. The existing sample fraction
instead uses known samples only. Neither estimate propagates slope uncertainty.

## What the colors mean

For a chosen limit L (default 10 degrees):

| Color | Meaning |
| --- | --- |
| Teal | Slope from 0 through L/2 degrees |
| Amber | Slope greater than L/2, through L degrees |
| Red | Slope greater than L degrees |
| Gray | Unknown: missing fine DEM, incomplete neighbor stencil, grid edge or tile seam |

The limit is an adjustable project example, not a NASA standard or a vehicle's
certified tolerance. Fractions describe grid samples; the within-limit fraction
uses **known samples only**. A fully unknown grid has no within-limit fraction.
The normal gray border means the central difference lacks neighbors outside the
requested grid. It is not a ring of hazardous ground.

## Terrain and calculation

`GET /api/terrain_slopes?latitudeDeg=&longitudeEastDeg=` returns a preliminary
`terrain-slope-grid` artifact in MOON_ME_DE421. The default is 249 by 249 samples
over 1.24 km square, at 5 m spacing. Rows run south to north; columns west to east.
The client flips rows for a north-up raster. Longitude is east-positive.

The backend uses the **existing PGDA 5 m surface elevation tiles**. Their heights
are bilinearly sampled at points on the same spherical local grid used by the
terrain viewer. It does not use procedural texture, display lighting, vertical
exaggeration, observer height, or the 80/240 m fallback DEMs for this product.

For each sample, construct its radial direction p and position X=(R+h)p, with
R=1737400 m and radial surface height h. Estimate two surface tangents by centered
differences across east/west and north/south neighbors. Their cross product is the
surface normal N. The slope is:

```
atan2(|N cross p|, |N dot p|) in degrees
```

This measures tilt relative to the **local radial up at each point**. A level
spherical surface therefore has zero slope rather than a false curvature slope.
The default difference baseline is 10 m, spanning two 5 m steps. Every result
requires a finite center and four finite cardinal neighbors from the **same DEM
tile**. Stencils crossing independently adjusted tiles are unknown, avoiding false
slopes from elevation offsets at tile seams. This conservative seam policy can
omit terrain where another tile could supply a complete stencil.

The endpoint accepts odd n from 17 to 401 and half extents from 100 to 2000 m,
with grid spacing at least 5 m. It caches up to 16 successful grids per process.
The client uses the default grid, caches up to eight successful responses, validates
coordinates/frame/grid metadata and numeric samples, aborts stale requests, and
offers retry on errors or a 30 s timeout. Restart the backend after replacing DEM
files to clear its terrain and slope caches.

## Limits and ownership

This is an initial steepness screen. It is **not a landing-safety assessment**.
Five-metre pixel spacing does not establish five-metre effective resolution or
resolve every small rock, crater, ledge, regolith property or landing-footprint
hazard. Centered gradients can smooth small features. This implementation does not
propagate DEM uncertainty, calculate footprint roughness, analyze an approach
trajectory or certify a lander-specific slope tolerance. It does not change solar
generation, terrain visibility, battery results, site ranking or mission grades.

NASA's [PGDA product description](https://pgda.gsfc.nasa.gov/products/78) explains
the interpolation and slope uncertainty of these terrain products. Its published
slope products can support a future independent comparison; our derivative has
not been validated against those products. NASA's
[lunar site-selection paper](https://www.nasa.gov/wp-content/uploads/2024/02/15-2024-architecture-workshop-white-paper-lunar-site-selection.pdf)
describes the separate need to assess lander-specific terrain and obstacle limits.

Terrain owns `backend/slopes.py` and the slope API. The Planner owns the map,
legend, screening threshold and inspection readout. Solar/communication modules
are consumed as before. `src/ui/slopeIntegration.ts` adapts the shared scenario;
changing dates, playback time or panel settings does not reload static terrain.
Unsupported catalog locations, such as Apollo 11, show Unknown. South-polar
locations outside the fine DEM tiles also show Unknown rather than a coarse-data
estimate. The existing 3D terrain viewer remains available.

## Run and verify

From this checkout, the existing `./run.ps1` starts the frontend and Python API.
For separate terminals after installing dependencies/downloading terrain:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8765
npm.cmd run dev
```

Vite's `SCIENCE_API` environment variable selects another API port if needed.
Slope requests use `src/apiBase.ts`: relative to Vite's base URL by default, or
`VITE_API_ORIGIN` when configured. This helper matches the pending
`infra/azure-express-fixes` version; it does not by itself configure server CORS.
The new endpoint is served by Python; rebuilding only the frontend does not add
it to an already-running old backend. Neither `.venv`, downloaded `data/`, nor
`node_modules/` should be committed.

```powershell
npm.cmd test
npm.cmd run build
.\.venv\Scripts\python.exe -m pytest -q
```

Tests cover known planar slopes, a level Moon sphere, signs/orientation, missing
stencils, tile offsets, coarse-only coverage, all six current polar study sites, invalid grids,
API errors, threshold boundaries, raster orientation and metadata validation.
Browser evidence is in `slope-main-evidence/`; the UI contract is in
`SLOPE_UI_CONTRACT.md`. Numerical regression checks are not physical validation.

## Updated-repository compatibility check

The original slope feature used the separate `person2/integration` dashboard.
This branch ports its calculation and map into the shared Planner instead of
replacing the current frontend. It preserves the latest pathfinding routes and
expanded catalog. The original feature checkout remains separate.

Local verification: 86 Python tests, 8 frontend tests, Ruff, TypeScript/Vite build,
and desktop/phone browser checks passed. Real API requests succeeded for CR1,
SR1, Peak Near Shackleton, de Gerlache Rim 1, Leibnitz Beta Plateau and Malapert
Massif. Site A/B changes, comparison off/on, threshold changes, unsupported sites
and an all-unknown custom location were checked in the browser. No browser
console errors were observed during those checks.

The upstream pathfinding code had three Ruff findings. Explicit `strict=False`
on adjacent-pair `zip` calls and a test import-order correction resolve these
without changing pathfinding behavior. CI now downloads the existing science
fixtures before pytest, which requires the DEMs and kernels. GitHub CI has not
been run for these uncommitted changes.

A scratch three-way merge with `infra/azure-express-fixes` (`518e9e7`) found no
text conflicts in the shared backend route file; its new API helper is identical
to ours. That is a source compatibility check, not an Azure deployment test.
Keep DEMs, virtual environments and node_modules out of the commit.
