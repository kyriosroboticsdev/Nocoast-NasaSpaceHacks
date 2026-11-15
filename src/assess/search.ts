import { assessMission, type MissionAssessment } from './windows';
import { rankAssessments, scoreAssessment, type RankedSite } from './decision';
import type { HorizonProfile } from '../horizon/types';
import { createAnalyticProvider } from '../ephemeris/horizons';
import type { ScenarioState } from '../scenario/types';

export type SearchCandidate = {
  id: string;
  latitudeDeg: number;
  longitudeEastDeg: number;
  surfaceElevationM: number;
  elevBins: Array<number | null>;
};

export type SearchCatalog = {
  schemaVersion: string;
  artifactId: string;
  region: { label: string; minLatitudeDeg: number; gridSpacingM: number };
  method: {
    dem: string;
    nearField5m: boolean;
    azimuthSpacingDeg: number;
    honesty: string;
  };
  candidateCount: number;
  candidates: SearchCandidate[];
};

export type SearchHit = RankedSite & {
  latitudeDeg: number;
  longitudeEastDeg: number;
  surfaceElevationM: number;
  /** Compact elev bins used for ranking — retained on Adopt. */
  elevBins: Array<number | null>;
};

let cachedCatalog: SearchCatalog | undefined;

export async function loadSearchCatalog(baseUrl: string): Promise<SearchCatalog> {
  if (cachedCatalog) return cachedCatalog;
  const res = await fetch(`${baseUrl}science/search/polar-cap-candidates.json`);
  if (!res.ok) throw new Error(`Search catalog HTTP ${res.status}`);
  cachedCatalog = (await res.json()) as SearchCatalog;
  return cachedCatalog;
}

export function candidateToHorizon(c: SearchCandidate, spacingDeg: number): HorizonProfile {
  const bins = c.elevBins.map((elevationDeg, i) => ({
    azimuthDeg: i * spacingDeg,
    elevationDeg,
    distanceM: null as number | null,
    status: (elevationDeg == null ? 'gap' : 'ok') as 'ok' | 'gap' | 'sphere',
  }));
  return {
    schemaVersion: '1.0',
    siteId: c.id,
    frameId: 'MOON_ME_DE421',
    observer: {
      latitudeDeg: c.latitudeDeg,
      longitudeEastDeg: c.longitudeEastDeg,
      surfaceElevationM: c.surfaceElevationM,
      heightAboveGroundM: 2,
    },
    spacingDeg,
    model: 'lola_overview_coarse',
    sources: ['NASA PGDA LOLA 320 m polar overview (search grid)'],
    notes: [
      'Coarse regional search horizon — overview DEM only; az 0 = true local north.',
      'Bearings that exit DEM before geometric closure are null (gap).',
      'Not meter-perfect; prefer CR1/SR1 5 m study profiles for final decisions.',
    ],
    bins,
    generatedAtUtc: new Date().toISOString(),
  };
}

/** Great-circle distance on a sphere (km) — Moon radius ~1737.4 km. */
export function lunarDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 1737.4;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type SearchRegion =
  | { kind: 'cap' }
  | { kind: 'around'; latitudeDeg: number; longitudeEastDeg: number; radiusKm: number };

export async function rankSearchCandidates(options: {
  catalog: SearchCatalog;
  state: ScenarioState;
  region: SearchRegion;
  topN: number;
  stepHours?: number;
}): Promise<{ hits: SearchHit[]; assessed: number; limitations: string }> {
  const { catalog, state, region, topN } = options;
  const spacing = catalog.method.azimuthSpacingDeg || 2;
  let pool = catalog.candidates;
  if (region.kind === 'around') {
    pool = pool.filter(
      c =>
        lunarDistanceKm(
          c.latitudeDeg,
          c.longitudeEastDeg,
          region.latitudeDeg,
          region.longitudeEastDeg,
        ) <= region.radiusKm,
    );
  }

  const rows: Array<{
    siteId: string;
    label: string;
    publishedLabel: string;
    assessment: MissionAssessment;
    latitudeDeg: number;
    longitudeEastDeg: number;
    surfaceElevationM: number;
  }> = [];

  // Score in chunks so the UI can stay responsive between awaits.
  const chunk = 16;
  for (let i = 0; i < pool.length; i += chunk) {
    const slice = pool.slice(i, i + chunk);
    const part = await Promise.all(
      slice.map(async c => {
        const horizon = candidateToHorizon(c, spacing);
        const provider = createAnalyticProvider({
          siteId: c.id,
          latDeg: c.latitudeDeg,
          lonEastDeg: c.longitudeEastDeg,
          altitudeKm: (c.surfaceElevationM + 2) / 1000,
          startUtc: state.startUtc,
          durationHours: state.durationHours,
        });
        const assessment = assessMission({
          siteId: c.id,
          siteLabel: `Search ${Math.abs(c.latitudeDeg).toFixed(3)}°S ${c.longitudeEastDeg.toFixed(2)}°E`,
          horizonModel: 'lola_overview_coarse',
          provider,
          horizon,
          startUtc: state.startUtc,
          durationHours: state.durationHours,
          scrubUtc: state.scrubUtc,
          thresholds: state.thresholds,
          stepHours: options.stepHours ?? 2,
        });
        return {
          siteId: c.id,
          label: assessment.siteLabel,
          publishedLabel: `S${c.id.replace('search-', '')}`,
          assessment,
          latitudeDeg: c.latitudeDeg,
          longitudeEastDeg: c.longitudeEastDeg,
          surfaceElevationM: c.surfaceElevationM,
        };
      }),
    );
    rows.push(...part);
    // Yield to the browser between chunks.
    await new Promise(r => setTimeout(r, 0));
  }

  const ranked = rankAssessments(rows).slice(0, topN);
  const hits: SearchHit[] = ranked.map(r => {
    const meta = rows.find(x => x.siteId === r.siteId)!;
    const elevBins = pool.find(c => c.id === r.siteId)?.elevBins ?? [];
    return {
      ...r,
      latitudeDeg: meta.latitudeDeg,
      longitudeEastDeg: meta.longitudeEastDeg,
      surfaceElevationM: meta.surfaceElevationM,
      elevBins,
    };
  });

  return {
    hits,
    assessed: pool.length,
    limitations: catalog.method.honesty,
  };
}

export { scoreAssessment };
