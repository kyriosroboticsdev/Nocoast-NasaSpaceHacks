import './style.css';
import { startTerrain, type TerrainApi, type TerrainMarkerSpec } from './main';
import { CATALOG_GROUP_LABELS, SITE_CATALOG, resolveSiteCoords } from './scenario/catalog';
import {
  applyUrlParams,
  getScenario,
  scenarioToSearchParams,
  setCustomCoords,
  setMissionWindow,
  setMode,
  setPrimarySite,
  setScenario,
  setScrubUtc,
  setSecondarySite,
  setThresholds,
  subscribeScenario,
  syncUrl,
  toggleCompare,
  toggleTechnicalDetails,
} from './scenario/state';
import type { ScenarioState } from './scenario/types';
import { loadHorizonProfile } from './horizon/load';
import type { HorizonProfile } from './horizon/types';
import { createEphemerisProvider } from './ephemeris/horizons';
import {
  backendEphemerisProvider,
  backendHorizonProfile,
  fetchBackendAnalysis,
  fetchPathfind,
  type PathfindResult,
} from './science/backend';
import { assessMission, type MissionAssessment } from './assess/windows';
import {
  DATE_SLIP_OFFSETS_DAYS,
  authorityBadge,
  buildDateSuggestions,
  explainVerdict,
  findBestWindow,
  instantStatusClass,
  instantStatusFromSample,
  instantStatusLabel,
  rankAssessments,
  slipStartUtc,
  type DateSuggestion,
  type RankedSite,
} from './assess/decision';
import {
  candidateToHorizon,
  computeIlluminationOverlay,
  loadSearchCatalog,
  rankSearchCandidates,
  type SearchCatalog,
  type SearchHit,
} from './assess/search';
import { renderSkyline } from './viz/skyline';
import { renderTimeline } from './viz/timeline';
import {
  dateInputToUtcIso,
  fmtDeg,
  fmtHours,
  fmtPct,
  fmtPower,
  localDateInputValue,
  viabilityClass,
  viabilityIcon,
} from './ui/format';
import { plainConsequence, plainSummary, simpleCards } from './ui/plain';
import { createTour } from './ui/tour';
import {
  POWER_COMMS_PRIMER,
  attachMetricHelp,
  mountStaticHelp,
  type MetricHelpId,
} from './ui/metricHelp';

const base = import.meta.env.BASE_URL;
const el = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;

let terrain: TerrainApi | undefined;
let assessA: MissionAssessment | undefined;
let assessB: MissionAssessment | undefined;
let cachedHorizon: HorizonProfile | undefined;
/** The exact horizon profile used for the current (no-override) Site A assessment, so the skyline always
 * matches the metrics it's painted from — including when that horizon came from the Person 2 backend. */
let lastPrimaryHorizon: HorizonProfile | undefined;
let lastKey = '';
let lastUiState: ScenarioState | undefined;
let lastFocusKey = '';
let recomputeTimer = 0;
let scrubPaintRaf = 0;
let urlSyncTimer = 0;
let playTimer = 0;
let playing = false;
let lastRanked: RankedSite[] = [];
let lastDateSuggestions: DateSuggestion[] = [];
let lastSearchHits: SearchHit[] = [];
let searchCatalog: SearchCatalog | undefined;
/** Retained when Adopt is used on a search hit — keeps overview LOLA horizon (not sphere). */
let adoptedSearchHorizon: HorizonProfile | undefined;
let adoptedSearchElevationM: number | undefined;
let rankToken = 0;
let searchToken = 0;
let dateToken = 0;
let recomputeToken = 0;
let lastDecisionKey = '';
let illuminationToken = 0;
let lastIlluminationKey = '';
let antennaToken = 0;
let pathfindToken = 0;

function decisionKey(state: ScenarioState): string {
  // Site adopt must not wipe rank/search lists — only window/threshold changes invalidate scores.
  return JSON.stringify({
    start: state.startUtc,
    hours: state.durationHours,
    th: state.thresholds,
  });
}

function clearStaleDecisionLists(state: ScenarioState) {
  const key = decisionKey(state);
  if (key === lastDecisionKey) return;
  lastDecisionKey = key;
  if (lastRanked.length || lastSearchHits.length || lastDateSuggestions.length) {
    lastRanked = [];
    lastSearchHits = [];
    lastDateSuggestions = [];
    renderRankList([]);
    renderSearchList([]);
    renderDateList([]);
    el('rank-status').textContent = 'Window/thresholds changed — re-run Rank / Find best.';
    el('search-status').textContent = 'Window/thresholds changed — re-run Find best.';
    el('date-status').textContent = 'Window changed — re-run Suggest dates.';
  }
}

function clearAdoptedSearchHorizon() {
  adoptedSearchHorizon = undefined;
  adoptedSearchElevationM = undefined;
}

function horizonFlagText(a: MissionAssessment): string {
  const badge = authorityBadge(a.horizonModel, a.ephemerisSource);
  if (a.ephemerisSource.startsWith('Person 2 backend')) return `Horizon: LOLA live (Person 2 backend) · ${badge}`;
  if (a.horizonModel === 'lola_terrain') return `Horizon: LOLA 5 m study · ${badge} · ${a.ephemerisSource}`;
  if (a.horizonModel === 'lola_overview_coarse') return `Horizon: LOLA overview (adopted search) · ${badge}`;
  return `⚠ Horizon: optimistic sphere · ${badge}`;
}

function fillSiteSelect(select: HTMLSelectElement, selected: string) {
  select.replaceChildren();
  const order = ['study', 'curated', 'clps', 'apollo', 'international'] as const;
  for (const cat of order) {
    const sites = SITE_CATALOG.filter(s => s.category === cat);
    if (!sites.length) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = CATALOG_GROUP_LABELS[cat] ?? cat;
    for (const site of sites) {
      optgroup.append(new Option(`${site.publishedLabel} · ${site.name}`, site.siteId, false, site.siteId === selected));
    }
    select.append(optgroup);
  }
  select.append(new Option('Custom lat/lon (sphere horizon)', 'custom', false, selected === 'custom'));
}

function renderMetricGrid(target: HTMLElement, a: MissionAssessment, scrubIso: string) {
  const instant = a.samples.reduce((best, s) =>
    Math.abs(Date.parse(s.utc) - Date.parse(scrubIso)) < Math.abs(Date.parse(best.utc) - Date.parse(scrubIso)) ? s : best,
  a.samples[0]);
  const floor = getScenario().thresholds.batteryFloorW;
  const meanVsFloor =
    a.meanPowerW >= floor
      ? `${fmtPower(a.meanPowerW)} · ≥ floor ${fmtPower(floor)}`
      : `${fmtPower(a.meanPowerW)} · below floor ${fmtPower(floor)}`;
  const uid = target.id || 'metric';
  type Row =
    | { kind: 'group'; label: string }
    | { kind: 'metric'; label: string; value: string; help?: MetricHelpId; tech?: boolean };

  const rows: Row[] = [
    { kind: 'group', label: '— Mission window —' },
    { kind: 'metric', label: 'Sunlight availability', value: fmtPct(a.sunlightPct), help: 'sunlight' },
    { kind: 'metric', label: 'Can see Earth', value: fmtPct(a.earthLosPct), help: 'earthLos' },
    { kind: 'metric', label: 'Sun + Earth together', value: fmtPct(a.simultaneousPct), help: 'sunEarth' },
    { kind: 'metric', label: 'Average solar power', value: meanVsFloor, help: 'meanPower' },
    { kind: 'metric', label: 'Peak solar power', value: fmtPower(a.peakPowerW), help: 'peakPower', tech: true },
    { kind: 'metric', label: 'Longest darkness', value: fmtHours(a.longestSunBlackoutHours), help: 'sunBlackout' },
    { kind: 'metric', label: 'Longest Earth-contact gap', value: fmtHours(a.longestEarthBlackoutHours), help: 'earthBlackout' },
  ];
  if ((a.unknownHours ?? 0) > 0.05) {
    rows.push({
      kind: 'metric',
      label: 'Unknown hours',
      value: fmtHours(a.unknownHours),
      help: 'unknownHours',
    });
  }
  rows.push(
    { kind: 'group', label: '— At slider time —' },
    { kind: 'metric', label: 'Time to sunset', value: fmtHours(a.hoursToSunset), help: 'timeSunset' },
    { kind: 'metric', label: 'Time until Earth sets', value: fmtHours(a.hoursToEarthset), help: 'timeEarthset' },
    { kind: 'metric', label: 'Sun elevation (slider)', value: fmtDeg(instant?.sunEl), help: 'sunElev', tech: true },
    { kind: 'metric', label: 'Sun clear elev', value: fmtDeg(instant?.sunClearEl), help: 'sunClear', tech: true },
    { kind: 'metric', label: 'Earth elevation (slider)', value: fmtDeg(instant?.earthEl), help: 'earthElev', tech: true },
    { kind: 'metric', label: 'Earth clear elev', value: fmtDeg(instant?.earthClearEl), help: 'earthClear', tech: true },
  );

  target.replaceChildren();
  for (const row of rows) {
    const div = document.createElement('div');
    if (row.kind === 'group') {
      div.className = 'metric-group';
      const span = document.createElement('span');
      span.textContent = row.label;
      div.append(span);
      target.append(div);
      continue;
    }
    if (row.tech) div.className = 'tech-only';
    const span = document.createElement('span');
    span.textContent = row.label;
    if (row.help) attachMetricHelp(span, row.help, uid);
    const strong = document.createElement('strong');
    strong.textContent = row.value;
    div.append(span, strong);
    target.append(div);
  }
}

