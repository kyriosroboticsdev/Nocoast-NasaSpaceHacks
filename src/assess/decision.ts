import type { MissionAssessment, TimeWindow } from './windows';
import type { ViabilityGrade } from '../scenario/types';

export type InstantStatus = 'BOTH' | 'SUNLIT' | 'EARTH_LOS' | 'BLACKOUT' | 'UNKNOWN';

export type RankedSite = {
  siteId: string;
  label: string;
  publishedLabel: string;
  horizonModel: string;
  viability: ViabilityGrade;
  viabilityReason: string;
  sunlightPct: number;
  earthLosPct: number;
  simultaneousPct: number;
  meanPowerW: number;
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
  meanPowerW: number;
  score: number;
  deltaSimultaneousPct: number;
  label: string;
};

/** Ops status at scrub time — independent of window-grade viability. */
export function instantStatusFromSample(sample: {
  sunlit: boolean | null;
  earthLos: boolean | null;
} | undefined): InstantStatus {
  if (!sample) return 'UNKNOWN';
  if (sample.sunlit === true && sample.earthLos === true) return 'BOTH';
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

/** Composite score: simultaneous first, then sun/Earth, then power, with viability bonus. */
export function scoreAssessment(a: MissionAssessment): number {
  const viab =
    a.viability === 'GO' ? 30 :
    a.viability === 'RISKY' ? 12 : 0;
  return (
    a.simultaneousPct * 2.2 +
    a.sunlightPct * 0.9 +
    a.earthLosPct * 0.9 +
    Math.min(40, a.meanPowerW) * 0.35 +
    viab -
    a.longestSunBlackoutHours * 0.15 -
    a.longestEarthBlackoutHours * 0.1
  );
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
    .map(r => ({
      siteId: r.siteId,
      label: r.label,
      publishedLabel: r.publishedLabel,
      horizonModel: r.assessment.horizonModel,
      viability: r.assessment.viability,
      viabilityReason: r.assessment.viabilityReason,
      sunlightPct: r.assessment.sunlightPct,
      earthLosPct: r.assessment.earthLosPct,
      simultaneousPct: r.assessment.simultaneousPct,
      meanPowerW: r.assessment.meanPowerW,
      score: scoreAssessment(r.assessment),
      assessment: r.assessment,
    }))
    .sort((a, b) => b.score - a.score);
}

export function buildDateSuggestions(
  baseline: MissionAssessment,
  candidates: Array<{ offsetDays: number; startUtc: string; assessment: MissionAssessment }>,
): DateSuggestion[] {
  const baseScore = scoreAssessment(baseline);
  return candidates
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
        label: c.offsetDays === 0 ? 'Current start' : `Slip ${sign}${c.offsetDays} d`,
      };
    })
    .filter(s => s.offsetDays !== 0)
    .sort((a, b) => b.score - a.score || Math.abs(a.offsetDays) - Math.abs(b.offsetDays))
    .map(s => ({
      ...s,
      // Annotate relative to baseline after sort for display helpers.
      label: s.score > baseScore + 0.5
        ? `${s.label} · better`
        : s.score < baseScore - 0.5
          ? `${s.label} · worse`
          : s.label,
    }));
}

/** Plain-language why this site/date wins or fails — for Learn + NO-GO prompts. */
export function explainVerdict(a: MissionAssessment): string {
  const parts: string[] = [];
  if (a.viability === 'GO') {
    parts.push(
      `${a.siteLabel} looks viable over this window: sunlight ${a.sunlightPct.toFixed(0)}%, Earth LOS ${a.earthLosPct.toFixed(0)}%, simultaneous ${a.simultaneousPct.toFixed(0)}%.`,
    );
  } else if (a.viability === 'RISKY') {
    parts.push(
      `${a.siteLabel} is marginal: sunlight ${a.sunlightPct.toFixed(0)}%, Earth LOS ${a.earthLosPct.toFixed(0)}%. Storage, relay, or a date slip may be needed.`,
    );
  } else {
    parts.push(
      `${a.siteLabel} fails planning thresholds here: sunlight ${a.sunlightPct.toFixed(0)}%, Earth LOS ${a.earthLosPct.toFixed(0)}%, simultaneous only ${a.simultaneousPct.toFixed(0)}%.`,
    );
  }
  if (a.horizonModel === 'sphere_optimistic') {
    parts.push('Horizon is an optimistic sphere — real terrain could worsen obstruction.');
  } else {
    parts.push('Horizon uses measured LOLA terrain for this study point.');
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
