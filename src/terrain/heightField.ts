/**
 * One elevation function for the whole Moon.
 *
 * Directions are unit vectors from the Moon's centre in the viewer frame:
 * +Y through the south pole, +X towards 90°E, −Z towards 0°E.
 * Heights are metres above the 1737.4 km reference sphere.
 *
 * Sources: the 320 m polar LOLA overview where it exists, the 4 ppd global
 * LDEM everywhere else, cross-faded over a band just inside the LOLA rim so
 * the surface has no step where the data changes.
 */

/** Polar stereographic height grid (node registered, row 0 = north-most y). */
export type PolarGrid = {
  x: number;
  y: number;
  width: number;
  spacing: number;
  values: Float32Array;
};

export type GlobalLdem = {
  width: number;
  height: number;
  ppd: number;
  lonWestDeg: number;
  latNorthDeg: number;
  metersPerUnit: number;
  values: Int16Array;
};

export type HeightSource = 'lola' | 'blend' | 'ldem';

export type HeightField = {
  /** Elevation for a unit direction from the Moon's centre. */
  height: (dx: number, dy: number, dz: number) => number;
  /** Elevation at south-polar stereographic metres (valid for any latitude). */
  heightAtPolar: (x: number, y: number) => number;
  /** Which data set the elevation at this direction comes from. */
  source: (dx: number, dy: number, dz: number) => HeightSource;
  /** LOLA is used unblended inside this stereographic radius (m). */
  blendInnerM: number;
  /** LOLA weight reaches zero at this stereographic radius (m). */
  blendOuterM: number;
  /** Native sample spacing of each source (m). */
  lolaSpacingM: number;
  ldemSpacingM: number;
};

/** Width of the LOLA → LDEM cross-fade, about 1.3 LDEM pixels. */
const BLEND_WIDTH_M = 10_000;

export function parseGlobalLdem(buffer: ArrayBuffer): GlobalLdem {
  const header = new DataView(buffer);
  const magic = String.fromCharCode(
    header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3),
  );
  if (magic !== 'LDEM') throw new Error('Unexpected global LDEM magic');
  const version = header.getUint32(4, true);
  if (version !== 1) throw new Error(`Unsupported global LDEM version ${version}`);
  const width = header.getUint32(8, true);
  const height = header.getUint32(12, true);
  const ppd = header.getUint32(16, true);
  const lonWestDeg = header.getFloat32(20, true);
  const latNorthDeg = header.getFloat32(24, true);
  const metersPerUnit = header.getFloat32(28, true);
  const values = new Int16Array(buffer, 32, width * height);
  return { width, height, ppd, lonWestDeg, latNorthDeg, metersPerUnit, values };
}

