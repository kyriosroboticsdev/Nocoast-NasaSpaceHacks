import { assessMission, type TimeWindow } from '../assess/windows';
import { simulateStay, assertSolarContext } from '../power/stay';
import { panelFromThresholds } from '../power/adapter';
import { SITES } from '../power/model.mjs';
import { DEFAULT_MISSION_SETTINGS, type StateSegment } from '../power/mission';
import type { BackendAnalysis } from './backend';

type Window = { startUtc: string; endUtc: string };

/** Preserve the visibility owner's refined windows. Uncovered time is unknown. */
export function timelineFromWindows(startUtc: string, durationSeconds: number,
  on: Window[], off: Window[], unknown: Window[]): StateSegment[] {
  const start = Date.parse(startUtc);
  if (!Number.isFinite(start) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Invalid backend visibility time range.');
  }
  const spans = [...on.map(w => ({ ...w, available: true })),
    ...off.map(w => ({ ...w, available: false })), ...unknown.map(w => ({ ...w, available: null }))]
    .map(w => ({ startOffsetSeconds: (Date.parse(w.startUtc) - start) / 1000,
      endOffsetSeconds: (Date.parse(w.endUtc) - start) / 1000, available: w.available }))
    .sort((a, b) => a.startOffsetSeconds - b.startOffsetSeconds);
  const out: StateSegment[] = [];
  let at = 0;
  for (const s of spans) {
    if (!Number.isFinite(s.startOffsetSeconds) || !Number.isFinite(s.endOffsetSeconds)
      || s.endOffsetSeconds <= s.startOffsetSeconds || s.startOffsetSeconds < at - 1e-6
      || s.startOffsetSeconds < 0 || s.endOffsetSeconds > durationSeconds) {
      throw new Error('Invalid or overlapping backend visibility windows.');
    }
    if (s.startOffsetSeconds > at) out.push({ startOffsetSeconds: at, endOffsetSeconds: s.startOffsetSeconds, available: null });
    out.push(s); at = s.endOffsetSeconds;
  }
  if (at < durationSeconds) out.push({ startOffsetSeconds: at, endOffsetSeconds: durationSeconds, available: null });
  return out;
}

const stateAt = (timeline: StateSegment[], t: number) =>
  timeline.find(s => t >= s.startOffsetSeconds && t < s.endOffsetSeconds)?.available ?? null;

