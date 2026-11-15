import { readFile } from 'node:fs/promises';
import { simulate } from '../src/power/model.mjs';
import { DEFAULT_MISSION_SETTINGS } from '../.cache/solar-tests/power/mission.js';
const baseline = JSON.parse(await readFile(new URL('./fixtures/analytic-sweep.json', import.meta.url), 'utf8'));
export function powerFixture(watts, visible = watts.map(() => 1), step = 600) {
  const input = structuredClone(baseline);
  input.samples = watts.map((w, i) => ({ timeUtc: new Date(Date.parse(input.time.startUtc) + i * step * 1000).toISOString().replace('.000Z', 'Z'),
    sun: { azimuthDeg: 0, elevationDeg: Math.asin(w / 1000) * 180 / Math.PI, rangeAu: 1 },
    solarVisibleFraction: visible[i], quality: { status: visible[i] == null ? 'missing' : 'valid', reason: visible[i] == null ? 'fixture_gap' : null } }));
  input.time.endUtc = input.samples.at(-1).timeUtc;
  return simulate(input, { areaM2: 1, efficiency: 1, tiltDeg: 0, azimuthDeg: 0, referenceIrradianceWm2: 1000 });
}
export function settings(patch = {}) {
  return { battery: { ...DEFAULT_MISSION_SETTINGS.battery, capacityWh: 1000, initialSocFraction: 0,
    reserveSocFraction: 0, chargeEfficiency: 1, dischargeEfficiency: 1, maxChargeW: 1000, maxDischargeW: 1000, ...patch },
    requirements: { minPowerAvailabilityFraction: 1, minCommsAvailabilityFraction: 0.5, maxCommsBlackoutHours: 24 } };
}
export const comms = (seconds, available = true) => [{ startOffsetSeconds: 0, endOffsetSeconds: seconds, available }];
