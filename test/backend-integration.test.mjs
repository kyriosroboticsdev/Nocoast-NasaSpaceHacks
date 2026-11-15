import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessBackendMission, timelineFromWindows } from '../.cache/solar-tests/science/assessment.js';
import { simulateStay, missionVerdict } from '../.cache/solar-tests/power/stay.js';
import { assessInstant } from '../.cache/solar-tests/assess/windows.js';
import { DEFAULT_THRESHOLDS } from '../.cache/solar-tests/scenario/types.js';
import { sphereHorizon } from '../.cache/solar-tests/horizon/types.js';
import { settings } from './helpers.mjs';

const source = JSON.parse(await readFile(new URL('./fixtures/analytic-sweep.json', import.meta.url)));
const start = '2027-01-01T00:00:00Z', end = '2027-01-01T00:20:00Z';
const panel = { areaM2: 1, efficiency: 0.3, tiltDeg: 0, azimuthDeg: 0, referenceIrradianceWm2: 1361 };
const stamp = seconds => new Date(Date.parse(start) + seconds * 1000).toISOString().replace('.000Z', 'Z');
const window = (a, b) => ({ startUtc: stamp(a), endUtc: stamp(b), durationSeconds: b - a });
function input() {
  const s = structuredClone(source);
  s.time = { ...s.time, startUtc: start, endUtc: end };
  s.provenance.visibility = { provider: 'Synthetic backend protocol fixture', mode: 'terrain',
    sunModel: 'center-binary-v1', horizonArtifactId: 'test', horizonObserverHeightAboveGroundM: 2 };
  s.samples = [0, 600, 1200].map(t => ({ timeUtc: stamp(t), sun: { azimuthDeg: 0, elevationDeg: 90, rangeAu: 1 },
    solarVisibleFraction: 1, quality: { status: 'valid', reason: null } }));
  return s;
}
function fixture() {
  const horizon = sphereHorizon(source.siteId, source.site.latitudeDeg, source.site.longitudeEastDeg,
    source.site.surfaceElevationM, 2);
  horizon.model = 'lola_terrain';
  const provider = { series: {}, sourceLabel: 'test backend',
    get: () => ({ azimuthDeg: 0, elevationDeg: 10 }) };
  const options = { siteId: source.siteId, siteLabel: 'CR1', horizonModel: 'lola_terrain', horizon, provider,
    startUtc: start, durationHours: 1 / 3, scrubUtc: start,
    thresholds: { ...DEFAULT_THRESHOLDS, panelAreaM2: 1, panelEfficiency: 0.3 }, missionSettings: settings() };
  const backend = { solarInput: input(),
    sun: { sunlitWindows: [window(0, 1200)], darkPeriods: [], unknown: [], summary: { longestGapSeconds: 0 } },
    communication: { windows: [window(360, 1200)], blackouts: [window(0, 360)], unknown: [],
      summary: { longestGapSeconds: 360 } },
    sunAndCommunication: { windows: [window(360, 1200)] } };
  return { options, backend };
}

test('backend refined contact agrees in metrics and mission, without midpoint resampling', () => {
  const { options, backend } = fixture();
  const a = assessBackendMission(backend, options);
  assert.equal(a.earthLosPct, 70);
  assert.equal(a.mission.summary.commsAvailabilityFraction, 0.7);
  assert.equal(a.mission.summary.longestCommsBlackoutSeconds, 360);
  assert.equal(a.meanPowerW, 408.3);
  assert.equal(a.samples[0].powerW, 408.3);
  assert.equal(a.viability, 'GO');
  assert.equal(a.mission.viability.qualifiedForMissionDecision, true);
});

test('backend solar mask is applied once even when display horizon disagrees', () => {
  const { options, backend } = fixture();
  options.horizon.bins.forEach(b => { b.elevationDeg = 80; });
  backend.solarInput.samples[0].solarVisibleFraction = 0;
  backend.sun.sunlitWindows = [window(600, 1200)];
  backend.sun.darkPeriods = [window(0, 600)];
  const a = assessBackendMission(backend, options);
  assert.equal(a.samples[0].powerW, 0);
  assert.equal(a.samples[1].powerW, 408.3);
  assert.equal(a.solar.summary.totalEnergyWh, 408.3 / 6);
});

