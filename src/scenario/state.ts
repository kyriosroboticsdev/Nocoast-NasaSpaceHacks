import {
  createDefaultScenario,
  type AppMode,
  type ScenarioState,
  type ScenarioThresholds,
} from './types';

type Listener = (state: ScenarioState) => void;

let state: ScenarioState = createDefaultScenario();
const listeners = new Set<Listener>();

export function getScenario(): ScenarioState {
  return state;
}

export function subscribeScenario(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener(state);
}

export function setScenario(patch: Partial<ScenarioState>) {
  state = { ...state, ...patch };
  if (patch.thresholds) {
    state = { ...state, thresholds: { ...state.thresholds, ...patch.thresholds } };
  }
  emit();
}

export function setMode(mode: AppMode) {
  setScenario({ mode, showTechnicalDetails: mode === 'planner' ? state.showTechnicalDetails : false });
}

export function setPrimarySite(siteId: string) {
  setScenario({ primary: { ...state.primary, siteId } });
}

export function setSecondarySite(siteId: string) {
  setScenario({ secondary: { ...state.secondary, siteId } });
}

export function setCustomCoords(slot: 'A' | 'B', lat: number, lon: number) {
  if (slot === 'A') {
    setScenario({
      primary: { ...state.primary, siteId: 'custom', customLatDeg: lat, customLonEastDeg: lon },
    });
  } else {
    setScenario({
      secondary: { ...state.secondary, siteId: 'custom', customLatDeg: lat, customLonEastDeg: lon },
    });
  }
}

export function setMissionWindow(startUtc: string, durationHours: number) {
  const start = Date.parse(startUtc);
  const scrub = Date.parse(state.scrubUtc);
  const end = start + durationHours * 3600_000;
  const nextScrub = Number.isFinite(scrub)
    ? new Date(Math.min(Math.max(scrub, start), end)).toISOString()
    : startUtc;
  setScenario({ startUtc, durationHours, scrubUtc: nextScrub });
}

export function setScrubUtc(scrubUtc: string) {
  setScenario({ scrubUtc });
}

export function setThresholds(thresholds: Partial<ScenarioThresholds>) {
  setScenario({ thresholds: { ...state.thresholds, ...thresholds } });
}

export function toggleCompare(enabled: boolean) {
  setScenario({ compareEnabled: enabled });
}

export function toggleTechnicalDetails(show: boolean) {
  setScenario({ showTechnicalDetails: show });
}

function parseFinite(raw: string | null, min?: number, max?: number): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
}

