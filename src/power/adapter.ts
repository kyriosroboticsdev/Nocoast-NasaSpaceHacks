import type { EphemerisProvider } from '../ephemeris/horizons';
import type { HorizonProfile } from '../horizon/types';
import type { ScenarioThresholds } from '../scenario/types';
import { FRAME_ID, validateSite, SOLAR_REFERENCE_W_M2, type Panel, type SolarInput, type SolarSample } from './model.mjs';

export const STEP_SECONDS = 600;
/** Historical bundle elevations, retained for consumers of the original reference fixtures. */
export const SURFACE_ELEVATIONS: Record<string, number> = {
  'connecting-ridge-cr1': 1949.6080773175818,
  'shackleton-rim-sr1': 1735.2179263340893,
};
const checkedTimes = new WeakMap<object, boolean>();
function orderedTimes(series: NonNullable<EphemerisProvider['series']['sun']>): boolean {
  if (checkedTimes.has(series)) return checkedTimes.get(series)!;
  let previous = -Infinity;
  const valid = series.samples.every(sample => {
    try {
      const t = Date.parse(canonicalUtc(sample.utc));
      if (t <= previous) return false;
      previous = t;
      return true;
    } catch { return false; }
  });
  checkedTimes.set(series, valid);
  return valid;
}

/** Accept the app's .000Z representation without rounding fractional seconds. */
export function canonicalUtc(utc: string): string {
  const normalized = utc.replace(/\.000Z$/, 'Z');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(normalized)
    || !Number.isFinite(Date.parse(normalized))
    || new Date(normalized).toISOString().replace('.000Z', 'Z') !== normalized) {
    throw new Error('Solar timestamps must be UTC with whole seconds.');
  }
  return normalized;
}

export function panelFromThresholds(t: ScenarioThresholds): Panel {
  return { areaM2: t.panelAreaM2, efficiency: t.panelEfficiency, tiltDeg: t.panelTiltDeg,
    azimuthDeg: t.panelAzimuthDeg, referenceIrradianceWm2: SOLAR_REFERENCE_W_M2 };
}

/** Visibility belongs to assess/windows. This adapter consumes its mask unchanged.
 * It never recalculates a horizon or substitutes 1 AU for missing range.
 */
export function adaptSolarSample(utc: string, sunlit: boolean | null, provider: EphemerisProvider,
  horizon: HorizonProfile): SolarSample {
  const timeUtc = canonicalUtc(utc);
  const missing = (reason: string): SolarSample => ({ timeUtc,
    sun: { azimuthDeg: null, elevationDeg: null, rangeAu: null }, solarVisibleFraction: null,
    quality: { status: 'missing', reason } });
  const observer = horizon.observer;
  try {
    validateSite(horizon.siteId, { latitudeDeg: observer.latitudeDeg, longitudeEastDeg: observer.longitudeEastDeg,
      surfaceElevationM: observer.surfaceElevationM, referenceRadiusM: 1737400 });
  } catch { return missing('horizon_observer_or_frame_mismatch'); }
  if (horizon.frameId !== FRAME_ID || observer.heightAboveGroundM !== 2) {
    return missing('horizon_observer_or_frame_mismatch');
  }
  const series = provider.series.sun;
  if (!series || (series.source !== 'jpl_horizons' && !(series.source === 'bundled' && series.origin === 'jpl_horizons'))) {
    return missing('unverified_or_analytic_sun_ephemeris');
  }
  if (series.siteId !== horizon.siteId || series.frameId !== FRAME_ID
    || !Number.isFinite(series.observer.latitudeDeg) || !Number.isFinite(series.observer.longitudeEastDeg)
    || series.observerHeightAboveGroundM !== 2
    || Math.abs(series.observer.latitudeDeg - observer.latitudeDeg) > 1e-9
    || Math.abs(series.observer.longitudeEastDeg - observer.longitudeEastDeg) > 1e-9
    || !Number.isFinite(series.observer.altitudeKm)
    || Math.abs(series.observer.altitudeKm - (observer.surfaceElevationM + observer.heightAboveGroundM) / 1000) > 1e-6) {
    return missing('sun_observer_or_frame_mismatch');
  }
  const t = Date.parse(timeUtc);
  if (t < Date.parse('2027-01-01T00:00:00Z') || t > Date.parse('2028-01-01T00:00:00Z')) return missing('unsupported_date');
  // Locate actual bracketing samples; provider.get may clamp outside its span.
  const data = series.samples;
  if (!orderedTimes(series)) return missing('sun_timestamps_invalid');
  let lo = 0, hi = data.length - 1;
  if (!data.length || t < Date.parse(data[0].utc) || t > Date.parse(data[hi].utc)) return missing('sun_outside_coverage');
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Date.parse(data[mid].utc) < t) lo = mid + 1;
    else hi = mid;
  }
  const b = data[lo];
  const a = Date.parse(b.utc) === t ? b : data[lo - 1];
  if (!a) return missing('sun_outside_coverage');
  const span = Date.parse(b.utc) - Date.parse(a.utc);
  if (!Number.isFinite(span) || span < 0 || span > STEP_SECONDS * 1000) return missing('sun_ephemeris_gap');
  if ([a, b].some(s => !Number.isFinite(s.rangeAu) || s.rangeAu! < 0.1 || s.rangeAu! > 10
    || !Number.isFinite(s.azimuthDeg) || s.azimuthDeg < 0 || s.azimuthDeg >= 360
    || !Number.isFinite(s.elevationDeg) || Math.abs(s.elevationDeg) > 90)) return missing('sun_geometry_or_range_missing');
  if (sunlit == null) return missing('terrain_visibility_missing');
  const u = span ? (t - Date.parse(a.utc)) / span : 0;
  let da = b.azimuthDeg - a.azimuthDeg;
  if (da > 180) da -= 360;
  if (da < -180) da += 360;
  return { timeUtc, sun: {
    azimuthDeg: ((a.azimuthDeg + u * da) % 360 + 360) % 360,
    elevationDeg: a.elevationDeg + u * (b.elevationDeg - a.elevationDeg),
    rangeAu: a.rangeAu! + u * (b.rangeAu! - a.rangeAu!),
  }, solarVisibleFraction: sunlit ? 1 : 0, quality: { status: 'valid', reason: null } };
}

