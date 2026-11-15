/**
 * Client for the Person 2 science backend (`backend/app.py`, FastAPI on :8765, proxied at `/api` by Vite —
 * see vite.config.mjs and run.sh/run.ps1). It computes real Sun/Earth topocentric positions (Skyfield + JPL
 * DE421) and real 360-degree terrain horizons (PGDA 5 m site tiles, falling back to LOLA 80 m / 240 m) for
 * any south-polar point, not just the two bundled study sites.
 *
 * Every function here fails soft to `null` — the backend is a local, optional dev process. When it isn't
 * running (a static deploy, or the offline demo path), callers fall back to the existing bundled/sphere
 * pipeline exactly as before.
 */
import type { HorizonBin, HorizonProfile } from '../horizon/types';
import type { BodyId, EphemerisSeries } from '../ephemeris/types';
import type { EphemerisProvider } from '../ephemeris/horizons';
import { interpolateSeries } from '../ephemeris/horizons';

export type BackendSummary = {
  percentOfMission: number | null;
  totalSeconds: number | null;
  windowCount: number;
  longestWindowSeconds: number;
  longestGapSeconds: number | null;
  unknownSeconds: number;
};

export type BackendAnalysis = {
  site: {
    latitudeDeg: number;
    longitudeEastDeg: number;
    surfaceElevationM: number | null;
    terrainQuality: 'contract' | 'fallback' | 'none' | null;
    horizonSource: string | null;
    rankable: boolean;
  };
  horizon: {
    azimuthStartDeg: number;
    azimuthStepDeg: number;
    sampleCount: number;
    elevationDeg: (number | null)[];
  };
  series: {
    timesUtc: string[];
    sunAzimuthDeg: (number | null)[];
    sunElevationDeg: (number | null)[];
    earthAzimuthDeg: (number | null)[];
    earthElevationDeg: (number | null)[];
  };
  communication: { summary: BackendSummary };
  sun: { summary: BackendSummary };
  sunAndCommunication: { summary: BackendSummary };
};

const TIMEOUT_MS = 2500;
const cache = new Map<string, Promise<BackendAnalysis | null>>();

/** GET /api/analyze for an arbitrary (lat, lon, window) — cached per exact query within this session. */
export function fetchBackendAnalysis(
  latDeg: number,
  lonEastDeg: number,
  startUtc: string,
  endUtc: string,
  antennaMinElevationDeg: number | undefined,
  baseUrl: string,
): Promise<BackendAnalysis | null> {
  const key = `${latDeg}:${lonEastDeg}:${startUtc}:${endUtc}:${antennaMinElevationDeg ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const params = new URLSearchParams({
    latitudeDeg: String(latDeg),
    longitudeEastDeg: String(lonEastDeg),
    startUtc,
    endUtc,
  });
  if (antennaMinElevationDeg != null) params.set('antennaMinElevationDeg', String(antennaMinElevationDeg));

  const promise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(`${baseUrl}api/analyze?${params}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return (await res.json()) as BackendAnalysis;
    } catch {
      return null; // backend not running — caller falls back to the bundled/sphere pipeline
    }
  })();
  cache.set(key, promise);
  return promise;
}

/** Real NASA-DEM horizon from the backend, or null if it has no terrain coverage at this point. */
export function backendHorizonProfile(a: BackendAnalysis, siteId: string): HorizonProfile | null {
  if (!a.site.terrainQuality || a.site.terrainQuality === 'none') return null;
  const { azimuthStartDeg, azimuthStepDeg, elevationDeg } = a.horizon;
  if (!elevationDeg.some(v => v != null)) return null;
  const bins: HorizonBin[] = elevationDeg.map((v, i) => ({
    azimuthDeg: azimuthStartDeg + i * azimuthStepDeg,
    elevationDeg: v,
    distanceM: null,
    status: v == null ? 'gap' : 'ok',
  }));
  const fiveMeter = a.site.terrainQuality === 'contract';
  return {
    schemaVersion: '1.0',
    siteId,
    frameId: 'MOON_ME_DE421',
    observer: {
      latitudeDeg: a.site.latitudeDeg,
      longitudeEastDeg: a.site.longitudeEastDeg,
      surfaceElevationM: a.site.surfaceElevationM ?? 0,
      heightAboveGroundM: 2,
    },
    spacingDeg: azimuthStepDeg,
    // Both tiers are measured DEM, not a sphere guess — ranks as study-grade either way (authorityTier()).
    model: 'lola_terrain',
    sources: [fiveMeter
      ? 'Person 2 backend — PGDA 5 m DEM (Skyfield + JPL DE421)'
      : 'Person 2 backend — LOLA 80 m/240 m band (Skyfield + JPL DE421)'],
    notes: [
      'Computed live by the Person 2 science backend for this exact point, not bundled.',
      fiveMeter
        ? 'Full 5 m PGDA resolution at this point.'
        : 'One or more azimuths fell back to a coarser LOLA band than 5 m — still measured, not a sphere guess.',
    ],
    bins,
    generatedAtUtc: new Date().toISOString(),
  };
}

function toSeries(
  body: BodyId,
  siteId: string,
  site: BackendAnalysis['site'],
  times: string[],
  az: (number | null)[],
  el: (number | null)[],
): EphemerisSeries {
  const samples = times
    .map((utc, i) => ({ utc, az: az[i], el: el[i] }))
    .filter((s): s is { utc: string; az: number; el: number } => s.az != null && s.el != null)
    .map(s => ({ utc: s.utc, azimuthDeg: s.az, elevationDeg: s.el }));
  return {
    schemaVersion: '1.0',
    body,
    siteId,
    observer: { latitudeDeg: site.latitudeDeg, longitudeEastDeg: site.longitudeEastDeg, altitudeKm: 0 },
    stepHours: 600 / 3600,
    // Backend series fully covers the requested window; treat like 'bundled' so get() never clamps past end.
    source: 'bundled',
    samples,
    generatedAtUtc: new Date().toISOString(),
    notes: ['Person 2 backend: Skyfield + JPL DE421, body-fixed frame MOON_ME_DE421.'],
  };
}

/** EphemerisProvider backed by one backend /api/analyze call — live Skyfield + JPL DE421, any mission date
 * within the contract's supported year, no bundled-range coverage gaps. */
export function backendEphemerisProvider(siteId: string, a: BackendAnalysis): EphemerisProvider {
  const series = {
    sun: toSeries('sun', siteId, a.site, a.series.timesUtc, a.series.sunAzimuthDeg, a.series.sunElevationDeg),
    earth: toSeries('earth', siteId, a.site, a.series.timesUtc, a.series.earthAzimuthDeg, a.series.earthElevationDeg),
  };
  return {
    series,
    sourceLabel: 'Person 2 backend (Skyfield + JPL DE421, live)',
    get(body, utcIso) {
      return interpolateSeries(series[body], utcIso);
    },
  };
}