test('missing backend solar never falls back to an unqualified substitute', () => {
  const { options, backend } = fixture(); backend.solarInput = null;
  const a = assessBackendMission(backend, options);
  assert.equal(a.solar, null); assert.equal(a.mission, null); assert.equal(a.meanPowerW, null);
  assert.equal(a.earthLosPct, 70);
});

test('backend scenario mismatch, overlapping windows and out-of-range windows are rejected', () => {
  const { options, backend } = fixture(); backend.solarInput.siteId = 'shackleton-rim-sr1';
  assert.throws(() => assessBackendMission(backend, options), /mismatch/);
  assert.throws(() => timelineFromWindows(start, 1200, [window(0, 900)], [window(600, 1200)], []), /overlapping/);
  assert.throws(() => timelineFromWindows(start, 1200, [window(0, 1800)], [], []), /Invalid/);
});

test('uncovered communication remains unknown and cannot earn a score', () => {
  const communication = timelineFromWindows(start, 1200, [window(600, 1200)], [], []);
  const result = simulateStay(input(), panel, 40, settings(), communication);
  assert.equal(communication[0].available, null);
  assert.equal(result.mission.viability.score, null);
  assert.equal(result.mission.summary.unservedEnergyWh, 0);
});

test('complete terrain-based missions are graded without a validation declaration', () => {
  const s = input(), comm = timelineFromWindows(start, 1200, [window(0, 1200)], [], []);
  assert.equal(simulateStay(s, panel, 40, settings(), comm).mission.viability.qualifiedForMissionDecision, true);
  s.provenance.visibility.validation = { status: 'validated', algorithmVersion: 'synthetic-test' };
  assert.equal(simulateStay(s, panel, 40, settings(), comm).mission.viability.qualifiedForMissionDecision, true);
});

test('offline Earth gate uses absolute antenna elevation and strict terrain clearance like the backend', () => {
  const { options } = fixture();
  options.horizon.bins.forEach(b => { b.elevationDeg = 8; });
  options.thresholds.minEarthElevationDeg = 5;
  assert.equal(assessInstant(start, options.provider, options.horizon, options.thresholds).earthLos, true);
  options.horizon.bins.forEach(b => { b.elevationDeg = 10; });
  assert.equal(assessInstant(start, options.provider, options.horizon, options.thresholds).earthLos, false);
});

test('landing-day and site verdicts cannot promote rounded contact percentages to a pass', () => {
  const s = input();
  s.provenance.visibility.validation = { status: 'validated', algorithmVersion: 'synthetic-test' };
  const contact = timelineFromWindows(start, 1200, [window(0, 599.9)], [window(599.9, 1200)], []);
  const m = simulateStay(s, panel, 40, settings(), contact).mission;
  assert.equal((m.summary.commsAvailabilityFraction * 100).toFixed(1), '50.0');
  assert.equal(m.viability.requirementsMet, false);
  assert.equal(missionVerdict(m), 'caution');
  delete s.provenance.visibility.validation;
  assert.equal(missionVerdict(simulateStay(s, panel, 40, settings(), contact).mission), 'caution');
  assert.equal(missionVerdict(simulateStay(s, panel, 40, settings(), timelineFromWindows(start, 1200, [], [], [])).mission), 'unknown');
});
import { fetchBackendAnalysis } from '../.cache/solar-tests/science/backend.js';

test('invalid visibility ranges fail even when the backend returned no windows', () => {
  assert.throws(() => timelineFromWindows('invalid', 1200, [], [], []), /Invalid/);
  assert.throws(() => timelineFromWindows(start, -1, [], [], []), /Invalid/);
});

test('backend requests recover after a transient failure and cache each API base separately', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (calls.length === 1) throw new Error('cold backend');
    return { ok: true, json: async () => ({ source: url }) };
  });
  const get = base => fetchBackendAnalysis(-89.455, 222.69, start, end, 0, base);
  assert.equal(await get('/first/'), null);
  const recovered = await get('/first/');
  assert.ok(recovered);
  assert.equal(await get('/first/'), recovered);
  assert.equal(calls.length, 2);
  assert.notDeepEqual(await get('/second/'), recovered);
  assert.equal(calls.length, 3);
});

function coordinateFixture() {
  const f = fixture();
  f.options.siteId = f.options.horizon.siteId = 'map-spot';
  f.options.horizon.observer.latitudeDeg = -89.2;
  f.options.horizon.observer.longitudeEastDeg = 123.4;
  f.options.horizon.observer.surfaceElevationM = 2100;
  f.backend.solarInput.siteId = 'moon-lat-89.200000-lon-123.400000';
  Object.assign(f.backend.solarInput.site, { latitudeDeg: -89.2, longitudeEastDeg: 123.4, surfaceElevationM: 2100 });
  return f;
}

