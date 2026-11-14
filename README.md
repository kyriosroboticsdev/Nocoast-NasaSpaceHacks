# Lunar Shadow Lab terrain explorer

Explore the lunar south polar cap from 87°S to 90°S in Three.js. Right-drag to pan and scroll or pinch to zoom. Select Connecting Ridge CR1 or Shackleton Rim SR1 and use **Zoom to site** to return to the published coordinates.

With Node.js 22.12 or newer:

```powershell
npm.cmd ci
npm.cmd run dev
```

`npm.cmd run build` type checks and builds the browser client. Use `npm.cmd run preview` to review the build with the elevation endpoint enabled.

The overview uses 320 m mesh spacing from the [NASA PGDA regional LOLA DEM](https://pgda.gsfc.nasa.gov/products/90). Within 26 km of the camera target, the viewer fills the visible area with up to 36 tiles at 40 m, 20 m, 10 m or native 5 m spacing from the [NASA south pole mosaic](https://pgda.gsfc.nasa.gov/products/81). The level depends on camera distance and how much terrain is visible. Tiles load from the center outward, share boundary samples, and reuse recently loaded geometry when panning.

The viewer defaults to **Local LOLA file** and requests detail from `.cache/polar-full.tif` through the Vite server. Select **Stream from NASA** to use NASA range requests instead. The bundled 320 m overview is available in either mode. Native-resolution detail requires the `/terrain/window` endpoint or an equivalent tile service.

For an offline demo, run `node scripts/download-polar.mjs` once while connected. The downloader saves the full 3.47 GB raster under `.cache` and resumes completed ranges if interrupted. Start Vite normally to use the local file by default. To also block requests for NASA streaming on the server, start with:

```powershell
$env:POLAR_LOCAL_ONLY = '1'
npm.cmd run dev
```

For a demo on another computer, copy `.cache/polar-full.tif` to the same path in its checkout and install dependencies before going offline. The browser receives only the requested windows.

Original site-specific GLBs and reference elevations remain available as team handoff artifacts. The polar viewer uses the mosaic for both sites. Its terrain and display lighting are separate from the numerical horizons and science scenario data.
