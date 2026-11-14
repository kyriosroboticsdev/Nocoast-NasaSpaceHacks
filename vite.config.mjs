import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fromFile, fromUrl } from 'geotiff';

const mosaicUrl = 'https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/ldem_87s_5mpp.tif';
const localMosaic = '.cache/polar-full.tif';
const windowCache = '.cache/polar-windows';
const localOnly = process.env.POLAR_LOCAL_ONLY === '1';
let source;
async function openMosaic() {
  const local = existsSync(localMosaic);
  if (localOnly && !local) throw new Error(`Local terrain mosaic is missing at ${localMosaic}`);
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
  if (url.pathname !== '/terrain/window') return next();
  const numbers = ['column', 'row', 'stride'].map(name => {
    const value = url.searchParams.get(name);
    return value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
  });
  const [column, row, stride] = numbers;
  const size = 257;
  const extent = (size - 1) * stride + 1;
  // 1/2/4 for relief; 8 for mesh/wireframe (wider, lower-density windows).
  if (req.method !== 'GET' || ![1, 2, 4, 8].includes(stride) ||
      !Number.isInteger(column) || !Number.isInteger(row) ||
      column + extent > 40000 || row + extent > 40000) {
    res.writeHead(400).end('Invalid terrain window');
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
    const cachedPath = `${windowCache}/${column}-${row}-${stride}.bin`;
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
    source ??= openMosaic().catch(error => { source = undefined; throw error; });
    const {image, local} = await source;
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
      res.writeHead(502).end('Could not read the NASA terrain mosaic');
    }
  } finally {
    running--;
  }
}

export default defineConfig({
  plugins: [{
    name: 'polar-elevation-windows',
    configureServer(server) { server.middlewares.use(elevationWindow); },
    configurePreviewServer(server) { server.middlewares.use(elevationWindow); },
  }],
});
