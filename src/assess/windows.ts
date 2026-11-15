import { horizonElevationAt, type HorizonProfile } from '../horizon/types';
import type { EphemerisProvider } from '../ephemeris/horizons';
import type { ScenarioThresholds, ViabilityGrade } from '../scenario/types';

export type InstantAssessment = {
  utc: string;
  sunAz: number;
  sunEl: number;
  earthAz: number;
  earthEl: number;
  sunClearEl: number | null;
  earthClearEl: number | null;
  sunlit: boolean | null;
  earthLos: boolean | null;
  /** True when Sun or Earth ephemeris was missing for this instant. */
  unknown: boolean;
  irradianceProxy: number;
  powerW: number;
};

export type TimeWindow = { startUtc: string; endUtc: string; hours: number };

export type MissionAssessment = {
  siteLabel: string;
  siteId: string;
  horizonModel: string;
  ephemerisSource: string;
  samples: InstantAssessment[];
  sunlightWindows: TimeWindow[];
  earthWindows: TimeWindow[];
  simultaneousWindows: TimeWindow[];
  sunlightHours: number;
  earthLosHours: number;
  simultaneousHours: number;
  unknownHours: number;
  sunlightPct: number;
  earthLosPct: number;
  simultaneousPct: number;
  longestSunBlackoutHours: number;
  longestEarthBlackoutHours: number;
  meanPowerW: number;
  peakPowerW: number;
  viability: ViabilityGrade;
  viabilityReason: string;
  hoursToSunset: number | null;
  hoursToEarthset: number | null;
};

/** Build exact sample times on [start, end] with no overshoot past mission end. */
export function missionSampleTimes(startUtc: string, durationHours: number, stepHours: number): string[] {
  const start = Date.parse(startUtc);
  const end = start + Math.max(0, durationHours) * 3600_000;
  const stepMs = Math.max(1e-9, stepHours) * 3600_000;
  const out: string[] = [];
  for (let t = start; t < end - 1e-6; t += stepMs) {
    out.push(new Date(t).toISOString());
  }
  const endIso = new Date(end).toISOString();
  if (!out.length || out[out.length - 1] !== endIso) out.push(endIso);
  return out;
}

/**
 * Integrate a boolean|null flag across samples.
 * true/true → full segment; transition → half segment; null → unknown (not blackout).
 * Single-sample true near end still contributes via half-step transitions.
 */
function integrateFlag(
  samples: InstantAssessment[],
  flag: (s: InstantAssessment) => boolean | null,
): { windows: TimeWindow[]; onHours: number; offHours: number; unknownHours: number } {
  const windows: TimeWindow[] = [];
  let onHours = 0;
  let offHours = 0;
  let unknownHours = 0;
  let open: string | null = null;

  const midIso = (a: string, b: string) =>
    new Date((Date.parse(a) + Date.parse(b)) / 2).toISOString();

  const closeAt = (endUtc: string) => {
    if (!open) return;
    const hours = (Date.parse(endUtc) - Date.parse(open)) / 3600_000;
    if (hours > 1e-9) windows.push({ startUtc: open, endUtc, hours });
    open = null;
  };

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const dt = (Date.parse(b.utc) - Date.parse(a.utc)) / 3600_000;
    if (dt <= 0) continue;
    const fa = flag(a);
    const fb = flag(b);

    if (fa == null && fb == null) {
      closeAt(a.utc);
      unknownHours += dt;
      continue;
    }
    if (fa == null || fb == null) {
      // Half known / half unknown
      unknownHours += dt / 2;
      const known = fa ?? fb;
      const knownAtStart = fa != null;
      if (known === true) {
        onHours += dt / 2;
        if (knownAtStart) {
          if (!open) open = a.utc;
          closeAt(midIso(a.utc, b.utc));
        } else {
          open = midIso(a.utc, b.utc);
        }
      } else {
        offHours += dt / 2;
        closeAt(a.utc);
      }
      continue;
    }

    if (fa && fb) {
      onHours += dt;
      if (!open) open = a.utc;
    } else if (!fa && !fb) {
      offHours += dt;
      closeAt(a.utc);
    } else if (fa && !fb) {
      onHours += dt / 2;
      offHours += dt / 2;
      if (!open) open = a.utc;
      closeAt(midIso(a.utc, b.utc));
    } else {
      offHours += dt / 2;
      onHours += dt / 2;
      open = midIso(a.utc, b.utc);
    }
  }

  if (open && samples.length) closeAt(samples[samples.length - 1].utc);
  return { windows, onHours, offHours, unknownHours };
}

