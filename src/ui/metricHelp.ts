/**
 * Plain-language Planner metric explanations — significance + how calculated.
 * Copy matches assess/windows.ts and assess/decision.ts (direct-beam solar power, unknown ≠ blackout).
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
  | 'panelTilt'
  | 'panelAzimuth'
  | 'totalEnergy'
  | 'knownEnergy'
  | 'solarCoverage'
  | 'samplePower'
  | 'irradiance'
  | 'incidence';

export const METRIC_HELP: Record<MetricHelpId, { title: string; body: string }> = {
  sunlight: {
    title: "Sunlight availability",
    body: "Share of the mission when the Sun center clears the terrain horizon (>0\u00b0). The planner normally samples every 10 minutes; window transitions use the visibility module\u2019s midpoint approximation. Unknown is neither night nor sunlight. Solar energy separately holds each supplied mask over its following interval.",
  },
  earthLos: {
    title: 'Earth LOS availability',
    body:
      'Share of the mission span with direct-to-Earth line of sight: Earth elevation above terrain must meet the Min Earth elevation threshold (default 5°). ' +
      'No lunar relay is modeled — this is DTE only. Unknown hours are gaps, not blackout.',
  },
  sunEarth: {
    title: 'Sun ∩ Earth windows',
    body:
      'Hours when the site is both sunlit and has Earth LOS at once. That is the ops sweet spot: solar panels can charge while you talk to Earth without a relay — power delivery and commanding together. ' +
      'Outside ∩ you may have sunlight but no DTE (store data / wait for Earthrise) or Earth contact while in shadow (draw from battery). Percent is simultaneous hours ÷ mission length.',
  },
  meanPower: {
    title: "Mean panel output",
    body: "Duration-weighted solar energy divided by mission hours. Direct-beam power uses 1361/rangeAu\u00b2 W/m\u00b2 \u00d7 area \u00d7 efficiency \u00d7 max(0, panel-normal dot Sun-direction) \u00d7 upstream visible fraction. Unknown intervals make the full-window mean unknown. This constant-efficiency estimate excludes batteries, loads, temperature, dust and electrical losses.",
  },
  peakPower: {
    title: "Sampled peak panel output",
    body: "Highest known sampled panel output inside the half-open mission window. The end-boundary sample adds no extra peak or duration. This is not a bound on unsampled peaks; consult solar coverage when data is incomplete.",
  },
  sunBlackout: {
    title: 'Longest sun blackout',
    body:
      'Longest contiguous stretch where sunlight is explicitly false (terrain-blocked or below horizon). Unknown samples stop a blackout run — gaps are not treated as night. Guides battery / eclipse sizing.',
  },
  earthBlackout: {
    title: 'Longest Earth blackout',
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
    title: "Mission window grade",
    body: "The existing heuristic uses sunlight, Earth LOS, mean power and known coverage. Solar integration additionally requires complete inputs and declared terrain validation. Otherwise the grade is UNKNOWN. This is not a battery or mission-survival simulation.",
  },
  instant: {
    title: 'At scrub time',
    body:
      'Ops status for the single scrub sample: BOTH (sun ∩ Earth), SUNLIT (power, no DTE), EARTH LOS (contact, no sun), BLACKOUT (neither), or UNKNOWN (gap). Independent of the window grade.',
  },
  batteryFloor: {
    title: "Planning power threshold",
    body: "Existing heuristic threshold in watts for the mission grade. This P0 solar module does not simulate a battery or habitat load. A mean-power threshold does not establish survival through a blackout.",
  },
  minEarthEl: {
    title: 'Min Earth elevation',
    body:
      'Margin above the terrain horizon required before counting Earth LOS (degrees). Higher values demand clearer DTE geometry and usually lower Earth availability %.',
  },
  panelArea: {
    title: "Active panel area",
    body: "Active collecting area in square meters. Power scales linearly with this area.",
  },
  panelEff: {
    title: "Panel efficiency",
    body: "Conversion efficiency as a ratio from 0 to 1, held constant in this P0 model. Temperature dependence and electrical losses are excluded.",
  },
  panelTilt: {
    title: "Tilt from horizontal",
    body: "Fixed panel normal tilt from local up: 0\u00b0 is face-up horizontal, 90\u00b0 is vertical, 180\u00b0 faces down. Facing bearing chooses its direction. The model uses an ENU dot product with the true Sun direction, not terrain clearance.",
  },
  panelAzimuth: { title: "Panel facing bearing", body: "Bearing of the fixed panel normal, clockwise from true local north: N=0\u00b0, E=90\u00b0, S=180\u00b0, W=270\u00b0. It does not change the horizon mask. Bearing has no effect when the panel is horizontal." },
  totalEnergy: { title: "Total solar energy", body: "Estimated generated energy in Wh over physical mission time. Unobstructed endpoint watts are trapezoidally integrated; the left visibility mask is held on each interval. Unknown endpoints or gaps over 600 s make the total unknown." },
  knownEnergy: { title: "Known energy subtotal", body: "Energy only from intervals with complete solar inputs. It remains a subtotal if coverage is below 100%; it is not the full-mission total." },
  solarCoverage: { title: "Solar data coverage", body: "Percentage of mission duration with known solar interval energy. Unknown geometry, range, observer/frame mismatch, horizon gaps or missing endpoints reduce coverage. Complete coverage is not independent terrain validation." },
  samplePower: { title: "Panel output at scrub sample", body: "Watts at the nearest stored sample to the scrubber. It consumes the upstream terrain mask once. Known blocked Sun or back-face incidence gives zero; missing required data gives unknown." },
  irradiance: { title: "Direct normal irradiance", body: "Irradiance perpendicular to the incoming Sun direction: a nominal 1361 W/m\u00b2 at 1 AU scaled by inverse-square observer-to-Sun distance. Panel projection and terrain obstruction are applied separately." },
  incidence: { title: "Panel incidence angle", body: "Angle between the panel normal and the direction toward the Sun. Zero is face-on. At or above 90\u00b0 the single-face panel receives no direct power. Terrain may block it at any incidence angle." },
};

/** Short power / comms primer for metric cards and Learn. */
export const POWER_COMMS_PRIMER =
  'Communications: Earth LOS needs terrain clearance plus the min-elevation gate; availability % is DTE-up hours ÷ mission length; longest Earth blackout is the worst no-contact stretch; unknown hours are ephemeris/horizon gaps, not outages. ' +
  'Power: fixed panel orientation, area, efficiency, Sun distance and terrain visibility determine watts; elapsed time determines watt-hours. Unknown intervals make the total and mean unknown. No batteries or loads are simulated. ' +
  'Sun ∩ Earth is when both are true — the window you can recharge while talking to Earth with no relay.';

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
