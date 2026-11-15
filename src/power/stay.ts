import { simulate, type Panel, type SolarInput } from './model.mjs';
import { simulateMission, type MissionResult, type MissionSettings, type StateSegment } from './mission';

/** Shared dashboard/backend bridge. Complete data alone does not validate terrain. */
export function simulateStay(input: SolarInput, panel: Panel, loadW: number,
  settings: MissionSettings, communication: StateSegment[]) {
  const power = simulate(input, panel);
  const validation = input.provenance.visibility.validation as { status?: string } | undefined;
  power.summary.eligibleForTerrainComparison &&= validation?.status === 'validated';
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
