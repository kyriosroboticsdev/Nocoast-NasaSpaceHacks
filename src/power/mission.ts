import type { PowerResult } from './model.mjs';

export type BatterySettings = {
  capacityWh: number; initialSocFraction: number; reserveSocFraction: number;
  chargeEfficiency: number; dischargeEfficiency: number; maxChargeW: number; maxDischargeW: number;
};
export type MissionRequirements = {
  minPowerAvailabilityFraction: number; minCommsAvailabilityFraction: number; maxCommsBlackoutHours: number;
};
export type MissionSettings = { battery: BatterySettings; requirements: MissionRequirements };
export const DEFAULT_MISSION_SETTINGS: MissionSettings = {
  battery: { capacityWh: 2000, initialSocFraction: 0.8, reserveSocFraction: 0.1,
    chargeEfficiency: 0.95, dischargeEfficiency: 0.95, maxChargeW: 500, maxDischargeW: 500 },
  requirements: { minPowerAvailabilityFraction: 1, minCommsAvailabilityFraction: 0.5, maxCommsBlackoutHours: 24 },
};
export type StateSegment = { startOffsetSeconds: number; endOffsetSeconds: number; available: boolean | null };
export type EventWindow = { startOffsetSeconds: number; endOffsetSeconds: number; durationSeconds: number };
export type BatterySegment = StateSegment & {
  batteryStartWh: number | null; batteryEndWh: number | null;
  generationWh: number | null; loadWh: number; pvToLoadWh: number | null;
  chargeInputWh: number | null; dischargeOutputWh: number | null;
  batteryLossWh: number | null; curtailedWh: number | null; unservedWh: number | null;
  reason: string | null;
};

