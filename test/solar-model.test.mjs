import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculatePower, simulate, validateScenario, validatePanel, utcMilliseconds,
  sunDirectionEnu, panelNormalEnu, solarIrradianceWm2, resultCsv, SITES } from '../src/power/model.mjs';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const panel = changes => ({ areaM2: 1, efficiency: 0.3, tiltDeg: 0, azimuthDeg: 0, referenceIrradianceWm2: 1361, ...changes });
const sample = changes => ({ timeUtc: '2027-01-01T00:00:00Z', sun: { azimuthDeg: 0, elevationDeg: 90, rangeAu: 1 },
  solarVisibleFraction: 1, quality: { status: 'valid', reason: null }, ...changes });
const baseline = JSON.parse(await readFile(new URL('./fixtures/analytic-sweep.json', import.meta.url), 'utf8'));
function scenario(count = 7) {
  const input = structuredClone(baseline);
  input.samples = Array.from({ length: count }, (_, i) => sample({ timeUtc: new Date(Date.parse(input.time.startUtc) + i * 600000).toISOString().replace('.000Z', 'Z') }));
  input.time.endUtc = input.samples.at(-1).timeUtc;
  return input;
}
function missingAt(input, index) {
  input.samples[index].solarVisibleFraction = null;
  input.samples[index].quality = { status: 'missing', reason: 'upstream_visibility_missing' };
}