export function buildSolarInput(options: {
  siteId: string; startUtc: string; endUtc: string; provider: EphemerisProvider; horizon: HorizonProfile;
  samples: Array<{ utc: string; sunlit: boolean | null }>;
}): SolarInput | null {
  const { siteId, provider, horizon } = options;
  if (horizon.siteId !== siteId) return null;
  const site = { latitudeDeg: horizon.observer.latitudeDeg, longitudeEastDeg: horizon.observer.longitudeEastDeg,
    surfaceElevationM: horizon.observer.surfaceElevationM, referenceRadiusM: 1737400 };
  try { validateSite(siteId, site); } catch { return null; }
  if (horizon.frameId !== FRAME_ID || horizon.observer.heightAboveGroundM !== 2) return null;
  const startUtc = canonicalUtc(options.startUtc), endUtc = canonicalUtc(options.endUtc);
  if (Date.parse(startUtc) < Date.parse('2027-01-01T00:00:00Z')
    || Date.parse(endUtc) > Date.parse('2028-01-01T00:00:00Z')) return null;
  const id = `planner:${siteId}:${site.latitudeDeg},${site.longitudeEastDeg},${site.surfaceElevationM}:${startUtc}:${endUtc}:${horizon.generatedAtUtc}:${provider.series.sun?.generatedAtUtc ?? 'missing'}`;
  return {
    schemaVersion: '0.1.0', artifactType: 'solar-input', artifactId: id, scenarioId: id,
    generatedAtUtc: canonicalUtc(new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()),
    label: `${siteId} planner solar input`, frameId: FRAME_ID, siteId,
    site,
    observerHeightAboveGroundM: 2,
    time: { startUtc, endUtc, baseStepSeconds: STEP_SECONDS, visibilityInterpolation: 'previous-sample-hold' },
    provenance: {
      ephemeris: { provider: provider.series.sun?.origin ?? provider.series.sun?.source ?? 'unavailable',
        generatedAtUtc: provider.series.sun?.generatedAtUtc, request: provider.series.sun?.request,
        notes: provider.series.sun?.notes },
      visibility: { provider: 'assess/windows.assessInstant', mode: horizon.model === 'sphere_optimistic' ? 'local-plane-demo' : 'terrain',
        sunModel: 'center-binary-v1', horizonArtifactId: `${siteId}:${horizon.generatedAtUtc}`,
        horizonObserverHeightAboveGroundM: horizon.observer.heightAboveGroundM,
        validation: horizon.validation ?? { status: 'pending' }, sources: horizon.sources, notes: horizon.notes,
        timing: '10-minute sampled approximation; no shadow-event refinement' },
    },
    samples: options.samples.map(s => adaptSolarSample(s.utc, s.sunlit, provider, horizon)),
  };
}
