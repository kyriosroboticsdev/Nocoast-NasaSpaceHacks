import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { delayOffsets, orientationGrid, optimizeMission, analyzeDelays, analyzeDelaysResponsive, compareCandidates } from '../.cache/solar-tests/power/planning.js';
import { studyContexts } from '../.cache/solar-tests/power/contexts.js';
import { settings, comms } from './helpers.mjs';
import { createDefaultScenario } from '../.cache/solar-tests/scenario/types.js';
import { setScenario, getScenario, applyUrlParams, scenarioToSearchParams } from '../.cache/solar-tests/scenario/state.js';

const base = JSON.parse(await readFile(new URL('./fixtures/analytic-sweep.json', import.meta.url), 'utf8'));
const defaults = JSON.parse(await readFile(new URL('../docs/solar/TEAM_DEFAULTS.json', import.meta.url), 'utf8'));
const panel = { areaM2: 1, efficiency: 0.3, tiltDeg: 0, azimuthDeg: 0, referenceIrradianceWm2: 1361 };
function context(siteId = 'connecting-ridge-cr1', delayHours = 0, azimuth = 90, elevation = 10) {
  const input = structuredClone(base), site = defaults.sites.find(s => s.siteId === siteId);
  input.siteId = siteId; input.site = { latitudeDeg: site.latitudeDeg, longitudeEastDeg: site.longitudeEastDeg,
    surfaceElevationM: site.surfaceElevationM, referenceRadiusM: 1737400 };
  input.samples = Array.from({ length: 7 }, (_, i) => ({
    timeUtc: new Date(Date.parse(base.time.startUtc) + delayHours * 3600_000 + i * 600000).toISOString().replace('.000Z', 'Z'),
    sun: { azimuthDeg: azimuth, elevationDeg: elevation, rangeAu: 1 }, solarVisibleFraction: 1,
    quality: { status: 'valid', reason: null } }));
  input.time.startUtc = input.samples[0].timeUtc; input.time.endUtc = input.samples.at(-1).timeUtc;
  input.artifactId = `synthetic-${siteId}-${delayHours}`;
  return { id: input.artifactId, siteId, delayHours, input, communication: comms(3600), terrainValidated: false };
}
const optimize = (contexts, rest = {}) => optimizeMission({ contexts, panel, baseLoadW: 100,
  settings: settings({ capacityWh: 0 }), stepDeg: 30, ...rest });