test('coordinate-identified backend power matches a custom UI site by its actual observer', () => {
  const { options, backend } = coordinateFixture();
  const a = assessBackendMission(backend, options);
  assert.equal(a.siteId, 'map-spot');
  assert.equal(a.solarInput.siteId, 'moon-lat-89.200000-lon-123.400000');
  assert.equal(a.meanPowerW, 408.3);
  assert.equal(a.solar.summary.complete, true);
  assert.equal(a.mission.summary.commsAvailabilityFraction, 0.7);
});

test('a reused custom UI identity cannot adopt another point or elevation from a stale response', () => {
  for (const change of [
    f => { f.backend.solarInput.site.latitudeDeg += 0.01; },
    f => { f.backend.solarInput.site.longitudeEastDeg += 0.01; },
    f => { f.backend.solarInput.site.surfaceElevationM += 5; },
  ]) {
    const f = coordinateFixture(); change(f);
    assert.throws(() => assessBackendMission(f.backend, f.options), /mismatch/);
  }
});

test('coordinate mission grading does not require pending terrain validation to change', () => {
  const { options, backend } = coordinateFixture();
  const preliminary = assessBackendMission(backend, options);
  assert.equal(preliminary.mission.viability.requirementsMet, true);
  assert.equal(preliminary.mission.viability.qualifiedForMissionDecision, true);
  assert.equal(missionVerdict(preliminary.mission), 'go');
  backend.solarInput.provenance.visibility.validation = { status: 'validated', algorithmVersion: 'synthetic-test' };
  const qualified = assessBackendMission(backend, options);
  assert.equal(qualified.mission.viability.qualifiedForMissionDecision, true);
  assert.equal(missionVerdict(qualified.mission), 'go');
});

import { assertSolarContext } from '../.cache/solar-tests/power/stay.js';

test('dashboard context checks accept canonical backend IDs and equivalent longitudes', () => {
  const { backend } = coordinateFixture(), s = backend.solarInput;
  const context = { ...s.site, startUtc: start, endUtc: end, frameId: s.frameId, observerHeightAboveGroundM: 2 };
  assert.doesNotThrow(() => assertSolarContext(s, context));
  assert.doesNotThrow(() => assertSolarContext(s, { ...context, longitudeEastDeg: -236.6 }));
});

test('dashboard context checks reject stale points, dates and mismatched observer metadata', () => {
  const { backend } = coordinateFixture(), s = backend.solarInput;
  const context = { ...s.site, startUtc: start, endUtc: end, frameId: s.frameId, observerHeightAboveGroundM: 2 };
  for (const changes of [
    { latitudeDeg: -89.3 }, { longitudeEastDeg: 124 }, { surfaceElevationM: 2200 },
    { startUtc: '2027-01-02T00:00:00Z' }, { endUtc: '2027-01-01T00:30:00Z' },
    { latitudeDeg: NaN }, { longitudeEastDeg: Infinity }, { surfaceElevationM: NaN },
    { frameId: 'IAU_MOON' }, { observerHeightAboveGroundM: 0 },
  ]) assert.throws(() => assertSolarContext(s, { ...context, ...changes }));
});

test('pending terrain validation does not override GO, CAUTION or NO-GO and missing data stays unknown', () => {
  const s = input(); s.provenance.visibility.validation = { status: 'pending' };
  const full = timelineFromWindows(start, 1200, [window(0, 1200)], [], []);
  const limited = timelineFromWindows(start, 1200, [window(0, 300)], [window(300, 1200)], []);
  assert.equal(missionVerdict(simulateStay(s, panel, 40, settings(), full).mission), 'go');
  assert.equal(missionVerdict(simulateStay(s, panel, 40, settings(), limited).mission), 'caution');
  assert.equal(missionVerdict(simulateStay(s, panel, 1000, settings({ capacityWh: 0 }), full).mission), 'nogo');
  const missing = structuredClone(s);
  missing.samples[0].solarVisibleFraction = null;
  missing.samples[0].quality = { status: 'missing', reason: 'terrain_visibility_missing' };
  assert.equal(missionVerdict(simulateStay(missing, panel, 40, settings(), full).mission), 'unknown');
  assert.equal(s.provenance.visibility.validation.status, 'pending');
});
