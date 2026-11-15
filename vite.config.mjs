import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fromFile, fromUrl } from 'geotiff';

const mosaicUrl = 'https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/ldem_87s_5mpp.tif';
const localMosaic = '.cache/polar-full.tif';
const windowCache = '.cache/polar-windows';
const localOnly = process.env.POLAR_LOCAL_ONLY === '1';
const opened = new Map();
async function openMosaic(mode) {
  const local = mode !== 'stream';
  if (localOnly && mode === 'stream') throw new Error('NASA streaming is disabled on this server');
  if (local && !existsSync(localMosaic)) throw new Error(`Local terrain mosaic is missing at ${localMosaic}`);
  const tiff = local
    ? await fromFile(localMosaic)
    : await fromUrl(mosaicUrl, {blockSize: 65536, cacheSize: 256, maxRanges: 0});
  try {
    const image = await tiff.getImage();
    const [x, y] = image.getOrigin();
    const [dx, dy] = image.getResolution();
    const keys = image.getGeoKeys();
    if (x !== -100000 || y !== 100000 || dx !== 5 || dy !== -5 ||
        image.getWidth() !== 40000 || image.getHeight() !== 40000 ||
        keys.GeogSemiMajorAxisGeoKey !== 1737400 || keys.GeogSemiMinorAxisGeoKey !== 1737400 ||
        keys.ProjCoordTransGeoKey !== 15 || keys.ProjNatOriginLatGeoKey !== -90 ||
        keys.ProjStraightVertPoleLongGeoKey !== 0 || keys.GTRasterTypeGeoKey !== 1 ||
        keys.ProjScaleAtNatOriginGeoKey !== 1 || keys.ProjFalseEastingGeoKey !== 0 ||
        keys.ProjFalseNorthingGeoKey !== 0) {
      throw new Error('Unexpected projection or dimensions for the polar mosaic');
    }
    return {image, tiff, local};
  } catch (error) {
    await tiff.close();
    throw error;
  }
}

let running = 0;
async function elevationWindow(req, res, next) {
  const url = new URL(req.url, 'http://localhost');
  // /api/terrain/window is what the app requests (so Azure SWA forwards it to the backend in production);
  // this plugin middleware runs before Vite's /api proxy, so locally it is still served here.
  if (url.pathname !== '/terrain/window' && url.pathname !== '/api/terrain/window') return next();
  const numbers = ['column', 'row', 'stride'].map(name => {
    const value = url.searchParams.get(name);
    return value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
  });
  const [column, row, stride] = numbers;
  const requested = url.searchParams.get('source');
  const mode = requested === 'stream' ? 'stream'
    : requested === 'local' ? 'local'
    : (existsSync(localMosaic) ? 'local' : 'stream');
  const size = 257;
  const extent = (size - 1) * stride + 1;
  // 1/2/4 for relief; 8 for mesh/wireframe (wider, lower-density windows).
  if (req.method !== 'GET' || (requested && requested !== 'local' && requested !== 'stream') ||
      ![1, 2, 4, 8].includes(stride) ||
      !Number.isInteger(column) || !Number.isInteger(row) ||
      column + extent > 40000 || row + extent > 40000) {
    res.writeHead(400).end('Invalid terrain window');
    return;
  }
  if (localOnly && mode === 'stream') {
    res.writeHead(403).end('NASA streaming is disabled on this server');
    return;
  }
  if (running >= 2) {
    res.writeHead(503).end('Terrain reader busy');
    return;
  }
  const abort = new AbortController();
  res.once('close', () => abort.abort());
  running++;
  try {
    const cachedPath = `${windowCache}/${mode}-${column}-${row}-${stride}.bin`;
    const cached = await readFile(cachedPath).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (cached?.length === size * size * 4) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
        'X-Terrain-Source': 'local-cache',
      }).end(cached);
      return;
    }
    if (!opened.has(mode)) {
      opened.set(mode, openMosaic(mode).catch(error => { opened.delete(mode); throw error; }));
    }
    const {image, local} = await opened.get(mode);
    abort.signal.throwIfAborted();
    const raster = await image.readRasters({
      window: [column, row, column + extent, row + extent],
      samples: [0], interleave: true,
    });
    abort.signal.throwIfAborted();
    const result = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const height = raster[(y * extent + x) * stride];
        result.writeFloatLE(height, (y * size + x) * 4);
      }
    }
    if (!local) {
      await mkdir(windowCache, {recursive: true});
      await writeFile(cachedPath, result);
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
      'X-Terrain-Source': local ? 'local' : 'remote',
    }).end(result);
  } catch (error) {
    if (!res.destroyed) {
      console.error('Polar terrain read failed:', error);
      res.writeHead(mode === 'local' ? 503 : 502).end(mode === 'local'
        ? 'Could not read .cache/polar-full.tif'
        : 'Could not read the NASA terrain mosaic');
    }
  } finally {
    running--;
  }
}

// Person 2 science API (FastAPI, `python -m uvicorn backend.app:app --port 8765`). Dev-only enhancement —
// every caller in src/science/backend.ts fails soft to the bundled/sphere pipeline when this isn't running.
const api = {'/api': {target: process.env.SCIENCE_API ?? 'http://127.0.0.1:8765', changeOrigin: true}};

export default defineConfig({
  server: {proxy: api},
  preview: {proxy: api},
  plugins: [{
    name: 'polar-elevation-windows',
    configureServer(server) { server.middlewares.use(elevationWindow); },
    configurePreviewServer(server) { server.middlewares.use(elevationWindow); },
  }],
});
