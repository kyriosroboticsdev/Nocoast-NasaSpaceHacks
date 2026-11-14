import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateMission, DEFAULT_MISSION_SETTINGS, validateMissionSettings } from '../.cache/solar-tests/power/mission.js';
import { communicationTimeline } from '../.cache/solar-tests/assess/visibility.js';

import { powerFixture, settings, comms } from './helpers.mjs';
const close = (a, b, eps = 1e-7) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const flat = w => Array(7).fill(w);

test('PV serves the load first and only surplus charges, with charge efficiency', () => {
  const r = simulateMission(powerFixture(flat(100)), 40, settings({ chargeEfficiency: 0.9 }), comms(3600));
  close(r.summary.finalBatteryWh, 54); close(r.summary.chargeInputWh, 60);
  close(r.summary.servedLoadWh, 40); close(r.summary.batteryLossWh, 6);
  close(r.summary.curtailedEnergyWh, 0); assert.equal(r.viability.requirementsMet, true);
});
test('discharge efficiency and exact empty time determine outage duration', () => {
  const r = simulateMission(powerFixture(flat(0)), 100, settings({ capacityWh: 100, initialSocFraction: 1, dischargeEfficiency: 0.8 }), comms(3600));
  close(r.summary.finalBatteryWh, 0); close(r.summary.dischargeOutputWh, 80);
  close(r.summary.unservedEnergyWh, 20); close(r.summary.batteryLossWh, 20);
  close(r.summary.firstKnownPowerLossOffsetSeconds, 2880); close(r.summary.longestPowerOutageSeconds, 720);
  close(r.summary.powerAvailabilityFraction, 0.8); assert.equal(r.viability.requirementsMet, false);
});
test('reserve is a dispatch cutoff, never negative or secretly available', () => {
  const r = simulateMission(powerFixture(flat(0)), 60, settings({ capacityWh: 120, initialSocFraction: 0.5, reserveSocFraction: 0.25 }), comms(3600));
  close(r.summary.finalBatteryWh, 30); close(r.summary.unservedEnergyWh, 30);
  close(r.summary.firstKnownPowerLossOffsetSeconds, 1800);
});
test('saturation within an interval curtails only remaining surplus', () => {
  const r = simulateMission(powerFixture(flat(100)), 0, settings({ capacityWh: 25, chargeEfficiency: 0.5 }), comms(3600));
  close(r.summary.finalBatteryWh, 25); close(r.summary.chargeInputWh, 50);
  close(r.summary.curtailedEnergyWh, 50); close(r.summary.batteryLossWh, 25);
});
test('charge and discharge power limits are bus-side constraints', () => {
  const charge = simulateMission(powerFixture(flat(100)), 20, settings({ maxChargeW: 10 }), comms(3600));
  close(charge.summary.finalBatteryWh, 10); close(charge.summary.curtailedEnergyWh, 70);
  const discharge = simulateMission(powerFixture(flat(0)), 100, settings({ initialSocFraction: 1, maxDischargeW: 40 }), comms(3600));
  close(discharge.summary.finalBatteryWh, 960); close(discharge.summary.unservedEnergyWh, 60);
  close(discharge.summary.longestPowerOutageSeconds, 3600);
});
test('zero storage and a fully reserved battery both have no usable discharge energy', () => {
  for (const battery of [{ capacityWh: 0 }, { initialSocFraction: 1, reserveSocFraction: 1 }]) {
    const r = simulateMission(powerFixture(flat(0)), 100, settings(battery), comms(3600));
    close(r.summary.unservedEnergyWh, 100); close(r.summary.longestPowerOutageSeconds, 3600);
  }
});
test('a ramp with mean PV equal to load can still have an outage', () => {
  const r = simulateMission(powerFixture([0, 200]), 100, settings({ capacityWh: 0 }), comms(600));
  close(r.summary.powerAvailabilityFraction, 0.5); close(r.summary.unservedEnergyWh, 25 / 6);
  close(r.summary.curtailedEnergyWh, 25 / 6); close(r.summary.longestPowerOutageSeconds, 300);
});
test('ramp depletion solves the energy integral, not a constant-average approximation', () => {
  const r = simulateMission(powerFixture([0, 200]), 100, settings({ capacityWh: 1, initialSocFraction: 1 }), comms(600));
  const expectedEmpty = (600 - Math.sqrt(273600)) / 2;
  close(r.summary.firstKnownPowerLossOffsetSeconds, expectedEmpty);
  close(r.summary.longestPowerOutageSeconds, 300 - expectedEmpty);
  close(r.summary.finalBatteryWh, 1); // Later surplus refills this small battery.
});
test('subsecond derived event offsets retain physical duration without rounding timestamps', () => {
  const r = simulateMission(powerFixture([0, 0]), 1, settings({ capacityWh: 1 / 7200, initialSocFraction: 1 }), comms(600));
  close(r.summary.firstKnownPowerLossOffsetSeconds, 0.5);
  close(r.summary.longestPowerOutageSeconds, 599.5);
  assert.equal(r.time.eventTimeConvention, 'offset-seconds-from-startUtc');
});
test('tiny unmet loads are not classified as powered just because interval Wh are small', () => {
  const r = simulateMission(powerFixture(flat(0)), 1e-9, settings({ capacityWh: 0 }), comms(3600));
  assert.equal(r.summary.powerAvailabilityFraction, 0);
  assert.equal(r.viability.requirementsMet, false);
});
test('a score rounded to 100 never overrides a strict no-outage requirement', () => {
  const r = simulateMission(powerFixture([0, 0]), 1, settings({ capacityWh: (600 - 1e-7) / 3600, initialSocFraction: 1 }), comms(600));
  assert.ok(r.summary.longestPowerOutageSeconds > 0);
  assert.equal(Math.round(r.viability.score), 100);
  assert.equal(r.viability.requirementsMet, false);
});
test('solar visibility remains left-held at a transition, without double attenuation', () => {
  const r = simulateMission(powerFixture([100, 100, 100], [1, 0, 0]), 0, settings(), comms(1200));
  close(r.summary.finalBatteryWh, 100 / 6); close(r.summary.chargeInputWh, 100 / 6);
});
test('a missing solar interval poisons subsequent battery state instead of inventing a restart', () => {
  const r = simulateMission(powerFixture([100, 100, 100, 100, 100], [1, null, 1, 1, 1]), 40, settings(), comms(2400));
  assert.equal(r.summary.complete, false); assert.equal(r.summary.finalBatteryWh, null);
  assert.equal(r.summary.unservedEnergyWh, null); assert.equal(r.viability.score, null);
  assert.equal(r.segments.at(-1).reason, 'battery_state_unknown_after_gap');
});
test('communication gaps do not corrupt battery arithmetic but make viability unknown', () => {
  const r = simulateMission(powerFixture(flat(100)), 40, settings(), comms(3600, null));
  close(r.summary.finalBatteryWh, 60); assert.equal(r.summary.commsAvailabilityFraction, null);
  assert.equal(r.viability.score, null); assert.equal(r.summary.jointAvailabilityFraction, null);
});
test('joint windows require served electrical load and Earth LOS, not merely sunlight', () => {
  const r = simulateMission(powerFixture(flat(0)), 100, settings({ capacityWh: 100, initialSocFraction: 1, dischargeEfficiency: 0.8 }), comms(3600));
  close(r.summary.jointAvailabilityFraction, 0.8); close(r.jointWindows[0].durationSeconds, 2880);
});
test('score is explicit and separate from threshold pass/fail and scientific qualification', () => {
  const s = settings(); s.requirements.maxCommsBlackoutHours = 0.25;
  const r = simulateMission(powerFixture(flat(100)), 40, s,
    [{ startOffsetSeconds: 0, endOffsetSeconds: 1800, available: true }, { startOffsetSeconds: 1800, endOffsetSeconds: 3600, available: false }]);
  close(r.viability.score, 50); assert.equal(r.viability.requirementsMet, false);
  assert.equal(r.viability.qualifiedForMissionDecision, false);
});
test('visibility timeline preserves midpoint transitions and nulls', () => {
  const t = communicationTimeline([{ utc: '2027-01-01T00:00:00Z', earthLos: true },
    { utc: '2027-01-01T00:10:00Z', earthLos: false }, { utc: '2027-01-01T00:20:00Z', earthLos: null }]);
  assert.deepEqual(t.map(s => [s.startOffsetSeconds, s.endOffsetSeconds, s.available]),
    [[0, 300, true], [300, 600, false], [600, 900, false], [900, 1200, null]]);
});
test('malformed settings and incomplete communication partitions are rejected', () => {
  for (const patch of [{ capacityWh: -1 }, { chargeEfficiency: 0 }, { dischargeEfficiency: 2 },
    { initialSocFraction: 0.1, reserveSocFraction: 0.2 }, { maxChargeW: -1 }]) assert.throws(() => validateMissionSettings(settings(patch), 40));
  assert.throws(() => simulateMission(powerFixture(flat(100)), 40, settings(), comms(300)));
});
test('randomized battery curves conserve energy at the bus and in storage', () => {
  let seed = 1984;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let k = 0; k < 80; k++) {
    const p = powerFixture(Array.from({ length: 13 }, () => random() * 900));
    const s = settings({ capacityWh: 50 + random() * 500, initialSocFraction: 0.2 + random() * 0.8,
      reserveSocFraction: 0.1, chargeEfficiency: 0.7 + random() * 0.3, dischargeEfficiency: 0.7 + random() * 0.3,
      maxChargeW: random() * 300, maxDischargeW: random() * 300 });
    const r = simulateMission(p, random() * 500, s, comms(7200));
    for (const seg of r.segments) {
      close(seg.generationWh, seg.pvToLoadWh + seg.chargeInputWh + seg.curtailedWh);
      close(seg.loadWh, seg.pvToLoadWh + seg.dischargeOutputWh + seg.unservedWh);
      assert.ok(seg.batteryEndWh >= s.battery.capacityWh * s.battery.reserveSocFraction - 1e-8);
      assert.ok(seg.batteryEndWh <= s.battery.capacityWh + 1e-8);
    }
    close(r.summary.initialBatteryWh + p.summary.totalEnergyWh,
      r.summary.finalBatteryWh + r.summary.servedLoadWh + r.summary.curtailedEnergyWh + r.summary.batteryLossWh, 1e-6);
  }
});
