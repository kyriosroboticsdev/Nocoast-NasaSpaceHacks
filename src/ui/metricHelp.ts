/**
 * Plain-language Planner metric explanations — significance + how calculated.
 * Copy matches assess/windows.ts and assess/decision.ts (proxy power, unknown ≠ blackout).
 */

export type MetricHelpId =
  | 'sunlight'
  | 'earthLos'
  | 'sunEarth'
  | 'meanPower'
  | 'peakPower'
  | 'sunBlackout'
  | 'earthBlackout'
  | 'unknownHours'
  | 'timeSunset'
  | 'timeEarthset'
  | 'sunElev'
  | 'sunClear'
  | 'earthElev'
  | 'earthClear'
  | 'viability'
  | 'instant'
  | 'batteryFloor'
  | 'minEarthEl'
  | 'panelArea'
  | 'panelEff'
  | 'panelTilt';

export const METRIC_HELP: Record<MetricHelpId, { title: string; body: string }> = {
  sunlight: {
    title: 'Sunlight availability',
    body:
      'Share of the mission start→end span when the Sun clears the local terrain horizon (clearance > 0°). ' +
      'Counted from hourly samples; transitions count as half-on. Missing ephemeris or horizon bearings are unknown — they do not count as night.',
  },
  earthLos: {
    title: 'Can see Earth (radio contact)',
    body:
      'Share of the mission span with direct-to-Earth line of sight: Earth elevation above terrain must meet the Min Earth elevation threshold (default 5°). ' +
      'No lunar relay is modeled — this is DTE only. Unknown hours are gaps, not blackout.',
  },
  sunEarth: {
    title: 'Sun + Earth together',
    body:
      'Hours when the site is both sunlit and in view of Earth at once. That is the ops sweet spot: solar panels can charge while you talk to Earth without a relay — power delivery and commanding together. ' +
      'Outside those hours you may have sunlight but no Earth link (store data / wait for Earthrise) or Earth contact while in shadow (draw from battery). Percent is simultaneous hours ÷ mission length.',
  },
  meanPower: {
    title: 'Average solar power',
    body:
      'Average of the rough panel power at each known sample (unknown hours excluded). When sunlit: 1361 W/m² × panel area × efficiency × max(0, sin(sun elevation + tilt)); otherwise 0 W. ' +
      'This is a geometry proxy for comparing sites/dates — not a flight electrical model. GO also requires mean power ≥ battery floor.',
  },
  peakPower: {
    title: 'Peak solar power',
    body:
      'Highest sample power in the known window using the same proxy formula as mean power. Useful for sizing headroom; GO gates use the mean vs battery floor, not the peak.',
  },
  sunBlackout: {
    title: 'Longest darkness stretch',
    body:
      'Longest contiguous stretch where sunlight is explicitly false (terrain-blocked or below horizon). Unknown samples stop a blackout run — gaps are not treated as night. Guides battery / eclipse sizing.',
  },
  earthBlackout: {
    title: 'Longest Earth-contact gap',
    body:
      'Longest contiguous stretch without Earth LOS (elevation below terrain + min-elevation gate). Unknown stops the run. Long blackouts mean no DTE until Earthrise or a relay.',
  },
  unknownHours: {
    title: 'Unknown hours',
    body:
      'Time lacking usable Sun/Earth ephemeris or horizon clearance (for example past bundled Horizons coverage). Unknown is not blackout and not availability — viability still requires enough known coverage (≥ ~50% for GO/RISKY).',
  },
  timeSunset: {
    title: 'Time to sunset',
    body:
      'From the scrub instant, hours until sunlight first becomes false. 0 if already in shadow; blank/— if sunlit through the remaining samples. Scrub-only — does not change the mission-window grade.',
  },
  timeEarthset: {
    title: 'Time to Earthset',
    body:
      'From scrub, hours until Earth LOS first fails the clearance / min-elevation gate. 0 if already out of contact; — if Earth stays up. Ops timing for the last DTE pass in this span.',
  },
  sunElev: {
    title: 'Sun elevation (scrub)',
    body:
      'Geometric sun elevation above the local horizontal at scrub (airless; no refraction). Positive does not guarantee sunlight — terrain may still block; see sun clear elev.',
  },
  sunClear: {
    title: 'Sun clear elevation',
    body:
      'Sun elevation minus the terrain horizon height in that azimuth. > 0 ⇒ counted sunlit for power. LOLA study/overview profiles vs optimistic sphere change this number.',
  },
  earthElev: {
    title: 'Earth elevation (scrub)',
    body:
      'Geometric Earth elevation above local horizontal at scrub. Still must clear terrain and meet the min Earth elevation threshold for LOS.',
  },
  earthClear: {
    title: 'Earth clear elevation',
    body:
      'Earth elevation minus terrain horizon in that azimuth. LOS is true only when this clearance ≥ Min Earth elevation °.',
  },
  viability: {
    title: 'Mission window grade',
    body:
      'GO: sunlight ≥ 40%, Earth LOS ≥ 40%, mean power ≥ battery floor, and ≥ ~50% of hours known. ' +
      'RISKY: sunlight and Earth LOS each ≥ 20% with enough known coverage (storage/relay/date slip may still be needed). ' +
      'NO-GO: below those bars (sphere-only sites may be labeled terrain-unknown). Grades the full start→end window — not the scrub chip.',
  },
  instant: {
    title: 'At slider time',
    body:
      'Status for the single moment the time slider points at: SUN + EARTH (both at once), SUN ONLY (power, no Earth link), EARTH ONLY (contact, in shadow), DARK (neither), or NO DATA (coverage gap). Independent of the window grade.',
  },
  batteryFloor: {
    title: 'Battery floor',
    body:
      'Rough continuous-draw floor (W) used as a GO gate against mean power proxy. If mean power sits below this floor, the window cannot be GO even with decent sunlight % — framing battery risk during night / outage.',
  },
  minEarthEl: {
    title: 'Min Earth elevation',
    body:
      'Margin above the terrain horizon required before counting Earth LOS (degrees). Higher values demand clearer DTE geometry and usually lower Earth availability %.',
  },
  panelArea: {
    title: 'Panel area',
    body:
      'Assumed array area (m²) in the power proxy. Scales mean/peak watts linearly when the site is sunlit.',
  },
  panelEff: {
    title: 'Panel efficiency',
    body:
      'Assumed conversion efficiency (0–1) in the power proxy. Multiplies with area and solar constant when sunlit.',
  },
  panelTilt: {
    title: 'Panel tilt',
    body:
      'Degrees of tilt toward the Sun used in the incidence proxy: irradiance ∝ sin(sun elevation + tilt), clamped at ≥ 0. 0° = horizontal panel.',
  },
};