export function createHeightField(radius: number, polar: PolarGrid, ldem?: GlobalLdem): HeightField {
  const { width: W, height: H, ppd, lonWestDeg, latNorthDeg, metersPerUnit, values } = ldem ?? {
    width: 1, height: 1, ppd: 1/360, lonWestDeg: -180, latNorthDeg: 90,
    metersPerUnit: 1, values: new Int16Array(1),
  };
  const DEG = 180 / Math.PI;

  // The cylindrical grid has no sample at the poles; use each end row's mean
  // there so every longitude agrees on the pole's elevation.
  let northPole = 0;
  let southPole = 0;
  for (let i = 0; i < W; i++) {
    northPole += values[i];
    southPole += values[(H - 1) * W + i];
  }
  northPole = (northPole / W) * metersPerUnit;
  southPole = (southPole / W) * metersPerUnit;

  /** Bilinear global LDEM sample; pixel centres sit at half-pixel offsets. */
  function ldemHeight(latDeg: number, lonDeg: number): number {
    let fx = (lonDeg - lonWestDeg) * ppd - 0.5;
    fx -= Math.floor(fx / W) * W;
    let i0 = Math.floor(fx);
    const tx = fx - i0;
    if (i0 >= W) i0 = 0;
    const i1 = i0 + 1 === W ? 0 : i0 + 1;
    const fy = (latNorthDeg - latDeg) * ppd - 0.5;
    if (fy <= 0) {
      const row = (values[i0] + (values[i1] - values[i0]) * tx) * metersPerUnit;
      const t = Math.max(0, fy + 0.5) * 2;
      return northPole + (row - northPole) * t;
    }
    if (fy >= H - 1) {
      const base = (H - 1) * W;
      const row = (values[base + i0] + (values[base + i1] - values[base + i0]) * tx) * metersPerUnit;
      const t = Math.max(0, H - 0.5 - fy) * 2;
      return southPole + (row - southPole) * t;
    }
    const j0 = Math.floor(fy);
    const ty = fy - j0;
    const top = j0 * W;
    const bottom = top + W;
    const a = values[top + i0] + (values[top + i1] - values[top + i0]) * tx;
    const b = values[bottom + i0] + (values[bottom + i1] - values[bottom + i0]) * tx;
    return (a + (b - a) * ty) * metersPerUnit;
  }

  // Largest circle about the pole that the LOLA grid covers on every side,
  // kept two samples inside the edge so bilinear lookups never leave the grid.
  const last = (polar.width - 1) * polar.spacing;
  const covered = Math.min(-polar.x, polar.x + last, polar.y, last - polar.y);
  const blendOuterM = covered - 2 * polar.spacing;
  const blendInnerM = blendOuterM - BLEND_WIDTH_M;
  /** cos(colatitude from the south pole) at the outer blend radius. */
  const polarCos = Math.cos(2 * Math.atan(blendOuterM / (2 * radius)));

  /** Bilinear LOLA sample; callers keep (x, y) inside the covered circle. */
  function lolaHeight(x: number, y: number): number {
    const u = (x - polar.x) / polar.spacing;
    const v = (polar.y - y) / polar.spacing;
    const i = Math.min(Math.max(Math.floor(u), 0), polar.width - 2);
    const j = Math.min(Math.max(Math.floor(v), 0), polar.width - 2);
    const tu = u - i;
    const tv = v - j;
    const row = j * polar.width + i;
    const a = polar.values[row] + (polar.values[row + 1] - polar.values[row]) * tu;
    const b = polar.values[row + polar.width]
      + (polar.values[row + polar.width + 1] - polar.values[row + polar.width]) * tu;
    return a + (b - a) * tv;
  }

  /** LOLA weight: 1 inside the band, smoothstep down to 0 at its outer edge. */
  function lolaWeight(rho: number): number {
    if (rho <= blendInnerM) return 1;
    if (rho >= blendOuterM) return 0;
    const t = (rho - blendInnerM) / (blendOuterM - blendInnerM);
    return 1 - t * t * (3 - 2 * t);
  }

  function height(dx: number, dy: number, dz: number): number {
    let weight = 0;
    let lola = 0;
    if (dy > polarCos) {
      const scale = (2 * radius) / (1 + dy);
      const x = dx * scale;
      const y = -dz * scale;
      weight = lolaWeight(Math.hypot(x, y));
      if (weight > 0) {
        lola = lolaHeight(x, y);
        if (!Number.isFinite(lola)) weight = 0;
      }
    }
    if (weight >= 1) return lola;
    if (!ldem) return lola * weight;
    const latDeg = Math.asin(Math.min(1, Math.max(-1, -dy))) * DEG;
    const lonDeg = Math.atan2(dx, -dz) * DEG;
    const global = ldemHeight(latDeg, lonDeg);
    return weight > 0 ? global + (lola - global) * weight : global;
  }

  function heightAtPolar(x: number, y: number): number {
    const k = (x * x + y * y) / (4 * radius * radius);
    const scale = 1 / (radius * (1 + k));
    return height(x * scale, (1 - k) / (1 + k), -y * scale);
  }

  function source(dx: number, dy: number, dz: number): HeightSource {
    if (dy <= polarCos) return 'ldem';
    const scale = (2 * radius) / (1 + dy);
    const weight = lolaWeight(Math.hypot(dx * scale, dz * scale));
    return weight >= 1 ? 'lola' : weight > 0 ? 'blend' : 'ldem';
  }

  return {
    height,
    heightAtPolar,
    source,
    blendInnerM,
    blendOuterM,
    lolaSpacingM: polar.spacing,
    ldemSpacingM: (2 * Math.PI * radius) / W,
  };
}