function longestFalseRun(samples: InstantAssessment[], flag: (s: InstantAssessment) => boolean | null): number {
  let max = 0;
  let run = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const dt = (Date.parse(b.utc) - Date.parse(a.utc)) / 3600_000;
    const fa = flag(a);
    const fb = flag(b);
    // Blackout only when explicitly false (unknown does not extend blackout).
    if (fa === false && fb === false) {
      run += dt;
      max = Math.max(max, run);
    } else if (fa === false && fb === true) {
      run += dt / 2;
      max = Math.max(max, run);
      run = 0;
    } else if (fa === true && fb === false) {
      run = dt / 2;
      max = Math.max(max, run);
    } else if (fa === false && fb == null) {
      // stop blackout at unknown
      max = Math.max(max, run);
      run = 0;
    } else {
      run = 0;
    }
  }
  return max;
}

function hoursUntilFalse(samples: InstantAssessment[], fromUtc: string, flag: (s: InstantAssessment) => boolean | null): number | null {
  const from = Date.parse(fromUtc);
  const start = samples.find(s => Date.parse(s.utc) >= from) ?? samples[samples.length - 1];
  if (!start) return null;
  if (flag(start) == null) return null;
  if (flag(start) !== true) return 0;
  for (const s of samples) {
    if (Date.parse(s.utc) < from) continue;
    const f = flag(s);
    if (f == null) return (Date.parse(s.utc) - from) / 3600_000;
    if (f !== true) return (Date.parse(s.utc) - from) / 3600_000;
  }
  return null;
}

export function assessInstant(
  utc: string,
  provider: EphemerisProvider,
  horizon: HorizonProfile,
  thresholds: ScenarioThresholds,
): InstantAssessment {
  const sun = provider.get('sun', utc);
  const earth = provider.get('earth', utc);
  if (!sun || !earth) {
    return {
      utc,
      sunAz: sun?.azimuthDeg ?? NaN,
      sunEl: sun?.elevationDeg ?? NaN,
      earthAz: earth?.azimuthDeg ?? NaN,
      earthEl: earth?.elevationDeg ?? NaN,
      sunClearEl: null,
      earthClearEl: null,
      sunlit: null,
      earthLos: null,
      unknown: true,
      irradianceProxy: 0,
      powerW: 0,
    };
  }

  const sunHorizon = horizonElevationAt(horizon, sun.azimuthDeg);
  const earthHorizon = horizonElevationAt(horizon, earth.azimuthDeg);
  const sunClear = sunHorizon == null ? null : sun.elevationDeg - sunHorizon;
  const earthClear = earthHorizon == null ? null : earth.elevationDeg - earthHorizon;
  const sunlit = sunClear == null ? null : sunClear > 0;
  const earthLos = earthClear == null ? null : earthClear >= thresholds.minEarthElevationDeg;

  // Power only when sunlit; incidence from true sun elevation + panel tilt (not clearance hacks).
  let irradianceProxy = 0;
  let powerW = 0;
  if (sunlit === true) {
    const tilt = thresholds.panelTiltDeg;
    // Effective incidence angle vs panel normal: sun elev toward tilt-facing panel.
    const incidenceElev = sun.elevationDeg + tilt;
    irradianceProxy = Math.max(0, Math.sin(incidenceElev * Math.PI / 180));
    const solarConstant = 1361;
    powerW = solarConstant * thresholds.panelAreaM2 * thresholds.panelEfficiency * irradianceProxy;
  }

  return {
    utc,
    sunAz: sun.azimuthDeg,
    sunEl: sun.elevationDeg,
    earthAz: earth.azimuthDeg,
    earthEl: earth.elevationDeg,
    sunClearEl: sunClear,
    earthClearEl: earthClear,
    sunlit,
    earthLos,
    unknown: false,
    irradianceProxy,
    powerW,
  };
}

