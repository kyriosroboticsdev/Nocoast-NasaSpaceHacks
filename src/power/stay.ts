import { simulate, FRAME_ID, type Panel, type SolarInput } from './model.mjs';
import { simulateMission, type MissionResult, type MissionSettings, type StateSegment } from './mission';

export type SolarContext = {
  latitudeDeg: number; longitudeEastDeg: number; surfaceElevationM?: number;
  startUtc: string; endUtc: string; frameId?: string; observerHeightAboveGroundM?: number;
};

/** Match a reusable science artifact to the point and stay currently requested. */
export function assertSolarContext(input: SolarInput, context: SolarContext) {
  const start = Date.parse(context.startUtc), end = Date.parse(context.endUtc);
  const longitudeDifference = Math.abs(((input.site.longitudeEastDeg - context.longitudeEastDeg + 540) % 360) - 180);
  if (![context.latitudeDeg, context.longitudeEastDeg, input.site.latitudeDeg, input.site.longitudeEastDeg,
    input.site.surfaceElevationM, start, end].every(Number.isFinite)
    || (context.surfaceElevationM !== undefined && (!Number.isFinite(context.surfaceElevationM)
      || Math.abs(input.site.surfaceElevationM - context.surfaceElevationM) > 0.01))
    || Math.abs(input.site.latitudeDeg - context.latitudeDeg) > 1e-6 || longitudeDifference > 1e-6
    || input.frameId !== (context.frameId ?? FRAME_ID)
    || input.observerHeightAboveGroundM !== (context.observerHeightAboveGroundM ?? 2)
    || Date.parse(input.time.startUtc) !== start || Date.parse(input.time.endUtc) !== end || end <= start) {
    throw new Error('Solar input does not match the requested location, observer or stay.');
  }
}

/** Shared dashboard/backend bridge; terrain validation stays provenance, not a grade gate. */
export function simulateStay(input: SolarInput, panel: Panel, loadW: number,
  settings: MissionSettings, communication: StateSegment[]) {
  const power = simulate(input, panel);
  return { power, mission: simulateMission(power, loadW, settings, communication) };
}

/** Judge the exact mission artifact, never rounded landing-day sweep statistics. */
export function missionVerdict(mission: MissionResult | null | undefined) {
  if (!mission || mission.viability.requirementsMet == null) return 'unknown';
  if (!mission.viability.qualifiedForMissionDecision) return 'preliminary';
  if (mission.viability.requirementsMet) return 'go';
  const required = mission.parameters.requirements.minPowerAvailabilityFraction;
  const powerMet = required === 1 ? mission.powerOutages.length === 0
    : mission.summary.powerAvailabilityFraction != null && mission.summary.powerAvailabilityFraction + 1e-12 >= required;
  return powerMet ? 'caution' : 'nogo';
}
