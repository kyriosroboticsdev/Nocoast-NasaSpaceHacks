import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessInstant, assessMission } from '../.cache/solar-tests/assess/windows.js';
import { rankAssessments, buildDateSuggestions } from '../.cache/solar-tests/assess/decision.js';
import { adaptSolarSample, buildSolarInput, canonicalUtc, panelFromThresholds } from '../.cache/solar-tests/power/adapter.js';
import { interpolateSeries } from '../.cache/solar-tests/ephemeris/horizons.js';
import { sphereHorizon } from '../.cache/solar-tests/horizon/types.js';
import { DEFAULT_THRESHOLDS, createDefaultScenario } from '../.cache/solar-tests/scenario/types.js';
import { getScenario, setScenario, scenarioToSearchParams, applyUrlParams } from '../.cache/solar-tests/scenario/state.js';
import { fmtPower, fmtEnergy, fmtAvailability, fmtDuration } from '../.cache/solar-tests/ui/format.js';
import { rankSearchCandidates } from '../.cache/solar-tests/assess/search.js';
import { simulate } from '../src/power/model.mjs';

const SITE = 'connecting-ridge-cr1';
const START = '2027-01-01T00:00:00Z';
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function fixture({ elevation = 90, azimuth = 0, horizonElevation = 0, hours = 2 } = {}) {
  // Synthetic fixtures exercise the JPL wire contract; these are not ephemerides.
  const horizon = sphereHorizon(SITE, -89.4555, 222.6192, 1949.6080773175818, 2);
  horizon.model = 'lola_terrain';
  horizon.bins.forEach(b => { b.elevationDeg = horizonElevation; b.status = 'ok'; });
  const sun = {
    schemaVersion: '1.1', body: 'sun', siteId: SITE, frameId: 'MOON_ME_DE421',
    observerHeightAboveGroundM: 2,
    observer: { latitudeDeg: -89.4555, longitudeEastDeg: 222.6192, altitudeKm: 1.9516080773175818 },
    stepHours: 1 / 6, source: 'jpl_horizons', origin: 'jpl_horizons',
    generatedAtUtc: START, notes: ['Synthetic protocol test fixture'],
    samples: Array.from({ length: hours * 6 + 1 }, (_, i) => ({
      utc: new Date(Date.parse(START) + i * 600000).toISOString(), azimuthDeg: azimuth, elevationDeg: elevation, rangeAu: 1,
    })),
  };
  const provider = { series: { sun }, sourceLabel: 'synthetic protocol fixture',
    get: (body, utc) => body === 'sun' ? interpolateSeries(sun, utc) : { utc, azimuthDeg: 0, elevationDeg: 30 } };
  const thresholds = { ...DEFAULT_THRESHOLDS, panelAreaM2: 1, panelEfficiency: 0.3 };
  return { siteId: SITE, siteLabel: 'CR1', horizonModel: horizon.model, provider, horizon, startUtc: START,
    durationHours: hours, scrubUtc: START, thresholds };
}

test('integration uses true solar elevation, not clearance, for panel incidence', () => {
  const f = fixture({ elevation: 30, horizonElevation: 20 });
  const instant = assessInstant(START, f.provider, f.horizon, f.thresholds);
  assert.equal(instant.sunClearEl, 10);
  close(instant.powerW, 204.15);
});

test('blocked high-tilt panel produces zero; upstream false is consumed unchanged', () => {
  const f = fixture({ elevation: 10, horizonElevation: 20 });
  f.thresholds.panelTiltDeg = 80;
  assert.equal(assessInstant(START, f.provider, f.horizon, f.thresholds).powerW, 0);
  f.horizon.bins.forEach(b => { b.elevationDeg = 0; });
  assert.equal(adaptSolarSample(START, false, f.provider, f.horizon).solarVisibleFraction, 0);
});

test('panel bearing distinguishes front and back in the shared assessment', () => {
  const f = fixture({ elevation: 10, azimuth: 90 });
  f.thresholds.panelTiltDeg = 80;
  f.thresholds.panelAzimuthDeg = 90;
  close(assessInstant(START, f.provider, f.horizon, f.thresholds).powerW, 408.3);
  f.thresholds.panelAzimuthDeg = 270;
  assert.equal(assessInstant(START, f.provider, f.horizon, f.thresholds).powerW, 0);
});

test('mission has exact endpoints, 600-second cadence and duration-weighted Wh', () => {
  const f = fixture(); f.durationHours = 1.5;
  const a = assessMission(f);
  assert.equal(a.samples.length, 10);
  assert.equal(a.samples.at(-1).utc, '2027-01-01T01:30:00.000Z');
  assert.equal(a.solar.summary.durationSeconds, 5400);
  close(a.solar.summary.totalEnergyWh, 612.45);
  close(a.meanPowerW, 408.3);
  assert.equal(a.solar.summary.coverageFraction, 1);
});

