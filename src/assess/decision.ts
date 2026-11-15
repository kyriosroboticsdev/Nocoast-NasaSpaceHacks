import type { MissionAssessment, TimeWindow } from './windows';
import type { ViabilityGrade } from '../scenario/types';

export type InstantStatus = 'BOTH' | 'SUNLIT' | 'EARTH_LOS' | 'BLACKOUT' | 'UNKNOWN';

export type AuthorityTier = 'study' | 'overview' | 'sphere';

export type RankedSite = {
  siteId: string;
  label: string;
  publishedLabel: string;
  horizonModel: string;
  ephemerisSource: string;
  authorityTier: AuthorityTier;
  viability: ViabilityGrade;
  viabilityReason: string;
  sunlightPct: number;
  earthLosPct: number;
  simultaneousPct: number;
  meanPowerW: number | null;
  score: number;
  assessment: MissionAssessment;
};

export type DateSuggestion = {
  offsetDays: number;
  startUtc: string;
  viability: ViabilityGrade;
  sunlightPct: number;
  earthLosPct: number;
  simultaneousPct: number;
  meanPowerW: number | null;
  score: number;
  deltaSimultaneousPct: number;
  label: string;
  ephemerisSource: string;
};

/** Ops status at scrub time — independent of window-grade viability. */
export function instantStatusFromSample(sample: {
  sunlit: boolean | null;
  earthLos: boolean | null;
  unknown?: boolean;
} | undefined): InstantStatus {
  if (!sample || sample.unknown) return 'UNKNOWN';
  if (sample.sunlit == null && sample.earthLos == null) return 'UNKNOWN';
  if (sample.sunlit === true && sample.earthLos === true) return 'BOTH';
  if (sample.sunlit === true && sample.earthLos == null) return 'UNKNOWN';
  if (sample.earthLos === true && sample.sunlit == null) return 'UNKNOWN';
  if (sample.sunlit === true) return 'SUNLIT';
  if (sample.earthLos === true) return 'EARTH_LOS';
  if (sample.sunlit === false || sample.earthLos === false) return 'BLACKOUT';
  return 'UNKNOWN';
}

export function instantStatusLabel(status: InstantStatus): string {
  switch (status) {
    case 'BOTH': return 'SUN + EARTH ✓';
    case 'SUNLIT': return 'SUN ONLY · no Earth link';
    case 'EARTH_LOS': return 'EARTH ONLY · in shadow';
    case 'BLACKOUT': return 'DARK · no contact';
    default: return 'NO DATA';
  }
}

export function instantStatusClass(status: InstantStatus): string {
  switch (status) {
    case 'BOTH': return 'instant-both';
    case 'SUNLIT': return 'instant-sun';
    case 'EARTH_LOS': return 'instant-earth';
    case 'BLACKOUT': return 'instant-blackout';
    default: return 'instant-unknown';
  }
}

export function authorityTier(horizonModel: string): AuthorityTier {
  if (horizonModel === 'lola_terrain') return 'study';
  if (horizonModel === 'lola_overview_coarse') return 'overview';
  return 'sphere';
}

export function authorityBadge(horizonModel: string, ephemerisSource: string): string {
  const tier = authorityTier(horizonModel);
  const horiz =
    tier === 'study' ? 'LOLA 5 m' :
    tier === 'overview' ? 'LOLA overview' :
    'sphere';
  const eph = /bundled|jpl|live/i.test(ephemerisSource) && !/analytic/i.test(ephemerisSource)
    ? 'JPL'
    : /partial|unknown/i.test(ephemerisSource)
      ? 'JPL partial'
      : 'analytic';
  return `${horiz} · ${eph}`;
}

/** Prefer longest simultaneous ∩, else longest sunlight, else longest Earth LOS. */
export function findBestWindow(assessment: MissionAssessment): {
  kind: 'simultaneous' | 'sunlight' | 'earth' | 'none';
  window: TimeWindow | null;
} {
  const pick = (wins: TimeWindow[]) =>
    wins.reduce<TimeWindow | null>((best, w) => (!best || w.hours > best.hours ? w : best), null);

  const both = pick(assessment.simultaneousWindows);
  if (both && both.hours > 0) return { kind: 'simultaneous', window: both };
  const sun = pick(assessment.sunlightWindows);
  if (sun && sun.hours > 0) return { kind: 'sunlight', window: sun };
  const earth = pick(assessment.earthWindows);
  if (earth && earth.hours > 0) return { kind: 'earth', window: earth };
  return { kind: 'none', window: null };
}