/** Use backend science directly, rather than re-raycasting its horizon in the UI. */
export function assessBackendMission(backend: BackendAnalysis, options: Parameters<typeof assessMission>[0]) {
  const a = assessMission(options);
  const duration = options.durationHours * 3600, start = Date.parse(options.startUtc);
  const earth = timelineFromWindows(options.startUtc, duration, backend.communication.windows,
    backend.communication.blackouts, backend.communication.unknown);
  const sunlight = timelineFromWindows(options.startUtc, duration, backend.sun.sunlitWindows,
    backend.sun.darkPeriods, backend.sun.unknown);
  const input = backend.solarInput ?? null;
  const observer = options.horizon.observer;
  if (input) {
    if (Object.hasOwn(SITES, options.siteId) && input.siteId !== options.siteId) throw new Error('Backend solar scenario mismatch.');
    try {
      assertSolarContext(input, { ...observer, observerHeightAboveGroundM: observer.heightAboveGroundM,
        frameId: options.horizon.frameId, startUtc: options.startUtc,
        endUtc: new Date(start + duration * 1000).toISOString() });
    } catch { throw new Error('Backend solar scenario mismatch.'); }
  }
  const result = input ? simulateStay(input, panelFromThresholds(options.thresholds), options.thresholds.batteryFloorW,
    options.missionSettings ?? DEFAULT_MISSION_SETTINGS, earth) : null;
  const power = result?.power ?? null, mission = result?.mission ?? null;
  const validated = power?.summary.eligibleForTerrainComparison ?? false;
  const times = [...new Set([...a.samples.map(s => s.utc), ...(input?.samples.map(s => s.timeUtc) ?? [])]
    .map(Date.parse))].sort((x, y) => x - y);
  let pi = 0, ai = 0;
  const baseSamples = a.samples;
  a.samples = times.map(t => {
    while (ai + 1 < baseSamples.length && Date.parse(baseSamples[ai + 1].utc) <= t) ai++;
    const near = baseSamples[ai];
    const offset = (t - start) / 1000;
    const sunlit = stateAt(sunlight, offset), earthLos = stateAt(earth, offset);
    while (power && pi + 1 < power.samples.length && Date.parse(power.samples[pi + 1].timeUtc) <= t) pi++;
    const p = power?.samples[pi], next = power?.samples[pi + 1];
    const u = p && next ? (t - Date.parse(p.timeUtc)) / (Date.parse(next.timeUtc) - Date.parse(p.timeUtc)) : 0;
    const watts = p?.unobstructedPowerW == null || p.solarVisibleFraction == null
      || (next && next.unobstructedPowerW == null) ? null
      : (p.unobstructedPowerW + u * ((next?.unobstructedPowerW ?? p.unobstructedPowerW) - p.unobstructedPowerW)) * p.solarVisibleFraction;
    const source = input?.samples[pi];
    return { ...near, utc: new Date(t).toISOString(), sunlit, earthLos, unknown: sunlit == null || earthLos == null,
      sunAz: source?.sun.azimuthDeg ?? near.sunAz, sunEl: source?.sun.elevationDeg ?? near.sunEl,
      solar: p ? { ...p, timeUtc: new Date(t).toISOString().replace('.000Z', 'Z'), powerW: watts }
        : { ...near.solar, powerW: null, unobstructedPowerW: null, normalIrradianceWm2: null,
          panelIrradianceWm2: null, incidenceCosine: null, incidenceAngleDeg: null,
          sunDirectionEnu: null, solarVisibleFraction: null, quality: { status: 'missing' as const, reason: 'backend_solar_unavailable' } },
      powerW: watts };
  });
  const windows = (ws: Window[]): TimeWindow[] => ws.map(w => ({ ...w, hours: (Date.parse(w.endUtc) - Date.parse(w.startUtc)) / 3600000 }));
  const knownHours = (ss: StateSegment[], value: boolean | null) => ss.filter(s => s.available === value)
    .reduce((sum, s) => sum + (s.endOffsetSeconds - s.startOffsetSeconds) / 3600, 0);
  a.sunlightWindows = windows(backend.sun.sunlitWindows);
  a.earthWindows = windows(backend.communication.windows);
  a.simultaneousWindows = windows(backend.sunAndCommunication.windows);
  a.sunlightHours = knownHours(sunlight, true); a.earthLosHours = knownHours(earth, true);
  a.simultaneousHours = a.simultaneousWindows.reduce((sum, w) => sum + w.hours, 0);
  a.sunlightPct = 100 * a.sunlightHours / options.durationHours;
  a.earthLosPct = 100 * a.earthLosHours / options.durationHours;
  a.simultaneousPct = 100 * a.simultaneousHours / options.durationHours;
  a.unknownHours = Math.max(knownHours(sunlight, null), knownHours(earth, null));
  a.longestSunBlackoutHours = (backend.sun.summary.longestGapSeconds ?? 0) / 3600;
  a.longestEarthBlackoutHours = (backend.communication.summary.longestGapSeconds ?? 0) / 3600;
  a.solarInput = input; a.solar = power; a.mission = mission; a.communication = earth;
  a.meanPowerW = power?.summary.meanPowerW ?? null; a.peakPowerW = power?.summary.sampledPeakPowerW ?? null;
  a.powerWarning = !power ? backend.solarInputUnavailableReason || 'Backend solar input unavailable here; power remains unknown.'
    : !power.summary.complete ? 'Incomplete solar data; totals remain unknown.'
    : 'Direct-beam model using backend visibility; thermal effects and eclipses excluded.';
  a.viability = mission?.viability.qualifiedForMissionDecision ? mission.viability.requirementsMet ? 'GO' : 'NO-GO' : 'UNKNOWN';
  a.viabilityReason = mission?.viability.score != null && !validated ? 'Illustrative estimate; measured terrain inputs are unavailable.' : a.powerWarning;
  const untilFalse = (ss: StateSegment[]) => {
    const t = (Date.parse(options.scrubUtc) - start) / 1000;
    if (stateAt(ss, t) == null) return null;
    if (!stateAt(ss, t)) return 0;
    const next = ss.find(s => s.endOffsetSeconds > t && s.available !== true);
    return next ? (next.startOffsetSeconds - t) / 3600 : null;
  };
  a.hoursToSunset = untilFalse(sunlight); a.hoursToEarthset = untilFalse(earth);
  return a;
}