/** Big icon cards — the simple layer's main reading surface. */
function renderSimpleCards(target: HTMLElement, a: MissionAssessment) {
  const cards = simpleCards(a, getScenario().thresholds);
  target.replaceChildren();
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `simple-card tone-${card.tone}`;
    const icon = document.createElement('span');
    icon.className = 'sc-icon';
    icon.textContent = card.icon;
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'sc-label';
    label.textContent = card.label;
    const value = document.createElement('strong');
    value.className = 'sc-value';
    value.textContent = card.value;
    const note = document.createElement('span');
    note.className = 'sc-note';
    note.textContent = card.note;
    div.append(icon, label, value, note);
    target.append(div);
  }
}

function hoursUntil(a: MissionAssessment, scrub: string, kind: 'sun' | 'earth'): number | null {
  const from = Date.parse(scrub);
  const flag = (s: (typeof a.samples)[0]) => (kind === 'sun' ? s.sunlit : s.earthLos);
  const start = a.samples.find(s => Date.parse(s.utc) >= from) ?? a.samples[a.samples.length - 1];
  if (!start || flag(start) !== true) return 0;
  for (const s of a.samples) {
    if (Date.parse(s.utc) < from) continue;
    if (flag(s) !== true) return (Date.parse(s.utc) - from) / 3600_000;
  }
  return null;
}

function matchesAdoptedSearch(lat: number, lon: number): boolean {
  if (!adoptedSearchHorizon) return false;
  const o = adoptedSearchHorizon.observer;
  return Math.abs(o.latitudeDeg - lat) < 1e-4 && Math.abs(o.longitudeEastDeg - lon) < 1e-4;
}

async function computeSlot(state: ScenarioState, slot: 'A' | 'B', override?: {
  siteId: string;
  customLatDeg?: number;
  customLonEastDeg?: number;
  startUtc?: string;
}): Promise<MissionAssessment> {
  const sc = override
    ? { siteId: override.siteId, customLatDeg: override.customLatDeg, customLonEastDeg: override.customLonEastDeg }
    : slot === 'A' ? state.primary : state.secondary;
  const startUtc = override?.startUtc ?? state.startUtc;
  const coords = resolveSiteCoords(sc.siteId, sc.customLatDeg, sc.customLonEastDeg);
  const useAdopted = sc.siteId === 'custom' && matchesAdoptedSearch(coords.latitudeDeg, coords.longitudeEastDeg);

  // Person 2 backend (live Skyfield + JPL DE421 + real PGDA/LOLA DEM) — tried first for south-polar points,
  // where it actually has terrain data. Fails soft to the bundled/sphere chain below when unreachable (no
  // local backend running), out of its supported mission window, or outside its DEM coverage.
  if (!useAdopted && coords.latitudeDeg <= -75) {
    const endUtc = new Date(Date.parse(startUtc) + state.durationHours * 3600_000).toISOString();
    const backend = await fetchBackendAnalysis(
      coords.latitudeDeg, coords.longitudeEastDeg, startUtc, endUtc, state.thresholds.minEarthElevationDeg, base,
    );
    const backendHorizon = backend ? backendHorizonProfile(backend, sc.siteId) : null;
    if (backend && backendHorizon) {
      if (slot === 'A' && !override) lastPrimaryHorizon = backendHorizon;
      return assessMission({
        siteId: sc.siteId,
        siteLabel: coords.label,
        horizonModel: backendHorizon.model,
        provider: backendEphemerisProvider(sc.siteId, backend),
        horizon: backendHorizon,
        startUtc,
        durationHours: state.durationHours,
        scrubUtc: override?.startUtc ?? state.scrubUtc,
        thresholds: state.thresholds,
      });
    }
  }

  const horizon = useAdopted && adoptedSearchHorizon
    ? adoptedSearchHorizon
    : await loadHorizonProfile(sc.siteId, base, coords.latitudeDeg, coords.longitudeEastDeg);
  if (slot === 'A' && !override) lastPrimaryHorizon = horizon;
  const elevationM = useAdopted && adoptedSearchElevationM != null
    ? adoptedSearchElevationM
    : coords.elevationM;
  const horizonModel = useAdopted ? 'lola_overview_coarse' : coords.horizonModel;
  const provider = await createEphemerisProvider({
    siteId: sc.siteId,
    latDeg: coords.latitudeDeg,
    lonEastDeg: coords.longitudeEastDeg,
    altitudeKm: (elevationM + coords.observerHeightM) / 1000,
    startUtc,
    durationHours: state.durationHours,
    baseUrl: base,
    allowLive: false,
  });
  return assessMission({
    siteId: sc.siteId,
    siteLabel: useAdopted
      ? `Search ${Math.abs(coords.latitudeDeg).toFixed(3)}°S ${coords.longitudeEastDeg.toFixed(2)}°E`
      : coords.label,
    horizonModel,
    provider,
    horizon,
    startUtc,
    durationHours: state.durationHours,
    scrubUtc: override?.startUtc ?? state.scrubUtc,
    thresholds: state.thresholds,
  });
}

function nearestSample(a: MissionAssessment, scrubIso: string) {
  return a.samples.reduce((best, s) =>
    Math.abs(Date.parse(s.utc) - Date.parse(scrubIso)) < Math.abs(Date.parse(best.utc) - Date.parse(scrubIso)) ? s : best,
  a.samples[0]);
}

function scheduleUrlSync() {
  window.clearTimeout(urlSyncTimer);
  urlSyncTimer = window.setTimeout(() => syncUrl(), 150);
}

function paintSkyline(instant: ReturnType<typeof nearestSample> | undefined) {
  if (!cachedHorizon) return;
  renderSkyline(el<HTMLCanvasElement>('skyline'), cachedHorizon, instant ? {
    sunAz: instant.sunAz, sunEl: instant.sunEl, sunClear: instant.sunlit,
    earthAz: instant.earthAz, earthEl: instant.earthEl, earthClear: instant.earthLos,
  } : undefined);
}

function paintInstantChip(id: string, a: MissionAssessment, scrubIso: string) {
  const instant = nearestSample(a, scrubIso);
  const status = instantStatusFromSample(instant);
  const chip = el(id);
  chip.textContent = instantStatusLabel(status);
  chip.className = `instant-chip ${instantStatusClass(status)}`;
}