test('reference irradiance and inverse-square law', () => {
  close(solarIrradianceWm2(1), 1361); close(solarIrradianceWm2(2), 340.25);
  close(solarIrradianceWm2(0.5), 5444);
  assert.throws(() => solarIrradianceWm2(0));
  assert.throws(() => solarIrradianceWm2(Number.MIN_VALUE));
});
test('face-on 1 m2 / 30 percent gives 408.3 W', () => close(calculatePower(sample(), panel()).powerW, 408.3));
test('60-degree incidence halves power', () => close(calculatePower(sample({ sun: { azimuthDeg: 0, elevationDeg: 30, rangeAu: 1 } }), panel()).powerW, 204.15));
test('horizontal low-Sun panel uses sine of elevation, not elevation itself', () => {
  const result = calculatePower(sample({ sun: { azimuthDeg: 210, elevationDeg: 5, rangeAu: 1 } }), panel());
  close(result.powerW, 408.3 * Math.sin(5 * Math.PI / 180));
});
test('zero front projection and back-face illumination cannot generate negative or phantom power', () => {
  close(calculatePower(sample({ sun: { azimuthDeg: 0, elevationDeg: 0, rangeAu: 1 } }), panel()).powerW, 0);
  close(calculatePower(sample(), panel({ tiltDeg: 180 })).powerW, 0);
});
test('fully blocked, fractional exposure, and zero efficiency/area behave independently', () => {
  close(calculatePower(sample({ solarVisibleFraction: 0 }), panel()).powerW, 0);
  close(calculatePower(sample({ solarVisibleFraction: 0.5 }), panel()).powerW, 204.15);
  close(calculatePower(sample(), panel({ areaM2: 0 })).powerW, 0);
  close(calculatePower(sample(), panel({ efficiency: 0 })).powerW, 0);
});
test('power scales with active area and efficiency exactly once', () => {
  close(calculatePower(sample(), panel({ areaM2: 10 })).powerW, 4083);
  close(calculatePower(sample(), panel({ efficiency: 0.6 })).powerW, 816.6);
});
test('panel facing east and west distinguish front and back', () => {
  const east = sample({ sun: { azimuthDeg: 90, elevationDeg: 0, rangeAu: 1 } });
  close(calculatePower(east, panel({ tiltDeg: 90, azimuthDeg: 90 })).powerW, 408.3);
  close(calculatePower(east, panel({ tiltDeg: 90, azimuthDeg: 270 })).powerW, 0);
});
test('trust upstream visibility below local horizontal; do not invent a zero-degree terrain horizon', () => {
  const result = calculatePower(sample({ sun: { azimuthDeg: 0, elevationDeg: -1, rangeAu: 1 } }), panel({ tiltDeg: 91 }));
  close(result.powerW, 408.3);
});
test('ENU compass and zenith agree with team axes', () => {
  for (const [az, vector] of [[0, [0, 1, 0]], [90, [1, 0, 0]], [180, [0, -1, 0]], [270, [-1, 0, 0]]]) {
    sunDirectionEnu(az, 0).forEach((v, i) => close(v, vector[i]));
  }
  sunDirectionEnu(30, 90).forEach((v, i) => close(v, [0, 0, 1][i]));
  panelNormalEnu(0, 245).forEach((v, i) => close(v, [0, 0, 1][i]));
});
test('independent scalar incidence equation agrees with ENU dot product over a grid', () => {
  for (const el of [-10, 0, 5, 30, 80, 90]) for (const az of [0, 20, 90, 179, 270, 359.9]) {
    for (const tilt of [0, 30, 85, 90, 180]) for (const bearing of [0, 123, 300]) {
      const d = Math.PI / 180;
      const projection = Math.sin(el*d)*Math.cos(tilt*d) + Math.cos(el*d)*Math.sin(tilt*d)*Math.cos((az-bearing)*d);
      const output = calculatePower(sample({ sun: { azimuthDeg: az, elevationDeg: el, rangeAu: 1 } }), panel({ tiltDeg: tilt, azimuthDeg: bearing }));
      close(output.powerW, 408.3 * Math.max(0, projection));
      assert.ok(output.powerW >= 0 && output.powerW <= 408.3 + 1e-10);
    }
  }
});
test('unknown visibility remains null, including zero-area/blocked-like situations', () => {
  const unknown = sample({ solarVisibleFraction: null, quality: { status: 'missing', reason: 'horizon_missing' } });
  assert.equal(calculatePower(unknown, panel()).powerW, null);
  assert.equal(calculatePower(unknown, panel({ areaM2: 0 })).powerW, null);
});
test('invalid types, units, ranges, and undocumented nulls are rejected', () => {
  for (const changes of [{ areaM2: -1 }, { efficiency: 30 }, { tiltDeg: 181 }, { referenceIrradianceWm2: NaN }, { areaM2: '10' }]) assert.throws(() => validatePanel(panel(changes)));
  assert.throws(() => calculatePower(sample({ solarVisibleFraction: 1.01 }), panel()));
  assert.throws(() => calculatePower(sample({ solarVisibleFraction: null }), panel()));
  assert.throws(() => calculatePower(sample({ sun: { azimuthDeg: 360, elevationDeg: 5, rangeAu: 1 } }), panel()));
  assert.throws(() => calculatePower(sample({ sun: { azimuthDeg: 0, elevationDeg: 0 } }), panel()));
});
test('UTC parsing rejects invalid calendar dates, offsets, local dates, and leap-second ambiguity', () => {
  for (const date of ['2027-02-30T00:00:00Z', '2027-01-01T00:00:00-06:00', '2027-01-01T00:00:00', '2027-01-01', '2027-01-01T00:00:60Z']) assert.throws(() => utcMilliseconds(date));
});
test('one hour at 408.3 W integrates to 408.3 Wh, not watt-seconds', () => {
  const output = simulate(scenario(), panel());
  close(output.summary.totalEnergyWh, 408.3); close(output.summary.meanPowerW, 408.3);
  assert.equal(output.summary.coverageFraction, 1); assert.equal(output.summary.unknownSeconds, 0);
});
test('visibility transition is held on [start,end), not smeared with trapezoidal sample power', () => {
  const input = scenario(3); input.samples[1].solarVisibleFraction = 0; input.samples[2].solarVisibleFraction = 0;
  const output = simulate(input, panel());
  close(output.summary.totalEnergyWh, 408.3 / 6);
  close(output.intervals[0].energyWh, 408.3 / 6); close(output.intervals[1].energyWh, 0);
});
test('a terminal visibility change contributes no extra duration', () => {
  const input = scenario(2); input.samples[1].solarVisibleFraction = 0;
  close(simulate(input, panel()).summary.totalEnergyWh, 408.3 / 6);
});
test('an end-boundary-only illumination does not count as a mission sampled peak', () => {
  const input = scenario(2); input.samples[0].solarVisibleFraction = 0;
  const output = simulate(input, panel());
  assert.equal(output.summary.totalEnergyWh, 0);
  assert.equal(output.summary.sampledPeakPowerW, 0);
});
test('known energy uses elapsed time for irregular refined samples', () => {
  const input = scenario(3);
  input.samples[1].timeUtc = '2027-01-01T00:01:00Z';
  input.samples[2].timeUtc = '2027-01-01T00:10:00Z'; input.time.endUtc = input.samples[2].timeUtc;
  close(simulate(input, panel()).summary.totalEnergyWh, 408.3 / 6);
});
test('missing data yields a subtotal and unknown total/mean; intervals touching it are unknown', () => {
  const input = scenario(5); missingAt(input, 2);
  const output = simulate(input, panel());
  assert.equal(output.summary.totalEnergyWh, null); assert.equal(output.summary.meanPowerW, null);
  close(output.summary.knownEnergyWh, 408.3 / 3); close(output.summary.coverageFraction, 0.5);
  assert.equal(output.summary.unknownSeconds, 1200);
  assert.equal(output.intervals[1].energyWh, null); assert.equal(output.intervals[2].energyWh, null);
});
test('large timestamp gaps are unknown even when endpoints are valid', () => {
  const input = scenario(3); input.samples.splice(1, 1);
  const output = simulate(input, panel());
  assert.equal(output.summary.totalEnergyWh, null); assert.equal(output.summary.knownEnergyWh, 0);
  assert.equal(output.intervals[0].quality.reason, 'ephemeris_gap');
});
test('unknown solar range is not silently replaced with 1 AU', () => {
  const input = scenario(2); input.samples[0].sun.rangeAu = null;
  input.samples[0].quality = { status: 'missing', reason: 'ephemeris_missing' };
  assert.equal(simulate(input, panel()).samples[0].powerW, null);
});
test('source site, observer, frame, dates, and boundary samples are validated', () => {
  const mutations = [s => s.frameId = 'IAU_MOON', s => s.site.longitudeEastDeg = -137.3808,
    s => s.observerHeightAboveGroundM = 0, s => s.siteId = '', s => s.samples.pop(),
    s => s.samples.reverse(), s => s.time.startUtc = '2026-12-31T00:00:00Z',
    s => s.samples[1].timeUtc = s.samples[0].timeUtc, s => s.time.visibilityInterpolation = 'linear'];
  for (const mutate of mutations) { const input = scenario(); mutate(input); assert.throws(() => validateScenario(input)); }
});
test('mission length limit and next-year end boundary are explicit', () => {
  const input = scenario(2); input.time.startUtc = input.samples[0].timeUtc = '2027-12-31T23:50:00Z';
  input.time.endUtc = input.samples[1].timeUtc = '2028-01-01T00:00:00Z'; validateScenario(input);
  input.time.endUtc = input.samples[1].timeUtc = '2028-01-01T00:10:00Z'; assert.throws(() => validateScenario(input));
  const long = scenario(2); long.time.endUtc = long.samples[1].timeUtc = '2027-03-03T00:00:00Z'; assert.throws(() => validateScenario(long));
});
test('binary visibility rejects fractions unless the source declares a fractional model', () => {
  const input = scenario(2); input.provenance.visibility.sunModel = 'center-binary-v1'; input.samples[0].solarVisibleFraction = 0.5;
  assert.throws(() => validateScenario(input));
  input.provenance.visibility.sunModel = 'disk-fraction-v1'; validateScenario(input);
});
test('a test-only disk fraction cannot be relabeled as production terrain', () => {
  const input = scenario(); input.provenance.visibility.mode = 'terrain';
  input.provenance.visibility.horizonArtifactId = 'some-horizon';
  input.provenance.visibility.horizonObserverHeightAboveGroundM = 2;
  assert.throws(() => validateScenario(input), /restricted to synthetic/);
});
test('terrain comparisons require complete data and a matching upstream horizon height', () => {
  const input = scenario(); assert.equal(simulate(input, panel()).summary.eligibleForTerrainComparison, false);
  input.provenance.visibility.mode = 'terrain'; assert.throws(() => validateScenario(input));
  input.provenance.visibility.sunModel = 'center-binary-v1';
  input.provenance.visibility.horizonArtifactId = 'example-upstream-horizon';
  input.provenance.visibility.horizonObserverHeightAboveGroundM = 2;
  assert.equal(simulate(input, panel()).summary.eligibleForTerrainComparison, true);
  missingAt(input, 2); assert.equal(simulate(input, panel()).summary.eligibleForTerrainComparison, false);
});
test('inputs are not mutated and source/panel metadata survives export', () => {
  const input = scenario(); const copy = structuredClone(input); const config = panel();
  const result = simulate(input, config); assert.deepEqual(input, copy);
  assert.deepEqual(result.panel, config); assert.deepEqual(result.provenance, input.provenance);
  assert.equal(result.units.vectors, 'ENU'); assert.equal(result.observerHeightAboveGroundM, 2);
  assert.notEqual(result.artifactId, simulate(input, panel({ tiltDeg: 30 })).artifactId);
});
test('CSV preserves UTC, numeric units in headers, and missing values as empty fields', () => {
  const input = scenario(3); missingAt(input, 1); const csv = resultCsv(simulate(input, panel()));
  assert.ok(csv.includes('normalIrradianceWm2')); assert.ok(csv.includes('2027-01-01T00:10:00Z'));
  assert.ok(csv.includes('"missing","upstream_visibility_missing"')); assert.ok(!csv.includes('NaN'));
});
