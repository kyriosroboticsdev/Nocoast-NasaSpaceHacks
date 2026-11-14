/**
 * Coarse south-polar candidate grid with LOLA 320 m overview horizons.
 * Not a meter-perfect global optimum — overview DEM only, ~10 km spacing,
 * 2° azimuth bins. Azimuth 0 = true local north (ENU great-circle bearings).
 * Writes public/science/search/polar-cap-candidates.json.
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

function destinationLatLon(latDeg, lonEastDeg, bearingDeg, distM) {
  const δ = distM / radius;
  const θ = bearingDeg * DEG;
  const φ1 = latDeg * DEG;
  const λ1 = lonEastDeg * DEG;
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(Math.max(-1, Math.min(1, sinφ2)));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * sinδ * cosφ1, cosδ - sinφ1 * Math.sin(φ2));
  return {
    latitudeDeg: φ2 * RAD,
    longitudeEastDeg: ((λ2 * RAD) % 360 + 360) % 360,
  };
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

/** Compact elevBins: number (0.01°) or null for gap. True-north ENU bearings. */
function overviewElevBins(observer, overview) {
  const observerH = observer.surfaceElevationM + OBSERVER_AGL_M;
  const bins = [];
  const maxDist = 250_000;
  const step = 640;

  for (let i = 0; i < 360 / SPACING_DEG; i++) {
    const az = i * SPACING_DEG;
    let maxEl = -90;
    let samples = 0;
    let closed = false;
    let exitedDem = false;
    let maxDistHit = null;

    for (let dist = step; dist <= maxDist; dist += step) {
      const dest = destinationLatLon(observer.latitudeDeg, observer.longitudeEastDeg, az, dist);
      const { x, y } = siteXY(dest.latitudeDeg, dest.longitudeEastDeg);
      const h = heightAt(overview, x, y);
      if (!Number.isFinite(h)) {
        if (samples > 0) exitedDem = true;
        break;
      }
      samples++;
      const el = Math.atan2(h - observerH - (dist * dist) / (2 * radius), dist) * RAD;
      if (el > maxEl + 1e-6) {
        maxEl = el;
        maxDistHit = dist;
        closed = false;
      } else if (maxDistHit != null && maxEl - el > 0.05) {
        closed = true;
      }
    }
    const peakNearEdge = maxDistHit != null && samples > 0 && !closed;
    // For overview search: require closure; exiting DEM without post-peak decline → null.
    const incomplete = samples < 6 || (exitedDem && (!closed || peakNearEdge));
    bins.push(incomplete ? null : Math.round(maxEl * 100) / 100);
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
    azimuthFrame: 'true_local_north_ENU',
    rayStepM: 640,
    maxRayKm: 250,
    honesty:
      'Regional coarse ranking only — not a global or meter-perfect optimum. Azimuth 0 = true local north. DEM reach is limited (~80–145 km typical); bearings that exit DEM before geometric closure are null. Prefer CR1/SR1 5 m LOLA profiles for study-grade decisions.',
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