/** Soft score; authority penalties keep sphere/analytic from outranking LOLA+JPL. */
export function scoreAssessment(a: MissionAssessment): number {
  return a.mission?.viability.qualifiedForMissionDecision && a.mission.viability.score != null
    ? a.mission.viability.score : -Infinity;
}

/**
 * Grade the landing the user actually configured.
 * Certified terrain validation stays on `qualifiedForMissionDecision`; this grade still
 * moves when site, date, stay, power, or Earth-contact requirements change.
 */
export function plannerViability(a: MissionAssessment): ViabilityGrade {
  const mission = a.mission;
  const met = mission?.viability.requirementsMet;
  if (met === true) return 'GO';
  if (met === false && mission) {
    const required = mission.parameters.requirements.minPowerAvailabilityFraction;
    const power = mission.summary.powerAvailabilityFraction;
    const outage = mission.summary.longestPowerOutageSeconds ?? 0;
    const powerMet = power != null && (required >= 1 - 1e-9 ? outage === 0 : power + 1e-12 >= required);
    return powerMet ? 'RISKY' : 'NO-GO';
  }
  if (a.sunlightPct >= 40 && a.earthLosPct >= 40) return 'GO';
  if (a.sunlightPct >= 20 && a.earthLosPct >= 20) return 'RISKY';
  if (a.meanPowerW == null && a.sunlightPct <= 0 && a.earthLosPct <= 0) return 'UNKNOWN';
  return a.samples.length ? 'NO-GO' : 'UNKNOWN';
}

/** Rankable score for planner search, including preliminary terrain. */
export function plannerScore(a: MissionAssessment): number {
  if (a.mission?.viability.score != null) return a.mission.viability.score;
  if (plannerViability(a) === 'UNKNOWN') return -Infinity;
  return a.sunlightPct * 0.45 + a.earthLosPct * 0.35 + a.simultaneousPct * 0.2;
}

function byAuthorityThenScore(a: RankedSite, b: RankedSite): number {
  const tierOrder = { study: 0, overview: 1, sphere: 2 };
  const td = tierOrder[a.authorityTier] - tierOrder[b.authorityTier];
  if (td !== 0) return td;
  return b.score - a.score;
}

export function rankAssessments(
  rows: Array<{
    siteId: string;
    label: string;
    publishedLabel: string;
    assessment: MissionAssessment;
  }>,
): RankedSite[] {
  return rows
    .filter(r => r.assessment.mission?.viability.qualifiedForMissionDecision)
    .map(r => ({
      siteId: r.siteId,
      label: r.label,
      publishedLabel: r.publishedLabel,
      horizonModel: r.assessment.horizonModel,
      ephemerisSource: r.assessment.ephemerisSource,
      authorityTier: authorityTier(r.assessment.horizonModel),
      viability: r.assessment.viability,
      viabilityReason: r.assessment.viabilityReason,
      sunlightPct: r.assessment.sunlightPct,
      earthLosPct: r.assessment.earthLosPct,
      simultaneousPct: r.assessment.simultaneousPct,
      meanPowerW: r.assessment.meanPowerW,
      score: scoreAssessment(r.assessment),
      assessment: r.assessment,
    }))
    .sort(byAuthorityThenScore);
}

/** Same columns as mission ranking, but preliminary terrain still produces an adoptable list. */
export function rankPlannerAssessments(
  rows: Array<{
    siteId: string;
    label: string;
    publishedLabel: string;
    assessment: MissionAssessment;
  }>,
): RankedSite[] {
  return rows
    .map(r => ({
      siteId: r.siteId,
      label: r.label,
      publishedLabel: r.publishedLabel,
      horizonModel: r.assessment.horizonModel,
      ephemerisSource: r.assessment.ephemerisSource,
      authorityTier: authorityTier(r.assessment.horizonModel),
      viability: plannerViability(r.assessment),
      viabilityReason: r.assessment.viabilityReason,
      sunlightPct: r.assessment.sunlightPct,
      earthLosPct: r.assessment.earthLosPct,
      simultaneousPct: r.assessment.simultaneousPct,
      meanPowerW: r.assessment.meanPowerW,
      score: plannerScore(r.assessment),
      assessment: r.assessment,
    }))
    .filter(r => r.score > -Infinity && r.viability !== 'UNKNOWN')
    .sort(byAuthorityThenScore);
}