export function assessMission(options: {
  siteId: string;
  siteLabel: string;
  horizonModel: string;
  provider: EphemerisProvider;
  horizon: HorizonProfile;
  startUtc: string;
  durationHours: number;
  scrubUtc: string;
  thresholds: ScenarioThresholds;
  stepHours?: number;
}): MissionAssessment {
  const step = options.stepHours ?? 1;
  const times = missionSampleTimes(options.startUtc, options.durationHours, step);
  const samples = times.map(utc => assessInstant(utc, options.provider, options.horizon, options.thresholds));

  const sunInt = integrateFlag(samples, s => s.sunlit);
  const earthInt = integrateFlag(samples, s => s.earthLos);
  const bothInt = integrateFlag(samples, s => (s.sunlit === true && s.earthLos === true ? true : s.sunlit == null || s.earthLos == null ? null : false));

  const span = Math.max(1e-9, options.durationHours);
  const sunlightHours = sunInt.onHours;
  const earthLosHours = earthInt.onHours;
  const simultaneousHours = bothInt.onHours;
  const unknownHours = Math.max(sunInt.unknownHours, earthInt.unknownHours);

  const powers = samples.filter(s => !s.unknown).map(s => s.powerW);
  const meanPowerW = powers.length ? powers.reduce((a, b) => a + b, 0) / powers.length : 0;
  const peakPowerW = powers.length ? Math.max(...powers) : 0;

  // Percent of mission duration (never inflate past 100 via overshoot).
  const sunlightPct = Math.min(100, (100 * sunlightHours) / span);
  const earthLosPct = Math.min(100, (100 * earthLosHours) / span);
  const simultaneousPct = Math.min(100, (100 * simultaneousHours) / span);

  // Known-fraction viability: do not treat unknown as blackout, but require enough known coverage.
  const knownFraction = Math.max(0, 1 - unknownHours / span);
  let viability: ViabilityGrade = 'NO-GO';
  let viabilityReason = 'Insufficient sunlight or Earth LOS for the selected thresholds.';

  const sphereOnly = options.horizonModel === 'sphere_optimistic';
  // Sphere alone must not get RISKY promotion without Earth LOS.
  if (sunlightPct >= 40 && earthLosPct >= 40 && meanPowerW >= options.thresholds.batteryFloorW && knownFraction >= 0.5) {
    viability = 'GO';
    viabilityReason = 'Sunlight and Earth LOS both meet planning thresholds with margin.';
  } else if (sunlightPct >= 20 && earthLosPct >= 20 && knownFraction >= 0.5) {
    viability = 'RISKY';
    viabilityReason = 'Partial coverage — feasible with storage/relay or schedule tuning.';
  } else if (sphereOnly) {
    viability = 'NO-GO';
    viabilityReason = 'Sphere-horizon estimate only — insufficient Earth/sun coverage (terrain unknown).';
  }

  if (unknownHours > span * 0.25) {
    viabilityReason += ` Ephemeris unknown for ~${unknownHours.toFixed(1)} h of the window.`;
  }

  return {
    siteLabel: options.siteLabel,
    siteId: options.siteId,
    horizonModel: options.horizonModel,
    ephemerisSource: options.provider.sourceLabel,
    samples,
    sunlightWindows: sunInt.windows,
    earthWindows: earthInt.windows,
    simultaneousWindows: bothInt.windows,
    sunlightHours,
    earthLosHours,
    simultaneousHours,
    unknownHours,
    sunlightPct,
    earthLosPct,
    simultaneousPct,
    longestSunBlackoutHours: longestFalseRun(samples, s => s.sunlit),
    longestEarthBlackoutHours: longestFalseRun(samples, s => s.earthLos),
    meanPowerW,
    peakPowerW,
    viability,
    viabilityReason,
    hoursToSunset: hoursUntilFalse(samples, options.scrubUtc, s => s.sunlit),
    hoursToEarthset: hoursUntilFalse(samples, options.scrubUtc, s => s.earthLos),
  };
}
