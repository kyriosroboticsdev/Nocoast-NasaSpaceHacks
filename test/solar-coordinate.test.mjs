import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simulate, validateScenario } from '../src/power/model.mjs';
import { adaptSolarSample, buildSolarInput } from '../.cache/solar-tests/power/adapter.js';
import { sphereHorizon } from '../.cache/solar-tests/horizon/types.js';

const baseline = JSON.parse(await readFile(new URL('./fixtures/analytic-sweep.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(await readFile(new URL('../contract/lunar-navigator.v0.1.json', import.meta.url), 'utf8')).sites;
const start = '2027-01-01T00:00:00Z', end = '2027-01-01T00:10:00Z';
const panel = { areaM2: 2, efficiency: 0.28, tiltDeg: 90, azimuthDeg: 90, referenceIrradianceWm2: 1361 };
const custom = { siteId: 'moon-lat-89.123456-lon-42.123456', latitudeDeg: -89.123456, longitudeEastDeg: 42.123456,
  surfaceElevationM: 3500 };
function input(site = custom) {
  const s = structuredClone(baseline);
  s.siteId = site.siteId;
  s.site = { latitudeDeg: site.latitudeDeg, longitudeEastDeg: site.longitudeEastDeg,
    surfaceElevationM: site.surfaceElevationM, referenceRadiusM: 1737400 };
  s.time = { ...s.time, startUtc: start, endUtc: end };
  s.samples = [start, end].map(timeUtc => ({ timeUtc, sun: { azimuthDeg: 90, elevationDeg: 0, rangeAu: 1 },
    solarVisibleFraction: 1, quality: { status: 'valid', reason: null } }));
  return s;
}
function adapter(site = custom) {
  // Synthetic wire-contract fixture, not a claim of measured ephemerides at these coordinates.
  const horizon = sphereHorizon(site.siteId, site.latitudeDeg, site.longitudeEastDeg, site.surfaceElevationM, 2);
  horizon.model = 'lola_terrain';
  const sun = { siteId: site.siteId, frameId: 'MOON_ME_DE421', observerHeightAboveGroundM: 2,
    observer: { latitudeDeg: site.latitudeDeg, longitudeEastDeg: site.longitudeEastDeg,
      altitudeKm: (site.surfaceElevationM + 2) / 1000 }, source: 'jpl_horizons', origin: 'jpl_horizons',
    generatedAtUtc: start, samples: input(site).samples.map(s => ({ utc: s.timeUtc, ...s.sun })) };
  const provider = { series: { sun }, sourceLabel: 'synthetic protocol fixture', get: () => null };
  const samples = [start, end].map(utc => ({ utc, sunlit: true }));
  return { siteId: site.siteId, provider, horizon, startUtc: start, endUtc: end, samples };
}

test('all six catalog locations and coordinate-defined points replay through the same power equations', () => {
  for (const site of [...catalog, custom, { ...custom, siteId: 'polar-point', latitudeDeg: -90, longitudeEastDeg: 0 }]) {
    const s = input(site), p = simulate(s, panel);
    assert.equal(p.siteId, site.siteId);
    assert.deepEqual(p.site, s.site);
    assert.equal(p.samples[0].powerW, 762.1600000000001);
    assert.equal(p.summary.complete, true);
  }
});

test('coordinate support preserves fixed legacy identities, bounds and required metadata', () => {
  for (const mutate of [
    s => { s.site.latitudeDeg = -90.01; }, s => { s.site.latitudeDeg = NaN; },
    s => { s.site.longitudeEastDeg = -1; }, s => { s.site.longitudeEastDeg = 360; },
    s => { s.site.surfaceElevationM = null; }, s => { s.siteId = ''; },
    s => { s.siteId = 'connecting-ridge-cr1'; }, s => { s.siteId = 'shackleton-rim-sr1'; },
    s => { s.frameId = 'IAU_MOON'; }, s => { s.observerHeightAboveGroundM = 0; },
  ]) {
    const s = input(); mutate(s); assert.throws(() => validateScenario(s));
  }
});

test('new locations retain unknown intervals for missing range, visibility and time gaps', () => {
  for (const field of ['range', 'visibility', 'gap']) {
    const s = input();
    if (field === 'range') s.samples[0].sun.rangeAu = null;
    if (field === 'visibility') s.samples[0].solarVisibleFraction = null;
    if (field !== 'gap') s.samples[0].quality = { status: 'missing', reason: `missing_${field}` };
    else s.samples[1].timeUtc = s.time.endUtc = '2027-01-01T00:20:00Z';
    const p = simulate(s, panel);
    assert.equal(p.summary.complete, false);
    assert.equal(p.summary.totalEnergyWh, null);
    assert.equal(p.summary.meanPowerW, null);
  }
});

test('different locations and dates use their supplied Sun geometry and recompute for current hardware', () => {
  const first = input(), second = input({ ...custom, siteId: 'another-point', longitudeEastDeg: 200 });
  second.samples.forEach(s => { s.sun.azimuthDeg = 270; });
  assert.ok(simulate(first, panel).summary.totalEnergyWh > 0);
  assert.equal(simulate(second, panel).summary.totalEnergyWh, 0);
  const later = input();
  later.samples.forEach(s => { s.timeUtc = s.timeUtc.replace('01-01', '01-02'); s.sun.rangeAu = 2; });
  later.time.startUtc = later.samples[0].timeUtc; later.time.endUtc = later.samples[1].timeUtc;
  assert.equal(simulate(later, panel).summary.totalEnergyWh, simulate(first, panel).summary.totalEnergyWh / 4);
  assert.equal(simulate(first, { ...panel, areaM2: 4 }).summary.totalEnergyWh, simulate(first, panel).summary.totalEnergyWh * 2);
});

test('adapter uses actual observer coordinates and terrain elevation at new catalog and custom sites', () => {
  for (const site of [catalog[2], catalog[5], custom]) {
    const f = adapter(site), s = buildSolarInput(f);
    assert.ok(s);
    assert.deepEqual(s.site, input(site).site);
    assert.equal(s.samples[0].quality.status, 'valid');
    assert.equal(simulate(s, panel).summary.complete, true);
    assert.equal(s.provenance.visibility.validation.status, 'pending');
  }
});

test('adapter rejects mismatched positions, real observer altitude, invented range and analytic sources', () => {
  for (const mutate of [
    f => { f.provider.series.sun.observer.latitudeDeg += 0.1; },
    f => { f.provider.series.sun.observer.longitudeEastDeg += 0.1; },
    f => { f.provider.series.sun.observer.altitudeKm = 0.002; },
    f => { f.provider.series.sun.siteId = 'different-observer'; },
    f => { f.provider.series.sun.source = 'analytic_fallback'; },
    f => { delete f.provider.series.sun.samples[0].rangeAu; },
    f => { f.horizon.observer.surfaceElevationM = NaN; },
  ]) {
    const f = adapter(); mutate(f);
    assert.equal(adaptSolarSample(start, true, f.provider, f.horizon).quality.status, 'missing');
  }
});

test('adapter exports matching updated terrain elevation instead of a hardcoded site elevation', () => {
  const site = { ...catalog[0], surfaceElevationM: 1950 };
  const f = adapter(site), s = buildSolarInput(f);
  assert.equal(s.site.surfaceElevationM, 1950);
  assert.equal(s.samples[0].quality.status, 'valid');
  f.provider.series.sun.observer.altitudeKm = (catalog[0].surfaceElevationM + 2) / 1000;
  assert.equal(adaptSolarSample(start, true, f.provider, f.horizon).quality.reason, 'sun_observer_or_frame_mismatch');
});