test('delay grid includes zero and exact max, never overshoots, and limits workload', () => {
  assert.deepEqual(delayOffsets(25, 12), [0, 12, 24, 25]);
  assert.deepEqual(delayOffsets(0, 12), [0]); assert.deepEqual(delayOffsets(1, 12), [0, 1]);
  for (const args of [[-1, 1], [337, 12], [24, 0], [336, 1], [Infinity, 12]]) assert.throws(() => delayOffsets(...args));
  assert.deepEqual(delayOffsets(3 / 3600, 1 / 3600), [0, 1 / 3600, 2 / 3600, 3 / 3600]);
  assert.throws(() => delayOffsets(0.00001, 1), /whole seconds/);
});
test('orientation grid preserves budget and includes off-grid current orientation', () => {
  const current = { ...panel, tiltDeg: 37, azimuthDeg: 103 };
  const before = structuredClone(current), grid = orientationGrid(current, 30);
  assert.deepEqual(grid[0], current); assert.deepEqual(current, before);
  assert.equal(grid.filter(p => p.tiltDeg === 0).length, 1); assert.equal(grid.filter(p => p.tiltDeg === 180).length, 1);
  assert.ok(grid.every(p => p.areaM2 === panel.areaM2 && p.efficiency === panel.efficiency));
  assert.throws(() => orientationGrid(panel, 1));
});
test('low east Sun selects a near-vertical east-facing panel and improves unmet load', async () => {
  const r = await optimize([context()]);
  assert.equal(r.best.panel.tiltDeg, 90); assert.equal(r.best.panel.azimuthDeg, 90);
  assert.equal(r.best.worstUnservedEnergyWh, 0);
  assert.ok(r.baselines[0].worstUnservedEnergyWh > 20);
  assert.ok(compareCandidates(r.best, r.baselines[0]) < 0);
  assert.equal(r.best.qualifiedForMissionDecision, false); // Synthetic/preliminary comparisons stay qualified as such.
});
test('site comparison finds the best tested site and keeps separate site results', async () => {
  const r = await optimize([context(), context('shackleton-rim-sr1', 0, 270, 5)]);
  assert.equal(r.best.siteId, 'shackleton-rim-sr1');
  assert.equal(r.best.panel.azimuthDeg, 270);
  assert.equal(r.ranked.length, 2); assert.equal(r.comparisonComplete, true);
});
test('robust orientation evaluates real delayed geometry, not shifted baseline flags', async () => {
  const a = context(), b = context('connecting-ridge-cr1', 12, 270);
  const nominal = await optimize([a], { baseLoadW: 50 });
  const robust = await optimize([a, b], { baseLoadW: 50 });
  assert.equal(nominal.best.panel.azimuthDeg, 90);
  assert.equal(robust.best.panel.tiltDeg, 0);
  assert.equal(robust.best.worstUnservedEnergyWh, 0);
  assert.equal(robust.best.scenarioCount, 2);
});
test('landing delays retain the same initial charge, mission duration and fixed hardware', () => {
  const a = context(), b = context('connecting-ridge-cr1', 12);
  b.input.samples.forEach(s => { s.solarVisibleFraction = 0; });
  const r = analyzeDelays([a, b], { ...panel, tiltDeg: 90, azimuthDeg: 90 }, 100, settings({ capacityWh: 0 }));
  assert.equal(r.bySite[0].complete, true);
  assert.equal(r.bySite[0].worstCase.worstUnservedEnergyWh, 100);
  assert.equal(r.bySite[0].worstCase.worstUnservedCase.delayHours, 12);
  assert.equal(r.cases[0].summary.durationSeconds, r.cases[1].summary.durationSeconds);
  assert.equal(r.cases[0].summary.initialBatteryWh, r.cases[1].summary.initialBatteryWh);
});
test('unknown delayed coverage cannot be dropped from a worst-case claim or optimization', async () => {
  const a = context(), b = context('connecting-ridge-cr1', 12);
  b.input.samples[2].sun.rangeAu = null;
  b.input.samples[2].quality = { status: 'missing', reason: 'synthetic_range_missing' };
  const r = analyzeDelays([a, b], panel, 100, settings());
  assert.equal(r.bySite[0].complete, false); assert.equal(r.bySite[0].worstCase, null);
  assert.ok(r.bySite[0].knownScenariosOnly); assert.equal(r.bySite[0].unknownScenarios, 1);
  const optimized = await optimize([a, b]);
  assert.equal(optimized.best, null); assert.equal(optimized.exclusions.length, 1);
  assert.match(optimized.exclusions[0].reason, /Incomplete/);
});
test('one unknown site produces an explicitly incomplete comparison, not a global-best claim', async () => {
  const unknown = { ...context('shackleton-rim-sr1'), input: null, unavailableReason: 'No matching range data.' };
  const r = await optimize([context(), unknown]);
  assert.equal(r.best.siteId, 'connecting-ridge-cr1'); assert.equal(r.comparisonComplete, false);
  assert.equal(r.exclusions[0].reason, 'No matching range data.');
});
test('incomplete communication excludes a case even if solar is complete', async () => {
  const c = context(); c.communication = comms(3600, null);
  const r = await optimize([c]); assert.equal(r.best, null);
  assert.match(r.exclusions[0].reason, /Communication/);
});
test('cancelled searches never return a partial optimum', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(optimize([context()], { signal: controller.signal }), { name: 'AbortError' });
  const next = new AbortController();
  await assert.rejects(optimize([context()], { signal: next.signal, onProgress: () => next.abort() }), { name: 'AbortError' });
});
test('current orientation remains a candidate, with deterministic ties for zero area', async () => {
  const current = { ...panel, areaM2: 0, tiltDeg: 37, azimuthDeg: 103 };
  const r = await optimize([context()], { panel: current });
  assert.deepEqual(r.best.panel, current); assert.equal(r.best.worstUnservedEnergyWh, 100);
});
test('different mission lengths and incomplete delay schedules cannot be compared', async () => {
  const a = context(), b = context('shackleton-rim-sr1'); b.input.time.endUtc = '2027-01-01T02:00:00Z';
  await assert.rejects(optimize([a, b]), /same nominal/);
  await assert.rejects(optimize([context(), context('connecting-ridge-cr1', 12), context('shackleton-rim-sr1')]), /same delay/);
});
test('oversized grid is rejected before running expensive evaluations', async () => {
  const many = Array.from({ length: 25 }, (_, i) => context('connecting-ridge-cr1', i * 12));
  await assert.rejects(optimize(many, { stepDeg: 5 }), /10000/);
});
test('mission and planning settings survive sharing, invalid coupled settings are rejected', () => {
  const state = createDefaultScenario(); state.missionSettings.battery.capacityWh = 3456;
  state.missionSettings.battery.initialSocFraction = 0.75; state.missionSettings.requirements.maxCommsBlackoutHours = 8;
  state.planning = { maxDelayHours: 25, delayStepHours: 12, orientationStepDeg: 15, robustOptimization: true };
  const query = scenarioToSearchParams(state); setScenario(createDefaultScenario()); applyUrlParams(query);
  assert.deepEqual(getScenario().missionSettings, state.missionSettings); assert.deepEqual(getScenario().planning, state.planning);
  applyUrlParams('?battery='+encodeURIComponent(JSON.stringify({ initialSocFraction: 0, reserveSocFraction: 0.9 })));
  assert.deepEqual(getScenario().missionSettings, state.missionSettings);
});

