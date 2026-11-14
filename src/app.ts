import './style.css';
import { startTerrain, type TerrainApi } from './main';
import { SITE_CATALOG, resolveSiteCoords } from './scenario/catalog';
import {
  applyUrlParams,
  getScenario,
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
import { horizonElevationAt, type HorizonProfile } from './horizon/types';
import { createEphemerisProvider, type EphemerisProvider } from './ephemeris/horizons';
import { renderSkyline } from './viz/skyline';
import {
  dateInputToUtcIso,
  fmtDeg,
  localDateInputValue,
} from './ui/format';

const base = import.meta.env.BASE_URL;
const el = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;

let terrain: TerrainApi | undefined;
let horizonA: HorizonProfile | undefined;
let providerA: EphemerisProvider | undefined;
let lastEphemKey = '';

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

function paintSkyline(state: ScenarioState) {
  if (!horizonA || !providerA) return;
  const sun = providerA.get('sun', state.scrubUtc);
  const earth = providerA.get('earth', state.scrubUtc);
  const sunH = horizonElevationAt(horizonA, sun.azimuthDeg);
  const earthH = horizonElevationAt(horizonA, earth.azimuthDeg);
  const sunClear = sunH == null ? null : sun.elevationDeg - sunH;
  const earthClear = earthH == null ? null : earth.elevationDeg - earthH;
  renderSkyline(el<HTMLCanvasElement>('skyline'), horizonA, {
    sunAz: sun.azimuthDeg,
    sunEl: sun.elevationDeg,
    sunClear: sunClear == null ? null : sunClear > 0,
    earthAz: earth.azimuthDeg,
    earthEl: earth.elevationDeg,
    earthClear: earthClear == null ? null : earthClear > 0,
  });
  el('metric-grid-a').replaceChildren();
  const rows: Array<[string, string]> = [
    ['Sun az / el', `${fmtDeg(sun.azimuthDeg)} / ${fmtDeg(sun.elevationDeg)}`],
    ['Sun vs terrain', sunClear == null ? '—' : `${fmtDeg(sunClear)} clear`],
    ['Earth az / el', `${fmtDeg(earth.azimuthDeg)} / ${fmtDeg(earth.elevationDeg)}`],
    ['Earth vs terrain', earthClear == null ? '—' : `${fmtDeg(earthClear)} clear`],
  ];
  for (const [label, value] of rows) {
    const div = document.createElement('div');
    div.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    el('metric-grid-a').append(div);
  }
  el('scrub-label').textContent = `${state.scrubUtc.replace('.000Z', 'Z')} · ${providerA.sourceLabel}`;
  el('viability-a').textContent = 'Ephemeris + terrain obstruction live · full windows next';
}

async function refreshScience(state: ScenarioState) {
  const coords = resolveSiteCoords(state.primary.siteId, state.primary.customLatDeg, state.primary.customLonEastDeg);
  const key = JSON.stringify({
    site: state.primary, start: state.startUtc, hours: state.durationHours,
  });
  horizonA = await loadHorizonProfile(state.primary.siteId, base, coords.latitudeDeg, coords.longitudeEastDeg);
  if (key !== lastEphemKey || !providerA) {
    lastEphemKey = key;
    el('status').textContent = 'Loading Sun/Earth ephemeris…';
    providerA = await createEphemerisProvider({
      siteId: state.primary.siteId,
      latDeg: coords.latitudeDeg,
      lonEastDeg: coords.longitudeEastDeg,
      altitudeKm: (coords.elevationM + coords.observerHeightM) / 1000,
      startUtc: state.startUtc,
      durationHours: state.durationHours,
      baseUrl: base,
      allowLive: false,
    });
    el('status').textContent = '';
  }
  el('metrics-a-title').textContent = coords.label;
  el('horizon-flag-a').textContent = horizonA.model === 'lola_terrain'
    ? `Horizon model: LOLA terrain · ephemeris ${providerA.sourceLabel}`
    : `⚠ Sphere horizon (optimistic) · ephemeris ${providerA.sourceLabel}`;
  paintSkyline(state);
  syncUrl();
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
  const hoursFromStart = (Date.parse(state.scrubUtc) - Date.parse(state.startUtc)) / 3600_000;
  scrub.value = String(Math.max(0, Math.min(state.durationHours, hoursFromStart)));
  el<HTMLInputElement>('min-earth-el').value = String(state.thresholds.minEarthElevationDeg);
  el<HTMLInputElement>('panel-area').value = String(state.thresholds.panelAreaM2);
  el<HTMLInputElement>('panel-eff').value = String(state.thresholds.panelEfficiency);
  el<HTMLInputElement>('battery-floor').value = String(state.thresholds.batteryFloorW);
  el<HTMLInputElement>('tech-details').checked = state.showTechnicalDetails;
  void refreshScience(state);
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
    const hours = Number((e.target as HTMLInputElement).value);
    setScrubUtc(new Date(Date.parse(getScenario().startUtc) + hours * 3600_000).toISOString());
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
    try {
      await navigator.clipboard.writeText(location.href);
      el('share-status').textContent = 'Link copied.';
    } catch {
      el('share-status').textContent = location.href;
    }
  };
  el('export-json').onclick = () => {
    el('share-status').textContent = 'Time-series export arrives with assessment phase.';
  };
  window.addEventListener('resize', () => paintSkyline(getScenario()));
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
