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

/** Parse shareable URL query into scenario (best-effort). */
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
    const iso = date.includes('T') ? date : `${date}T00:00:00.000Z`;
    if (!Number.isNaN(Date.parse(iso))) {
      patch.startUtc = iso;
      patch.scrubUtc = iso;
    }
  }
  const hours = params.get('hours');
  if (hours && /^\d+(\.\d+)?$/.test(hours)) patch.durationHours = Number(hours);
  const compare = params.get('compare');
  if (compare === '0' || compare === '1') patch.compareEnabled = compare === '1';
  const lat = params.get('lat');
  const lon = params.get('lon');
  if (lat && lon && site === 'custom') {
    patch.primary = {
      id: 'A',
      siteId: 'custom',
      customLatDeg: Number(lat),
      customLonEastDeg: Number(lon),
    };
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
  p.set('compare', s.compareEnabled ? '1' : '0');
  if (s.primary.siteId === 'custom' && s.primary.customLatDeg != null && s.primary.customLonEastDeg != null) {
    p.set('lat', String(s.primary.customLatDeg));
    p.set('lon', String(s.primary.customLonEastDeg));
  }
  return p.toString();
}

export function syncUrl() {
  const next = `${location.pathname}?${scenarioToSearchParams()}`;
  history.replaceState(null, '', next);
}
