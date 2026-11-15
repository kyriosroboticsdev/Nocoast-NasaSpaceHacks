/**
 * Plain-language layer: turns a MissionAssessment into sentences and big
 * metric cards a first-time visitor can read. The expert grid keeps the raw
 * numbers; everything here is a translation, never a different computation.
 */
import type { MissionAssessment } from '../assess/windows';
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

/** "18 h" / "2.1 days" — spans for prose, never "now / already set". */
export function fmtSpan(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${hours.toFixed(0)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

function sunPhrase(a: MissionAssessment): string {
  const p = a.sunlightPct;
  if (p >= 95) return 'the Sun shines nearly the whole time';
  if (p >= 70) return `the site is sunlit most of the time (${p.toFixed(0)}%)`;
  if (p >= 40) return `the site gets sunlight about ${p.toFixed(0)}% of the time`;
  return `the site sits in shadow most of the time (only ${p.toFixed(0)}% sun)`;
}

function earthPhrase(a: MissionAssessment): string {
  const p = a.earthLosPct;
  const gap = a.longestEarthBlackoutHours;
  const gapTxt = gap >= 6 ? `, with no-contact gaps up to ${fmtSpan(gap)}` : '';
  if (p >= 95) return `Earth stays in radio view almost continuously${gapTxt}`;
  if (p >= 60) return `the lander can radio Earth ${p.toFixed(0)}% of the time${gapTxt}`;
  if (p >= 20) return `radio contact with Earth is patchy (${p.toFixed(0)}% of the time${gapTxt})`;
  return `Earth is almost never in radio view (${p.toFixed(0)}%${gapTxt})`;
}

function powerClause(a: MissionAssessment, th: ScenarioThresholds): string | null {
  if (a.meanPowerW == null) return 'Solar power for this window is unknown';
  if (a.meanPowerW >= th.batteryFloorW) return null;
  return `Solar panels would average ~${fmtPower(a.meanPowerW)} against the ~${fmtPower(th.batteryFloorW)} the lander needs`;
}

function verdictClause(a: MissionAssessment): string {
  if (a.viability === 'GO') return 'Overall: a good window — power and Earth contact both hold up.';
  if (a.viability === 'RISKY') {
    return 'Overall: doable but risky — it would need big batteries, a relay satellite, or some luck.';
  }
  return 'Overall: this site-and-date combination does not work — try another week or another site.';
}

function terrainCaveat(a: MissionAssessment): string | null {
  if (a.horizonModel === 'sphere_optimistic') {
    return 'Terrain detail for this spot is not mapped in this tool, so the real view could be worse.';
  }
  return null;
}

/** 2–3 sentence story of this site + window, no jargon, numbers kept. */
export function plainSummary(a: MissionAssessment, th: ScenarioThresholds): string {
  const parts = [`Here, ${sunPhrase(a)} and ${earthPhrase(a)}.`];
  const power = powerClause(a, th);
  if (power) parts.push(`${power}.`);
  parts.push(verdictClause(a));
  const caveat = terrainCaveat(a);
  if (caveat) parts.push(caveat);
  return parts.join(' ');
}

/** The dominant failure in human terms — for RISKY / NO-GO prompts. */
export function plainConsequence(a: MissionAssessment, th: ScenarioThresholds): string {
  const problems: string[] = [];
  if (a.sunlightPct < 40) {
    problems.push('The site spends most of this window in darkness.');
  } else if (a.meanPowerW != null && a.meanPowerW < th.batteryFloorW) {
    problems.push('The solar panels cannot keep up — the batteries would drain faster than they recharge.');
  }
  if (a.longestEarthBlackoutHours >= 24) {
    problems.push(`Mission control would lose contact for up to ${fmtSpan(a.longestEarthBlackoutHours)} at a time.`);
  } else if (a.earthLosPct < 40) {
    problems.push('Radio contact with Earth is available less than half the time.');
  }
  if (!problems.length) {
    problems.push('Margins are thin — sunlight and Earth contact rarely line up at the same time.');
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
      note: 'of the window in daylight',
    },
    {
      icon: '📡', label: 'Earth contact', tone: earthTone,
      value: `${a.earthLosPct.toFixed(0)}%`,
      note: 'of the window in radio contact',
    },
    {
      icon: '🔋', label: 'Solar power', tone: powerTone,
      value: fmtPower(a.meanPowerW),
      note: `average, vs ~${fmtPower(th.batteryFloorW)} needed`,
    },
    {
      icon: '⏳', label: 'Longest contact gap', tone: gapTone,
      value: gap > 0 ? fmtSpan(gap) : 'none',
      note: 'longest stretch with no link to Earth',
    },
  ];
}
