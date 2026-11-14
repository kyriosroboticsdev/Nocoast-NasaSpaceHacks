/**
 * Offline 360° horizon profiles for CR1 / SR1 from bundled LOLA products.
 * Near-field: 5 m focus windows; far-field: 320 m polar overview.
 * Observer = surface + 2 m AGL. Airless geometric elevation (no refraction).
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

function horizonForSite(site, focus, overview) {
  const { x: ox, y: oy } = siteXY(site.latitudeDeg, site.longitudeEastDeg);
  const observerH = site.surfaceElevationM + site.heightAboveGroundM;
  const spacingDeg = 0.25;
  const bins = [];
  const maxDist = 400_000;
  const stepNear = 25;
  const stepFar = 320;

  for (let i = 0; i < 360 / spacingDeg; i++) {
    const az = i * spacingDeg;
    const rad = az * DEG;
    // Polar stereographic: +X = 90°E, +Y = 0°E. Azimuth from north (0°E / +Y).
    const dirX = Math.sin(rad);
    const dirY = Math.cos(rad);
    let maxEl = -90;
    let maxDistHit = null;
    let gaps = 0;
    let samples = 0;
    let dist = stepNear;
    while (dist <= maxDist) {
      const x = ox + dirX * dist;
      const y = oy + dirY * dist;
      const { h, source } = sampleTerrain(focus, overview, x, y);
      if (!Number.isFinite(h)) {
        gaps++;
      } else {
        samples++;
        // Geometric elevation angle to terrain point (flat-plane approx + curvature).
        const dh = h - observerH;
        const range = dist;
        // Lunar curvature: drop ≈ r²/(2R)
        const curve = (range * range) / (2 * radius);
        const el = Math.atan2(dh - curve, range) * RAD;
        if (el > maxEl) {
          maxEl = el;
          maxDistHit = range;
        }
      }
      dist += dist < 5000 ? stepNear : stepFar;
      void source;
    }
    const mostlyGap = samples < 10 || gaps > samples * 4;
    bins.push({
      azimuthDeg: az,
      elevationDeg: mostlyGap ? null : Number(maxEl.toFixed(4)),
      distanceM: mostlyGap ? null : maxDistHit,
      status: mostlyGap ? 'gap' : 'ok',
    });
  }

  // Downsample / keep 0.25° but also emit 1° companion note.
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
      'Near-field ≤~1.28 km uses 5 m focus; beyond that uses 320 m overview to 400 km.',
      'Gaps remain null — never interpolated across missing DEM.',
      'Local visual mesh is not the authority for these angles.',
    ],
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
  const min = Math.min(...els);
  const max = Math.max(...els);
  console.log(`${site.siteId}: ${ok} ok / ${gap} gap · el ${min.toFixed(2)}° … ${max.toFixed(2)}° → ${out}`);
}