test('serialized delay reports contain independent replayable inputs and identical outcome summaries', () => {
  const c = context();
  const report = analyzeDelays([c], panel, 100, settings());
  const copy = JSON.parse(JSON.stringify(report));
  const replay = analyzeDelays(copy.sourceContexts, copy.panel, copy.parameters.baseLoadW, copy.parameters);
  assert.deepEqual(replay.cases, report.cases);
  report.sourceContexts[0].input.samples[0].sun.azimuthDeg = 270;
  assert.equal(c.input.samples[0].sun.azimuthDeg, 90);
});

test('responsive delay analysis agrees with the synchronous model and supports cancellation', async () => {
  const contexts = [context(), context('connecting-ridge-cr1', 12, 270)];
  const sync = analyzeDelays(contexts, panel, 100, settings());
  const asyncResult = await analyzeDelaysResponsive(contexts, panel, 100, settings());
  assert.deepEqual(asyncResult, sync);
  const controller = new AbortController();
  await assert.rejects(analyzeDelaysResponsive(contexts, panel, 100, settings(), controller.signal, () => controller.abort()), { name: 'AbortError' });
});

test('context preparation rejects excessive or fractional-second requests before fetching data', async () => {
  const s = createDefaultScenario();
  await assert.rejects(studyContexts(s, [0, 0.00001], '/'), /unique delay/);
  s.durationHours = 1440;
  await assert.rejects(studyContexts(s, delayOffsets(288, 12), '/'), /100000/);
});

test('landing-delay results do not require an upstream terrain validation declaration', () => {
  const c = context();
  c.input.provenance.visibility = { ...c.input.provenance.visibility, mode: 'terrain',
    sunModel: 'center-binary-v1', horizonArtifactId: 'measured-test-profile', horizonObserverHeightAboveGroundM: 2 };
  c.terrainValidated = false;
  const result = analyzeDelays([c], panel, 0, settings());
  assert.equal(result.cases[0].viability.qualifiedForMissionDecision, true);
});

import { selectedMissionSites } from '../.cache/solar-tests/power/contexts.js';
test('optimization and delays follow chosen catalog and custom coordinates', () => {
  const state = createDefaultScenario();
  state.primary = { id: 'A', siteId: 'peak-near-shackleton' };
  state.secondary = { id: 'B', siteId: 'custom', customLatDeg: -88.125, customLonEastDeg: 45 };
  state.compareEnabled = true;
  const sites = selectedMissionSites(state);
  assert.equal(sites.length, 2);
  assert.equal(sites[0].siteId, 'peak-near-shackleton');
  assert.equal(sites[1].latitudeDeg, -88.125);
  assert.equal(sites[1].longitudeEastDeg, 45);
  state.primary = { ...state.secondary, id: 'A' };
  assert.equal(selectedMissionSites(state).length, 1);
  state.compareEnabled = false;
  assert.equal(selectedMissionSites(state)[0].latitudeDeg, -88.125);
});
