import { simulate, validatePanel, type Panel, type SolarInput } from './model.mjs';
import { simulateMission, validateMissionSettings, type MissionSettings, type StateSegment } from './mission';

export type MissionContext = {
  id: string; siteId: string; delayHours: number; input: SolarInput | null;
  communication: StateSegment[]; terrainValidated: boolean; unavailableReason?: string;
};
export function delayOffsets(maxHours: number, stepHours: number): number[] {
  if (!Number.isFinite(maxHours) || maxHours < 0 || maxHours > 336
    || !Number.isFinite(stepHours) || stepHours <= 0 || stepHours > 336) throw new Error('Delay range must be 0–336 h and step must be positive.');
  const maxSeconds = Math.round(maxHours * 3600), stepSeconds = Math.round(stepHours * 3600);
  if (stepSeconds < 1 || Math.abs(maxHours * 3600 - maxSeconds) > 1e-7 || Math.abs(stepHours * 3600 - stepSeconds) > 1e-7) {
    throw new Error('Delay bounds and step must correspond to whole seconds.');
  }
  const out = [0];
  for (let seconds = stepSeconds; seconds < maxSeconds; seconds += stepSeconds) {
    out.push(seconds / 3600);
    if (out.length >= 25) throw new Error('Use at most 25 delay scenarios; increase the delay step.');
  }
  if (maxHours > 0) out.push(maxHours);
  if (out.length > 25) throw new Error('Use at most 25 delay scenarios.');
  return out;
}
export function orientationGrid(panel: Panel, stepDeg: number): Panel[] {
  validatePanel(panel);
  if (![5, 15, 30, 45, 90].includes(stepDeg)) throw new Error('Orientation step must be 5, 15, 30, 45 or 90 degrees.');
  const out: Panel[] = [], seen = new Set<string>();
  const add = (tiltDeg: number, azimuthDeg: number) => {
    azimuthDeg = ((azimuthDeg % 360) + 360) % 360;
    const key = tiltDeg === 0 || tiltDeg === 180 ? String(tiltDeg) : `${tiltDeg}:${azimuthDeg}`;
    if (seen.has(key)) return;
    seen.add(key); out.push({ ...panel, tiltDeg, azimuthDeg });
  };
  // Always test the current hardware orientation, including off-grid values.
  add(panel.tiltDeg, panel.azimuthDeg);
  for (let tilt = 0; tilt <= 180; tilt += stepDeg) {
    if (tilt === 0 || tilt === 180) add(tilt, 0);
    else for (let bearing = 0; bearing < 360; bearing += stepDeg) add(tilt, bearing);
  }
  return out;
}
function evaluate(context: MissionContext, panel: Panel, baseLoadW: number, settings: MissionSettings) {
  if (!context.input) return { id: context.id, siteId: context.siteId, delayHours: context.delayHours,
    startUtc: null, endUtc: null, summary: null, viability: null,
    reason: context.unavailableReason ?? 'Solar input unavailable.' };
  const power = simulate(context.input, panel);
  const mission = simulateMission(power, baseLoadW, settings, context.communication);
  return { id: context.id, siteId: context.siteId, delayHours: context.delayHours,
    startUtc: context.input.time.startUtc, endUtc: context.input.time.endUtc,
    sourceInputArtifactId: context.input.artifactId, summary: mission.summary, viability: mission.viability,
    reason: !mission.summary.complete
      ? `Incomplete solar/battery coverage: ${power.samples.find(s => s.quality.status === 'missing')?.quality.reason ?? 'input gap'}`
      : mission.viability.score == null ? 'Communication coverage is incomplete.' : null };
}
type CaseResult = ReturnType<typeof evaluate>;
function aggregate(siteId: string, panel: Panel, cases: CaseResult[]) {
  if (!cases.length || cases.some(c => c.reason || c.viability?.score == null)) return null;
  const worstUnserved = cases.reduce((a, b) => a.summary!.unservedEnergyWh! >= b.summary!.unservedEnergyWh! ? a : b);
  const worstOutage = cases.reduce((a, b) => a.summary!.longestPowerOutageSeconds! >= b.summary!.longestPowerOutageSeconds! ? a : b);
  const worstScore = cases.reduce((a, b) => a.viability!.score! <= b.viability!.score! ? a : b);
  return { siteId, panel: { ...panel }, scenarioCount: cases.length,
    worstUnservedCase: { id: worstUnserved.id, delayHours: worstUnserved.delayHours },
    worstOutageCase: { id: worstOutage.id, delayHours: worstOutage.delayHours },
    minimumScoreCase: { id: worstScore.id, delayHours: worstScore.delayHours },
    worstUnservedEnergyWh: Math.max(...cases.map(c => c.summary!.unservedEnergyWh!)),
    worstPowerOutageSeconds: Math.max(...cases.map(c => c.summary!.longestPowerOutageSeconds!)),
    minimumScore: Math.min(...cases.map(c => c.viability!.score!)),
    minimumFinalBatteryWh: Math.min(...cases.map(c => c.summary!.finalBatteryWh!)),
    minimumGenerationWh: Math.min(...cases.map(c => c.summary!.solarEnergyWh!)),
    allRequirementsMet: cases.every(c => c.viability!.requirementsMet),
    qualifiedForMissionDecision: cases.every(c => c.viability!.qualifiedForMissionDecision), cases };
}
export type CandidateEvaluation = NonNullable<ReturnType<typeof aggregate>>;
/** Lexicographic, not a claim of a continuous/global optimum. Lower is better. */
export function compareCandidates(a: CandidateEvaluation, b: CandidateEvaluation): number {
  for (const [av, bv] of [[a.worstUnservedEnergyWh, b.worstUnservedEnergyWh],
    [a.worstPowerOutageSeconds, b.worstPowerOutageSeconds], [b.minimumScore, a.minimumScore],
    [b.minimumFinalBatteryWh, a.minimumFinalBatteryWh], [b.minimumGenerationWh, a.minimumGenerationWh]]) {
    if (Math.abs(av - bv) > 1e-7) return av - bv;
  }
  return 0;
}
function validateContexts(contexts: MissionContext[]) {
  if (!contexts.length || contexts.length > 50) throw new Error('Provide 1–50 site/delay contexts.');
  const ids = new Set<string>();
  const siteDelays = new Set<string>();
  if (contexts.reduce((n, c) => n + (c.input?.samples.length ?? 0), 0) > 100000) throw new Error('Analysis exceeds 100000 source samples. Reduce duration or delay scenarios.');
  let duration: number | undefined, origin: number | undefined;
  for (const c of contexts) {
    const siteDelay = `${c.siteId}:${Math.round(c.delayHours * 3600)}`;
    if (ids.has(c.id) || siteDelays.has(siteDelay) || !Number.isFinite(c.delayHours) || c.delayHours < 0 || c.delayHours > 336
      || Math.abs(c.delayHours * 3600 - Math.round(c.delayHours * 3600)) > 1e-7) throw new Error('Invalid or duplicate delay context.');
    ids.add(c.id);
    siteDelays.add(siteDelay);
    if (!c.input) continue;
    if (c.siteId !== c.input.siteId) throw new Error('Context/site mismatch.');
    const start = Date.parse(c.input.time.startUtc), span = Date.parse(c.input.time.endUtc) - start;
    const nominal = start - Math.round(c.delayHours * 3600) * 1000;
    if (duration != null && (duration !== span || origin !== nominal)) throw new Error('Compared contexts must use the same nominal landing time and mission duration.');
    duration = span; origin = nominal;
  }
}

