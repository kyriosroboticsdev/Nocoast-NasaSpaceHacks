/** P0 direct-beam model. All vectors use scientific ENU, all public angles degrees.
 * No ephemeris, terrain horizon, or production visibility is calculated here.
 */
export const MODEL_ID = 'direct-beam-constant-efficiency-v1';
export const SOLAR_REFERENCE_W_M2 = 1361;
export const FRAME_ID = 'MOON_ME_DE421';
export const SITES = Object.freeze({
  'connecting-ridge-cr1': Object.freeze({ latitudeDeg: -89.4555, longitudeEastDeg: 222.6192 }),
  'shackleton-rim-sr1': Object.freeze({ latitudeDeg: -89.7742, longitudeEastDeg: 203.4952 }),
});
const START = Date.parse('2027-01-01T00:00:00Z');
const END = Date.parse('2028-01-01T00:00:00Z');
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = message => { throw new Error(message); };

function number(v, name, min = -Infinity, max = Infinity) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    fail(`${name} must be a finite number in [${min}, ${max}].`);
  }
  return v;
}
function text(v, name) {
  if (typeof v !== 'string' || !v.trim() || v.length > 2000) fail(`${name} must be nonempty text (at most 2000 characters).`);
}
export function utcMilliseconds(value, name = 'timestamp') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    fail(`${name} must use UTC YYYY-MM-DDTHH:mm:ssZ.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== value) fail(`${name} is not a valid UTC date.`);
  return ms;
}

export function validatePanel(panel) {
  if (!plain(panel)) fail('Panel configuration is required.');
  number(panel.areaM2, 'panel.areaM2', 0, 1000000);
  number(panel.efficiency, 'panel.efficiency', 0, 1);
  number(panel.tiltDeg, 'panel.tiltDeg', 0, 180);
  number(panel.azimuthDeg, 'panel.azimuthDeg', 0, 360);
  number(panel.referenceIrradianceWm2, 'panel.referenceIrradianceWm2', 0, 10000);
  return panel;
}

export function sunDirectionEnu(azimuthDeg, elevationDeg) {
  const az = number(azimuthDeg, 'sun.azimuthDeg', 0, 360) * DEG;
  const el = number(elevationDeg, 'sun.elevationDeg', -90, 90) * DEG;
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
}
export function panelNormalEnu(tiltDeg, azimuthDeg) {
  const tilt = number(tiltDeg, 'panel.tiltDeg', 0, 180) * DEG;
  const az = number(azimuthDeg, 'panel.azimuthDeg', 0, 360) * DEG;
  return [Math.sin(tilt) * Math.sin(az), Math.sin(tilt) * Math.cos(az), Math.cos(tilt)];
}
export function solarIrradianceWm2(rangeAu, reference = SOLAR_REFERENCE_W_M2) {
  number(rangeAu, 'sun.rangeAu', Number.MIN_VALUE, Infinity);
  number(reference, 'referenceIrradianceWm2', 0, 10000);
  const result = reference / (rangeAu * rangeAu);
  if (!Number.isFinite(result)) fail('Sun distance is too small for a finite irradiance.');
  return result;
}

function validateSample(sample, name = 'sample') {
  if (!plain(sample) || !plain(sample.sun)) fail(`${name} requires a sun object.`);
  utcMilliseconds(sample.timeUtc, `${name}.timeUtc`);
  const fields = [
    [sample.sun.azimuthDeg, `${name}.sun.azimuthDeg`, 0, 360],
    [sample.sun.elevationDeg, `${name}.sun.elevationDeg`, -90, 90],
    [sample.sun.rangeAu, `${name}.sun.rangeAu`, 0.1, 10],
    [sample.solarVisibleFraction, `${name}.solarVisibleFraction`, 0, 1],
  ];
  for (const [value, label, min, max] of fields) if (value !== null) number(value, label, min, max);
  if (sample.sun.azimuthDeg === 360) fail(`${name}.sun.azimuthDeg must be in [0,360); normalize 360 to 0.`);
  const missing = fields.some(([value]) => value === null);
  if (!plain(sample.quality) || !['valid', 'missing'].includes(sample.quality.status)) fail(`${name}.quality.status must be valid or missing.`);
  if (missing || sample.quality.status === 'missing') {
    text(sample.quality.reason, `${name}.quality.reason for missing data`);
    if (sample.quality.status !== 'missing') fail(`${name}: null values require quality.status=missing.`);
  } else if (sample.quality.reason !== null) fail(`${name}: valid data requires quality.reason=null.`);
  return sample;
}

/** Point evaluation. A missing required input remains unknown even in a blocked sample. */
export function calculatePower(sample, panel) {
  validatePanel(panel);
  validateSample(sample);
  const base = { timeUtc: sample.timeUtc, solarVisibleFraction: sample.solarVisibleFraction };
  if (sample.quality.status === 'missing') {
    return { ...base, normalIrradianceWm2: null, incidenceCosine: null, incidenceAngleDeg: null,
      panelIrradianceWm2: null, unobstructedPowerW: null, powerW: null,
      sunDirectionEnu: null, panelNormalEnu: panelNormalEnu(panel.tiltDeg, panel.azimuthDeg),
      quality: { status: 'missing', reason: sample.quality.reason } };
  }
  const s = sunDirectionEnu(sample.sun.azimuthDeg, sample.sun.elevationDeg);
  const n = panelNormalEnu(panel.tiltDeg, panel.azimuthDeg);
  let cosine = clamp(s.reduce((sum, v, i) => sum + v * n[i], 0), -1, 1);
  // Numerical roundoff at exact tangency must not create a phantom positive wattage.
  if (Math.abs(cosine) < 1e-14) cosine = 0;
  const normalIrradianceWm2 = solarIrradianceWm2(sample.sun.rangeAu, panel.referenceIrradianceWm2);
  const frontFaceCosine = Math.max(0, cosine);
  const unoccludedPanelIrradiance = normalIrradianceWm2 * frontFaceCosine;
  const unobstructedPowerW = unoccludedPanelIrradiance * panel.areaM2 * panel.efficiency;
  const panelIrradianceWm2 = unoccludedPanelIrradiance * sample.solarVisibleFraction;
  const powerW = unobstructedPowerW * sample.solarVisibleFraction;
  if (![unobstructedPowerW, panelIrradianceWm2, powerW].every(Number.isFinite)) fail('Panel inputs produce a nonfinite output.');
  return { ...base, normalIrradianceWm2, incidenceCosine: cosine,
    incidenceAngleDeg: Math.acos(cosine) / DEG, panelIrradianceWm2, unobstructedPowerW, powerW,
    sunDirectionEnu: s, panelNormalEnu: n, quality: { status: 'valid', reason: null } };
}

export function validateScenario(input) {
  if (!plain(input)) fail('Import must be a JSON object.');
  if (input.schemaVersion !== '0.1.0' || input.artifactType !== 'solar-input') fail('Expected schemaVersion=0.1.0 and artifactType=solar-input.');
  for (const field of ['artifactId', 'scenarioId', 'label']) text(input[field], field);
  utcMilliseconds(input.generatedAtUtc, 'generatedAtUtc');
  if (input.frameId !== FRAME_ID) fail(`frameId must be ${FRAME_ID}.`);
  if (!Object.hasOwn(SITES, input.siteId)) fail('P0 supports connecting-ridge-cr1 and shackleton-rim-sr1.');
  if (!plain(input.site)) fail('Site metadata is required.');
  const expected = SITES[input.siteId];
  for (const field of ['latitudeDeg', 'longitudeEastDeg']) {
    number(input.site[field], `site.${field}`);
    if (Math.abs(input.site[field] - expected[field]) > 1e-9) fail(`site.${field} does not match the fixed site ID.`);
  }
  number(input.site.surfaceElevationM, 'site.surfaceElevationM', -15000, 15000);
  if (input.site.referenceRadiusM !== 1737400) fail('site.referenceRadiusM must be 1737400.');
  if (input.observerHeightAboveGroundM !== 2) fail('P0 requires the shared 2 m observer height; regenerate matching inputs before changing it.');
  if (!plain(input.time)) fail('Time metadata is required.');
  const start = utcMilliseconds(input.time.startUtc, 'time.startUtc');
  const end = utcMilliseconds(input.time.endUtc, 'time.endUtc');
  if (start < START || end > END || end <= start || end - start > 60 * 86400000) fail('Mission must be 0–60 days within 2027, with end after start.');
  if (input.time.baseStepSeconds !== 600) fail('time.baseStepSeconds must be 600; finer explicit samples are allowed.');
  if (input.time.visibilityInterpolation !== 'previous-sample-hold') fail('time.visibilityInterpolation must be previous-sample-hold.');
  const provenance = input.provenance;
  if (!plain(provenance) || !plain(provenance.ephemeris) || !plain(provenance.visibility)) fail('Ephemeris and visibility provenance are required.');
  text(provenance.ephemeris.provider, 'provenance.ephemeris.provider');
  const visibility = provenance.visibility;
  text(visibility.provider, 'provenance.visibility.provider');
  if (!['terrain', 'local-plane-demo', 'synthetic-test'].includes(visibility.mode)) fail('Visibility mode must be terrain, local-plane-demo, or synthetic-test.');
  if (!['center-binary-v1', 'disk-fraction-v1', 'fractional-test-v1'].includes(visibility.sunModel)) fail('Unsupported visibility sunModel.');
  if (visibility.sunModel === 'fractional-test-v1' && visibility.mode !== 'synthetic-test') fail('fractional-test-v1 is restricted to synthetic-test mode.');
  if (visibility.mode === 'terrain') {
    text(visibility.horizonArtifactId, 'provenance.visibility.horizonArtifactId');
    if (visibility.horizonObserverHeightAboveGroundM !== input.observerHeightAboveGroundM) fail('Horizon observer height must match the power scenario observer.');
  }
  if (!Array.isArray(input.samples) || input.samples.length < 2 || input.samples.length > 100000) fail('Provide 2–100000 samples including both mission boundaries.');
  let previous = -Infinity;
  input.samples.forEach((sample, i) => {
    validateSample(sample, `samples[${i}]`);
    const ms = utcMilliseconds(sample.timeUtc);
    if (ms <= previous || ms < start || ms > end) fail('Sample timestamps must be strictly increasing and within the mission boundaries.');
    previous = ms;
    const fraction = sample.solarVisibleFraction;
    if (visibility.sunModel === 'center-binary-v1' && fraction !== null && fraction !== 0 && fraction !== 1) fail('center-binary-v1 accepts only visibility 0, 1, or null.');
  });
  if (utcMilliseconds(input.samples[0].timeUtc) !== start || previous !== end) fail('Samples must include exact start and end boundaries; no extrapolation is allowed.');
  return input;
}

/** Geometry is trapezoidal between samples; supplied visibility is held on [a,b).
 * This avoids smearing a shadow transition across the previous interval.
 * Gaps > cadence or missing endpoint data are unknown, never zero energy.
 */
export function simulate(input, panel) {
  validateScenario(input);
  validatePanel(panel);
  const samples = input.samples.map(sample => calculatePower(sample, panel));
  const intervals = [];
  let knownEnergyWh = 0, knownUnobstructedEnergyWh = 0, knownSeconds = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    const durationSeconds = (utcMilliseconds(b.timeUtc) - utcMilliseconds(a.timeUtc)) / 1000;
    const gap = durationSeconds > input.time.baseStepSeconds;
    const valid = !gap && a.quality.status === 'valid' && b.quality.status === 'valid';
    const unoccludedEnergy = valid ? (a.unobstructedPowerW + b.unobstructedPowerW) / 2 * durationSeconds / 3600 : null;
    const energyWh = valid ? unoccludedEnergy * a.solarVisibleFraction : null;
    if (valid) { knownEnergyWh += energyWh; knownUnobstructedEnergyWh += unoccludedEnergy; knownSeconds += durationSeconds; }
    intervals.push({ startUtc: a.timeUtc, endUtc: b.timeUtc, durationSeconds, energyWh,
      unobstructedEnergyWh: unoccludedEnergy, solarVisibleFraction: valid ? a.solarVisibleFraction : null,
      quality: { status: valid ? 'valid' : 'missing', reason: valid ? null : gap ? 'ephemeris_gap' : 'missing_endpoint' },
      cumulativeKnownEnergyWh: knownEnergyWh });
  }
  const durationSeconds = (utcMilliseconds(input.time.endUtc) - utcMilliseconds(input.time.startUtc)) / 1000;
  const unknownSeconds = durationSeconds - knownSeconds;
  const complete = unknownSeconds === 0;
  // End-boundary sample brackets integration but is outside the half-open mission.
  const validPowers = samples.slice(0, -1).map(s => s.powerW).filter(v => v !== null);
  return {
    schemaVersion: '0.1.0', artifactType: 'power',
    artifactId: `${input.artifactId}:power:${MODEL_ID}:${[panel.areaM2, panel.efficiency, panel.tiltDeg, panel.azimuthDeg, panel.referenceIrradianceWm2].join(':')}`,
    scenarioId: input.scenarioId, generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    frameId: input.frameId, siteId: input.siteId, site: structuredClone(input.site),
    observerHeightAboveGroundM: input.observerHeightAboveGroundM,
    sourceArtifactId: input.artifactId, provenance: structuredClone(input.provenance),
    model: { id: MODEL_ID, integration: 'trapezoidal-unobstructed-power-with-previous-visibility-hold',
      exclusions: ['temperature dependence', 'eclipse attenuation', 'dust and degradation', 'reflected light',
        'electrical conversion and wiring losses', 'batteries and loads', 'panel self-shadowing'],
      partialDiskApproximation: 'Scalar fraction scales center-ray irradiance; not a resolved solar-disk integration.' },
    units: { power: 'W', irradiance: 'W/m2', energy: 'Wh', angles: 'deg', distance: 'AU', vectors: 'ENU' },
    panel: { ...panel }, time: { ...input.time },
    summary: { durationSeconds, knownSeconds, unknownSeconds, coverageFraction: knownSeconds / durationSeconds,
      totalEnergyWh: complete ? knownEnergyWh : null, knownEnergyWh,
      meanPowerW: complete ? knownEnergyWh * 3600 / durationSeconds : null,
      sampledPeakPowerW: validPowers.length ? validPowers.reduce((peak, value) => Math.max(peak, value), 0) : null,
      knownUnobstructedEnergyWh, knownObstructionLossWh: knownUnobstructedEnergyWh - knownEnergyWh,
      complete, eligibleForTerrainComparison: complete && input.provenance.visibility.mode === 'terrain' },
    samples, intervals,
  };
}

export function resultCsv(result) {
  const fields = ['timeUtc', 'normalIrradianceWm2', 'incidenceCosine', 'solarVisibleFraction', 'panelIrradianceWm2', 'powerW'];
  const escape = v => v === null || v === undefined ? '' : `"${String(v).replaceAll('"', '""')}"`;
  return [fields.join(',') + ',quality,reason', ...result.samples.map(s =>
    [...fields.map(f => escape(s[f])), escape(s.quality.status), escape(s.quality.reason)].join(','))].join('\r\n') + '\r\n';
}
