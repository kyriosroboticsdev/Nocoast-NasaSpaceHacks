import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slopeBand, slopeCell, slopeRaster, slopeSummary, slopeArea, formatSlopeArea, validateSlopeGrid, SLOPE_COLORS } from '../src/terrain/slopes.mjs';

function grid() {
  return { schemaVersion: '1.0', artifactType: 'terrain-slope-grid', modelId: 'pgda-5m-central-normal-radial-up-v1',
    frameId: 'MOON_ME_DE421', referenceRadiusM: 1737400, validationStatus: 'preliminary',
    latitudeDeg: -89, longitudeEastDeg: 222, n: 41, halfExtentM: 100, gridSpacingM: 5,
    demPixelSpacingM: 5, gradientBaselineM: 10, rowOrder: 'south-to-north', columnOrder: 'west-to-east',
    slopeDeg: Array(41 * 41).fill(null), centerSlopeDeg: null, knownFraction: 0 };
}
const site = { lat: -89, lon: 222 };
test('limits have explicit inclusive boundaries and missing never means level', () => {
  assert.equal(slopeBand(5, 10), 'lower'); assert.equal(slopeBand(10, 10), 'near');
  assert.equal(slopeBand(10.0001, 10), 'above');
  for (const v of [null, NaN, Infinity, -1, 91]) assert.equal(slopeBand(v, 10), 'unknown');
  for (const v of [0, 46, NaN]) assert.throws(() => slopeBand(5, v));
});
test('raster flips north to screen top and preserves east/west', () => {
  const g = { n: 3, slopeDeg: [1, null, 20, 1, 1, 1, 7, null, 2] };
  const rgba = slopeRaster(g, 10);
  assert.deepEqual([...rgba.slice(0, 4)], [...SLOPE_COLORS.near, 255]);
  assert.deepEqual([...rgba.slice(8, 12)], [...SLOPE_COLORS.lower, 255]);
  assert.deepEqual([...rgba.slice(32, 36)], [...SLOPE_COLORS.above, 255]);
});
test('screen inspection and keyboard coordinates follow north up', () => {
  assert.deepEqual(slopeCell(0, 0, 249), { col: 0, row: 248 });
  assert.deepEqual(slopeCell(1, 1, 249), { col: 248, row: 0 });
  assert.deepEqual(slopeCell(.5, .5, 249), { col: 124, row: 124 });
  assert.deepEqual(slopeCell(-1, 2, 249), { col: 0, row: 0 });
});
test('within-limit statistics use known samples only, with all-missing kept unknown', () => {
  assert.equal(slopeSummary(grid(), 10).withinFraction, null);
  assert.deepEqual(slopeSummary({ slopeDeg: [null, 2, 10, 20] }, 10), { known: 3, within: 2, withinFraction: 2 / 3 });
});
test('response validates site, frame, dimensions, resolution and coverage', () => {
  assert.equal(validateSlopeGrid(grid(), site).knownFraction, 0);
  for (const changes of [{ frameId: 'wrong' }, { latitudeDeg: -88 }, { rowOrder: 'north-to-south' },
    { n: 42 }, { gridSpacingM: 1 }, { knownFraction: 1 }, { gradientBaselineM: null },
    { centerSlopeDeg: 0 }, { slopeDeg: [1] }, { demPixelSpacingM: 80 }]) {
    assert.throws(() => validateSlopeGrid({ ...grid(), ...changes }, site));
  }
  for (const value of [NaN, Infinity, -1, 91]) {
    const g = grid(); g.slopeDeg[0] = value;
    assert.throws(() => validateSlopeGrid(g, site));
  }
  assert.doesNotThrow(() => validateSlopeGrid({ ...grid(), longitudeEastDeg: -138 }, site));
});
test('area partitions the exact window without overcounting node-registered edges', () => {
  const g = { n: 3, gridSpacingM: 5, halfExtentM: 5, slopeDeg: Array(9).fill(3) };
  assert.deepEqual(slopeArea(g, 10), { totalAreaM2: 100, knownAreaM2: 100, unknownAreaM2: 0,
    withinAreaM2: 100, aboveAreaM2: 0, withinPatchFraction: 1, coverageAreaFraction: 1 });
  g.slopeDeg[4] = 20; // center represents a full 25 m2 footprint
  const a = slopeArea(g, 10);
  assert.equal(a.withinAreaM2, 75); assert.equal(a.aboveAreaM2, 25);
  g.slopeDeg[0] = null; // corner represents only 6.25 m2 inside the window
  const b = slopeArea(g, 10);
  assert.equal(b.unknownAreaM2, 6.25); assert.equal(b.withinAreaM2, 68.75);
  assert.equal(b.withinAreaM2 + b.aboveAreaM2 + b.unknownAreaM2, 100);
});
test('unknown coverage never becomes safe area or a misleading zero', () => {
  const g = grid(); const a = slopeArea(g, 10);
  assert.equal(a.totalAreaM2, 40000); assert.equal(a.unknownAreaM2, 40000);
  assert.equal(a.withinAreaM2, null); assert.equal(a.withinPatchFraction, null);
  g.slopeDeg[840] = 30;
  assert.equal(slopeArea(g, 10).withinAreaM2, 0); // known steep terrain, unlike all-unknown
  g.slopeDeg[840] = 10;
  assert.equal(slopeArea(g, 10).withinAreaM2, 25); // inclusive limit, unchanged denominator
  assert.equal(slopeArea(g, 10).withinPatchFraction, 25 / 40000);
  assert.throws(() => slopeArea({ ...g, gridSpacingM: 10 }, 10));
});
test('area formatting retains units and distinguishes unknown from zero', () => {
  assert.equal(formatSlopeArea(null), 'Unknown'); assert.equal(formatSlopeArea(0), '0 m²');
  assert.equal(formatSlopeArea(25), '25 m²'); assert.equal(formatSlopeArea(1e6), '1.000 km²');
});

test('coarse slope estimates retain their native resolution and reject false 5 m labels', () => {
  const g = { ...grid(), modelId: 'lola-dem-central-normal-radial-up-v1', n: 15, halfExtentM: 620,
    gridSpacingM: 1240 / 14, gradientBaselineM: 2480 / 14, demPixelSpacingM: 80,
    slopeDeg: Array(225).fill(null), centerSlopeDeg: null, knownFraction: 0 };
  assert.equal(validateSlopeGrid(g, site).demPixelSpacingM, 80);
  assert.throws(() => validateSlopeGrid({ ...g, modelId: 'pgda-5m-central-normal-radial-up-v1' }, site));
  assert.throws(() => validateSlopeGrid({ ...g, demPixelSpacingM: 240 }, site));
});