export function analyzeDelays(contexts: MissionContext[], panel: Panel, baseLoadW: number, settings: MissionSettings) {
  validateContexts(contexts); validatePanel(panel); validateMissionSettings(settings, baseLoadW);
  const cases = contexts.map(c => evaluate(c, panel, baseLoadW, settings));
  return delayReport(contexts, panel, baseLoadW, settings, cases);
}
function delayReport(contexts: MissionContext[], panel: Panel, baseLoadW: number, settings: MissionSettings, cases: CaseResult[]) {
  const siteIds = [...new Set(contexts.map(c => c.siteId))];
  const bySite = siteIds.map(siteId => {
    const group = cases.filter(c => c.siteId === siteId);
    const known = group.filter(c => !c.reason);
    const conditional = aggregate(siteId, panel, known);
    // A missing delay must never disappear from a claimed worst case.
    return { siteId, complete: known.length === group.length, testedScenarios: group.length,
      unknownScenarios: group.length - known.length, worstCase: known.length === group.length ? conditional : null,
      knownScenariosOnly: conditional };
  });
  const rankedSites = bySite.flatMap(site => site.worstCase ? [site.worstCase] : []).sort(compareCandidates);
  return { schemaVersion: '0.2.0', artifactType: 'landing-delay-analysis', panel: { ...panel },
    parameters: { baseLoadW, ...structuredClone(settings) },
    sourceContexts: structuredClone(contexts),
    assumption: 'Same mission duration and initial battery state at every actual landing; no pre-landing power consumption modeled.',
    scope: 'Finite tested delays only; no guarantee for untested times.', cases, bySite,
    comparisonComplete: bySite.every(s => s.complete), rankedSites, mostResilientSite: rankedSites[0] ?? null };
}
export type DelayReport = ReturnType<typeof analyzeDelays>;
export async function analyzeDelaysResponsive(contexts: MissionContext[], panel: Panel, baseLoadW: number,
  settings: MissionSettings, signal?: AbortSignal, onProgress?: (done: number, total: number) => void) {
  validateContexts(contexts); validatePanel(panel); validateMissionSettings(settings, baseLoadW);
  const cases: CaseResult[] = [];
  const abort = () => { if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError'); };
  for (const c of contexts) {
    abort(); cases.push(evaluate(c, panel, baseLoadW, settings)); onProgress?.(cases.length, contexts.length);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  abort(); const report = delayReport(contexts, panel, baseLoadW, settings, cases);
  await new Promise(resolve => setTimeout(resolve, 0)); abort(); return report;
}

export async function optimizeMission(options: {
  contexts: MissionContext[]; panel: Panel; baseLoadW: number; settings: MissionSettings; stepDeg: number;
  signal?: AbortSignal; onProgress?: (completed: number, total: number) => void;
}) {
  const { contexts, panel, baseLoadW, settings, signal, onProgress } = options;
  validateContexts(contexts); validateMissionSettings(settings, baseLoadW);
  const grid = orientationGrid(panel, options.stepDeg), siteIds = [...new Set(contexts.map(c => c.siteId))];
  const schedules = siteIds.map(id => contexts.filter(c => c.siteId === id).map(c => c.delayHours).sort((a, b) => a - b).join(','));
  if (new Set(schedules).size > 1) throw new Error('Every compared site must use the same delay scenarios.');
  const total = grid.length * contexts.length;
  if (total > 10000) throw new Error('Search exceeds 10000 scenario evaluations. Use a coarser grid or fewer delays.');
  const abort = () => { if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError'); };
  const exclusions: Array<{ siteId: string; reason: string }> = [];
  const ranked: CandidateEvaluation[] = [], baselines: CandidateEvaluation[] = [];
  let completed = 0, evaluated = 0;
  let lastYield = performance.now();
  const evaluateGroup = async (group: MissionContext[], candidate: Panel) => {
    const cases: CaseResult[] = [];
    for (const c of group) {
      abort(); cases.push(evaluate(c, candidate, baseLoadW, settings)); evaluated++;
      if (performance.now() - lastYield > 25) {
        onProgress?.(completed, total); await new Promise(resolve => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
    return cases;
  };
  for (const siteId of siteIds) {
    abort();
    const group = contexts.filter(c => c.siteId === siteId);
    const baselineCases = await evaluateGroup(group, grid[0]);
    const baseline = aggregate(siteId, grid[0], baselineCases);
    if (!baseline) {
      exclusions.push({ siteId, reason: baselineCases.find(c => c.reason)?.reason ?? 'Incomplete context.' });
      completed += grid.length * group.length; onProgress?.(completed, total); continue;
    }
    baselines.push(baseline);
    let best = baseline;
    for (let i = 0; i < grid.length; i++) {
      abort();
      const value = i === 0 ? baseline : aggregate(siteId, grid[i], await evaluateGroup(group, grid[i]))!;
      if (compareCandidates(value, best) < 0) best = value;
      completed += group.length;
      if (i % 4 === 0) { onProgress?.(completed, total); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    ranked.push(best);
  }
  abort(); onProgress?.(completed, total);
  ranked.sort(compareCandidates);
  return { schemaVersion: '0.2.0', artifactType: 'panel-site-grid-search',
    objective: 'Minimize worst unserved Wh, then worst outage, then maximize minimum score, final battery Wh, harvested Wh.',
    parameters: { baseLoadW, ...structuredClone(settings) }, originalPanel: { ...panel },
    sourceContexts: structuredClone(contexts),
    grid: { stepDeg: options.stepDeg, orientationsPerSite: grid.length, includesCurrentOrientation: true, tiltRangeDeg: [0, 180] },
    scenarioEvaluations: evaluated, scheduledScenarioSlots: total, comparisonComplete: exclusions.length === 0,
    scope: 'Best tested fixed orientation per site; actual input sources and finite delay grid only. No continuous/global optimum claim.',
    best: ranked[0] ?? null, ranked, baselines, exclusions };
}
export type OptimizationReport = Awaited<ReturnType<typeof optimizeMission>>;