function paintNogoPrompt(a: MissionAssessment) {
  const prompt = el('nogo-prompt-a');
  if (a.viability === 'GO') {
    prompt.hidden = true;
    prompt.textContent = '';
    return;
  }
  prompt.hidden = false;
  const action =
    a.viability === 'NO-GO'
      ? 'Try “Rank known sites”, “Suggest better dates”, or the ±7/14-day buttons — the tool will hunt for a combination that works.'
      : 'A nearby week or site may be safer — try “Suggest better dates” or compare with Site B.';
  prompt.textContent = `${plainConsequence(a, getScenario().thresholds)} ${action}`;
}

function paintBestWindowLabel(a: MissionAssessment) {
  const best = findBestWindow(a);
  const label = el('best-window-label');
  if (!best.window) {
    label.textContent = 'No clear sun/Earth window in this mission span.';
    return;
  }
  const kind =
    best.kind === 'simultaneous' ? 'Best sun + Earth stretch' :
    best.kind === 'sunlight' ? 'Best sunlight stretch (never both)' :
    'Best Earth-contact stretch (never both)';
  label.textContent = `${kind}: ${best.window.hours.toFixed(1)} h · ${best.window.startUtc.slice(0, 16)}Z → ${best.window.endUtc.slice(0, 16)}Z (highlighted on timeline)`;
}

function paintLearnTip(a: MissionAssessment, b?: MissionAssessment) {
  const tip = el('learn-verdict-tip');
  if (!tip) return;
  let text = explainVerdict(a);
  if (b) {
    text += ` Compared with ${b.siteLabel}: ${b.viability} (sun + Earth together ${b.simultaneousPct.toFixed(0)}% vs ${a.simultaneousPct.toFixed(0)}%).`;
  }
  tip.textContent = text;
}

function paintMetricPrimers(a: MissionAssessment, slot: 'a' | 'b') {
  const primer = el(`metric-primer-${slot}`);
  if (!primer) return;
  const sunH = a.sunlightHours.toFixed(1);
  const earthH = a.earthLosHours.toFixed(1);
  const bothH = a.simultaneousHours.toFixed(1);
  const unk = (a.unknownHours ?? 0) > 0.05 ? ` · ~${a.unknownHours.toFixed(1)} h unknown (not blackout)` : '';
  primer.textContent =
    `Comms: Earth in view ${fmtPct(a.earthLosPct)} (~${earthH} h direct-to-Earth); longest contact gap ${fmtHours(a.longestEarthBlackoutHours)}. ` +
    `Power: sunlight ${fmtPct(a.sunlightPct)} (~${sunH} h); average ${fmtPower(a.meanPowerW)} vs floor ${fmtPower(getScenario().thresholds.batteryFloorW)}; longest darkness ${fmtHours(a.longestSunBlackoutHours)}. ` +
    `Sun + Earth together ${fmtPct(a.simultaneousPct)} (~${bothH} h) — recharge while talking to Earth, no relay.${unk}`;
}

function paintAssessment(state: ScenarioState, opts: { syncUrlNow?: boolean } = {}) {
  if (!assessA) return;
  el('metrics-a-title').textContent = assessA.siteLabel;
  const viabA = el('viability-a');
  viabA.textContent = `${viabilityIcon(assessA.viability)} ${assessA.viability} · ${assessA.viabilityReason}`;
  viabA.className = `viability ${viabilityClass(assessA.viability)}`;
  paintInstantChip('instant-a', assessA, state.scrubUtc);
  el('plain-summary-a').textContent = plainSummary(assessA, state.thresholds);
  renderSimpleCards(el('simple-cards-a'), assessA);
  paintNogoPrompt(assessA);
  paintBestWindowLabel(assessA);
  renderMetricGrid(el('metric-grid-a'), assessA, state.scrubUtc);
  paintMetricPrimers(assessA, 'a');
  el('horizon-flag-a').textContent = horizonFlagText(assessA);

  if (assessB && state.compareEnabled) {
    el('metrics-b').hidden = false;
    el('metrics-b-title').textContent = assessB.siteLabel;
    const viabB = el('viability-b');
    viabB.textContent = `${viabilityIcon(assessB.viability)} ${assessB.viability} · ${assessB.viabilityReason}`;
    viabB.className = `viability ${viabilityClass(assessB.viability)}`;
    paintInstantChip('instant-b', assessB, state.scrubUtc);
    el('plain-summary-b').textContent = plainSummary(assessB, state.thresholds);
    renderSimpleCards(el('simple-cards-b'), assessB);
    renderMetricGrid(el('metric-grid-b'), assessB, state.scrubUtc);
    paintMetricPrimers(assessB, 'b');
    el('horizon-flag-b').textContent = horizonFlagText(assessB);
  } else {
    el('metrics-b').hidden = true;
  }

  paintLearnTip(assessA, state.compareEnabled ? assessB : undefined);

  const instant = nearestSample(assessA, state.scrubUtc);
  paintSkyline(instant);
  el('scrub-label').textContent = `${state.scrubUtc.replace('.000Z', 'Z')} · ${assessA.ephemerisSource}`;
  const highlight = findBestWindow(assessA);
  renderTimeline(
    el<HTMLCanvasElement>('timeline'),
    assessA,
    state.scrubUtc,
    state.compareEnabled ? assessB : null,
    highlight,
  );
  if (opts.syncUrlNow) syncUrl();
  else scheduleUrlSync();
}

/** Scrub-only refresh: update derived scrub metrics + viz in place (no control shell rebuild). */
function paintScrubOnly(state: ScenarioState) {
  if (!assessA) return;
  assessA = {
    ...assessA,
    hoursToSunset: hoursUntil(assessA, state.scrubUtc, 'sun'),
    hoursToEarthset: hoursUntil(assessA, state.scrubUtc, 'earth'),
  };
  if (assessB) {
    assessB = {
      ...assessB,
      hoursToSunset: hoursUntil(assessB, state.scrubUtc, 'sun'),
      hoursToEarthset: hoursUntil(assessB, state.scrubUtc, 'earth'),
    };
  }
  paintAssessment(state);
}

function scheduleScrubPaint(state: ScenarioState) {
  if (scrubPaintRaf) cancelAnimationFrame(scrubPaintRaf);
  scrubPaintRaf = requestAnimationFrame(() => {
    scrubPaintRaf = 0;
    paintScrubOnly(state);
  });
}

function isScrubOnlyChange(prev: ScenarioState | undefined, next: ScenarioState): boolean {
  if (!prev) return false;
  return (
    prev.scrubUtc !== next.scrubUtc
    && prev.mode === next.mode
    && prev.compareEnabled === next.compareEnabled
    && prev.showTechnicalDetails === next.showTechnicalDetails
    && prev.startUtc === next.startUtc
    && prev.durationHours === next.durationHours
    && prev.primary === next.primary
    && prev.secondary === next.secondary
    && prev.thresholds === next.thresholds
  );
}

/** Camera focus follows Site A only — B-only edits must not yank the view. */
function siteFocusKey(state: ScenarioState): string {
  const a = state.primary;
  return JSON.stringify({
    a: a.siteId,
    alat: a.customLatDeg,
    alon: a.customLonEastDeg,
  });
}

