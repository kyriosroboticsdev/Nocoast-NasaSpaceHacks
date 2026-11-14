import './style.css';
import { startTerrain, type TerrainApi } from './main';
import { CATALOG_GROUP_LABELS, SITE_CATALOG, findSite, resolveSiteCoords } from './scenario/catalog';
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
import { assessMission, type MissionAssessment } from './assess/windows';
import {
  DATE_SLIP_OFFSETS_DAYS,
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
} from './ui/format';
import { createTour } from './ui/tour';

const base = import.meta.env.BASE_URL;
const el = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;

let terrain: TerrainApi | undefined;
let assessA: MissionAssessment | undefined;
let assessB: MissionAssessment | undefined;
let cachedHorizon: HorizonProfile | undefined;
let lastKey = '';
let lastUiState: ScenarioState | undefined;
let recomputeTimer = 0;
let scrubPaintRaf = 0;
let urlSyncTimer = 0;
let playTimer = 0;
let playing = false;
let lastRanked: RankedSite[] = [];
let lastDateSuggestions: DateSuggestion[] = [];

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
  const rows: Array<[string, string, boolean?, string?]> = [
    ['— Mission window —', '', false, 'group'],
    ['Sunlight availability', fmtPct(a.sunlightPct)],
    ['Earth LOS availability', fmtPct(a.earthLosPct)],
    ['Sun ∩ Earth windows', fmtPct(a.simultaneousPct)],
    ['Mean power proxy', fmtPower(a.meanPowerW)],
    ['Peak power proxy', fmtPower(a.peakPowerW), true],
    ['Longest sun blackout', fmtHours(a.longestSunBlackoutHours)],
    ['Longest Earth blackout', fmtHours(a.longestEarthBlackoutHours)],
    ['— At scrub time —', '', false, 'group'],
    ['Time to sunset', fmtHours(a.hoursToSunset)],
    ['Time to Earthset', fmtHours(a.hoursToEarthset)],
    ['Sun elev (scrub)', fmtDeg(instant?.sunEl), true],
    ['Sun clear elev', fmtDeg(instant?.sunClearEl), true],
    ['Earth elev (scrub)', fmtDeg(instant?.earthEl), true],
    ['Earth clear elev', fmtDeg(instant?.earthClearEl), true],
  ];
  target.replaceChildren();
  for (const [label, value, tech, kind] of rows) {
    const div = document.createElement('div');
    if (kind === 'group') {
      div.className = 'metric-group';
      div.innerHTML = `<span>${label}</span>`;
      target.append(div);
      continue;
    }
    if (tech) div.className = 'tech-only';
    div.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
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
  const horizon = await loadHorizonProfile(sc.siteId, base, coords.latitudeDeg, coords.longitudeEastDeg);
  const provider = await createEphemerisProvider({
    siteId: sc.siteId,
    latDeg: coords.latitudeDeg,
    lonEastDeg: coords.longitudeEastDeg,
    altitudeKm: (coords.elevationM + coords.observerHeightM) / 1000,
    startUtc,
    durationHours: state.durationHours,
    baseUrl: base,
    allowLive: false,
  });
  return assessMission({
    siteId: sc.siteId,
    siteLabel: coords.label,
    horizonModel: coords.horizonModel,
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
      ? 'Try Rank sites, Suggest better dates, or slip ±7/14 days — or enable compare with Site B.'
      : 'Consider a date slip or Site B compare if margins look tight.';
  prompt.textContent = `${explainVerdict(a)} ${action}`;
}

function paintBestWindowLabel(a: MissionAssessment) {
  const best = findBestWindow(a);
  const label = el('best-window-label');
  if (!best.window) {
    label.textContent = 'No clear sun/Earth window in this mission span.';
    return;
  }
  const kind =
    best.kind === 'simultaneous' ? 'Best sun ∩ Earth' :
    best.kind === 'sunlight' ? 'Best sunlight (no ∩)' :
    'Best Earth LOS (no ∩)';
  label.textContent = `${kind}: ${best.window.hours.toFixed(1)} h · ${best.window.startUtc.slice(0, 16)}Z → ${best.window.endUtc.slice(0, 16)}Z (highlighted on timeline)`;
}

function paintLearnTip(a: MissionAssessment, b?: MissionAssessment) {
  const tip = el('learn-verdict-tip');
  if (!tip) return;
  let text = explainVerdict(a);
  if (b) {
    text += ` Compared with ${b.siteLabel}: ${b.viability} (∩ ${b.simultaneousPct.toFixed(0)}% vs ${a.simultaneousPct.toFixed(0)}%).`;
  }
  tip.textContent = text;
}

function paintAssessment(state: ScenarioState, opts: { syncUrlNow?: boolean } = {}) {
  if (!assessA) return;
  el('metrics-a-title').textContent = assessA.siteLabel;
  const viabA = el('viability-a');
  viabA.textContent = `${assessA.viability} · ${assessA.viabilityReason}`;
  viabA.className = `viability ${viabilityClass(assessA.viability)}`;
  paintInstantChip('instant-a', assessA, state.scrubUtc);
  paintNogoPrompt(assessA);
  paintBestWindowLabel(assessA);
  renderMetricGrid(el('metric-grid-a'), assessA, state.scrubUtc);
  el('horizon-flag-a').textContent = assessA.horizonModel === 'lola_terrain'
    ? `Horizon: LOLA terrain · ephemeris ${assessA.ephemerisSource}`
    : `⚠ Horizon: optimistic sphere · ephemeris ${assessA.ephemerisSource}`;

  if (assessB && state.compareEnabled) {
    el('metrics-b').hidden = false;
    el('metrics-b-title').textContent = assessB.siteLabel;
    const viabB = el('viability-b');
    viabB.textContent = `${assessB.viability} · ${assessB.viabilityReason}`;
    viabB.className = `viability ${viabilityClass(assessB.viability)}`;
    paintInstantChip('instant-b', assessB, state.scrubUtc);
    renderMetricGrid(el('metric-grid-b'), assessB, state.scrubUtc);
    el('horizon-flag-b').textContent = assessB.horizonModel === 'lola_terrain'
      ? `Horizon: LOLA terrain · ephemeris ${assessB.ephemerisSource}`
      : `⚠ Horizon: optimistic sphere · ephemeris ${assessB.ephemerisSource}`;
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
  el('status').textContent = 'Updating power & comms assessment…';
  try {
    assessA = await computeSlot(state, 'A');
    assessB = state.compareEnabled ? await computeSlot(state, 'B') : undefined;
    cachedHorizon = await loadHorizonProfile(
      state.primary.siteId, base, state.primary.customLatDeg, state.primary.customLonEastDeg,
    );
    paintAssessment(state, { syncUrlNow: true });
    el('status').textContent = '';
  } catch (error) {
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

  document.body.classList.toggle('mode-learn', state.mode === 'learn');
  document.body.classList.toggle('mode-planner', state.mode === 'planner');
  document.body.classList.toggle('show-tech', state.showTechnicalDetails || state.mode === 'planner');
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
    list.innerHTML = '<p class="empty-hint">Click “Rank sites for this window” to score the catalog (+ current custom Site A).</p>';
    return;
  }
  rows.forEach((row, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `rank-item viability-${viabilityClass(row.viability)}`;
    item.setAttribute('role', 'listitem');
    const sphere = row.horizonModel !== 'lola_terrain' ? ' · sphere' : ' · LOLA';
    item.innerHTML = `
      <span class="rank-pos">#${i + 1}</span>
      <span class="rank-body">
        <strong>${row.publishedLabel} · ${row.label}</strong>
        <span class="rank-metrics">${row.viability} · ∩ ${fmtPct(row.simultaneousPct)} · sun ${fmtPct(row.sunlightPct)} · Earth ${fmtPct(row.earthLosPct)}${sphere}</span>
      </span>
      <span class="rank-adopt">Adopt</span>`;
    item.onclick = () => {
      if (row.siteId === 'custom') {
        const s = getScenario();
        setCustomCoords('A', s.primary.customLatDeg ?? -89.5, s.primary.customLonEastDeg ?? 0);
      } else {
        setPrimarySite(row.siteId);
        const site = findSite(row.siteId);
        if (site) terrain?.focusLatLon(site.latitudeDeg, site.longitudeEastDeg);
      }
      el('rank-status').textContent = `Adopted ${row.publishedLabel}`;
    };
    list.append(item);
  });
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
    const deltaTxt = `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% ∩`;
    item.innerHTML = `
      <span class="rank-pos">#${i + 1}</span>
      <span class="rank-body">
        <strong>${row.label}</strong>
        <span class="rank-metrics">${row.startUtc.slice(0, 10)} · ${row.viability} · ∩ ${fmtPct(row.simultaneousPct)} (${deltaTxt})</span>
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
    lastRanked = rankAssessments(rows);
    renderRankList(lastRanked);
    el('rank-status').textContent = `${lastRanked.length} sites · window ${state.startUtc.slice(0, 10)} · ${state.durationHours} h`;
  } catch (error) {
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
    lastDateSuggestions = buildDateSuggestions(assessA, candidates);
    renderDateList(lastDateSuggestions);
    const best = lastDateSuggestions[0];
    el('date-status').textContent = best
      ? `Best nearby: ${best.label} (${best.startUtc.slice(0, 10)})`
      : 'No alternatives';
  } catch (error) {
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
    setCustomCoords('A', lat, lon);
    el('status').textContent = `Custom Site A set to ${lat.toFixed(3)}°, ${lon.toFixed(3)}°E (optimistic sphere horizon).`;
    setPickMode(false);
  });
}

function wireUi() {
  el('mode-planner').onclick = () => setMode('planner');
  el('mode-learn').onclick = () => setMode('learn');
  el<HTMLSelectElement>('site').onchange = e => {
    const siteId = (e.target as HTMLSelectElement).value;
    setPrimarySite(siteId);
    const coords = resolveSiteCoords(siteId, getScenario().primary.customLatDeg, getScenario().primary.customLonEastDeg);
    terrain?.focusLatLon(coords.latitudeDeg, coords.longitudeEastDeg);
  };
  el<HTMLSelectElement>('site-b').onchange = e => setSecondarySite((e.target as HTMLSelectElement).value);
  el<HTMLInputElement>('compare-toggle').onchange = e => toggleCompare((e.target as HTMLInputElement).checked);
  el('apply-custom-a').onclick = () => {
    const lat = Number(el<HTMLInputElement>('lat-a').value);
    const lon = Number(el<HTMLInputElement>('lon-a').value);
    setCustomCoords('A', lat, lon);
    terrain?.focusLatLon(lat, lon);
  };
  el('apply-custom-b').onclick = () => {
    setCustomCoords('B', Number(el<HTMLInputElement>('lat-b').value), Number(el<HTMLInputElement>('lon-b').value));
  };
  el('pick-map-a').onclick = () => setPickMode(true);
  el('cancel-pick').onclick = () => setPickMode(false);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && terrain?.isPickMode()) setPickMode(false);
  });

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
  el<HTMLInputElement>('tech-details').onchange = e => toggleTechnicalDetails((e.target as HTMLInputElement).checked);
  el('focus').onclick = () => {
    const s = getScenario();
    const coords = resolveSiteCoords(s.primary.siteId, s.primary.customLatDeg, s.primary.customLonEastDeg);
    terrain?.focusLatLon(coords.latitudeDeg, coords.longitudeEastDeg);
  };

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
      if (guide === 'cr1-jan') {
        setScenario({
          primary: { id: 'A', siteId: 'connecting-ridge-cr1' },
          startUtc: '2027-01-15T00:00:00.000Z', scrubUtc: '2027-01-15T00:00:00.000Z',
          durationHours: 168, compareEnabled: false,
        });
        terrain?.focusLatLon(-89.4555, 222.6192);
      } else if (guide === 'sr1-jan') {
        setScenario({
          primary: { id: 'A', siteId: 'shackleton-rim-sr1' },
          startUtc: '2027-01-15T00:00:00.000Z', scrubUtc: '2027-01-15T00:00:00.000Z',
          durationHours: 168, compareEnabled: false,
        });
        terrain?.focusLatLon(-89.7742, 203.4952);
      } else if (guide === 'compare') {
        setScenario({
          primary: { id: 'A', siteId: 'connecting-ridge-cr1' },
          secondary: { id: 'B', siteId: 'shackleton-rim-sr1' },
          startUtc: '2027-01-15T00:00:00.000Z', scrubUtc: '2027-01-15T00:00:00.000Z',
          durationHours: 168, compareEnabled: true,
        });
        terrain?.focusLatLon(-89.4555, 222.6192);
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
        terrain?.showGlobe(true);
      } else if (guide === 'rank') {
        void runRankSites();
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
      dateSuggestions: lastDateSuggestions,
      notes: [
        'Quest/VR export shape: time-series samples with sun/earth flags and power proxy.',
        'No Quest VR runtime is bundled — consume this JSON in an external viewer.',
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
  window.addEventListener('resize', () => {
    if (assessA) paintAssessment(getScenario());
  });

  renderRankList([]);
  renderDateList([]);
}

async function boot() {
  applyUrlParams(location.search);
  wireUi();
  syncControlsFromState(getScenario());
  subscribeScenario(syncControlsFromState);

  const tour = createTour(el('tour-root'));
  el('replay-tour').onclick = () => tour.start(true);

  try {
    terrain = await startTerrain();
    const s = getScenario();
    const coords = resolveSiteCoords(s.primary.siteId, s.primary.customLatDeg, s.primary.customLonEastDeg);
    terrain.focusLatLon(coords.latitudeDeg, coords.longitudeEastDeg);
  } catch (error) {
    el('status').textContent = 'Could not open the polar terrain viewer.';
    console.error(error);
  }

  window.setTimeout(() => tour.start(false), 700);
}

void boot();