export function buildDateSuggestions(
  baseline: MissionAssessment,
  candidates: Array<{ offsetDays: number; startUtc: string; assessment: MissionAssessment }>,
  opts?: { planner?: boolean },
): DateSuggestion[] {
  const baseScore = opts?.planner ? plannerScore(baseline) : scoreAssessment(baseline);
  return candidates
    .filter(c => opts?.planner
      ? plannerViability(c.assessment) !== 'UNKNOWN'
      : !!c.assessment.mission?.viability.qualifiedForMissionDecision)
    .map(c => {
      const score = opts?.planner ? plannerScore(c.assessment) : scoreAssessment(c.assessment);
      const viability = opts?.planner ? plannerViability(c.assessment) : c.assessment.viability;
      const sign = c.offsetDays > 0 ? '+' : '';
      return {
        offsetDays: c.offsetDays,
        startUtc: c.startUtc,
        viability,
        sunlightPct: c.assessment.sunlightPct,
        earthLosPct: c.assessment.earthLosPct,
        simultaneousPct: c.assessment.simultaneousPct,
        meanPowerW: c.assessment.meanPowerW,
        score,
        deltaSimultaneousPct: c.assessment.simultaneousPct - baseline.simultaneousPct,
        ephemerisSource: c.assessment.ephemerisSource,
        label: c.offsetDays === 0 ? 'Current start' : `Slip ${sign}${c.offsetDays} d`,
      };
    })
    .filter(s => s.offsetDays !== 0)
    .sort((a, b) => b.score - a.score || Math.abs(a.offsetDays) - Math.abs(b.offsetDays))
    .map(s => ({
      ...s,
      label: s.score > baseScore + 0.5
        ? `${s.label} · better`
        : s.score < baseScore - 0.5
          ? `${s.label} · worse`
          : s.label,
    }));
}

/** Plain-language why this site/date wins or fails — for Learn + NO-GO prompts. */
export function explainVerdict(a: MissionAssessment): string {
  if (a.mission?.viability.score != null) return `${a.siteLabel}: ${a.viabilityReason} Mission score ${a.mission.viability.score.toFixed(1)}/100; unserved load ${a.mission.summary.unservedEnergyWh!.toFixed(1)} Wh.`;
  if (a.viability === 'UNKNOWN') return `${a.siteLabel}: ${a.viabilityReason}`;
  const parts: string[] = [];
  if (a.viability === 'GO') {
    parts.push(
      `${a.siteLabel} works for this window: sunlit ${a.sunlightPct.toFixed(0)}% of the time, in contact with Earth ${a.earthLosPct.toFixed(0)}%, and both at once ${a.simultaneousPct.toFixed(0)}% — enough to recharge while talking home (average ~${a.meanPowerW?.toFixed(0) ?? 'unknown'} W).`,
    );
  } else if (a.viability === 'RISKY') {
    parts.push(
      `${a.siteLabel} is borderline: sun ${a.sunlightPct.toFixed(0)}%, Earth contact ${a.earthLosPct.toFixed(0)}%, both at once only ${a.simultaneousPct.toFixed(0)}%. It may need bigger batteries, a relay satellite, or a different week.`,
    );
  } else {
    parts.push(
      `${a.siteLabel} does not work here: sun ${a.sunlightPct.toFixed(0)}%, Earth contact ${a.earthLosPct.toFixed(0)}%, both at once ${a.simultaneousPct.toFixed(0)}%, average power ~${a.meanPowerW?.toFixed(0) ?? 'unknown'} W.`,
    );
  }
  if (a.horizonModel === 'sphere_optimistic') {
    parts.push('Terrain detail for this spot is not mapped in this tool — real ridges could make it worse.');
  } else if (a.horizonModel === 'lola_overview_coarse') {
    parts.push('Terrain here uses the coarse regional map (not the high-detail study data).');
  } else {
    parts.push('Terrain uses high-detail NASA elevation data (LOLA) for this spot.');
  }
  if ((a.unknownHours ?? 0) > 0.5) {
    parts.push(`About ${a.unknownHours.toFixed(1)} h fall outside the precise data coverage (unknown, not necessarily dark).`);
  }
  if (/analytic/i.test(a.ephemerisSource)) {
    parts.push('Sun/Earth positions use a simplified fallback model here — exact JPL data is used where available.');
  }
  const best = findBestWindow(a);
  if (best.window) {
    const kind =
      best.kind === 'simultaneous' ? 'sun + Earth together' :
      best.kind === 'sunlight' ? 'sunlight' : 'Earth contact';
    parts.push(`Longest stretch of ${kind} is ~${best.window.hours.toFixed(1)} h starting ${best.window.startUtc.slice(0, 16)}Z.`);
  }
  return parts.join(' ');
}

export const DATE_SLIP_OFFSETS_DAYS = [-21, -14, -7, -3, 3, 7, 14, 21] as const;

export function slipStartUtc(startUtc: string, offsetDays: number): string {
  return new Date(Date.parse(startUtc) + offsetDays * 86400_000).toISOString();
}
