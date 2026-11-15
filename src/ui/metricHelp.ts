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
  | 'incidence'
  | 'electricalAvailability'
  | 'unservedEnergy'
  | 'powerOutage'
  | 'batteryWh'
  | 'jointPoweredComms'
  | 'missionScore';

export const METRIC_HELP: Record<MetricHelpId, { title: string; body: string }> = {
  sunlight: {
    title: "Sunlight availability",
    body: "Share of the mission when the Sun center clears the terrain horizon (>0\u00b0). The planner normally samples every 10 minutes; window transitions use the visibility module\u2019s midpoint approximation. Unknown is neither night nor sunlight. Solar energy separately holds each supplied mask over its following interval.",
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
    title: "Mean panel output",
    body: "Duration-weighted generated solar energy divided by mission hours, before load and storage dispatch. It is not itself a survival test: inspect unserved load, electrical outages and battery energy. Unknown solar intervals make this mean unknown.",
  },
  peakPower: {
    title: "Sampled peak panel output",
    body: "Highest known sampled panel output inside the half-open mission window. The end-boundary sample adds no extra peak or duration. This is not a bound on unsampled peaks; consult solar coverage when data is incomplete.",
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
      'Time lacking usable Sun/Earth ephemeris or horizon clearance (for example past bundled Horizons coverage). Unknown is not blackout and not availability — the full mission score requires complete relevant solar, battery and communication coverage.',
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
    title: "Mission requirements",
    body: "The mission model checks electrical availability, Earth contact fraction and longest communication blackout against the chosen requirements. Only complete, scientifically qualified inputs can receive GO/NO-GO. Preliminary inputs show a conditional result; missing data shows UNKNOWN.",
  },
  instant: {
    title: 'At slider time',
    body:
      'Status for the single moment the time slider points at: SUN + EARTH (both at once), SUN ONLY (power, no Earth link), EARTH ONLY (contact, in shadow), DARK (neither), or NO DATA (coverage gap). Independent of the window grade.',
  },
  batteryFloor: {
    title: "Equipment power demand",
    body: "Constant electrical demand in W from lander, rover or crew equipment during the selected stay at the landing site. The historical URL field name is retained, but this value is now a real simulated load. It draws from PV and then the battery down to reserve.",
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
  electricalAvailability: { title: "Electrical power availability", body: "Fraction of mission time the full constant equipment demand is served by PV plus battery. Battery power limits and reserve cutoff apply. It differs from sunlight availability; missing data makes the full fraction unknown." },
  unservedEnergy: { title: "Unserved load energy", body: "Demand minus power actually supplied to the load, integrated in Wh. The model uses constant equipment demand and resolves battery-empty times within intervals. Unknown battery history makes the full total unknown." },
  powerOutage: { title: "Longest electrical outage", body: "Longest continuous period with any unmet equipment demand, including discharge-rate limits. This is an electrical outage, not a shadow duration. Unknown periods are not counted as a known outage or silently skipped from the full metric." },
  batteryWh: { title: "Battery energy and losses", body: "Stored energy in Wh. Initial charge and reserve are fractions of capacity. Charge efficiency adds stored Wh; discharge draws output Wh divided by efficiency. Full storage curtails surplus, and power limits constrain bus flows. The chart is blank after unknown state." },
  jointPoweredComms: { title: "Powered Earth contact", body: "Time when the full equipment demand is served and the visibility owner reports Earth contact. Battery can support contact in shadow. This is distinct from Sun \u2229 Earth; unknown inputs remain unknown." },
  missionScore: { title: "Mission score", body: "Project policy: 100 \u00d7 capped power availability / required availability \u00d7 capped Earth contact / required contact \u00d7 capped allowed blackout / longest Earth blackout. All factors are capped at 1. Requirements pass/fail is separate from rounded score. Not a probability or NASA standard; preliminary inputs stay unqualified." },
};

/** Short power / comms primer for metric cards and Learn. */
export const POWER_COMMS_PRIMER =
  'Communications: Earth LOS needs terrain clearance plus the min-elevation gate; availability % is DTE-up hours ÷ mission length; longest Earth blackout is the worst no-contact stretch; unknown hours are ephemeris/horizon gaps, not outages. ' +
  'Power: fixed panel orientation, area, efficiency, Sun distance and terrain visibility determine watts; elapsed time determines watt-hours. Unknown intervals make the total and mean unknown. Battery and constant-load dispatch report unmet Wh and electrical outages. ' +
  'Sun + Earth together is illumination and contact overlap; powered Earth contact also counts battery support while the equipment load is served.';

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