/** Keep 3D focus + multi-category markers aligned with Site A / B / search. */
function syncTerrainToScenario(state: ScenarioState, opts: { fly?: boolean } = {}) {
  if (!terrain) return;
  const a = resolveSiteCoords(state.primary.siteId, state.primary.customLatDeg, state.primary.customLonEastDeg);
  const focusKey = siteFocusKey(state);
  const shouldFly = opts.fly !== false && focusKey !== lastFocusKey;
  if (shouldFly) {
    lastFocusKey = focusKey;
    terrain.focusLatLon(a.latitudeDeg, a.longitudeEastDeg);
  }

  const markers: TerrainMarkerSpec[] = [];
  const chosenId =
    state.primary.siteId === 'custom'
      ? 'chosen-custom'
      : `chosen-${state.primary.siteId}`;

  for (const site of SITE_CATALOG) {
    // Skip if this catalog pin is the active chosen site (chosen marker wins).
    if (site.siteId === state.primary.siteId) continue;
    if (state.compareEnabled && site.siteId === state.secondary.siteId) continue;
    markers.push({
      id: `catalog-${site.siteId}`,
      category: 'catalog',
      latitudeDeg: site.latitudeDeg,
      longitudeEastDeg: site.longitudeEastDeg,
      label: site.publishedLabel,
    });
  }

  for (const hit of lastSearchHits) {
    // Don't double-draw a search hit that was just adopted as custom at same coords.
    const sameAsChosen =
      state.primary.siteId === 'custom'
      && Math.abs((state.primary.customLatDeg ?? 999) - hit.latitudeDeg) < 1e-4
      && Math.abs((state.primary.customLonEastDeg ?? 999) - hit.longitudeEastDeg) < 1e-4;
    if (sameAsChosen) continue;
    markers.push({
      id: hit.siteId,
      category: 'search',
      latitudeDeg: hit.latitudeDeg,
      longitudeEastDeg: hit.longitudeEastDeg,
      label: hit.publishedLabel,
    });
  }

  markers.push({
    id: chosenId,
    category: 'chosen',
    latitudeDeg: a.latitudeDeg,
    longitudeEastDeg: a.longitudeEastDeg,
    label: 'Site A',
  });

  if (state.compareEnabled) {
    const b = resolveSiteCoords(
      state.secondary.siteId,
      state.secondary.customLatDeg,
      state.secondary.customLonEastDeg,
    );
    markers.push({
      id: `compare-${state.secondary.siteId}`,
      category: 'compare',
      latitudeDeg: b.latitudeDeg,
      longitudeEastDeg: b.longitudeEastDeg,
      label: 'Site B',
    });
  }

  terrain.setMarkers(markers);
}

/** Dark (no sunlight) -> amber (--sun) -> warm white (full sunlight), for the illumination overlay's
 * continuous color scale — three-stop lerp in RGB, pct in [0, 100]. */
function sunlightColor(pct: number): number {
  const t = Math.max(0, Math.min(100, pct)) / 100;
  const stops: [number, number, number][] = [
    [0x16, 0x23, 0x3a], // dark navy — no sunlight
    [0xe6, 0xb8, 0x4d], // --sun amber — midpoint
    [0xff, 0xf3, 0xc4], // warm white — full sunlight
  ];
  const seg = t < 0.5 ? 0 : 1;
  const localT = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const [r0, g0, b0] = stops[seg];
  const [r1, g1, b1] = stops[seg + 1];
  const r = Math.round(r0 + (r1 - r0) * localT);
  const g = Math.round(g0 + (g1 - g0) * localT);
  const b = Math.round(b0 + (b1 - b0) * localT);
  return (r << 16) | (g << 8) | b;
}

/** 2D illumination overlay: sunlight-% coverage across the polar cap for the current mission window,
 * as small flat dots independent of the catalog/search/chosen/compare markers (TerrainApi.setOverlayMarkers).
 * Off by default (toggle-illumination-overlay); recomputed whenever the mission window changes while on. */
async function refreshIlluminationOverlay(state: ScenarioState) {
  if (!terrain) return;
  const on = el<HTMLInputElement>('toggle-illumination-overlay').checked;
  const status = el('illumination-status');
  if (!on) {
    terrain.setOverlayMarkers([]);
    status.hidden = true;
    return;
  }
  const key = JSON.stringify({ start: state.startUtc, hours: state.durationHours, th: state.thresholds });
  if (key === lastIlluminationKey) return;
  lastIlluminationKey = key;
  const token = ++illuminationToken;
  status.hidden = false;
  status.textContent = 'Scoring sunlight coverage across the polar cap…';
  try {
    if (!searchCatalog) searchCatalog = await loadSearchCatalog(base);
    if (token !== illuminationToken) return;
    const points = await computeIlluminationOverlay({ catalog: searchCatalog, state, stepHours: 2 });
    if (token !== illuminationToken) return;
    terrain.setOverlayMarkers(
      points.map((p, i) => ({
        id: `illum-${i}`,
        category: 'catalog' as const,
        latitudeDeg: p.latitudeDeg,
        longitudeEastDeg: p.longitudeEastDeg,
        color: sunlightColor(p.sunlightPct),
      })),
    );
    status.textContent =
      `Sunlight coverage · ${points.length} points · LOLA 320 m overview + analytic ephemeris (coarse, badged). ` +
      'Dark = no sunlight in this window, amber/white = increasing sunlight %.';
  } catch (error) {
    if (token !== illuminationToken) return;
    console.error(error);
    status.textContent = 'Illumination overlay failed — check console.';
  }
}

/** Fixed-mount directional antenna link quality (backend/analysis.py antenna_link_quality, extension —
 * not in contract v0.1). Opt-in: only queries the backend when both boresight angles are set. South-polar
 * sites only (same backend DEM coverage gate as the main assessment). */
async function refreshAntennaLinkQuality(state: ScenarioState) {
  const out = el('antenna-link-quality');
  const azRaw = el<HTMLInputElement>('antenna-boresight-az').value;
  const elRaw = el<HTMLInputElement>('antenna-boresight-el').value;
  if (azRaw === '' || elRaw === '') {
    out.hidden = true;
    return;
  }
  const boresightAzimuthDeg = Number(azRaw);
  const boresightElevationDeg = Number(elRaw);
  const beamwidthDeg = Number(el<HTMLInputElement>('antenna-beamwidth').value) || undefined;
  const coords = resolveSiteCoords(state.primary.siteId, state.primary.customLatDeg, state.primary.customLonEastDeg);
  out.hidden = false;
  if (coords.latitudeDeg > -75) {
    out.textContent = 'Antenna link quality needs a south-polar site (CR1/SR1, or custom ≤ 75°S) with the science backend running.';
    return;
  }
  const token = ++antennaToken;
  out.textContent = 'Computing antenna link quality…';
  const endUtc = new Date(Date.parse(state.startUtc) + state.durationHours * 3600_000).toISOString();
  const backend = await fetchBackendAnalysis(
    coords.latitudeDeg, coords.longitudeEastDeg, state.startUtc, endUtc,
    state.thresholds.minEarthElevationDeg, base,
    { boresightAzimuthDeg, boresightElevationDeg, beamwidthDeg },
  );
  if (token !== antennaToken) return;
  if (!backend?.antenna.modeled) {
    out.textContent = 'Antenna link quality unavailable — science backend not reachable for this site/window.';
    return;
  }
  const { onBoresightFractionOfCommWindow, meanLinkQualityWhileVisible } = backend.antenna;
  out.textContent =
    `Antenna link quality: on-boresight ${fmtPct((onBoresightFractionOfCommWindow ?? 0) * 100)} of the Earth-comm window` +
    (meanLinkQualityWhileVisible != null
      ? ` · mean quality while Earth visible ${fmtPct(meanLinkQualityWhileVisible * 100)}`
      : '') +
    '. Simplified fixed-mount pointing, no real RF link budget.';
}

function adoptSearchHit(hit: SearchHit) {
  const spacing = searchCatalog?.method.azimuthSpacingDeg || 2;
  const elevBins = hit.elevBins.length
    ? hit.elevBins
    : (searchCatalog?.candidates.find(c => c.id === hit.siteId)?.elevBins ?? []);
  adoptedSearchHorizon = candidateToHorizon(
    {
      id: hit.siteId,
      latitudeDeg: hit.latitudeDeg,
      longitudeEastDeg: hit.longitudeEastDeg,
      surfaceElevationM: hit.surfaceElevationM,
      elevBins,
    },
    spacing,
  );
  adoptedSearchElevationM = hit.surfaceElevationM;
  // Clear before setCustomCoords so subscribeScenario always re-flies the camera.
  lastFocusKey = '';
  setCustomCoords('A', hit.latitudeDeg, hit.longitudeEastDeg);
  el('search-status').textContent = `Adopted ${hit.publishedLabel} → Site A (overview LOLA horizon retained)`;
}

