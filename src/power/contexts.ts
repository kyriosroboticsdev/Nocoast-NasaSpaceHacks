import type { ScenarioState } from '../scenario/types';
import { resolveSiteCoords } from '../scenario/catalog';
import { loadHorizonProfile } from '../horizon/load';
import { createEphemerisProvider } from '../ephemeris/horizons';
import { assessMission } from '../assess/windows';
import type { MissionContext } from './planning';
import { fetchBackendAnalysis, backendHorizonProfile, backendEphemerisProvider } from '../science/backend';
import { assessBackendMission } from '../science/assessment';
import { canonicalUtc } from './adapter';
import { validateMissionSettings } from './mission';

/** Active coordinates, including custom A/B points; duplicate positions are evaluated once. */
export function selectedMissionSites(state: ScenarioState) {
  const slots = [state.primary, ...(state.compareEnabled ? [state.secondary] : [])];
  const seen = new Set<string>();
  return slots.flatMap(slot => {
    const c = resolveSiteCoords(slot.siteId, slot.customLatDeg, slot.customLonEastDeg);
    c.latitudeDeg = Number(c.latitudeDeg.toFixed(6));
    c.longitudeEastDeg = Number((((c.longitudeEastDeg % 360) + 360) % 360).toFixed(6)) % 360;
    const key = `${c.latitudeDeg}:${c.longitudeEastDeg}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...c, siteId: slot.siteId === 'custom' ? `custom:${key}` : slot.siteId }];
  });
}
/** Re-evaluate positions and the visibility owner's horizon mask at each actual
 * landing time. Share the provider per site; never shift cached shadow flags.
 */
export async function studyContexts(state: ScenarioState, offsets: number[], baseUrl: string, signal?: AbortSignal) {
  canonicalUtc(state.startUtc);
  validateMissionSettings(state.missionSettings, state.thresholds.batteryFloorW);
  if (!offsets.length || offsets.length > 25 || !offsets.includes(0) || new Set(offsets.map(h => Math.round(h * 3600))).size !== offsets.length
    || offsets.some(h => !Number.isFinite(h) || h < 0 || h > 336 || Math.abs(h * 3600 - Math.round(h * 3600)) > 1e-7)
    || !Number.isFinite(state.durationHours) || state.durationHours <= 0 || state.durationHours > 1440) {
    throw new Error('Use a 0–60 day mission and 1–25 unique delay offsets including zero, up to 336 hours.');
  }
  const sites = selectedMissionSites(state);
  if ((Math.ceil(state.durationHours * 6) + 1) * offsets.length * sites.length > 100000) {
    throw new Error('Requested analysis exceeds 100000 source samples. Reduce duration or delay scenarios.');
  }
  const contexts: MissionContext[] = [];
  for (const site of sites) {
    const siteId = site.siteId;
    if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
    for (const delayHours of offsets) {
      if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
      const startUtc = new Date(Date.parse(state.startUtc) + Math.round(delayHours * 3600) * 1000).toISOString();
      const backend = await fetchBackendAnalysis(site.latitudeDeg, site.longitudeEastDeg, startUtc,
        new Date(Date.parse(startUtc) + state.durationHours * 3600000).toISOString(), state.thresholds.minEarthElevationDeg, baseUrl);
      if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
      const backendHorizon = backend && backendHorizonProfile(backend, siteId);
      let fallback: ReturnType<typeof assessMission> | undefined;
      if (!backend || !backendHorizon) {
        const horizon = await loadHorizonProfile(siteId, baseUrl, site.latitudeDeg, site.longitudeEastDeg);
        const provider = await createEphemerisProvider({ siteId, latDeg: site.latitudeDeg, lonEastDeg: site.longitudeEastDeg,
          altitudeKm: (site.elevationM + site.observerHeightM) / 1000,
          startUtc, durationHours: state.durationHours, baseUrl, allowLive: false });
        if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
        fallback = assessMission({ siteId, siteLabel: site.label, horizonModel: horizon.model, provider, horizon,
          startUtc, durationHours: state.durationHours, scrubUtc: startUtc,
          thresholds: state.thresholds, missionSettings: state.missionSettings });
      }
      const assessment = backend && backendHorizon ? assessBackendMission(backend, {
        siteId, siteLabel: site.label, horizonModel: backendHorizon.model,
        provider: backendEphemerisProvider(siteId, backend), horizon: backendHorizon,
        startUtc, durationHours: state.durationHours, scrubUtc: startUtc,
        thresholds: state.thresholds, missionSettings: state.missionSettings,
      }) : fallback!;
      const artifactSiteId = assessment.solarInput?.siteId ?? siteId;
      contexts.push({ id: `${artifactSiteId}:delay-${delayHours}`, siteId: artifactSiteId, delayHours, input: assessment.solarInput,
        communication: assessment.communication, terrainValidated: assessment.mission?.viability.qualifiedForMissionDecision ?? false,
        unavailableReason: assessment.powerWarning });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return contexts;
}
