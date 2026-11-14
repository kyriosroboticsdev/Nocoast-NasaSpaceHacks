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
    case 'BOTH': return 'BOTH · sun ∩ Earth';
    case 'SUNLIT': return 'SUNLIT · no Earth LOS';
    case 'EARTH_LOS': return 'EARTH LOS · no sun';
    case 'BLACKOUT': return 'BLACKOUT';
    default: return 'UNKNOWN';
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
    .sort((a, b) => {
      // Hard tier order: study → overview → sphere, then score within tier.
      const tierOrder = { study: 0, overview: 1, sphere: 2 };
      const td = tierOrder[a.authorityTier] - tierOrder[b.authorityTier];
      if (td !== 0) return td;
      return b.score - a.score;
    });
}

export function buildDateSuggestions(
  baseline: MissionAssessment,
  candidates: Array<{ offsetDays: number; startUtc: string; assessment: MissionAssessment }>,
): DateSuggestion[] {
  const baseScore = scoreAssessment(baseline);
  return candidates
    .filter(c => c.assessment.mission?.viability.qualifiedForMissionDecision)
    .map(c => {
      const score = scoreAssessment(c.assessment);
      const sign = c.offsetDays > 0 ? '+' : '';
      return {
        offsetDays: c.offsetDays,
        startUtc: c.startUtc,
        viability: c.assessment.viability,
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
      `${a.siteLabel} looks viable over this window: sunlight ${a.sunlightPct.toFixed(0)}%, Earth LOS ${a.earthLosPct.toFixed(0)}%, Sun ∩ Earth ${a.simultaneousPct.toFixed(0)}% (power while talking to Earth), mean power ~${(a.meanPowerW?.toFixed(0) ?? 'unknown')} W.`,
    );
  } else if (a.viability === 'RISKY') {
    parts.push(
      `${a.siteLabel} is marginal: sunlight ${a.sunlightPct.toFixed(0)}%, Earth LOS ${a.earthLosPct.toFixed(0)}%, Sun ∩ Earth ${a.simultaneousPct.toFixed(0)}%. Storage, relay, or a date slip may be needed when ∩ is thin.`,
    );
  } else {
    parts.push(
      `${a.siteLabel} fails planning thresholds here: sunlight ${a.sunlightPct.toFixed(0)}%, Earth LOS ${a.earthLosPct.toFixed(0)}%, Sun ∩ Earth only ${a.simultaneousPct.toFixed(0)}%, mean power ~${(a.meanPowerW?.toFixed(0) ?? 'unknown')} W.`,
    );
  }
  if (a.horizonModel === 'sphere_optimistic') {
    parts.push('Horizon is an optimistic sphere — real terrain could worsen obstruction.');
  } else if (a.horizonModel === 'lola_overview_coarse') {
    parts.push('Horizon uses coarse LOLA 320 m overview (regional search grade, not 5 m study).');
  } else {
    parts.push('Horizon uses measured LOLA terrain for this study point.');
  }
  if ((a.unknownHours ?? 0) > 0.5) {
    parts.push(`About ${a.unknownHours.toFixed(1)} h lack ephemeris coverage (unknown, not blackout).`);
  }
  if (/analytic/i.test(a.ephemerisSource)) {
    parts.push('Ephemeris is analytic fallback — prefer bundled JPL when available.');
  }
  const best = findBestWindow(a);
  if (best.window) {
    const kind =
      best.kind === 'simultaneous' ? 'sun ∩ Earth' :
      best.kind === 'sunlight' ? 'sunlight' : 'Earth LOS';
    parts.push(`Longest ${kind} stretch is ~${best.window.hours.toFixed(1)} h starting ${best.window.startUtc.slice(0, 16)}Z.`);
  }
  return parts.join(' ');
}

export const DATE_SLIP_OFFSETS_DAYS = [-21, -14, -7, -3, 3, 7, 14, 21] as const;

export function slipStartUtc(startUtc: string, offsetDays: number): string {
  return new Date(Date.parse(startUtc) + offsetDays * 86400_000).toISOString();
}