function renderPathfindResult(result: PathfindResult) {
  el('pathfind-results').hidden = false;
  el('pathfind-summary').innerHTML = `
    <div><span>Total distance</span><strong>${Math.round(result.totalDistanceKm).toLocaleString()} km</strong></div>
    <div><span>Sunlit</span><strong>${fmtPct(result.sunlitFraction * 100)}</strong></div>
    <div><span>Earth comm</span><strong>${fmtPct(result.earthCommFraction * 100)}</strong></div>
    <div><span>Obstacles touched</span><strong>${result.obstaclesTouched}</strong></div>`;
  const strip = el('pathfind-strip');
  strip.replaceChildren();
  for (const wp of result.waypoints) {
    const span = document.createElement('span');
    const color = wp.sunlit && wp.earthVisible ? 'var(--both)'
      : wp.sunlit ? 'var(--sun)'
      : wp.earthVisible ? 'var(--earth)'
      : 'var(--muted)';
    span.style.background = wp.blocked ? 'var(--nogo)' : color;
    span.title = `${wp.id} · ${wp.sunlit ? 'sunlit' : 'dark'} · ${wp.earthVisible ? 'Earth visible' : 'no Earth comm'}${wp.blocked ? ' · BLOCKED' : ''}`;
    strip.append(span);
  }
}

async function runPathfind() {
  const state = getScenario();
  const token = ++pathfindToken;
  const button = el<HTMLButtonElement>('compute-pathfind');
  const status = el('pathfind-status');
  button.disabled = true;
  status.textContent = 'Computing A* relay path over the Earth–Moon corridor…';
  el('pathfind-results').hidden = true;
  try {
    const result = await fetchPathfind(state.startUtc, base);
    if (token !== pathfindToken) return;
    if (!result) {
      status.textContent = 'Pathfinding backend unavailable — is the science backend running?';
      return;
    }
    renderPathfindResult(result);
    status.textContent = `Computed for mission start ${state.startUtc.slice(0, 16)}Z.`;
  } catch (error) {
    if (token !== pathfindToken) return;
    console.error(error);
    status.textContent = 'Pathfinding failed — check console.';
  } finally {
    if (token === pathfindToken) button.disabled = false;
  }
}

async function recompute(state: ScenarioState) {
  const key = JSON.stringify({
    a: state.primary, b: state.secondary, start: state.startUtc,
    hours: state.durationHours, th: state.thresholds, compare: state.compareEnabled,
  });
  if (key === lastKey && assessA) {
    paintScrubOnly(state);
    return;
  }
  lastKey = key;
  const token = ++recomputeToken;
  el('status').textContent = 'Updating power & comms assessment…';
  try {
    const nextA = await computeSlot(state, 'A');
    const nextB = state.compareEnabled ? await computeSlot(state, 'B') : undefined;
    if (token !== recomputeToken) return;
    assessA = nextA;
    assessB = nextB;
    if (
      state.primary.siteId === 'custom'
      && state.primary.customLatDeg != null
      && matchesAdoptedSearch(state.primary.customLatDeg, state.primary.customLonEastDeg ?? 0)
      && adoptedSearchHorizon
    ) {
      cachedHorizon = adoptedSearchHorizon;
    } else if (lastPrimaryHorizon) {
      // Keep the skyline in sync with whatever horizon nextA's assessment actually used (bundled, sphere,
      // or the Person 2 backend) — computeSlot() already resolved this; don't re-derive it independently.
      cachedHorizon = lastPrimaryHorizon;
    } else {
      cachedHorizon = await loadHorizonProfile(
        state.primary.siteId, base, state.primary.customLatDeg, state.primary.customLonEastDeg,
      );
    }
    if (token !== recomputeToken) return;
    paintAssessment(state, { syncUrlNow: true });
    el('status').textContent = '';
    void refreshIlluminationOverlay(state);
    void refreshAntennaLinkQuality(state);
  } catch (error) {
    if (token !== recomputeToken) return;
    console.error(error);
    el('status').textContent = 'Assessment failed — check console.';
  }
}

function syncControlsFromState(state: ScenarioState) {
  const scrubOnly = isScrubOnlyChange(lastUiState, state);
  lastUiState = state;

  if (scrubOnly) {
    scheduleScrubPaint(state);
    return;
  }

  clearStaleDecisionLists(state);

  // Drop retained search horizon if Site A left those coordinates.
  if (
    adoptedSearchHorizon
    && !(
      state.primary.siteId === 'custom'
      && state.primary.customLatDeg != null
      && matchesAdoptedSearch(state.primary.customLatDeg, state.primary.customLonEastDeg ?? 0)
    )
  ) {
    clearAdoptedSearchHorizon();
  }

  // Site / compare changes → 3D focus + marker categories follow Site A (and B).
  syncTerrainToScenario(state);

  document.body.classList.toggle('mode-learn', state.mode === 'learn');
  document.body.classList.toggle('mode-planner', state.mode === 'planner');
  // Simple view is the default everywhere; the expert checkbox reveals the full grids,
  // thresholds, and provenance in both Planner and Learn.
  document.body.classList.toggle('show-tech', state.showTechnicalDetails);
  document.body.classList.toggle('hide-b', !state.compareEnabled);
  el('mode-planner').classList.toggle('active', state.mode === 'planner');
  el('mode-learn').classList.toggle('active', state.mode === 'learn');
  el<HTMLButtonElement>('mode-planner').setAttribute('aria-pressed', String(state.mode === 'planner'));
  el<HTMLButtonElement>('mode-learn').setAttribute('aria-pressed', String(state.mode === 'learn'));
  el('learn-panel').hidden = state.mode !== 'learn';
  el('mode-tagline').textContent = state.mode === 'learn'
    ? 'See why south-pole lighting and Earth visibility make landing dates so unforgiving.'
    : 'Find, compare, and decide landing sites and dates for solar power and direct-to-Earth communications.';
  fillSiteSelect(el<HTMLSelectElement>('site'), state.primary.siteId);
  fillSiteSelect(el<HTMLSelectElement>('site-b'), state.secondary.siteId);
  el('custom-a').hidden = state.primary.siteId !== 'custom';
  el('custom-b').hidden = state.secondary.siteId !== 'custom';
  if (state.primary.siteId === 'custom') {
    if (state.primary.customLatDeg != null) el<HTMLInputElement>('lat-a').value = String(state.primary.customLatDeg);
    if (state.primary.customLonEastDeg != null) el<HTMLInputElement>('lon-a').value = String(state.primary.customLonEastDeg);
  }
  if (state.secondary.siteId === 'custom') {
    if (state.secondary.customLatDeg != null) el<HTMLInputElement>('lat-b').value = String(state.secondary.customLatDeg);
    if (state.secondary.customLonEastDeg != null) el<HTMLInputElement>('lon-b').value = String(state.secondary.customLonEastDeg);
  }
  el<HTMLInputElement>('compare-toggle').checked = state.compareEnabled;
  el<HTMLInputElement>('start-utc').value = localDateInputValue(state.startUtc);
  el<HTMLInputElement>('duration').value = String(state.durationHours);
  const scrub = el<HTMLInputElement>('scrub');
  scrub.max = String(state.durationHours);
  if (document.activeElement !== scrub) {
    scrub.value = String(Math.max(0, Math.min(state.durationHours,
      (Date.parse(state.scrubUtc) - Date.parse(state.startUtc)) / 3600_000)));
  }
  el<HTMLInputElement>('min-earth-el').value = String(state.thresholds.minEarthElevationDeg);
  el<HTMLInputElement>('panel-area').value = String(state.thresholds.panelAreaM2);
  el<HTMLInputElement>('panel-eff').value = String(state.thresholds.panelEfficiency);
  el<HTMLInputElement>('panel-tilt').value = String(state.thresholds.panelTiltDeg);
  el<HTMLInputElement>('battery-floor').value = String(state.thresholds.batteryFloorW);
  el<HTMLInputElement>('tech-details').checked = state.showTechnicalDetails;
  window.clearTimeout(recomputeTimer);
  recomputeTimer = window.setTimeout(() => void recompute(state), 60);
}

