/** Offline check: 1.5 h mission must not report >100% sunlight. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyticSunAzEl, analyticEarthAzEl } from './lib/analytic-math.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function missionSampleTimes(startUtc, durationHours, stepHours) {
  const start = Date.parse(startUtc);
  const end = start + Math.max(0, durationHours) * 3600_000;
  const stepMs = Math.max(1e-9, stepHours) * 3600_000;
  const out = [];
  for (let t = start; t < end - 1e-6; t += stepMs) out.push(new Date(t).toISOString());
  const endIso = new Date(end).toISOString();
  if (!out.length || out[out.length - 1] !== endIso) out.push(endIso);
  return out;
}

function integrate(samples, flag) {
  let on = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const dt = (Date.parse(samples[i + 1].utc) - Date.parse(samples[i].utc)) / 3600_000;
    const fa = flag(samples[i]);
    const fb = flag(samples[i + 1]);
    if (fa === true && fb === true) on += dt;
    else if (fa === true || fb === true) on += dt / 2;
  }
  return on;
}

const startUtc = '2027-01-15T00:00:00.000Z';
const durationHours = 1.5;
const times = missionSampleTimes(startUtc, durationHours, 1);
console.log('sample times', times);

const horizon = JSON.parse(await readFile(join(root, 'public/science/horizons/connecting-ridge-cr1.json'), 'utf8'));
function horizonAt(az) {
  const spacing = horizon.spacingDeg;
  const i0 = Math.floor((((az % 360) + 360) % 360) / spacing) % horizon.bins.length;
  const a = horizon.bins[i0];
  const b = horizon.bins[(i0 + 1) % horizon.bins.length];
  if (a.elevationDeg == null || b.elevationDeg == null) return null;
  return a.elevationDeg;
}

const samples = times.map(utc => {
  const sun = analyticSunAzEl(utc, -89.4555, 222.6192);
  const earth = analyticEarthAzEl(utc, -89.4555, 222.6192);
  const sh = horizonAt(sun.azimuthDeg);
  const eh = horizonAt(earth.azimuthDeg);
  return {
    utc,
    sunlit: sh == null ? null : sun.elevationDeg - sh > 0,
    earthLos: eh == null ? null : earth.elevationDeg - eh >= 5,
  };
});

const sunH = integrate(samples, s => s.sunlit);
const pct = (100 * sunH) / durationHours;
console.log({ sunHours: sunH, sunlightPct: pct, samples: samples.map(s => s.sunlit) });
if (pct > 100.01) {
  console.error('FAIL: sunlight pct > 100');
  process.exit(1);
}
console.log('PASS: 1.5 h sunlight pct <= 100');

// Old buggy sampling for contrast
const buggy = [];
const n = Math.round(1.5 / 1);
const start = Date.parse(startUtc);
for (let i = 0; i <= n; i++) buggy.push(new Date(start + i * 3600_000).toISOString());
console.log('old buggy times would be', buggy, '→ span', (Date.parse(buggy[buggy.length - 1]) - start) / 3600_000, 'h');
