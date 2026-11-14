import './style.css';
import { startTerrain, type TerrainApi } from './main';
import { SITE_CATALOG, resolveSiteCoords } from './scenario/catalog';
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
import { createEphemerisProvider } from './ephemeris/horizons';
import { assessMission, type MissionAssessment } from './assess/windows';
import { renderSkyline } from './viz/skyline';
import {
  dateInputToUtcIso,
  fmtDeg,
  fmtHours,
  fmtPct,
  fmtPower,
  localDateInputValue,
  viabilityClass,
} from './ui/format';

const base = import.meta.env.BASE_URL;
const el = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;

let terrain: TerrainApi | undefined;
let assessA: MissionAssessment | undefined;
let assessB: MissionAssessment | undefined;
let lastKey = '';
let recomputeTimer = 0;

function fillSiteSelect(select: HTMLSelectElement, selected: string) {
  select.replaceChildren();
  const groups = [
    { label: 'Study points (LOLA horizons)', filter: (s: (typeof SITE_CATALOG)[0]) => s.category === 'study' },
    { label: 'Curated catalog', filter: (s: (typeof SITE_CATALOG)[0]) => s.category === 'curated' },
  ];
  for (const group of groups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const site of SITE_CATALOG.filter(group.filter)) {
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
  const rows: Array<[string, string, boolean?]> = [
    ['Sunlight availability', fmtPct(a.sunlightPct)],
    ['Earth LOS availability', fmtPct(a.earthLosPct)],
    ['Sun ∩ Earth windows', fmtPct(a.simultaneousPct)],
    ['Mean power proxy', fmtPower(a.meanPowerW)],
    ['Peak power proxy', fmtPower(a.peakPowerW), true],
    ['Longest sun blackout', fmtHours(a.longestSunBlackoutHours)],
    ['Longest Earth blackout', fmtHours(a.longestEarthBlackoutHours)],
    ['Time to sunset', fmtHours(a.hoursToSunset)],
    ['Time to Earthset', fmtHours(a.hoursToEarthset)],
    ['Sun elev (scrub)', fmtDeg(instant?.sunEl), true],
    ['Sun clear elev', fmtDeg(instant?.sunClearEl), true],
    ['Earth elev (scrub)', fmtDeg(instant?.earthEl), true],
    ['Earth clear elev', fmtDeg(instant?.earthClearEl), true],
  ];
  target.replaceChildren();
  for (const [label, value, tech] of rows) {
    const div = document.createElement('div');
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

async function computeSlot(state: ScenarioState, slot: 'A' | 'B'): Promise<MissionAssessment> {
  const sc = slot === 'A' ? state.primary : state.secondary;
  const coords = resolveSiteCoords(sc.siteId, sc.customLatDeg, sc.customLonEastDeg);
  const horizon = await loadHorizonProfile(sc.siteId, base, coords.latitudeDeg, coords.longitudeEastDeg);
  const provider = await createEphemerisProvider({
    siteId: sc.siteId,
    latDeg: coords.latitudeDeg,
    lonEastDeg: coords.longitudeEastDeg,
    altitudeKm: (coords.elevationM + coords.observerHeightM) / 1000,
    startUtc: state.startUtc,
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
    startUtc: state.startUtc,
    durationHours: state.durationHours,
    scrubUtc: state.scrubUtc,
    thresholds: state.thresholds,
  });
}

function paintAssessment(state: ScenarioState) {
  if (!assessA) return;
  el('metrics-a-title').textContent = assessA.siteLabel;
  const viabA = el('viability-a');
  viabA.textContent = `${assessA.viability} · ${assessA.viabilityReason}`;
  viabA.className = `viability ${viabilityClass(assessA.viability)}`;
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
    renderMetricGrid(el('metric-grid-b'), assessB, state.scrubUtc);
    el('horizon-flag-b').textContent = assessB.horizonModel === 'lola_terrain'
      ? `Horizon: LOLA terrain · ephemeris ${assessB.ephemerisSource}`
      : `⚠ Horizon: optimistic sphere · ephemeris ${assessB.ephemerisSource}`;
  } else {
    el('metrics-b').hidden = true;
  }

  const instant = assessA.samples.reduce((best, s) =>
    Math.abs(Date.parse(s.utc) - Date.parse(state.scrubUtc)) < Math.abs(Date.parse(best.utc) - Date.parse(state.scrubUtc)) ? s : best,
  assessA.samples[0]);
  void loadHorizonProfile(state.primary.siteId, base, state.primary.customLatDeg, state.primary.customLonEastDeg)
    .then(horizon => {
      renderSkyline(el<HTMLCanvasElement>('skyline'), horizon, instant ? {
        sunAz: instant.sunAz, sunEl: instant.sunEl, sunClear: instant.sunlit,
        earthAz: instant.earthAz, earthEl: instant.earthEl, earthClear: instant.earthLos,
      } : undefined);
    });
  el('scrub-label').textContent = `${state.scrubUtc.replace('.000Z', 'Z')} · ${assessA.ephemerisSource}`;
  syncUrl();
}

async function recompute(state: ScenarioState) {
  const key = JSON.stringify({
    a: state.primary, b: state.secondary, start: state.startUtc,
    hours: state.durationHours, th: state.thresholds, compare: state.compareEnabled,
  });
  if (key === lastKey && assessA) {
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
    return;
  }
  lastKey = key;
  el('status').textContent = 'Updating power & comms assessment…';
  try {
    assessA = await computeSlot(state, 'A');
    assessB = state.compareEnabled ? await computeSlot(state, 'B') : undefined;
    paintAssessment(state);
    el('status').textContent = '';
  } catch (error) {
    console.error(error);
    el('status').textContent = 'Assessment failed — check console.';
  }
}

function syncControlsFromState(state: ScenarioState) {
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
    : 'Compare sites and dates for solar power and direct-to-Earth communications.';
  fillSiteSelect(el<HTMLSelectElement>('site'), state.primary.siteId);
  fillSiteSelect(el<HTMLSelectElement>('site-b'), state.secondary.siteId);
  el('custom-a').hidden = state.primary.siteId !== 'custom';
  el('custom-b').hidden = state.secondary.siteId !== 'custom';
  el<HTMLInputElement>('compare-toggle').checked = state.compareEnabled;
  el<HTMLInputElement>('start-utc').value = localDateInputValue(state.startUtc);
  el<HTMLInputElement>('duration').value = String(state.durationHours);
  const scrub = el<HTMLInputElement>('scrub');
  scrub.max = String(state.durationHours);
  scrub.value = String(Math.max(0, Math.min(state.durationHours,
    (Date.parse(state.scrubUtc) - Date.parse(state.startUtc)) / 3600_000)));
  el<HTMLInputElement>('min-earth-el').value = String(state.thresholds.minEarthElevationDeg);
  el<HTMLInputElement>('panel-area').value = String(state.thresholds.panelAreaM2);
  el<HTMLInputElement>('panel-eff').value = String(state.thresholds.panelEfficiency);
  el<HTMLInputElement>('battery-floor').value = String(state.thresholds.batteryFloorW);
  el<HTMLInputElement>('tech-details').checked = state.showTechnicalDetails;
  window.clearTimeout(recomputeTimer);
  recomputeTimer = window.setTimeout(() => void recompute(state), 60);
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
    batteryFloorW: Number(el<HTMLInputElement>('battery-floor').value),
  });
  for (const id of ['min-earth-el', 'panel-area', 'panel-eff', 'battery-floor']) el(id).onchange = th;
  el<HTMLInputElement>('tech-details').onchange = e => toggleTechnicalDetails((e.target as HTMLInputElement).checked);
  el('focus').onclick = () => {
    const s = getScenario();
    const coords = resolveSiteCoords(s.primary.siteId, s.primary.customLatDeg, s.primary.customLonEastDeg);
    terrain?.focusLatLon(coords.latitudeDeg, coords.longitudeEastDeg);
  };
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
      notes: ['Quest/VR export shape: time-series samples with sun/earth flags and power proxy.'],
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
}

async function boot() {
  applyUrlParams(location.search);
  wireUi();
  syncControlsFromState(getScenario());
  subscribeScenario(syncControlsFromState);
  try {
    terrain = await startTerrain();
    const s = getScenario();
    const coords = resolveSiteCoords(s.primary.siteId, s.primary.customLatDeg, s.primary.customLonEastDeg);
    terrain.focusLatLon(coords.latitudeDeg, coords.longitudeEastDeg);
  } catch (error) {
    el('status').textContent = 'Could not open the polar terrain viewer.';
    console.error(error);
  }
}

void boot();