/** Parse shareable URL query into scenario (best-effort, validated). */
export function applyUrlParams(search: string) {
  const params = new URLSearchParams(search);
  const patch: Partial<ScenarioState> = {};
  const mode = params.get('mode');
  if (mode === 'planner' || mode === 'learn') patch.mode = mode;
  const site = params.get('site');
  if (site) patch.primary = { ...state.primary, siteId: site };
  const siteB = params.get('siteB');
  if (siteB) patch.secondary = { ...state.secondary, siteId: siteB };

  const date = params.get('date');
  if (date) {
    const iso = date.includes('T') ? (date.endsWith('Z') ? date : `${date}Z`) : `${date}T00:00:00.000Z`;
    const t = Date.parse(iso);
    if (Number.isFinite(t)) {
      patch.startUtc = new Date(t).toISOString();
      patch.scrubUtc = new Date(t).toISOString();
    }
  }

  const hours = parseFinite(params.get('hours'), 0.1, 10000);
  if (hours != null) patch.durationHours = hours;

  const scrub = params.get('scrub');
  if (scrub) {
    const iso = scrub.includes('T') ? (scrub.endsWith('Z') ? scrub : `${scrub}Z`) : null;
    if (iso && Number.isFinite(Date.parse(iso))) patch.scrubUtc = new Date(Date.parse(iso)).toISOString();
  }

  const compare = params.get('compare');
  if (compare === '0' || compare === '1') patch.compareEnabled = compare === '1';

  const lat = parseFinite(params.get('lat'), -90, 90);
  const lon = parseFinite(params.get('lon'), 0, 360);
  if (lat != null && lon != null && (site === 'custom' || params.get('site') === 'custom')) {
    patch.primary = {
      id: 'A',
      siteId: 'custom',
      customLatDeg: lat,
      customLonEastDeg: lon,
    };
  }

  const latB = parseFinite(params.get('latB'), -90, 90);
  const lonB = parseFinite(params.get('lonB'), 0, 360);
  if (latB != null && lonB != null && (siteB === 'custom' || params.get('siteB') === 'custom')) {
    patch.secondary = {
      id: 'B',
      siteId: 'custom',
      customLatDeg: latB,
      customLonEastDeg: lonB,
    };
  }

  const thresholds: Partial<ScenarioThresholds> = {};
  const minEl = parseFinite(params.get('minEarthElevationDeg') ?? params.get('minEl'), -5, 90);
  if (minEl != null) thresholds.minEarthElevationDeg = minEl;
  const area = parseFinite(params.get('panelAreaM2') ?? params.get('area'), 0, 1000000);
  if (area != null) thresholds.panelAreaM2 = area;
  const eff = parseFinite(params.get('panelEfficiency') ?? params.get('eff'), 0, 1);
  if (eff != null) thresholds.panelEfficiency = eff;
  const tilt = parseFinite(params.get('panelTiltDeg') ?? params.get('tilt'), 0, 180);
  if (tilt != null) thresholds.panelTiltDeg = tilt;
  const bearing = parseFinite(params.get('panelAzimuthDeg'), 0, 359.999999);
  if (bearing != null) thresholds.panelAzimuthDeg = bearing;
  const floor = parseFinite(params.get('batteryFloorW') ?? params.get('floor'), 0, 1e6);
  if (floor != null) thresholds.batteryFloorW = floor;
  if (Object.keys(thresholds).length) patch.thresholds = { ...state.thresholds, ...thresholds };

  // Clamp scrub into mission window once start/duration known.
  const startUtc = patch.startUtc ?? state.startUtc;
  const durationHours = patch.durationHours ?? state.durationHours;
  const scrubUtc = patch.scrubUtc ?? state.scrubUtc;
  const t0 = Date.parse(startUtc);
  const t1 = t0 + durationHours * 3600_000;
  const ts = Date.parse(scrubUtc);
  if (Number.isFinite(ts)) {
    patch.scrubUtc = new Date(Math.min(Math.max(ts, t0), t1)).toISOString();
  }

  if (Object.keys(patch).length) setScenario(patch);
}

export function scenarioToSearchParams(s: ScenarioState = state): string {
  const p = new URLSearchParams();
  p.set('mode', s.mode);
  p.set('site', s.primary.siteId);
  p.set('siteB', s.secondary.siteId);
  p.set('date', s.startUtc.slice(0, 19) + 'Z');
  p.set('hours', String(s.durationHours));
  p.set('scrub', s.scrubUtc.slice(0, 19) + 'Z');
  p.set('compare', s.compareEnabled ? '1' : '0');
  if (s.primary.siteId === 'custom' && s.primary.customLatDeg != null && s.primary.customLonEastDeg != null) {
    p.set('lat', String(s.primary.customLatDeg));
    p.set('lon', String(s.primary.customLonEastDeg));
  }
  if (s.secondary.siteId === 'custom' && s.secondary.customLatDeg != null && s.secondary.customLonEastDeg != null) {
    p.set('latB', String(s.secondary.customLatDeg));
    p.set('lonB', String(s.secondary.customLonEastDeg));
  }
  p.set('minEl', String(s.thresholds.minEarthElevationDeg));
  p.set('area', String(s.thresholds.panelAreaM2));
  p.set('eff', String(s.thresholds.panelEfficiency));
  p.set('tilt', String(s.thresholds.panelTiltDeg));
  p.set('panelAzimuthDeg', String(s.thresholds.panelAzimuthDeg));
  p.set('floor', String(s.thresholds.batteryFloorW));
  return p.toString();
}

export function syncUrl() {
  const next = `${location.pathname}?${scenarioToSearchParams()}`;
  history.replaceState(null, '', next);
}