function finite(value: number, name: string, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be in [${min}, ${max}].`);
}
export function validateMissionSettings(settings: MissionSettings, baseLoadW: number) {
  const b = settings.battery, r = settings.requirements;
  finite(baseLoadW, 'Equipment power demand W', 0, 1e6);
  finite(b.capacityWh, 'Battery capacity Wh', 0, 1e9);
  finite(b.reserveSocFraction, 'Battery reserve', 0, 1);
  finite(b.initialSocFraction, 'Initial battery charge', b.reserveSocFraction, 1);
  finite(b.chargeEfficiency, 'Charge efficiency', 0.000001, 1);
  finite(b.dischargeEfficiency, 'Discharge efficiency', 0.000001, 1);
  finite(b.maxChargeW, 'Maximum charge W', 0, 1e9);
  finite(b.maxDischargeW, 'Maximum discharge W', 0, 1e9);
  finite(r.minPowerAvailabilityFraction, 'Required power availability', 0.000001, 1);
  finite(r.minCommsAvailabilityFraction, 'Required communication availability', 0, 1);
  finite(r.maxCommsBlackoutHours, 'Allowed communication blackout hours', 0, 1440);
}

/** Midpoint transitions are owned by the visibility layer; consume a complete timeline. */
function validateTimeline(timeline: StateSegment[], duration: number) {
  let end = 0;
  for (const s of timeline) {
    if (!Number.isFinite(s.startOffsetSeconds) || !Number.isFinite(s.endOffsetSeconds)
      || Math.abs(s.startOffsetSeconds - end) > 1e-6 || s.endOffsetSeconds <= end
      || ![true, false, null].includes(s.available)) throw new Error('Communication timeline must partition the mission in order.');
    end = s.endOffsetSeconds;
  }
  if (Math.abs(end - duration) > 1e-6) throw new Error('Communication timeline must cover both mission boundaries.');
}
function windows(timeline: StateSegment[], flag: boolean): EventWindow[] {
  const out: EventWindow[] = [];
  for (const s of timeline) {
    if (s.available !== flag) continue;
    const last = out.at(-1);
    if (last && Math.abs(last.endOffsetSeconds - s.startOffsetSeconds) < 1e-7) {
      last.endOffsetSeconds = s.endOffsetSeconds;
      last.durationSeconds = last.endOffsetSeconds - last.startOffsetSeconds;
    } else out.push({ startOffsetSeconds: s.startOffsetSeconds, endOffsetSeconds: s.endOffsetSeconds,
      durationSeconds: s.endOffsetSeconds - s.startOffsetSeconds });
  }
  return out;
}
function stats(timeline: StateSegment[], duration: number) {
  let on = 0, unknown = 0;
  for (const s of timeline) {
    const dt = s.endOffsetSeconds - s.startOffsetSeconds;
    if (s.available === true) on += dt;
    if (s.available == null) unknown += dt;
  }
  const outages = windows(timeline, false);
  const longest = outages.reduce((n, w) => Math.max(n, w.durationSeconds), 0);
  return { knownAvailableSeconds: on, unknownSeconds: unknown,
    availabilityFraction: unknown < 1e-6 ? Math.max(0, Math.min(1, on / duration)) : null,
    longestBlackoutSeconds: unknown < 1e-6 ? longest : null, knownLongestBlackoutSeconds: longest, outages };
}
function intersect(a: StateSegment[], b: StateSegment[]): StateSegment[] {
  const out: StateSegment[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const left = Math.max(a[i].startOffsetSeconds, b[j].startOffsetSeconds);
    const right = Math.min(a[i].endOffsetSeconds, b[j].endOffsetSeconds);
    if (right > left) out.push({ startOffsetSeconds: left, endOffsetSeconds: right,
      available: a[i].available === false || b[j].available === false ? false
        : a[i].available === true && b[j].available === true ? true : null });
    const ae = a[i].endOffsetSeconds, be = b[j].endOffsetSeconds;
    if (ae <= be) i++;
    if (be <= ae) j++;
  }
  return out;
}

// Integral of a linearly changing bus power (W) over seconds, in Wh.
const energy = (a: number, b: number, seconds: number) => (a + b) * 0.5 * seconds / 3600;
function timeForEnergy(a: number, b: number, seconds: number, targetWh: number) {
  if (targetWh <= 0) return 0;
  let lo = 0, hi = seconds;
  for (let i = 0; i < 52; i++) {
    const t = (lo + hi) / 2;
    if (energy(a, a + (b - a) * t / seconds, t) < targetWh) lo = t;
    else hi = t;
  }
  return (lo + hi) / 2;
}

/** Ideal DC bus, constant load; storage limits/efficiencies apply on the bus side.
 * PV is the P0 linear unobstructed curve times its left-held visibility mask.
 * Split at load/rate crossings and battery saturation/depletion. Missing data
 * makes storage state unknown from that point forward; never invent a restart.
 */
export function simulateMission(power: PowerResult, baseLoadW: number, settings: MissionSettings,
  communication: StateSegment[]) {
  validateMissionSettings(settings, baseLoadW);
  const b = settings.battery, duration = power.summary.durationSeconds;
  if (!(duration > 0) || !Number.isFinite(duration) || power.samples.length !== power.intervals.length + 1) throw new Error('Invalid solar interval artifact.');
  validateTimeline(communication, duration);
  const origin = Date.parse(power.time.startUtc);
  const floorWh = b.capacityWh * b.reserveSocFraction;
  const initialWh = b.capacityWh * b.initialSocFraction;
  let stored: number | null = initialWh;
  let minimumKnownWh = initialWh, knownSeconds = 0, expectedStart = 0;
  const segments: BatterySegment[] = [];
  const totals = { pvToLoadWh: 0, chargeInputWh: 0, dischargeOutputWh: 0, batteryLossWh: 0, curtailedWh: 0, unservedWh: 0 };

  for (let i = 0; i < power.intervals.length; i++) {
    const interval = power.intervals[i], a = power.samples[i], z = power.samples[i + 1];
    const start = (Date.parse(interval.startUtc) - origin) / 1000;
    const end = (Date.parse(interval.endUtc) - origin) / 1000;
    if (Math.abs(start - expectedStart) > 1e-6 || end <= start || !Number.isFinite(end)
      || interval.startUtc !== a.timeUtc || interval.endUtc !== z.timeUtc) throw new Error('Solar intervals do not partition the mission.');
    expectedStart = end;
    if (stored == null || interval.quality.status !== 'valid' || interval.energyWh == null
      || a.unobstructedPowerW == null || z.unobstructedPowerW == null || interval.solarVisibleFraction == null) {
      segments.push({ startOffsetSeconds: start, endOffsetSeconds: end, available: null,
        batteryStartWh: stored, batteryEndWh: null, generationWh: interval.energyWh, loadWh: baseLoadW * (end - start) / 3600,
        pvToLoadWh: null, chargeInputWh: null, dischargeOutputWh: null, batteryLossWh: null, curtailedWh: null, unservedWh: null,
        reason: stored == null ? 'battery_state_unknown_after_gap' : 'solar_interval_unknown' });
      stored = null;
      continue;
    }
    const p0 = a.unobstructedPowerW * interval.solarVisibleFraction;
    const p1 = z.unobstructedPowerW * interval.solarVisibleFraction;
    if (![p0, p1].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Invalid solar power curve.');
    const seconds = end - start;
    const pvAt = (t: number) => p0 + (p1 - p0) * t / seconds;
    const cuts = [0, seconds];
    if (p0 !== p1) for (const level of [baseLoadW, baseLoadW + b.maxChargeW, baseLoadW - b.maxDischargeW]) {
      const t = (level - p0) * seconds / (p1 - p0);
      if (t > 1e-9 && t < seconds - 1e-9) cuts.push(t);
    }
    cuts.sort((x, y) => x - y);

    const emit = (l: number, r: number, charge: boolean, discharge: boolean) => {
      if (r - l <= 1e-10) return;
      const dt = r - l, pl = pvAt(l), pr = pvAt(r), mid = pvAt((l + r) / 2);
      const pvWh = energy(pl, pr, dt), loadWh = baseLoadW * dt / 3600;
      const pvToLoadWh = mid >= baseLoadW ? loadWh : pvWh;
      const chargeInputWh = charge ? energy(Math.min(b.maxChargeW, Math.max(0, pl - baseLoadW)), Math.min(b.maxChargeW, Math.max(0, pr - baseLoadW)), dt) : 0;
      const dischargeOutputWh = discharge ? energy(Math.min(b.maxDischargeW, Math.max(0, baseLoadW - pl)), Math.min(b.maxDischargeW, Math.max(0, baseLoadW - pr)), dt) : 0;
      const batteryStartWh = stored!;
      stored = Math.max(floorWh, Math.min(b.capacityWh, batteryStartWh + chargeInputWh * b.chargeEfficiency - dischargeOutputWh / b.dischargeEfficiency));
      minimumKnownWh = Math.min(minimumKnownWh, stored);
      const unservedWh = Math.max(0, loadWh - pvToLoadWh - dischargeOutputWh);
      const s: BatterySegment = { startOffsetSeconds: start + l, endOffsetSeconds: start + r,
        available: mid >= baseLoadW || (discharge && baseLoadW - mid <= b.maxDischargeW),
        batteryStartWh, batteryEndWh: stored, generationWh: pvWh, loadWh, pvToLoadWh,
        chargeInputWh, dischargeOutputWh, unservedWh, curtailedWh: Math.max(0, pvWh - pvToLoadWh - chargeInputWh),
        batteryLossWh: chargeInputWh * (1 - b.chargeEfficiency) + dischargeOutputWh * (1 / b.dischargeEfficiency - 1), reason: null };
      segments.push(s);
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += s[key]!;
      knownSeconds += dt;
    };
    for (let k = 0; k < cuts.length - 1; k++) {
      const l = cuts[k], r = cuts[k + 1];
      if (r - l < 1e-9) continue;
      const pl = pvAt(l), pr = pvAt(r), dt = r - l;
      if (pvAt((l + r) / 2) >= baseLoadW) {
        const c0 = Math.min(b.maxChargeW, Math.max(0, pl - baseLoadW));
        const c1 = Math.min(b.maxChargeW, Math.max(0, pr - baseLoadW));
        const inputWh = energy(c0, c1, dt), roomWh = Math.max(0, b.capacityWh - stored!);
        if (inputWh * b.chargeEfficiency > roomWh && inputWh > 0) {
          const t = timeForEnergy(c0, c1, dt, roomWh / b.chargeEfficiency);
          emit(l, l + t, true, false); emit(l + t, r, false, false);
        } else emit(l, r, true, false);
      } else {
        const d0 = Math.min(b.maxDischargeW, Math.max(0, baseLoadW - pl));
        const d1 = Math.min(b.maxDischargeW, Math.max(0, baseLoadW - pr));
        const outputWh = energy(d0, d1, dt), usableOutputWh = Math.max(0, stored! - floorWh) * b.dischargeEfficiency;
        if (outputWh > usableOutputWh && outputWh > 0) {
          const t = timeForEnergy(d0, d1, dt, usableOutputWh);
          emit(l, l + t, false, true); emit(l + t, r, false, false);
        } else emit(l, r, false, true);
      }
    }
  }
  if (Math.abs(expectedStart - duration) > 1e-6) throw new Error('Solar mission end does not match duration.');
  const complete = duration - knownSeconds < 1e-6;
  const demandWh = baseLoadW * duration / 3600;
  // Keep aggregate physical bounds despite floating-point summation roundoff.
  const unservedWh = Math.max(0, Math.min(demandWh, totals.unservedWh));
  const p = stats(segments, duration), c = stats(communication, duration);
  const jointTimeline = intersect(segments, communication), joint = stats(jointTimeline, duration);
  const r = settings.requirements;
  const measurable = complete && c.availabilityFraction != null && c.longestBlackoutSeconds != null;
  const powerFactor = p.availabilityFraction == null ? null : Math.min(1, p.availabilityFraction / r.minPowerAvailabilityFraction);
  const commsFactor = c.availabilityFraction == null ? null : r.minCommsAvailabilityFraction === 0 ? 1 : Math.min(1, c.availabilityFraction / r.minCommsAvailabilityFraction);
  const blackoutFactor = c.longestBlackoutSeconds == null ? null : c.longestBlackoutSeconds === 0 ? 1 : Math.min(1, r.maxCommsBlackoutHours * 3600 / c.longestBlackoutSeconds);
  const score = measurable ? 100 * powerFactor! * commsFactor! * blackoutFactor! : null;
  const requirementsMet = measurable ?
    (r.minPowerAvailabilityFraction === 1 ? p.outages.length === 0 : p.availabilityFraction! + 1e-12 >= r.minPowerAvailabilityFraction)
    && (r.minCommsAvailabilityFraction === 1 ? c.outages.length === 0 : c.availabilityFraction! + 1e-12 >= r.minCommsAvailabilityFraction)
    && (r.maxCommsBlackoutHours === 0 ? c.outages.length === 0 : c.longestBlackoutSeconds! <= r.maxCommsBlackoutHours * 3600 + 1e-6) : null;
  return {
    schemaVersion: '0.2.0', artifactType: 'mission', sourcePowerArtifactId: power.artifactId, siteId: power.siteId,
    time: { startUtc: power.time.startUtc, endUtc: power.time.endUtc, eventTimeConvention: 'offset-seconds-from-startUtc' },
    model: { id: 'dc-bus-linear-pv-constant-load-v1', dispatch: 'PV serves load, then charges; battery covers deficits down to reserve',
      exclusions: ['temperature', 'battery degradation', 'self discharge', 'variable loads', 'electrical converter dynamics'],
      numerics: { arithmetic: 'IEEE-754 binary64', eventRootIterations: 52,
        partitionToleranceSeconds: 1e-6, negligibleSegmentSeconds: 1e-10 } },
    parameters: { baseLoadW, ...structuredClone(settings) }, units: { energy: 'Wh', power: 'W', offsets: 's', soc: 'fraction' },
    summary: { durationSeconds: duration, complete, knownSeconds: complete ? duration : knownSeconds,
      unknownSeconds: complete ? 0 : duration - knownSeconds, initialBatteryWh: initialWh,
      finalBatteryWh: stored, finalSocFraction: stored == null || b.capacityWh === 0 ? null : stored / b.capacityWh,
      minimumBatteryWh: complete ? minimumKnownWh : null, minimumKnownBatteryWh: minimumKnownWh,
      loadEnergyWh: demandWh, servedLoadWh: complete ? demandWh - unservedWh : null,
      solarEnergyWh: power.summary.totalEnergyWh,
      unservedEnergyWh: complete ? unservedWh : null, knownUnservedEnergyWh: unservedWh,
      chargeInputWh: complete ? totals.chargeInputWh : null, dischargeOutputWh: complete ? totals.dischargeOutputWh : null,
      batteryLossWh: complete ? totals.batteryLossWh : null, curtailedEnergyWh: complete ? totals.curtailedWh : null,
      powerAvailabilityFraction: p.availabilityFraction, longestPowerOutageSeconds: p.longestBlackoutSeconds,
      knownLongestPowerOutageSeconds: p.knownLongestBlackoutSeconds, firstKnownPowerLossOffsetSeconds: p.outages[0]?.startOffsetSeconds ?? null,
      commsAvailabilityFraction: c.availabilityFraction, longestCommsBlackoutSeconds: c.longestBlackoutSeconds,
      jointAvailabilityFraction: joint.availabilityFraction, knownJointAvailableSeconds: joint.knownAvailableSeconds },
    viability: { score, requirementsMet, qualifiedForMissionDecision: measurable && power.summary.eligibleForTerrainComparison,
      components: { powerFactor, commsFactor, blackoutFactor },
      rule: '100 × min(power/required,1) × min(comms/required,1) × min(allowed-blackout/actual,1); score is not a probability' },
    segments, communication, powerOutages: p.outages, communicationBlackouts: c.outages,
    jointWindows: windows(jointTimeline, true),
  };
}
export type MissionResult = ReturnType<typeof simulateMission>;
