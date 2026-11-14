/**
 * Coarse south-polar candidate grid with LOLA 320 m overview horizons.
 * Not a meter-perfect global optimum — overview DEM only, ~10 km spacing,
 * 2° azimuth bins. Writes public/science/search/polar-cap-candidates.json.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const radius = 1737400;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const CAP_LAT_MIN = -87;
const GRID_SPACING_M = 10_000;
const OBSERVER_AGL_M = 2;
const SPACING_DEG = 2;

function siteXY(latDeg, lonEastDeg) {
  const rho = 2 * radius * Math.tan(((latDeg + 90) * DEG) / 2);
  const lon = lonEastDeg * DEG;
  return { x: rho * Math.sin(lon), y: rho * Math.cos(lon) };
}

function xyToLatLon(x, y) {
  const rho = Math.hypot(x, y);
  const latitudeDeg = 2 * Math.atan(rho / (2 * radius)) * RAD - 90;
  let longitudeEastDeg = Math.atan2(x, y) * RAD;
  if (longitudeEastDeg < 0) longitudeEastDeg += 360;
  return { latitudeDeg, longitudeEastDeg };
}

function heightAt(grid, x, y) {
  const u = (x - grid.x) / grid.spacing;
  const v = (grid.y - y) / grid.spacing;
  const i = Math.floor(u);
  const j = Math.floor(v);
  if (i < 0 || j < 0 || i >= grid.width - 1 || j >= grid.width - 1) return NaN;
  const a = grid.values[j * grid.width + i];
  const b = grid.values[j * grid.width + i + 1];
  const c = grid.values[(j + 1) * grid.width + i];
  const d = grid.values[(j + 1) * grid.width + i + 1];
  if (![a, b, c, d].every(Number.isFinite)) return NaN;
  const du = u - i;
  const dv = v - j;
  return du + dv <= 1
    ? a + (b - a) * du + (c - a) * dv
    : d + (c - d) * (1 - du) + (b - d) * (1 - dv);
}

async function loadOverview() {
  const buf = await readFile(join(root, 'public/terrain/polar-overview.bin'));
  const header = new DataView(buf.buffer, buf.byteOffset, 12);
  return {
    x: header.getInt32(0, true),
    y: header.getInt32(4, true),
    width: header.getUint32(8, true),
    spacing: 320,
    values: new Float32Array(buf.buffer, buf.byteOffset + 12),
  };
}

function buildGridPoints(overview) {
  const capRho = 2 * radius * Math.tan(((CAP_LAT_MIN + 90) * DEG) / 2);
  const points = [];
  const step = GRID_SPACING_M;
  const n = Math.ceil((2 * capRho) / step);
  for (let iy = -n; iy <= n; iy++) {
    for (let ix = -n; ix <= n; ix++) {
      const x = ix * step;
      const y = iy * step;
      if (Math.hypot(x, y) > capRho) continue;
      const h = heightAt(overview, x, y);
      if (!Number.isFinite(h)) continue;
      const { latitudeDeg, longitudeEastDeg } = xyToLatLon(x, y);
      if (latitudeDeg > CAP_LAT_MIN) continue;
      points.push({
        x,
        y,
        latitudeDeg: Number(latitudeDeg.toFixed(4)),
        longitudeEastDeg: Number(longitudeEastDeg.toFixed(4)),
        surfaceElevationM: Number(h.toFixed(2)),
      });
    }
  }
  for (const pin of [
    { latitudeDeg: -89.4555, longitudeEastDeg: 222.6192 },
    { latitudeDeg: -89.7742, longitudeEastDeg: 203.4952 },
  ]) {
    const { x, y } = siteXY(pin.latitudeDeg, pin.longitudeEastDeg);
    const h = heightAt(overview, x, y);
    if (!Number.isFinite(h)) continue;
    if (points.some(p => Math.hypot(p.x - x, p.y - y) < step * 0.35)) continue;
    points.push({
      x,
      y,
      latitudeDeg: pin.latitudeDeg,
      longitudeEastDeg: pin.longitudeEastDeg,
      surfaceElevationM: Number(h.toFixed(2)),
    });
  }
  return points;
}

/** Compact elevBins: number (0.01°) or null for gap. */
function overviewElevBins(observer, overview) {
  const ox = observer.x;
  const oy = observer.y;
  const observerH = observer.surfaceElevationM + OBSERVER_AGL_M;
  const bins = [];
  const maxDist = 250_000;
  const step = 640;

  for (let i = 0; i < 360 / SPACING_DEG; i++) {
    const az = i * SPACING_DEG;
    const rad = az * DEG;
    const dirX = Math.sin(rad);
    const dirY = Math.cos(rad);
    let maxEl = -90;
    let samples = 0;
    let gaps = 0;
    for (let dist = step; dist <= maxDist; dist += step) {
      const h = heightAt(overview, ox + dirX * dist, oy + dirY * dist);
      if (!Number.isFinite(h)) {
        gaps++;
        continue;
      }
      samples++;
      const el = Math.atan2(h - observerH - (dist * dist) / (2 * radius), dist) * RAD;
      if (el > maxEl) maxEl = el;
    }
    const mostlyGap = samples < 8 || gaps > samples * 4;
    bins.push(mostlyGap ? null : Math.round(maxEl * 100) / 100);
  }
  return bins;
}

const overview = await loadOverview();
const points = buildGridPoints(overview);
console.log(`Grid candidates: ${points.length}`);

const candidates = [];
for (let i = 0; i < points.length; i++) {
  const p = points[i];
  const id = `search-${String(i).padStart(3, '0')}`;
  const elevBins = overviewElevBins(p, overview);
  candidates.push({
    id,
    latitudeDeg: p.latitudeDeg,
    longitudeEastDeg: p.longitudeEastDeg,
    surfaceElevationM: p.surfaceElevationM,
    elevBins,
  });
  if ((i + 1) % 40 === 0 || i === points.length - 1) {
    console.log(`  horizons ${i + 1}/${points.length}`);
  }
}

const payload = {
  schemaVersion: '1.0',
  artifactId: 'polar-cap-search-candidates-v1',
  generatedAtUtc: new Date().toISOString(),
  region: {
    label: 'South pole cap 87°S–90°S',
    minLatitudeDeg: CAP_LAT_MIN,
    maxLatitudeDeg: -90,
    gridSpacingM: GRID_SPACING_M,
  },
  method: {
    dem: 'LOLA 320 m polar overview',
    nearField5m: false,
    azimuthSpacingDeg: SPACING_DEG,
    rayStepM: 640,
    maxRayKm: 250,
    honesty:
      'Regional coarse ranking only — not a global or meter-perfect optimum. Prefer CR1/SR1 5 m LOLA profiles for study-grade decisions.',
  },
  candidateCount: candidates.length,
  candidates,
};

const outDir = join(root, 'public/science/search');
await mkdir(outDir, { recursive: true });
const out = join(outDir, 'polar-cap-candidates.json');
await writeFile(out, JSON.stringify(payload));
const mb = (Buffer.byteLength(JSON.stringify(payload)) / (1024 * 1024)).toFixed(2);
console.log(`Wrote ${candidates.length} candidates (${mb} MB) → ${out}`);
