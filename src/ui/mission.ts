import { getScenario, setScenario, subscribeScenario } from '../scenario/state';
import type { ScenarioState } from '../scenario/types';
import { DEFAULT_MISSION_SETTINGS, validateMissionSettings } from '../power/mission';
import { panelFromThresholds } from '../power/adapter';
import { studyContexts } from '../power/contexts';
import { analyzeDelaysResponsive, delayOffsets, optimizeMission, type OptimizationReport, type DelayReport } from '../power/planning';
import type { MissionAssessment } from '../assess/windows';
import { plannerViability } from '../assess/decision';
import { fmtEnergy, fmtPower, fmtDuration } from './format';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let optimization: OptimizationReport | null = null, delays: DelayReport | null = null;
let active: AbortController | null = null, jobId = 0, fingerprint = '';
export function missionAnalysisExport() { return { panelSiteOptimization: optimization, landingDelayAnalysis: delays }; }
export { fmtDuration } from './format';
export function missionGrade(a: MissionAssessment) {
  const grade = plannerViability(a);
  if (grade === 'UNKNOWN') return 'UNKNOWN · incomplete mission data';
  if (a.mission?.viability.requirementsMet == null) return `${grade} · sunlight and Earth contact`;
  const pass = a.mission.viability.requirementsMet ? 'requirements met' : 'requirements unmet';
  return `${grade} · ${pass}`;
}
export function appendBatteryChart(host: HTMLElement, a: MissionAssessment) {
  if (!a.mission) return;
  const { battery } = a.mission.parameters;
  const width = 600, height = 145, left = 84, right = 590, top = 12, bottom = 115;
  const cap = Math.max(1, battery.capacityWh), duration = a.mission.summary.durationSeconds;
  const x = (t: number) => left + t / duration * (right - left), y = (v: number) => bottom - v / cap * (bottom - top);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.classList.add('battery-chart');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${a.siteLabel}: battery stored energy in Wh over the mission; unknown sections blank`);
  const add = (tag: string, attributes: Record<string, string>, text?: string) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text) node.textContent = text;
    svg.append(node);
  };
  add('title', {}, 'Stored battery energy (Wh), dashed reserve cutoff; unknown sections are blank');
  add('line', { x1: String(left), x2: String(right), y1: String(bottom), y2: String(bottom), stroke: '#879aab' });
  const reserveY = y(battery.capacityWh * battery.reserveSocFraction);
  add('line', { x1: String(left), x2: String(right), y1: String(reserveY), y2: String(reserveY), stroke: '#efc47c', 'stroke-dasharray': '5 4' });
  const points: string[] = [];
  for (const s of a.mission.segments) {
    if (s.batteryStartWh != null) points.push(`${x(s.startOffsetSeconds)},${y(s.batteryStartWh)}`);
    if (s.batteryEndWh == null) break;
    points.push(`${x(s.endOffsetSeconds)},${y(s.batteryEndWh)}`);
  }
  add('polyline', { points: points.join(' '), fill: 'none', stroke: '#7de4d4', 'stroke-width': '2' });
  const capLabel = battery.capacityWh >= 1e6 ? `${(battery.capacityWh / 1e6).toFixed(1)} MWh`
    : battery.capacityWh >= 1000 ? `${(battery.capacityWh / 1000).toFixed(1)} kWh` : `${battery.capacityWh.toFixed(0)} Wh`;
  add('text', { x: '2', y: '16' }, capLabel);
  add('text', { x: '30', y: String(bottom) }, '0');
  add('text', { x: String(left), y: '137' }, 'Landing');
  add('text', { x: String(right), y: '137', 'text-anchor': 'end' }, `${(duration / 3600).toFixed(1)} h`);
  const wrapper = document.createElement('div'); wrapper.className = 'battery-chart-wrap';
  const caption = document.createElement('p'); caption.textContent = 'Stored battery Wh · dashed reserve · blank = unknown';
  wrapper.append(svg, caption); host.append(wrapper);
}

function scenarioKey(s: ScenarioState) {
  return JSON.stringify([s.startUtc, s.durationHours, s.primary, s.secondary, s.thresholds, s.missionSettings, s.planning]);
}
function message(text: string) { el('mission-job-status').textContent = text; }
function sync(s: ScenarioState, force = false) {
  const key = scenarioKey(s);
  if (!force && key === fingerprint) return; // Scrubbing/playback must not reset an input being edited.
  if (fingerprint && key !== fingerprint) {
    active?.abort(); jobId++; active = null;
    optimization = null; delays = null;
    el('optimization-results').replaceChildren(); el('delay-results').replaceChildren();
    el<HTMLButtonElement>('cancel-mission-job').disabled = true;
    el<HTMLButtonElement>('optimize-mission').disabled = false; el<HTMLButtonElement>('test-delays').disabled = false;
    message('Settings changed; rerun the comparison.');
  }
  fingerprint = key;
  document.querySelectorAll<HTMLInputElement>('[data-battery]').forEach(node => { node.value = String(s.missionSettings.battery[node.dataset.battery as keyof typeof s.missionSettings.battery]); });
  document.querySelectorAll<HTMLInputElement>('[data-requirement]').forEach(node => { node.value = String(s.missionSettings.requirements[node.dataset.requirement as keyof typeof s.missionSettings.requirements]); });
  el<HTMLInputElement>('max-delay-hours').value = String(s.planning.maxDelayHours);
  el<HTMLInputElement>('delay-step-hours').value = String(s.planning.delayStepHours);
  el<HTMLSelectElement>('orientation-step').value = String(s.planning.orientationStepDeg);
  el<HTMLInputElement>('robust-optimization').checked = s.planning.robustOptimization;
}
function applyControls(): boolean {
  const inputs = document.querySelectorAll<HTMLInputElement>('[data-battery], [data-requirement], #max-delay-hours, #delay-step-hours, #panel-area, #panel-eff, #panel-tilt, #panel-azimuth, #battery-floor, #min-earth-el');
  for (const node of inputs) if (!node.checkValidity()) {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    node.reportValidity(); return false;
  }
  const s = getScenario(), settings = structuredClone(s.missionSettings), planning = { ...s.planning };
  document.querySelectorAll<HTMLInputElement>('[data-battery]').forEach(node => { settings.battery[node.dataset.battery as keyof typeof settings.battery] = Number(node.value); });
  document.querySelectorAll<HTMLInputElement>('[data-requirement]').forEach(node => { settings.requirements[node.dataset.requirement as keyof typeof settings.requirements] = Number(node.value); });
  planning.maxDelayHours = Number(el<HTMLInputElement>('max-delay-hours').value);
  planning.delayStepHours = Number(el<HTMLInputElement>('delay-step-hours').value);
  planning.orientationStepDeg = Number(el<HTMLSelectElement>('orientation-step').value);
  planning.robustOptimization = el<HTMLInputElement>('robust-optimization').checked;
  try {
    validateMissionSettings(settings, s.thresholds.batteryFloorW);
    delayOffsets(planning.maxDelayHours, planning.delayStepHours);
    if (![5, 15, 30, 45, 90].includes(planning.orientationStepDeg)) throw new Error('Choose a supported orientation grid.');
    el('mission-config-error').textContent = '';
    setScenario({ missionSettings: settings, planning });
    return true;
  } catch (error) {
    el('mission-config-error').textContent = `Settings not applied: ${error instanceof Error ? error.message : error}`;
    return false;
  }
}
function table(host: HTMLElement, headers: string[]) {
  const scroll = document.createElement('div'); scroll.className = 'mission-table-scroll'; scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Scrollable analysis results');
  const node = document.createElement('table'), head = document.createElement('thead'), row = document.createElement('tr');
  for (const label of headers) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; row.append(th); }
  head.append(row); const body = document.createElement('tbody'); node.append(head, body); scroll.append(node); host.append(scroll); return body;
}
function row(body: HTMLElement, values: string[], action?: () => void) {
  const tr = document.createElement('tr');
  for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
  const td = document.createElement('td');
  if (action) { const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Apply'; button.setAttribute('aria-label', `Apply ${values[0]}: ${values[1]}`); button.onclick = action; td.append(button); }
  else td.textContent = '—';
  tr.append(td); body.append(tr);
}
const siteLabel = (id: string) => id === 'connecting-ridge-cr1' ? 'CR1' : id === 'shackleton-rim-sr1' ? 'SR1' : id;
function note(host: HTMLElement, text: string) { const p = document.createElement('p'); p.textContent = text; host.append(p); }
function renderOptimization(report: OptimizationReport) {
  const host = el('optimization-results'); host.replaceChildren();
  note(host, `Best tested fixed orientations on a ${report.grid.stepDeg}° grid, including the current orientation. ${report.scenarioEvaluations} scenario evaluations. ` +
    'Order: least worst-case unserved Wh, shortest worst outage, highest minimum score, final battery Wh, then harvested Wh.');
  if (report.ranked.some(r => !r.qualifiedForMissionDecision)) note(host, 'Preliminary engineering comparison: upstream terrain validation is pending. This is not a certified landing recommendation.');
  if (!report.comparisonComplete) note(host, 'Comparison incomplete: only sites with all requested scenarios known are ranked.');
  if (report.ranked.length) {
    const body = table(host, ['Site', 'Tilt / facing', 'Worst unserved', 'Worst outage', 'Min score', '']);
    for (const result of report.ranked) row(body, [siteLabel(result.siteId), `${result.panel.tiltDeg}° / ${result.panel.azimuthDeg}°`,
      fmtEnergy(result.worstUnservedEnergyWh), fmtDuration(result.worstPowerOutageSeconds), `${result.minimumScore.toFixed(1)}/100`], () => {
      const state = getScenario();
      setScenario({ primary: { id: 'A', siteId: result.siteId }, thresholds: { ...state.thresholds, panelTiltDeg: result.panel.tiltDeg, panelAzimuthDeg: result.panel.azimuthDeg } });
      message(`Applied ${siteLabel(result.siteId)} and tested panel orientation. Mission metrics are updating.`);
    });
  }
  for (const excluded of report.exclusions) note(host, `${siteLabel(excluded.siteId)} excluded: ${excluded.reason}`);
  if (!report.best) note(host, 'No complete cases to optimize. Use covered CR1/SR1 dates and inspect horizon/data gaps.');
}
function renderDelays(report: DelayReport) {
  const host = el('delay-results'); host.replaceChildren();
  note(host, 'Same hardware, load, mission duration and battery charge at each actual landing; no pre-landing consumption. Worst case applies only to tested delays.');
  for (const site of report.bySite) {
    const value = site.worstCase;
    note(host, value ? `${siteLabel(site.siteId)}: worst unserved ${fmtEnergy(value.worstUnservedEnergyWh)} at +${value.worstUnservedCase.delayHours} h; longest outage ${fmtDuration(value.worstPowerOutageSeconds)} at +${value.worstOutageCase.delayHours} h; minimum score ${value.minimumScore.toFixed(1)}/100 at +${value.minimumScoreCase.delayHours} h${value.qualifiedForMissionDecision ? '' : ' · preliminary'}.`
      : `${siteLabel(site.siteId)}: worst case UNKNOWN (${site.unknownScenarios} incomplete scenarios).`);
  }
  if (report.mostResilientSite) note(host, `Best among sites with complete tested-delay data: ${siteLabel(report.mostResilientSite.siteId)}${report.comparisonComplete ? '' : ' (other site data incomplete)'}.`);
  const body = table(host, ['Site / delay', 'Actual landing UTC', 'Unserved', 'Longest outage', 'Score', '']);
  for (const result of report.cases) row(body, [`${siteLabel(result.siteId)} / +${result.delayHours} h`, result.startUtc ?? 'Unavailable',
    fmtEnergy(result.summary?.unservedEnergyWh), fmtDuration(result.summary?.longestPowerOutageSeconds),
    result.viability?.score == null ? 'Unknown' : `${result.viability.score.toFixed(1)}/100${result.viability.qualifiedForMissionDecision ? '' : ' preliminary'}`],
  result.reason || !result.startUtc ? undefined : () => {
    setScenario({ primary: { id: 'A', siteId: result.siteId }, startUtc: result.startUtc!, scrubUtc: result.startUtc! });
    message(`Applied ${siteLabel(result.siteId)} landing +${result.delayHours} h.`);
  });
  for (const result of report.cases) if (result.reason) note(host, `${siteLabel(result.siteId)} +${result.delayHours} h: ${result.reason}`);
}
async function run(kind: 'optimize' | 'delays', baseUrl: string) {
  if (!applyControls()) return;
  const state = structuredClone(getScenario()), controller = new AbortController();
  active?.abort(); active = controller;
  const token = ++jobId;
  el<HTMLButtonElement>('cancel-mission-job').disabled = false;
  el<HTMLButtonElement>('optimize-mission').disabled = true; el<HTMLButtonElement>('test-delays').disabled = true;
  message('Preparing matching Sun, horizon and communication inputs…');
  try {
    const offsets = kind === 'delays' || state.planning.robustOptimization ? delayOffsets(state.planning.maxDelayHours, state.planning.delayStepHours) : [0];
    const contexts = await studyContexts(state, offsets, baseUrl, controller.signal);
    if (controller.signal.aborted || token !== jobId) return;
    if (kind === 'optimize') {
      const result = await optimizeMission({ contexts, panel: panelFromThresholds(state.thresholds), baseLoadW: state.thresholds.batteryFloorW,
        settings: state.missionSettings, stepDeg: state.planning.orientationStepDeg, signal: controller.signal,
        onProgress: (done, total) => { if (token === jobId) message(`Testing orientations and sites: ${done}/${total} scenario slots processed…`); } });
      if (token !== jobId) return;
      optimization = result; renderOptimization(result);
    } else {
      const report = await analyzeDelaysResponsive(contexts, panelFromThresholds(state.thresholds), state.thresholds.batteryFloorW,
        state.missionSettings, controller.signal, (done, total) => { if (token === jobId) message(`Testing landing delays: ${done}/${total}…`); });
      if (token !== jobId) return;
      delays = report; renderDelays(report);
    }
    message('Analysis complete. Review qualifications before applying a result; export JSON to save this analysis.');
  } catch (error) {
    if (token === jobId) message(error instanceof DOMException && error.name === 'AbortError' ? 'Analysis cancelled; no partial optimum was applied.'
      : `Analysis failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    if (token === jobId) {
      active = null; el<HTMLButtonElement>('cancel-mission-job').disabled = true;
      el<HTMLButtonElement>('optimize-mission').disabled = false; el<HTMLButtonElement>('test-delays').disabled = false;
    }
  }
}
export function wireMissionUi(baseUrl: string) {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-battery], [data-requirement], #max-delay-hours, #delay-step-hours, #orientation-step, #robust-optimization')
    .forEach(node => { node.onchange = () => { applyControls(); }; });
  el('reset-mission-settings').onclick = () => {
    el('mission-config-error').textContent = '';
    setScenario({ missionSettings: structuredClone(DEFAULT_MISSION_SETTINGS) }); sync(getScenario(), true);
  };
  el('optimize-mission').onclick = () => { void run('optimize', baseUrl); };
  el('test-delays').onclick = () => { void run('delays', baseUrl); };
  el('cancel-mission-job').onclick = () => { active?.abort(); message('Cancelling analysis…'); };
  subscribeScenario(sync); sync(getScenario());
}