/** Short power / comms primer for metric cards and Learn. */
export const POWER_COMMS_PRIMER =
  'Communications: Earth LOS needs terrain clearance plus the min-elevation gate; availability % is DTE-up hours ÷ mission length; longest Earth blackout is the worst no-contact stretch; unknown hours are ephemeris/horizon gaps, not outages. ' +
  'Power: sunlight needs sun clearance > 0°; mean watts use area × efficiency × tilt incidence when sunlit (else 0) and are compared to the battery floor for GO. ' +
  '“Sun + Earth together” is when both are true — the window you can recharge while talking to Earth with no relay.';

export function attachMetricHelp(
  labelEl: HTMLElement,
  helpId: MetricHelpId,
  uid: string,
): void {
  const help = METRIC_HELP[helpId];
  const tipId = `metric-tip-${uid}-${helpId}`;
  const visible = labelEl.textContent || help.title;
  labelEl.textContent = '';

  const wrap = document.createElement('span');
  wrap.className = 'metric-label-row';
  const text = document.createElement('span');
  text.className = 'metric-label-text';
  text.textContent = visible;

  const btn = makeHelpButton(help.title, tipId);
  const tip = makeTooltip(tipId, help.body);
  wrap.append(text, btn, tip);
  labelEl.append(wrap);
}

function makeHelpButton(title: string, tipId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'metric-help';
  btn.setAttribute('aria-label', `About ${title}`);
  btn.setAttribute('aria-describedby', tipId);
  btn.textContent = '?';
  // Avoid activating a parent <label for=…> when opening help.
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  return btn;
}

function makeTooltip(tipId: string, body: string): HTMLSpanElement {
  const tip = document.createElement('span');
  tip.id = tipId;
  tip.className = 'metric-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.textContent = body;
  return tip;
}

/** Build a focusable ? control + tooltip for static HTML hosts. */
export function mountStaticHelp(host: HTMLElement, helpId: MetricHelpId, uid: string): void {
  if (host.querySelector('.metric-help')) return;
  const help = METRIC_HELP[helpId];
  const tipId = `metric-tip-${uid}-${helpId}`;
  host.classList.add('has-metric-help');
  host.append(makeHelpButton(help.title, tipId), makeTooltip(tipId, help.body));
}