test('non-grid final mission boundary adds no extra duration', () => {
  const f = fixture(); f.durationHours = 1.25;
  const a = assessMission(f);
  assert.equal(a.samples.at(-1).utc, '2027-01-01T01:15:00.000Z');
  close(a.solar.summary.totalEnergyWh, 408.3 * 1.25);
});

test('missing range is unknown, never 1 AU or zero watts', () => {
  const f = fixture(); f.provider.series.sun.samples.forEach(s => { delete s.rangeAu; });
  const a = assessMission(f);
  assert.equal(a.samples[0].powerW, null);
  assert.equal(a.meanPowerW, null);
  assert.equal(a.solar.summary.totalEnergyWh, null);
  assert.equal(a.solar.summary.coverageFraction, 0);
  assert.equal(a.viability, 'UNKNOWN');
});

test('partial range coverage preserves subtotal and null total/mean', () => {
  const f = fixture(); delete f.provider.series.sun.samples.at(-1).rangeAu;
  const a = assessMission(f);
  assert.equal(a.meanPowerW, null);
  assert.equal(a.solar.summary.totalEnergyWh, null);
  close(a.solar.summary.knownEnergyWh, 408.3 * 11 / 6);
  close(a.solar.summary.coverageFraction, 11 / 12);
});

test('missing terrain is unknown even for a potentially blocked panel', () => {
  const f = fixture(); f.horizon.bins.forEach(b => { b.status = 'gap'; b.elevationDeg = null; });
  const a = assessMission(f);
  assert.equal(a.samples[0].solar.quality.reason, 'terrain_visibility_missing');
  assert.equal(a.solar.summary.knownEnergyWh, 0);
  assert.equal(a.solar.summary.totalEnergyWh, null);
});

test('provider and adapter reject requests outside real source coverage', () => {
  const f = fixture();
  assert.equal(f.provider.get('sun', '2027-01-02T00:00:00Z'), null);
  assert.equal(adaptSolarSample('2027-01-02T00:00:00Z', true, f.provider, f.horizon).quality.reason, 'sun_outside_coverage');
});

test('adapter does not interpolate through ephemeris gaps over 600 seconds', () => {
  const f = fixture(); f.provider.series.sun.samples.splice(1, 1);
  assert.equal(adaptSolarSample('2027-01-01T00:10:00Z', true, f.provider, f.horizon).quality.reason, 'sun_ephemeris_gap');
});

