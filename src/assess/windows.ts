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

function windowsFromFlags(samples: InstantAssessment[], flag: (s: InstantAssessment) => boolean | null): TimeWindow[] {
  const out: TimeWindow[] = [];
  let open: string | null = null;
  let prev: InstantAssessment | null = null;
  for (const s of samples) {
    const on = flag(s) === true;
    if (on && !open) open = s.utc;
    if (!on && open && prev) {
      out.push({
        startUtc: open,
        endUtc: prev.utc,
        hours: (Date.parse(prev.utc) - Date.parse(open)) / 3600_000,
      });
      open = null;
    }
    prev = s;
  }
  if (open && prev) {
    out.push({
      startUtc: open,
      endUtc: prev.utc,
      hours: (Date.parse(prev.utc) - Date.parse(open)) / 3600_000,
    });
  }
  return out;
}

function longestGap(samples: InstantAssessment[], flag: (s: InstantAssessment) => boolean | null): number {
  let max = 0;
  let run = 0;
  let prevT: number | null = null;
  for (const s of samples) {
    const t = Date.parse(s.utc);
    const off = flag(s) !== true;
    if (off && prevT != null) {
      run += (t - prevT) / 3600_000;
      max = Math.max(max, run);
    } else if (!off) {
      run = 0;
    }
    prevT = t;
  }
  return max;
}

function hoursUntilFalse(samples: InstantAssessment[], fromUtc: string, flag: (s: InstantAssessment) => boolean | null): number | null {
  const from = Date.parse(fromUtc);
  const start = samples.find(s => Date.parse(s.utc) >= from) ?? samples[samples.length - 1];
  if (!start || flag(start) !== true) return 0;
  for (const s of samples) {
    if (Date.parse(s.utc) < from) continue;
    if (flag(s) !== true) return (Date.parse(s.utc) - from) / 3600_000;
  }
  return null; // remains true through end of window
}

export function assessInstant(
  utc: string,
  provider: EphemerisProvider,
  horizon: HorizonProfile,
  thresholds: ScenarioThresholds,
): InstantAssessment {
  const sun = provider.get('sun', utc);
  const earth = provider.get('earth', utc);
  const sunHorizon = horizonElevationAt(horizon, sun.azimuthDeg);
  const earthHorizon = horizonElevationAt(horizon, earth.azimuthDeg);
  const sunClear = sunHorizon == null ? null : sun.elevationDeg - sunHorizon;
  const earthClear = earthHorizon == null ? null : earth.elevationDeg - earthHorizon;
  const sunlit = sunClear == null ? null : sunClear > 0;
  const earthLos = earthClear == null ? null : earthClear >= thresholds.minEarthElevationDeg;
  const clearEl = sunClear != null && sunClear > 0 ? sunClear : 0;
  const tilt = thresholds.panelTiltDeg * Math.PI / 180;
  // Simple irradiance proxy ∝ max(0, sin(el_clear)) with optional tilt boost.
  const irradianceProxy = Math.max(0, Math.sin((clearEl + thresholds.panelTiltDeg * 0.25) * Math.PI / 180));
  const solarConstant = 1361;
  const powerW = solarConstant * thresholds.panelAreaM2 * thresholds.panelEfficiency * irradianceProxy * Math.cos(tilt * 0.1);
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
  const samples: InstantAssessment[] = [];
  const start = Date.parse(options.startUtc);
  const n = Math.max(1, Math.round(options.durationHours / step));
  for (let i = 0; i <= n; i++) {
    const utc = new Date(start + i * step * 3600_000).toISOString();
    samples.push(assessInstant(utc, options.provider, options.horizon, options.thresholds));
  }

  const sunlightWindows = windowsFromFlags(samples, s => s.sunlit);
  const earthWindows = windowsFromFlags(samples, s => s.earthLos);
  const simultaneousWindows = windowsFromFlags(samples, s => s.sunlit === true && s.earthLos === true);

  const span = options.durationHours || 1;
  const sunlightHours = sunlightWindows.reduce((a, w) => a + w.hours, 0);
  const earthLosHours = earthWindows.reduce((a, w) => a + w.hours, 0);
  const simultaneousHours = simultaneousWindows.reduce((a, w) => a + w.hours, 0);
  const powers = samples.map(s => s.powerW);
  const meanPowerW = powers.reduce((a, b) => a + b, 0) / powers.length;
  const peakPowerW = Math.max(...powers);

  const sunlightPct = (100 * sunlightHours) / span;
  const earthLosPct = (100 * earthLosHours) / span;
  const simultaneousPct = (100 * simultaneousHours) / span;

  let viability: ViabilityGrade = 'NO-GO';
  let viabilityReason = 'Insufficient sunlight or Earth LOS for the selected thresholds.';
  if (sunlightPct >= 40 && earthLosPct >= 40 && meanPowerW >= options.thresholds.batteryFloorW) {
    viability = 'GO';
    viabilityReason = 'Sunlight and Earth LOS both meet planning thresholds with margin.';
  } else if (sunlightPct >= 20 && earthLosPct >= 20) {
    viability = 'RISKY';
    viabilityReason = 'Partial coverage — feasible with storage/relay or schedule tuning.';
  } else if (options.horizonModel === 'sphere_optimistic' && sunlightPct >= 15) {
    viability = 'RISKY';
    viabilityReason = 'Sphere-horizon estimate only — terrain may worsen real visibility.';
  }

  return {
    siteLabel: options.siteLabel,
    siteId: options.siteId,
    horizonModel: options.horizonModel,
    ephemerisSource: options.provider.sourceLabel,
    samples,
    sunlightWindows,
    earthWindows,
    simultaneousWindows,
    sunlightHours,
    earthLosHours,
    simultaneousHours,
    sunlightPct,
    earthLosPct,
    simultaneousPct,
    longestSunBlackoutHours: longestGap(samples, s => s.sunlit),
    longestEarthBlackoutHours: longestGap(samples, s => s.earthLos),
    meanPowerW,
    peakPowerW,
    viability,
    viabilityReason,
    hoursToSunset: hoursUntilFalse(samples, options.scrubUtc, s => s.sunlit),
    hoursToEarthset: hoursUntilFalse(samples, options.scrubUtc, s => s.earthLos),
  };
}
