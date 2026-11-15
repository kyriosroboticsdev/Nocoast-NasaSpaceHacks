/**
 * Offline 360° horizon profiles for CR1 / SR1 from bundled LOLA products.
 * Near-field: 5 m focus windows; far-field: 320 m polar overview.
 * Observer = surface + 2 m AGL. Airless geometric elevation (no refraction).
 * Azimuth 0 = true local north (ENU); rays follow constant-bearing great circles.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const radius = 1737400;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const sites = [
  {
    siteId: 'connecting-ridge-cr1',
    latitudeDeg: -89.4555,
    longitudeEastDeg: 222.6192,
    surfaceElevationM: 1949.6080773175818,
    heightAboveGroundM: 2,
    focusFile: 'public/terrain/focus/17664-22272.bin',
    focusColumn: 17664,
    focusRow: 22272,
  },
  {
    siteId: 'shackleton-rim-sr1',
    latitudeDeg: -89.7742,
    longitudeEastDeg: 203.4952,
    surfaceElevationM: 1735.2179263340893,
    heightAboveGroundM: 2,
    focusFile: 'public/terrain/focus/19328-21120.bin',
    focusColumn: 19328,
    focusRow: 21120,
  },
];

function siteXY(latDeg, lonEastDeg) {
  const rho = 2 * radius * Math.tan(((latDeg + 90) * DEG) / 2);
  const lon = lonEastDeg * DEG;
  return { x: rho * Math.sin(lon), y: rho * Math.cos(lon) };
}

/** Destination on a sphere after traveling distM along constant bearing (CW from north). */
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

async function loadFocus(site) {
  const buf = await readFile(join(root, site.focusFile));
  const size = 257;
  if (buf.byteLength !== size * size * 4) throw new Error(`Unexpected focus size for ${site.siteId}`);
  return {
    x: -100000 + (site.focusColumn + 0.5) * 5,
    y: 100000 - (site.focusRow + 0.5) * 5,
    width: size,
    spacing: 5,
    values: new Float32Array(buf.buffer, buf.byteOffset, size * size),
  };
}

function sampleTerrain(focus, overview, x, y) {
  const near = heightAt(focus, x, y);
  if (Number.isFinite(near)) return { h: near, source: 'focus5m' };
  const far = heightAt(overview, x, y);
  if (Number.isFinite(far)) return { h: far, source: 'overview320m' };
  return { h: NaN, source: 'gap' };
}

/**
 * March one bearing. Mark gap when DEM ends before geometric closure
 * (peak not confirmed by post-peak decline from curvature/range).
 */
function marchBearing(site, focus, overview, azDeg) {
  const observerH = site.surfaceElevationM + site.heightAboveGroundM;
  const maxDist = 400_000;
  const stepNear = 25;
  const stepFar = 320;
  let maxEl = -90;
  let maxDistHit = null;
  let samples = 0;
  let lastValidDist = 0;
  let closed = false;
  let exitedDem = false;

  for (let dist = stepNear; dist <= maxDist; dist += dist < 5000 ? stepNear : stepFar) {
    const dest = destinationLatLon(site.latitudeDeg, site.longitudeEastDeg, azDeg, dist);
    const { x, y } = siteXY(dest.latitudeDeg, dest.longitudeEastDeg);
    const { h } = sampleTerrain(focus, overview, x, y);
    if (!Number.isFinite(h)) {
      if (samples > 0) exitedDem = true;
      break;
    }
    samples++;
    lastValidDist = dist;
    const curve = (dist * dist) / (2 * radius);
    const el = Math.atan2(h - observerH - curve, dist) * RAD;
    if (el > maxEl + 1e-6) {
      maxEl = el;
      maxDistHit = dist;
      closed = false;
    } else if (maxDistHit != null && maxEl - el > 0.05) {
      // Peak clearly behind us — geometric horizon closed within DEM.
      closed = true;
    }
  }

  // Incomplete if DEM ends before closure, or the peak sits at the DEM edge
  // (higher terrain beyond coverage could still raise the horizon).
  const peakNearEdge = maxDistHit != null && lastValidDist - maxDistHit < 2500;
  const incomplete = samples < 8 || (exitedDem && (!closed || peakNearEdge));
  return {
    azimuthDeg: azDeg,
    elevationDeg: incomplete ? null : Number(maxEl.toFixed(4)),
    distanceM: incomplete ? null : maxDistHit,
    status: incomplete ? 'gap' : 'ok',
    _reachM: lastValidDist,
    _closed: closed,
    _exited: exitedDem,
  };
}

function horizonForSite(site, focus, overview) {
  const spacingDeg = 0.25;
  const bins = [];
  const reaches = [];

  for (let i = 0; i < 360 / spacingDeg; i++) {
    const bin = marchBearing(site, focus, overview, i * spacingDeg);
    reaches.push(bin._reachM);
    bins.push({
      azimuthDeg: bin.azimuthDeg,
      elevationDeg: bin.elevationDeg,
      distanceM: bin.distanceM,
      status: bin.status,
    });
  }

  const reachMin = Math.min(...reaches);
  const reachMax = Math.max(...reaches);
  const reachMinKm = (reachMin / 1000).toFixed(0);
  const reachMaxKm = (reachMax / 1000).toFixed(0);

  return {
    schemaVersion: '1.0',
    siteId: site.siteId,
    frameId: 'MOON_ME_DE421',
    observer: {
      latitudeDeg: site.latitudeDeg,
      longitudeEastDeg: site.longitudeEastDeg,
      surfaceElevationM: site.surfaceElevationM,
      heightAboveGroundM: site.heightAboveGroundM,
    },
    spacingDeg,
    model: 'lola_terrain',
    sources: [
      'NASA PGDA LOLA 5 m south pole mosaic focus window',
      'NASA PGDA LOLA 320 m polar overview',
    ],
    notes: [
      'Airless geometric horizon; no atmospheric refraction.',
      'Azimuth 0° = true local north (ENU); rays are constant-bearing great circles projected to DEM XY.',
      `Near-field ≤~1.28 km uses 5 m focus; overview DEM reach along rays is ~${reachMinKm}–${reachMaxKm} km (not 400 km).`,
      'Bearings that exit DEM before geometric closure are status=gap with null elevation — never interpolated.',
      'Local visual mesh is not the authority for these angles.',
    ],
    demReachM: { min: reachMin, max: reachMax },
    bins,
    generatedAtUtc: new Date().toISOString(),
  };
}

const overview = await loadOverview();
await mkdir(join(root, 'public/science/horizons'), { recursive: true });

for (const site of sites) {
  const focus = await loadFocus(site);
  const profile = horizonForSite(site, focus, overview);
  const out = join(root, `public/science/horizons/${site.siteId}.json`);
  await writeFile(out, JSON.stringify(profile));
  const ok = profile.bins.filter(b => b.status === 'ok').length;
  const gap = profile.bins.filter(b => b.status === 'gap').length;
  const els = profile.bins.map(b => b.elevationDeg).filter(v => v != null);
  const min = els.length ? Math.min(...els) : NaN;
  const max = els.length ? Math.max(...els) : NaN;
  console.log(
    `${site.siteId}: ${ok} ok / ${gap} gap · el ${min.toFixed?.(2) ?? 'n/a'}° … ${max.toFixed?.(2) ?? 'n/a'}° · DEM reach ${(profile.demReachM.min / 1000).toFixed(0)}–${(profile.demReachM.max / 1000).toFixed(0)} km → ${out}`,
  );
}