test('adapter rejects mismatched frame, observer, site and nonfinite coordinates', () => {
  for (const change of [
    f => { f.horizon.frameId = 'IAU_MOON'; },
    f => { f.horizon.observer.heightAboveGroundM = 0; },
    f => { f.horizon.observer.latitudeDeg = NaN; },
    f => { f.provider.series.sun.observer.altitudeKm = 0.002; },
    f => { f.provider.series.sun.siteId = 'shackleton-rim-sr1'; },
    f => { f.provider.series.sun.observer.longitudeEastDeg = NaN; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(adaptSolarSample(START, true, f.provider, f.horizon).quality.status, 'missing');
  }
});

test('analytic, legacy and duplicate-timestamp series cannot masquerade as solar input', () => {
  for (const change of [
    f => { f.provider.series.sun.source = 'analytic_fallback'; },
    f => { delete f.provider.series.sun.frameId; },
    f => { f.provider.series.sun.samples[1].utc = START; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(adaptSolarSample(START, true, f.provider, f.horizon).quality.status, 'missing');
  }
});

test('bundled source must preserve verified JPL origin metadata', () => {
  const f = fixture(); f.provider.series.sun.source = 'bundled';
  assert.equal(adaptSolarSample(START, true, f.provider, f.horizon).quality.status, 'valid');
  delete f.provider.series.sun.origin;
  assert.equal(adaptSolarSample(START, true, f.provider, f.horizon).quality.status, 'missing');
});

test('UTC normalization is lossless and rejects fractional seconds and impossible dates', () => {
  assert.equal(canonicalUtc('2027-01-01T00:00:00.000Z'), START);
  for (const utc of ['2027-01-01T00:00:00.123Z', '2027-02-30T00:00:00Z', '2027-01-01T00:00:00+00:00']) assert.throws(() => canonicalUtc(utc));
});

test('azimuth wrapping and range interpolation agree between provider and adapter', () => {
  const f = fixture();
  f.provider.series.sun.samples[0].azimuthDeg = 359;
  f.provider.series.sun.samples[1].azimuthDeg = 1;
  f.provider.series.sun.samples[1].rangeAu = 1.02;
  const utc = '2027-01-01T00:05:00Z';
  const s = adaptSolarSample(utc, true, f.provider, f.horizon);
  close(s.sun.azimuthDeg, 0); close(s.sun.rangeAu, 1.01);
  assert.deepEqual(f.provider.get('sun', utc), { utc, ...s.sun });
});

test('preliminary horizons display power but cannot enter mission rankings', () => {
  const f = fixture(); const a = assessMission(f);
  assert.ok(a.meanPowerW > 0); assert.equal(a.viability, 'UNKNOWN');
  assert.equal(a.solar.summary.eligibleForTerrainComparison, false);
  assert.equal(rankAssessments([{ siteId: SITE, label: 'CR1', publishedLabel: 'CR1', assessment: a }]).length, 0);
  assert.deepEqual(buildDateSuggestions(a, [{ offsetDays: 1, startUtc: START, assessment: a }]), []);
  f.horizon.validation = { status: 'validated', algorithmVersion: 'unit-test-only' };
  const validated = assessMission(f);
  assert.equal(validated.solar.summary.eligibleForTerrainComparison, true);
  assert.equal(rankAssessments([{ siteId: SITE, label: 'CR1', publishedLabel: 'CR1', assessment: validated }]).length, 1);
});

test('unsupported sites/dates retain unknown solar and invalid duration is rejected', () => {
  const f = fixture(); f.siteId = 'custom';
  assert.equal(assessMission(f).solar, null);
  const outside = fixture(); outside.startUtc = '2026-12-31T00:00:00Z';
  assert.equal(assessMission(outside).solar, null);
  for (const hours of [0, -1, 1441, NaN, Infinity]) assert.throws(() => assessMission({ ...fixture(), durationHours: hours }));
});

test('adapter output replays through the unchanged standalone kernel and JSON', () => {
  const f = fixture(); const a = assessMission(f);
  const input = buildSolarInput({ ...f, endUtc: a.samples.at(-1).utc, samples: a.samples });
  const restored = JSON.parse(JSON.stringify(input));
  const output = simulate(restored, panelFromThresholds(f.thresholds));
  close(output.summary.totalEnergyWh, a.solar.summary.totalEnergyWh);
  assert.equal(output.time.visibilityInterpolation, 'previous-sample-hold');
  assert.equal(output.units.energy, 'Wh'); assert.equal(output.units.vectors, 'ENU');
  assert.match(input.provenance.visibility.timing, /sampled/);
});

test('panel configuration survives URL sharing, including zero area/efficiency', () => {
  const scenario = createDefaultScenario();
  Object.assign(scenario.thresholds, { panelAreaM2: 0, panelEfficiency: 0, panelTiltDeg: 90, panelAzimuthDeg: 123,
    minEarthElevationDeg: 7, batteryFloorW: 55 });
  const query = scenarioToSearchParams(scenario);
  setScenario(createDefaultScenario()); applyUrlParams(query);
  assert.deepEqual(getScenario().thresholds, scenario.thresholds);
  const before = { ...getScenario().thresholds };
  applyUrlParams('?panelAreaM2=-1&panelEfficiency=2&panelTiltDeg=NaN&panelAzimuthDeg=360');
  assert.deepEqual(getScenario().thresholds, before);
});

test('unknown values cannot render as zero power/energy', () => {
  assert.equal(fmtPower(null), 'Unknown'); assert.equal(fmtEnergy(null), 'Unknown');
  assert.equal(fmtPower(0), '0 mW'); assert.equal(fmtEnergy(0), '0.0 Wh');
});

test('new regional-search handoff excludes analytic candidates with an explicit limitation', async () => {
  const catalog = { schemaVersion: '1', artifactId: 'unit-test', region: { label: 'test', minLatitudeDeg: -90, gridSpacingM: 1 },
    method: { dem: 'synthetic', nearField5m: false, azimuthSpacingDeg: 90, honesty: 'Synthetic protocol test.' },
    candidateCount: 1, candidates: [{ id: 'search-test', latitudeDeg: -89.5, longitudeEastDeg: 222,
      surfaceElevationM: 1000, elevBins: [0, 0, 0, 0] }] };
  const result = await rankSearchCandidates({ catalog, state: createDefaultScenario(), region: { kind: 'cap' }, topN: 3 });
  assert.equal(result.assessed, 1);
  assert.deepEqual(result.hits, []);
  assert.match(result.limitations, /No solar-qualified candidates/);
});

test('bundled Sun data matches fixed sites, 2m observers and complete 10-minute January-February coverage', async () => {
  const defaults = JSON.parse(await readFile(new URL('../docs/solar/TEAM_DEFAULTS.json', import.meta.url), 'utf8'));
  for (const site of defaults.sites) {
    const series = JSON.parse(await readFile(new URL(`../public/science/ephemeris/${site.siteId}-sun.json`, import.meta.url), 'utf8'));
    assert.equal(series.frameId, defaults.frameId); assert.equal(series.source, 'jpl_horizons');
    assert.equal(series.observerHeightAboveGroundM, 2);
    close(series.observer.altitudeKm, (site.surfaceElevationM + 2) / 1000);
    assert.equal(series.samples.length, 8497);
    assert.equal(series.samples[0].utc, START); assert.equal(series.samples.at(-1).utc, '2027-03-01T00:00:00Z');
    series.samples.forEach((s, i) => {
      assert.equal(Date.parse(s.utc), Date.parse(START) + i * 600000);
      assert.ok(s.rangeAu > 0.97 && s.rangeAu < 1.03);
    });
    assert.equal(series.request.RANGE_UNITS, "'AU'"); assert.equal(series.request.QUANTITIES, "'4,20'");
    assert.equal(series.request.APPARENT, "'AIRLESS'");
  }
});

test('missing Earth ephemeris does not turn valid solar input into zero or unknown power', () => {
  const f = fixture();
  const get = f.provider.get;
  f.provider.get = (body, utc) => body === 'earth' ? null : get(body, utc);
  const a = assessMission(f);
  assert.equal(a.samples[0].earthLos, null);
  assert.equal(a.samples[0].unknown, true);
  close(a.samples[0].powerW, 408.3);
  close(a.meanPowerW, 408.3);
  close(a.solar.summary.totalEnergyWh, 816.6);
  assert.equal(a.unknownHours, 2);
});

test('missing Sun coverage retains Earth LOS and unknown solar instead of fabricated zero', () => {
  const f = fixture();
  const get = f.provider.get;
  f.provider.get = (body, utc) => body === 'sun' ? null : get(body, utc);
  const a = assessMission(f);
  assert.equal(a.samples[0].sunlit, null);
  assert.equal(a.samples[0].earthLos, true);
  assert.equal(a.samples[0].powerW, null);
  assert.equal(a.solar.summary.totalEnergyWh, null);
});

test('URL sharing preserves new upstream Site B coordinates and scrub settings with panel orientation', () => {
  const scenario = createDefaultScenario();
  scenario.secondary = { id: 'B', siteId: 'custom', customLatDeg: -89.2, customLonEastDeg: 47 };
  scenario.scrubUtc = '2027-01-16T01:00:00.000Z';
  scenario.thresholds.panelTiltDeg = 120;
  scenario.thresholds.panelAzimuthDeg = 270;
  setScenario(createDefaultScenario());
  applyUrlParams(scenarioToSearchParams(scenario));
  assert.deepEqual(getScenario().secondary, scenario.secondary);
  assert.equal(getScenario().scrubUtc, scenario.scrubUtc);
  assert.equal(getScenario().thresholds.panelTiltDeg, 120);
  assert.equal(getScenario().thresholds.panelAzimuthDeg, 270);
});

test('stored energy can satisfy mission power requirements even when mean generation is below the load', () => {
  const f = fixture(); f.thresholds.batteryFloorW = 500;
  f.horizon.validation = { status: 'validated', algorithmVersion: 'synthetic-unit-test-only' };
  f.missionSettings = { battery: { capacityWh: 1000, initialSocFraction: 1, reserveSocFraction: 0,
    chargeEfficiency: 1, dischargeEfficiency: 1, maxChargeW: 1000, maxDischargeW: 1000 },
    requirements: { minPowerAvailabilityFraction: 1, minCommsAvailabilityFraction: 0.5, maxCommsBlackoutHours: 24 } };
  const a = assessMission(f);
  assert.ok(a.meanPowerW < 500); close(a.mission.summary.unservedEnergyWh, 0);
  assert.equal(a.viability, 'GO'); close(a.mission.viability.score, 100);
});

test('mission communication consumption agrees with the visibility owner midpoint windows', () => {
  const f = fixture(), get = f.provider.get;
  f.provider.get = (body, utc) => body === 'earth'
    ? { utc, azimuthDeg: 0, elevationDeg: Date.parse(utc) - Date.parse(START) < 1800000 ? 30 : -10 } : get(body, utc);
  const a = assessMission(f);
  close(a.mission.summary.commsAvailabilityFraction * 100, a.earthLosPct);
});

test('display distinguishes near-full availability and small shortages from exact success', () => {
  assert.equal(fmtAvailability(1), '100%');
  assert.equal(fmtAvailability(0.9999999), '<100%');
  assert.equal(fmtAvailability(null), 'Unknown');
  assert.notEqual(fmtEnergy(0.0001), fmtEnergy(0));
  assert.notEqual(fmtDuration(1e-7), fmtDuration(0));
});

test('scrubbing does not alter physical mission consumption or battery history', () => {
  const f = fixture(); const before = assessMission(f);
  f.scrubUtc = '2027-01-01T01:00:00Z'; const after = assessMission(f);
  assert.deepEqual(after.mission.summary, before.mission.summary);
  assert.deepEqual(after.mission.segments, before.mission.segments);
});