function renderRankList(rows: RankedSite[]) {
  const list = el('rank-list');
  list.replaceChildren();
  if (!rows.length) {
    list.innerHTML = '<p class="empty-hint">Click “Rank known sites” to score every catalog site (+ current custom Site A) for this window.</p>';
    return;
  }
  rows.forEach((row, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `rank-item viability-${viabilityClass(row.viability)}`;
    item.setAttribute('role', 'listitem');
    const badge = authorityBadge(row.horizonModel, row.ephemerisSource);
    item.innerHTML = `
      <span class="rank-pos">#${i + 1}</span>
      <span class="rank-body">
        <strong>${row.publishedLabel} · ${row.label}</strong>
        <span class="rank-metrics">${row.viability} · both ${fmtPct(row.simultaneousPct)} · sun ${fmtPct(row.sunlightPct)} · Earth ${fmtPct(row.earthLosPct)} · ${badge}</span>
      </span>
      <span class="rank-adopt">Adopt</span>`;
    item.onclick = () => {
      lastFocusKey = '';
      if (row.siteId === 'custom') {
        const s = getScenario();
        // Keep adopted search horizon if this custom row is the retained search site.
        if (!matchesAdoptedSearch(s.primary.customLatDeg ?? 999, s.primary.customLonEastDeg ?? 999)) {
          clearAdoptedSearchHorizon();
        }
        setCustomCoords('A', s.primary.customLatDeg ?? -89.5, s.primary.customLonEastDeg ?? 0);
      } else {
        clearAdoptedSearchHorizon();
        setPrimarySite(row.siteId);
      }
      // subscribeScenario → syncTerrainToScenario flies camera + updates chosen marker.
      el('rank-status').textContent = `Adopted ${row.publishedLabel} → Site A`;
    };
    list.append(item);
  });
}

