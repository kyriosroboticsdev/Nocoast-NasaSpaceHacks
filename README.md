# Lunar Navigator

One website that combines the team's workstreams:

| Page | What | Owner |
|---|---|---|
| `/` (`index.html`, `src/dashboard/`) | Dashboard: Sun, Earth & comms windows, site comparison, landing days and delays, plus a **3D terrain** tab | Person 2 |
| `/terrain.html` (`src/main.ts`) | 3D polar terrain explorer (also embedded in the dashboard; receives computed Sun/Earth directions) | Person 1 |
| `/api/*` (`backend/`) | Python science API: ephemeris, horizons, visibility, Quest export. See [docs/PERSON2_COMMS.md](docs/PERSON2_COMMS.md) | Person 2 |

**Run everything (Windows):** `./run.ps1`, then open http://127.0.0.1:5173.
On first run it creates the Python venv, downloads about 250 MB of NASA data into `data/`, and runs `npm ci`.

---

## Terrain explorer (Person 1)

Explore the lunar south polar cap from 87°S to 90°S in Three.js. Right-drag to pan and scroll or pinch to zoom. Select Connecting Ridge CR1 or Shackleton Rim SR1 and use **Zoom to site** to return to the published coordinates.

With Node.js 22.12 or newer:

```powershell
npm.cmd ci
npm.cmd run dev
```

`npm.cmd run build` type checks and builds the browser client. Use `npm.cmd run preview` to review the build with the elevation endpoint enabled.

The overview uses a 320 m level of detail from [NASA PGDA's regional LOLA DEM](https://pgda.gsfc.nasa.gov/products/90). Near the camera target, the viewer requests 20 m, 10 m or native 5 m sampling from the [NASA south pole mosaic](https://pgda.gsfc.nasa.gov/products/81). The browser keeps one detailed window in memory and blends its outer margin into the overview. It uses the reference sphere to position terrain at real scale. The study points have bundled native 5 m windows, and the script `node scripts/cache-polar-preview.mjs` regenerates them and the overview.

The Vite development and preview servers serve elevation windows from `.cache/polar-full.tif` when present, with NASA range requests available as a fallback when starting without the local file. A plain static host can serve the overview and bundled study points. Full on-demand detail requires the `/terrain/window` endpoint or an equivalent tile service.

For an offline demo, run `node scripts/download-polar.mjs` once while connected. The downloader saves the full 3.47 GB raster under `.cache` and resumes completed ranges if interrupted. Then start Vite with local-only terrain enabled:

```powershell
$env:POLAR_LOCAL_ONLY = '1'
npm.cmd run dev
```

For a demo on another computer, copy `.cache/polar-full.tif` to the same path in its checkout and install dependencies before going offline. The browser receives only the requested windows. While the mosaic is downloading, the bundled overview, both bundled 5 m site windows, and any previously streamed windows saved under `.cache/polar-windows` are available in local-only mode.

Original site-specific GLBs and reference elevations remain available as team handoff artifacts. The polar viewer uses the mosaic for both sites. Its terrain and display lighting are separate from the numerical horizons and science scenario data.
