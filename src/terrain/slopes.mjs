/** Pure slope-map validation and display helpers. No visibility or power calculations. */
export const SLOPE_COLORS = {
  lower: [45, 174, 157], near: [237, 192, 88], above: [232, 102, 104], unknown: [100, 110, 130],
};
export function validSlopeLimit(value) { return Number.isFinite(value) && value >= 1 && value <= 45; }
export function slopeBand(value, limit) {
  if (!validSlopeLimit(limit)) throw new Error('Use a slope limit between 1° and 45°.');
  if (value == null || !Number.isFinite(value) || value < 0 || value > 90) return 'unknown';
  return value <= limit / 2 ? 'lower' : value <= limit ? 'near' : 'above';
}
export function validateSlopeGrid(data, site) {
  if (!data || data.artifactType !== 'terrain-slope-grid' || data.schemaVersion !== '1.0'
    || data.modelId !== 'pgda-5m-central-normal-radial-up-v1' || data.frameId !== 'MOON_ME_DE421'
    || data.referenceRadiusM !== 1737400 || data.rowOrder !== 'south-to-north' || data.columnOrder !== 'west-to-east'
    || data.validationStatus !== 'preliminary') throw new Error('Unsupported slope data or coordinate frame.');
  const { n, halfExtentM, gridSpacingM, slopeDeg } = data;
  if (!Number.isInteger(n) || n < 17 || n > 401 || n % 2 !== 1 || !Number.isFinite(halfExtentM)
    || halfExtentM < 100 || halfExtentM > 2000 || !Number.isFinite(gridSpacingM) || gridSpacingM < 5
    || Math.abs(gridSpacingM - 2 * halfExtentM / (n - 1)) > 1e-9
    || data.demPixelSpacingM !== 5 || Math.abs(data.gradientBaselineM - 2 * gridSpacingM) > 1e-9
    || !Number.isFinite(data.gradientBaselineM) || !Array.isArray(slopeDeg) || slopeDeg.length !== n * n
    || slopeDeg.some(v => v !== null && (!Number.isFinite(v) || v < 0 || v > 90))) {
    throw new Error('Invalid slope grid or sample spacing.');
  }
  if (!Number.isFinite(data.latitudeDeg) || !Number.isFinite(data.longitudeEastDeg)
    || Math.abs(data.latitudeDeg - site.lat) > 1e-6
    || Math.abs((((data.longitudeEastDeg - site.lon) % 360) + 540) % 360 - 180) > 1e-6) {
    throw new Error('Slope data does not match the selected site.');
  }
  const known = slopeDeg.filter(v => v !== null).length;
  if (!Number.isFinite(data.knownFraction) || Math.abs(data.knownFraction - known / (n * n)) > 1e-9
    || data.centerSlopeDeg !== slopeDeg[(n * n - 1) / 2]) throw new Error('Inconsistent slope coverage.');
  return data;
}
export function slopeSummary(grid, limit) {
  if (!validSlopeLimit(limit)) throw new Error('Invalid slope limit.');
  const known = grid.slopeDeg.filter(v => v !== null);
  return { known: known.length, within: known.filter(v => v <= limit).length,
    withinFraction: known.length ? known.filter(v => v <= limit).length / known.length : null };
}
/** Approximate planimetric area over the fixed local map window, in square metres.
 * Samples are nodes, not cells: boundary footprints have half width (corners quarter).
 * This prevents counting an extra row/column outside the requested extent.
 */
export function slopeArea(grid, limit) {
  if (!validSlopeLimit(limit)) throw new Error('Invalid slope limit.');
  const { n, gridSpacingM, halfExtentM, slopeDeg } = grid;
  if (!Number.isInteger(n) || n < 2 || !Number.isFinite(gridSpacingM) || gridSpacingM <= 0
    || !Number.isFinite(halfExtentM) || halfExtentM <= 0
    || Math.abs(gridSpacingM * (n - 1) - 2 * halfExtentM) > 1e-8 || slopeDeg.length !== n * n) {
    throw new Error('Invalid area grid.');
  }
  let knownAreaM2 = 0, within = 0;
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    const value = slopeDeg[row * n + col];
    if (value == null) continue;
    if (!Number.isFinite(value) || value < 0 || value > 90) throw new Error('Invalid slope value.');
    const area = gridSpacingM ** 2 * (row === 0 || row === n - 1 ? .5 : 1) * (col === 0 || col === n - 1 ? .5 : 1);
    knownAreaM2 += area;
    if (value <= limit) within += area;
  }
  const totalAreaM2 = (2 * halfExtentM) ** 2;
  return { totalAreaM2, knownAreaM2, unknownAreaM2: Math.max(0, totalAreaM2 - knownAreaM2),
    withinAreaM2: knownAreaM2 ? within : null, aboveAreaM2: knownAreaM2 ? knownAreaM2 - within : null,
    withinPatchFraction: knownAreaM2 ? within / totalAreaM2 : null, coverageAreaFraction: knownAreaM2 / totalAreaM2 };
}
export function formatSlopeArea(areaM2) {
  return areaM2 == null ? 'Unknown' : areaM2 === 0 ? '0 m²'
    : areaM2 < 1000 ? `${areaM2.toLocaleString('en-US', { maximumFractionDigits: 1 })} m²`
      : `${(areaM2 / 1e6).toLocaleString('en-US', { maximumFractionDigits: 3, minimumFractionDigits: 3 })} km²`;
}
export function slopeRaster(grid, limit) {
  const rgba = new Uint8ClampedArray(grid.n * grid.n * 4);
  for (let y = 0; y < grid.n; y++) for (let x = 0; x < grid.n; x++) {
    // API rows increase northward; screen rows increase downward.
    const value = grid.slopeDeg[(grid.n - 1 - y) * grid.n + x];
    rgba.set([...SLOPE_COLORS[slopeBand(value, limit)], 255], 4 * (y * grid.n + x));
  }
  return rgba;
}
export function slopeCell(fx, fy, n) {
  return { col: Math.round(Math.max(0, Math.min(1, fx)) * (n - 1)),
    row: Math.round((1 - Math.max(0, Math.min(1, fy))) * (n - 1)) };
}