function renderSearchList(rows: SearchHit[]) {
  const list = el('search-list');
  list.replaceChildren();
  if (!rows.length) {
    list.innerHTML = '<p class="empty-hint">Click “Find best location” to score the polar overview grid for this mission window.</p>';
    return;
  }
  rows.forEach((row, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `rank-item viability-${viabilityClass(row.viability)}`;
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      <span class="rank-pos">#${i + 1}</span>
      <span class="rank-body">
        <strong>${row.publishedLabel} · ${Math.abs(row.latitudeDeg).toFixed(3)}°S ${row.longitudeEastDeg.toFixed(2)}°E</strong>
        <span class="rank-metrics">${row.viability} · both ${fmtPct(row.simultaneousPct)} · sun ${fmtPct(row.sunlightPct)} · Earth ${fmtPct(row.earthLosPct)} · avg ${fmtPower(row.meanPowerW)} (needs ${fmtPower(getScenario().thresholds.batteryFloorW)}) · overview LOLA</span>
      </span>
      <span class="rank-adopt">Adopt</span>`;
    item.onclick = () => adoptSearchHit(row);
    list.append(item);
  });
}

async function runFindBestLocation() {
  const state = getScenario();
  const token = ++searchToken;
  el('search-status').textContent = 'Loading grid…';
  el('search-list').innerHTML = '<p class="empty-hint">Scoring overview candidates…</p>';
  try {
    if (!searchCatalog) searchCatalog = await loadSearchCatalog(base);
    if (token !== searchToken) return;
    const regionSel = el<HTMLSelectElement>('search-region').value;
    const topN = Math.max(3, Math.min(25, Number(el<HTMLInputElement>('search-topn').value) || 8));
    const a = resolveSiteCoords(state.primary.siteId, state.primary.customLatDeg, state.primary.customLonEastDeg);
    const region =
      regionSel === 'around'
        ? {
            kind: 'around' as const,
            latitudeDeg: a.latitudeDeg,
            longitudeEastDeg: a.longitudeEastDeg,
            radiusKm: Math.max(10, Number(el<HTMLInputElement>('search-radius').value) || 80),
          }
        : { kind: 'cap' as const };

    el('search-status').textContent = 'Scoring…';
    const { hits, assessed, limitations } = await rankSearchCandidates({
      catalog: searchCatalog,
      state,
      region,
      topN,
      stepHours: 2,
    });
    if (token !== searchToken) return;
    lastSearchHits = hits;
    lastDecisionKey = decisionKey(state);
    renderSearchList(hits);
    syncTerrainToScenario(state, { fly: false });
    const note = el('neighborhood-note');
    note.innerHTML = `<strong>Find best location</strong> scored <strong>${assessed}</strong> coarse candidates
      (${searchCatalog.region.label}${region.kind === 'around' ? `, ≤${region.radiusKm} km of Site A` : ''})
      with <strong>LOLA 320 m overview</strong> horizons + analytic ephemeris (badged). Top ${hits.length} shown as amber ◆ markers.
      ${limitations}`;
    el('search-status').textContent = hits.length
      ? `Top ${hits.length} of ${assessed} · overview LOLA · analytic`
      : `No candidates in region (${assessed} scored)`;
  } catch (error) {
    if (token !== searchToken) return;
    console.error(error);
    el('search-status').textContent = 'Search failed';
    el('search-list').innerHTML = '<p class="empty-hint">Could not run regional search — see console.</p>';
  }
}

function renderDateList(rows: DateSuggestion[]) {
  const list = el('date-list');
  list.replaceChildren();
  if (!rows.length) {
    list.innerHTML = '<p class="empty-hint">Click “Suggest better dates” to score nearby start slips for Site A.</p>';
    return;
  }
  rows.slice(0, 6).forEach((row, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `rank-item viability-${viabilityClass(row.viability)}`;
    item.setAttribute('role', 'listitem');
    const delta = row.deltaSimultaneousPct;
    const deltaTxt = `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% both`;
    item.innerHTML = `
      <span class="rank-pos">#${i + 1}</span>
      <span class="rank-body">
        <strong>${row.label}</strong>
        <span class="rank-metrics">${row.startUtc.slice(0, 10)} · ${row.viability} · both ${fmtPct(row.simultaneousPct)} (${deltaTxt})</span>
      </span>
      <span class="rank-adopt">Apply</span>`;
    item.onclick = () => {
      setMissionWindow(row.startUtc, getScenario().durationHours);
      el('date-status').textContent = `Applied ${row.startUtc.slice(0, 10)}`;
    };
    list.append(item);
  });
}

async function runRankSites() {
  const state = getScenario();
  const token = ++rankToken;
  el('rank-status').textContent = 'Scoring…';
  el('rank-list').innerHTML = '<p class="empty-hint">Assessing catalog…</p>';
  try {
    const jobs: Array<Promise<{ siteId: string; label: string; publishedLabel: string; assessment: MissionAssessment }>> = [];
    for (const site of SITE_CATALOG) {
      jobs.push((async () => {
        const assessment = await computeSlot(state, 'A', { siteId: site.siteId });
        return {
          siteId: site.siteId,
          label: site.name,
          publishedLabel: site.publishedLabel,
          assessment,
        };
      })());
    }
    if (state.primary.siteId === 'custom') {
      jobs.push((async () => {
        const assessment = await computeSlot(state, 'A');
        const coords = resolveSiteCoords('custom', state.primary.customLatDeg, state.primary.customLonEastDeg);
        return {
          siteId: 'custom',
          label: coords.label,
          publishedLabel: 'CUSTOM',
          assessment,
        };
      })());
    }
    const rows = await Promise.all(jobs);
    if (token !== rankToken) return;
    lastRanked = rankAssessments(rows);
    lastDecisionKey = decisionKey(state);
    renderRankList(lastRanked);
    el('rank-status').textContent = `${lastRanked.length} sites · tiered LOLA→overview→sphere · ${state.startUtc.slice(0, 10)} · ${state.durationHours} h`;
  } catch (error) {
    if (token !== rankToken) return;
    console.error(error);
    el('rank-status').textContent = 'Rank failed';
    el('rank-list').innerHTML = '<p class="empty-hint">Could not rank sites — see console.</p>';
  }
}

async function runSuggestDates() {
  const state = getScenario();
  if (!assessA) {
    el('date-status').textContent = 'Wait for assessment…';
    return;
  }
  const token = ++dateToken;
  el('date-status').textContent = 'Searching slips…';
  el('date-list').innerHTML = '<p class="empty-hint">Scoring nearby starts…</p>';
  try {
    const candidates = await Promise.all(
      DATE_SLIP_OFFSETS_DAYS.map(async offsetDays => {
        const startUtc = slipStartUtc(state.startUtc, offsetDays);
        const assessment = await computeSlot(state, 'A', {
          siteId: state.primary.siteId,
          customLatDeg: state.primary.customLatDeg,
          customLonEastDeg: state.primary.customLonEastDeg,
          startUtc,
        });
        return { offsetDays, startUtc, assessment };
      }),
    );
    if (token !== dateToken) return;
    lastDateSuggestions = buildDateSuggestions(assessA, candidates);
    lastDecisionKey = decisionKey(state);
    renderDateList(lastDateSuggestions);
    const best = lastDateSuggestions[0];
    el('date-status').textContent = best
      ? `Best nearby: ${best.label} (${best.startUtc.slice(0, 10)}) · ${best.ephemerisSource}`
      : 'No alternatives';
  } catch (error) {
    if (token !== dateToken) return;
    console.error(error);
    el('date-status').textContent = 'Suggest failed';
    el('date-list').innerHTML = '<p class="empty-hint">Could not suggest dates — see console.</p>';
  }
}

function jumpToBestWindow() {
  if (!assessA) return;
  const best = findBestWindow(assessA);
  if (!best.window) {
    el('best-window-label').textContent = 'No window to jump to.';
    return;
  }
  setScrubUtc(best.window.startUtc);
}

function stopPlay() {
  playing = false;
  window.clearInterval(playTimer);
  playTimer = 0;
  el('play-scrub').hidden = false;
  el('pause-scrub').hidden = true;
  el<HTMLButtonElement>('play-scrub').setAttribute('aria-pressed', 'false');
}

function startPlay() {
  stopPlay();
  playing = true;
  el('play-scrub').hidden = true;
  el('pause-scrub').hidden = false;
  el<HTMLButtonElement>('play-scrub').setAttribute('aria-pressed', 'true');
  const tickMs = 80;
  playTimer = window.setInterval(() => {
    if (!playing) return;
    const state = getScenario();
    const speed = Number(el<HTMLSelectElement>('play-speed').value) || 1;
    const hoursPerTick = 0.25 * speed;
    const cur = (Date.parse(state.scrubUtc) - Date.parse(state.startUtc)) / 3600_000;
    let next = cur + hoursPerTick;
    if (next >= state.durationHours) {
      next = 0;
    }
    setScrubUtc(new Date(Date.parse(state.startUtc) + next * 3600_000).toISOString());
  }, tickMs);
}

function setPickMode(enabled: boolean) {
  el('cancel-pick').hidden = !enabled;
  el<HTMLButtonElement>('pick-map-a').classList.toggle('active-pick', enabled);
  if (!terrain) return;
  if (!enabled) {
    terrain.setPickMode(false);
    return;
  }
  terrain.setPickMode(true, (lat, lon) => {
    el<HTMLInputElement>('lat-a').value = lat.toFixed(4);
    el<HTMLInputElement>('lon-a').value = lon.toFixed(4);
    lastFocusKey = '';
    clearAdoptedSearchHorizon();
    setCustomCoords('A', lat, lon);
    el('status').textContent = `Custom Site A set to ${lat.toFixed(3)}°, ${lon.toFixed(3)}°E (optimistic sphere horizon).`;
    setPickMode(false);
  });
}

function wireMetricHelpChrome() {
  const pairs: Array<[string, MetricHelpId, string]> = [
    ['verdict-help-a', 'viability', 'a'],
    ['instant-help-a', 'instant', 'a'],
    ['verdict-help-b', 'viability', 'b'],
    ['instant-help-b', 'instant', 'b'],
    ['help-min-earth-el', 'minEarthEl', 'th'],
    ['help-panel-area', 'panelArea', 'th'],
    ['help-panel-eff', 'panelEff', 'th'],
    ['help-panel-tilt', 'panelTilt', 'th'],
    ['help-battery-floor', 'batteryFloor', 'th'],
  ];
  for (const [id, helpId, uid] of pairs) {
    const host = document.getElementById(id);
    if (host) mountStaticHelp(host, helpId, uid);
  }
  const primerLearn = el('learn-power-comms');
  if (primerLearn && !primerLearn.dataset.filled) {
    primerLearn.textContent = POWER_COMMS_PRIMER;
    primerLearn.dataset.filled = '1';
  }
}

function wireUi() {
  wireMetricHelpChrome();
  el('mode-planner').onclick = () => setMode('planner');
  el('mode-learn').onclick = () => setMode('learn');
  el<HTMLSelectElement>('site').onchange = e => {
    lastFocusKey = '';
    clearAdoptedSearchHorizon();
    setPrimarySite((e.target as HTMLSelectElement).value);
  };
  el<HTMLSelectElement>('site-b').onchange = e => {
    setSecondarySite((e.target as HTMLSelectElement).value);
  };
  el<HTMLInputElement>('compare-toggle').onchange = e => {
    toggleCompare((e.target as HTMLInputElement).checked);
  };
  el('apply-custom-a').onclick = () => {
    lastFocusKey = '';
    const lat = Number(el<HTMLInputElement>('lat-a').value);
    const lon = Number(el<HTMLInputElement>('lon-a').value);
    if (!matchesAdoptedSearch(lat, lon)) clearAdoptedSearchHorizon();
    setCustomCoords('A', lat, lon);
  };
  el('apply-custom-b').onclick = () => {
    // Site B edits must not clear Site A focus key / adopted search horizon.
    setCustomCoords('B', Number(el<HTMLInputElement>('lat-b').value), Number(el<HTMLInputElement>('lon-b').value));
  };
  el('pick-map-a').onclick = () => setPickMode(true);
  el('cancel-pick').onclick = () => setPickMode(false);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && terrain?.isPickMode()) setPickMode(false);
  });
  el<HTMLInputElement>('toggle-catalog-markers').onchange = e => {
    terrain?.setCatalogMarkersVisible((e.target as HTMLInputElement).checked);
  };
  el<HTMLInputElement>('toggle-search-markers').onchange = e => {
    terrain?.setSearchMarkersVisible((e.target as HTMLInputElement).checked);
  };
  el<HTMLInputElement>('toggle-illumination-overlay').onchange = () => {
    lastIlluminationKey = ''; // force recompute even if the mission window key is unchanged
    void refreshIlluminationOverlay(getScenario());
  };

  el<HTMLInputElement>('start-utc').onchange = e => {
    setMissionWindow(dateInputToUtcIso((e.target as HTMLInputElement).value), getScenario().durationHours);
  };
  el<HTMLInputElement>('duration').onchange = e => {
    setMissionWindow(getScenario().startUtc, Number((e.target as HTMLInputElement).value));
  };
  el<HTMLInputElement>('scrub').oninput = e => {
    setScrubUtc(new Date(Date.parse(getScenario().startUtc) + Number((e.target as HTMLInputElement).value) * 3600_000).toISOString());
  };
  const th = () => setThresholds({
    minEarthElevationDeg: Number(el<HTMLInputElement>('min-earth-el').value),
    panelAreaM2: Number(el<HTMLInputElement>('panel-area').value),
    panelEfficiency: Number(el<HTMLInputElement>('panel-eff').value),
    panelTiltDeg: Number(el<HTMLInputElement>('panel-tilt').value),
    batteryFloorW: Number(el<HTMLInputElement>('battery-floor').value),
  });
  for (const id of ['min-earth-el', 'panel-area', 'panel-eff', 'panel-tilt', 'battery-floor']) el(id).onchange = th;
  for (const id of ['antenna-boresight-az', 'antenna-boresight-el', 'antenna-beamwidth']) {
    el(id).onchange = () => void refreshAntennaLinkQuality(getScenario());
  }
  el('compute-pathfind').onclick = () => void runPathfind();
  el<HTMLInputElement>('tech-details').onchange = e => toggleTechnicalDetails((e.target as HTMLInputElement).checked);
  el('focus').onclick = () => {
    lastFocusKey = '';
    syncTerrainToScenario(getScenario(), { fly: true });
  };

  el('find-best-location').onclick = () => void runFindBestLocation();
  el('rank-sites').onclick = () => void runRankSites();
  el('suggest-dates').onclick = () => void runSuggestDates();
  el('jump-best-window').onclick = () => jumpToBestWindow();
  el('play-scrub').onclick = () => startPlay();
  el('pause-scrub').onclick = () => stopPlay();

  document.querySelectorAll<HTMLButtonElement>('[data-slip]').forEach(btn => {
    btn.onclick = () => {
      const days = Number(btn.dataset.slip);
      const next = slipStartUtc(getScenario().startUtc, days);
      setMissionWindow(next, getScenario().durationHours);
    };
  });

  document.querySelectorAll<HTMLButtonElement>('[data-season]').forEach(btn => {
    btn.onclick = () => {
      const kind = btn.dataset.season;
      if (kind === 'jan15') setMissionWindow('2027-01-15T00:00:00.000Z', 168);
      else if (kind === 'jan1') setMissionWindow('2027-01-01T00:00:00.000Z', 168);
      else if (kind === 'jan29') setMissionWindow('2027-01-29T00:00:00.000Z', 168);
      else if (kind === 'lunar-day') setMissionWindow(getScenario().startUtc, 708);
    };
  });

  document.querySelectorAll<HTMLButtonElement>('[data-guide]').forEach(btn => {
    btn.onclick = () => {
      const guide = btn.dataset.guide;
      lastFocusKey = '';
      if (guide === 'cr1-jan') {
        setScenario({
          primary: { id: 'A', siteId: 'connecting-ridge-cr1' },
          startUtc: '2027-01-15T00:00:00.000Z', scrubUtc: '2027-01-15T00:00:00.000Z',
          durationHours: 168, compareEnabled: false,
        });
      } else if (guide === 'sr1-jan') {
        setScenario({
          primary: { id: 'A', siteId: 'shackleton-rim-sr1' },
          startUtc: '2027-01-15T00:00:00.000Z', scrubUtc: '2027-01-15T00:00:00.000Z',
          durationHours: 168, compareEnabled: false,
        });
      } else if (guide === 'compare') {
        setScenario({
          primary: { id: 'A', siteId: 'connecting-ridge-cr1' },
          secondary: { id: 'B', siteId: 'shackleton-rim-sr1' },
          startUtc: '2027-01-15T00:00:00.000Z', scrubUtc: '2027-01-15T00:00:00.000Z',
          durationHours: 168, compareEnabled: true,
        });
      } else if (guide === 'slip') {
        setScenario({
          primary: { id: 'A', siteId: 'connecting-ridge-cr1' },
          secondary: { id: 'B', siteId: 'shackleton-rim-sr1' },
          startUtc: '2027-01-29T00:00:00.000Z', scrubUtc: '2027-01-29T00:00:00.000Z',
          durationHours: 168, compareEnabled: true,
        });
      } else if (guide === 'apollo') {
        setScenario({
          mode: 'learn',
          primary: { id: 'A', siteId: 'apollo-11' },
          secondary: { id: 'B', siteId: 'connecting-ridge-cr1' },
          startUtc: '2027-01-15T00:00:00.000Z', scrubUtc: '2027-01-15T00:00:00.000Z',
          durationHours: 168, compareEnabled: true,
        });
        // Equatorial: syncTerrain will globe-focus via focusLatLon outside cap.
      } else if (guide === 'rank') {
        void runRankSites();
        el('decision-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (guide === 'search') {
        void runFindBestLocation();
        el('decision-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    };
  });

  el('copy-link').onclick = async () => {
    const url = `${location.origin}${location.pathname}?${scenarioToSearchParams()}`;
    try {
      await navigator.clipboard.writeText(url);
      el('share-status').textContent = 'Link copied.';
    } catch {
      el('share-status').textContent = url;
    }
  };
  el('export-json').onclick = () => {
    if (!assessA) return;
    const payload = {
      exportedAtUtc: new Date().toISOString(),
      scenario: getScenario(),
      siteA: assessA,
      siteB: assessB ?? null,
      ranking: lastRanked.map(r => ({
        siteId: r.siteId, viability: r.viability, simultaneousPct: r.simultaneousPct, score: r.score,
      })),
      regionalSearch: lastSearchHits.map(r => ({
        siteId: r.siteId,
        latitudeDeg: r.latitudeDeg,
        longitudeEastDeg: r.longitudeEastDeg,
        viability: r.viability,
        simultaneousPct: r.simultaneousPct,
        score: r.score,
      })),
      dateSuggestions: lastDateSuggestions,
      notes: [
        'Quest/VR export shape: time-series samples with sun/earth flags and power proxy.',
        'No Quest VR runtime is bundled — consume this JSON in an external viewer.',
        'Regional search uses LOLA 320 m overview horizons — not meter-perfect.',
      ],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lunar-site-navigator-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    el('share-status').textContent = 'Exported time-series JSON.';
  };
  // Calendar timeline: click (or drag-hover) to jump the time slider.
  const timelineCanvas = el<HTMLCanvasElement>('timeline');
  const timelineTimeAt = (ev: MouseEvent): string | null => {
    const d = timelineCanvas.dataset;
    const t0 = Number(d.t0);
    const t1 = Number(d.t1);
    const trackX = Number(d.trackX);
    const trackW = Number(d.trackW);
    if (!Number.isFinite(t0) || !Number.isFinite(trackW) || trackW <= 0) return null;
    const rect = timelineCanvas.getBoundingClientRect();
    const f = (ev.clientX - rect.left - trackX) / trackW;
    if (f < 0 || f > 1) return null;
    return new Date(t0 + f * (t1 - t0)).toISOString();
  };
  timelineCanvas.addEventListener('click', ev => {
    const t = timelineTimeAt(ev);
    if (t) setScrubUtc(t);
  });
  timelineCanvas.addEventListener('mousemove', ev => {
    const t = timelineTimeAt(ev);
    timelineCanvas.title = t ? `Click to jump the time slider to ${t.slice(0, 16)}Z` : '';
  });

  window.addEventListener('resize', () => {
    if (assessA) paintAssessment(getScenario());
  });

  renderRankList([]);
  renderDateList([]);
  renderSearchList([]);
}

async function boot() {
  applyUrlParams(location.search);
  wireUi();
  syncControlsFromState(getScenario());
  subscribeScenario(syncControlsFromState);

  const tour = createTour(el('tour-root'));
  el('replay-tour').onclick = () => tour.start(true, 'quick');
  el('full-tour').onclick = () => tour.start(true, 'full');

  try {
    terrain = await startTerrain();
    terrain.onMarkerClick(marker => {
      if (marker.category === 'chosen') return;
      lastFocusKey = '';
      if (marker.category === 'catalog') {
        const siteId = marker.id.replace(/^catalog-/, '');
        setPrimarySite(siteId);
        el('status').textContent = `Adopted catalog ${marker.label ?? siteId} as Site A.`;
        return;
      }
      if (marker.category === 'search') {
        const hit = lastSearchHits.find(h => h.siteId === marker.id);
        if (hit) adoptSearchHit(hit);
        else setCustomCoords('A', marker.latitudeDeg, marker.longitudeEastDeg);
        return;
      }
      if (marker.category === 'compare') {
        // Focus Site B without changing Site A.
        terrain?.focusLatLon(marker.latitudeDeg, marker.longitudeEastDeg);
      }
    });
    lastFocusKey = '';
    syncTerrainToScenario(getScenario(), { fly: true });
  } catch (error) {
    el('status').textContent = 'Could not open the polar terrain viewer.';
    console.error(error);
  }

  window.setTimeout(() => tour.start(false), 700);
}

void boot();
