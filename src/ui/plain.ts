/**
 * Plain-language summaries and metric cards for first-time visitors.
 * The expert view keeps the detailed numbers; these explanations make them
 * easier to understand without changing the underlying assessment.
 */
import type { MissionAssessment } from '../assess/windows';
import { plannerViability } from '../assess/decision';
import type { ScenarioThresholds } from '../scenario/types';
import { fmtPower } from './format';

export type CardTone = 'good' | 'warn' | 'bad';

export type SimpleCard = {
  icon: string;
  label: string;
  value: string;
  note: string;
  tone: CardTone;
};

/** Format a duration for sentences, such as "18 hours" or "2.1 days". */
export function fmtSpan(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${hours.toFixed(0)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

function sunPhrase(a: MissionAssessment): string {
  const p = a.sunlightPct;
  if (p >= 95) return 'the Sun is up almost the entire time';
  if (p >= 70) return `the site gets sunlight most of the time (${p.toFixed(0)}%)`;
  if (p >= 40) return `the site gets sunlight about ${p.toFixed(0)}% of the time`;
  return `the site is in shadow most of the time, with sunlight only ${p.toFixed(0)}% of the time`;
}

function earthPhrase(a: MissionAssessment): string {
  const p = a.earthLosPct;
  const gap = a.longestEarthBlackoutHours;
  const gapTxt = gap >= 6 ? `, with communication gaps lasting up to ${fmtSpan(gap)}` : '';
  if (p >= 95) return `the lander can stay in touch with Earth almost all the time${gapTxt}`;
  if (p >= 60) return `the lander can contact Earth ${p.toFixed(0)}% of the time${gapTxt}`;
  if (p >= 20) return `contact with Earth is limited (${p.toFixed(0)}% of the time${gapTxt})`;
  return `the lander can rarely contact Earth (${p.toFixed(0)}% of the time${gapTxt})`;
}

function powerClause(a: MissionAssessment, th: ScenarioThresholds): string | null {
  if (a.meanPowerW == null) return 'Solar power for this window is unknown';
  if (a.meanPowerW >= th.batteryFloorW) return null;
  return `The panels would produce about ${fmtPower(a.meanPowerW)} on average, below the lander's estimated need of ${fmtPower(th.batteryFloorW)}`;
}

function verdictClause(a: MissionAssessment): string {
  const grade = plannerViability(a);
  if (grade === 'UNKNOWN') return a.mission?.summary.complete
    ? 'There is not enough complete power and contact data to grade this stay.'
    : 'There is not enough data to judge this stay.';
  if (grade === 'GO') return 'Overall, this looks like a good time to land: power and Earth contact both look promising.';
  if (grade === 'RISKY') {
    return 'Overall, this could work, but it comes with risks. Extra battery capacity or a relay satellite may help.';
  }
  return 'Overall, this site and date are not a good fit. Try a different week or landing site.';
}

function terrainCaveat(a: MissionAssessment): string | null {
  if (a.horizonModel === 'sphere_optimistic') {
    return 'Detailed terrain data is not available for this spot, so actual conditions could be less favorable.';
  }
  return null;
}

/** A short, plain-language summary of a site and mission window. */
export function plainSummary(a: MissionAssessment, th: ScenarioThresholds): string {
  const parts = [`At this site, ${sunPhrase(a)}, and ${earthPhrase(a)}.`];
  const power = powerClause(a, th);
  if (power) parts.push(`${power}.`);
  parts.push(verdictClause(a));
  const caveat = terrainCaveat(a);
  if (caveat) parts.push(caveat);
  return parts.join(' ');
}

/** Explain the main concerns for a RISKY or NO-GO result. */
export function plainConsequence(a: MissionAssessment, th: ScenarioThresholds): string {
  const problems: string[] = [];
  if (a.sunlightPct < 40) {
    problems.push('This site spends much of the mission window in darkness.');
  } else if (a.meanPowerW != null && a.meanPowerW < th.batteryFloorW) {
    problems.push('The panels may not keep up with demand, so the batteries could run down faster than they recharge.');
  }
  if (a.longestEarthBlackoutHours >= 24) {
    problems.push(`Mission control could lose contact for up to ${fmtSpan(a.longestEarthBlackoutHours)} at a time.`);
  } else if (a.earthLosPct < 40) {
    problems.push('The lander can contact Earth for less than half of the mission window.');
  }
  if (!problems.length) {
    problems.push('There is little margin for error: sunlight and Earth contact rarely happen at the same time.');
  }
  const caveat = terrainCaveat(a);
  if (caveat) problems.push(caveat);
  return problems.join(' ');
}

export function simpleCards(a: MissionAssessment, th: ScenarioThresholds): SimpleCard[] {
  const sunTone: CardTone = a.sunlightPct >= 70 ? 'good' : a.sunlightPct >= 40 ? 'warn' : 'bad';
  const earthTone: CardTone = a.earthLosPct >= 70 ? 'good' : a.earthLosPct >= 40 ? 'warn' : 'bad';
  const powerTone: CardTone =
    a.meanPowerW == null ? 'warn'
    : a.meanPowerW >= th.batteryFloorW ? 'good'
    : a.meanPowerW >= th.batteryFloorW * 0.5 ? 'warn' : 'bad';
  const gap = a.longestEarthBlackoutHours;
  const gapTone: CardTone = gap <= 12 ? 'good' : gap <= 48 ? 'warn' : 'bad';
  return [
    {
      icon: '☀️', label: 'Sunlight', tone: sunTone,
      value: `${a.sunlightPct.toFixed(0)}%`,
      note: 'of the mission window',
    },
    {
      icon: '📡', label: 'Earth contact', tone: earthTone,
      value: `${a.earthLosPct.toFixed(0)}%`,
      note: 'of the mission window',
    },
    {
      icon: '🔋', label: 'Solar power', tone: powerTone,
      value: fmtPower(a.meanPowerW),
      note: `average; about ${fmtPower(th.batteryFloorW)} needed`,
    },
    {
      icon: '⏳', label: 'Longest contact gap', tone: gapTone,
      value: gap > 0 ? fmtSpan(gap) : 'None',
      note: 'longest time without an Earth connection',
    },
  ];
}
