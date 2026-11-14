import type { SiteCatalogEntry } from './types';

/** Curated south-pole / notable sites. Study sites match sites.json coords. */
export const SITE_CATALOG: SiteCatalogEntry[] = [
  {
    siteId: 'connecting-ridge-cr1',
    name: 'Connecting Ridge CR1',
    publishedLabel: 'CR1',
    latitudeDeg: -89.4555,
    longitudeEastDeg: 222.6192,
    surfaceElevationM: 1949.6080773175818,
    observerHeightAboveGroundM: 2,
    category: 'study',
    notes: 'Primary Artemis/CLPS-region study point on Connecting Ridge.',
    horizonStatus: 'ready',
    horizonModel: 'lola_terrain',
    horizonUrl: 'science/horizons/connecting-ridge-cr1.json',
    terrainFocusKey: '17664-22272',
  },
  {
    siteId: 'shackleton-rim-sr1',
    name: 'Shackleton Rim SR1',
    publishedLabel: 'SR1',
    latitudeDeg: -89.7742,
    longitudeEastDeg: 203.4952,
    surfaceElevationM: 1735.2179263340893,
    observerHeightAboveGroundM: 2,
    category: 'study',
    notes: 'Shackleton crater rim study point near the south pole.',
    horizonStatus: 'ready',
    horizonModel: 'lola_terrain',
    horizonUrl: 'science/horizons/shackleton-rim-sr1.json',
    terrainFocusKey: '19328-21120',
  },
  {
    siteId: 'malapert-massif',
    name: 'Malapert Massif ridge',
    publishedLabel: 'MAL',
    latitudeDeg: -85.99,
    longitudeEastDeg: 2.0,
    surfaceElevationM: 4500,
    observerHeightAboveGroundM: 2,
    category: 'curated',
    notes: 'Elevated ridge often discussed for polar illumination and Earth view. Outside dense 87°S mosaic detail.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'peak-near-shackleton',
    name: 'Peak near Shackleton',
    publishedLabel: 'PNS',
    latitudeDeg: -89.54,
    longitudeEastDeg: 222.0,
    surfaceElevationM: 1800,
    observerHeightAboveGroundM: 2,
    category: 'curated',
    notes: 'Representative near-pole ridge crest for comparison demos.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'de-gerlache-ridge',
    name: 'de Gerlache ridge',
    publishedLabel: 'DGR',
    latitudeDeg: -88.5,
    longitudeEastDeg: 270.0,
    surfaceElevationM: 1200,
    observerHeightAboveGroundM: 2,
    category: 'curated',
    notes: 'South-polar ridge area of interest for illumination studies.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'haworth-crater-rim',
    name: 'Haworth crater rim',
    publishedLabel: 'HAW',
    latitudeDeg: -86.9,
    longitudeEastDeg: 337.0,
    surfaceElevationM: 800,
    observerHeightAboveGroundM: 2,
    category: 'curated',
    notes: 'Permanently shadowed region neighbor; optimistic sphere horizon only.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
];

export function findSite(siteId: string): SiteCatalogEntry | undefined {
  return SITE_CATALOG.find(s => s.siteId === siteId);
}

export function resolveSiteCoords(
  siteId: string,
  customLatDeg?: number,
  customLonEastDeg?: number,
): { latitudeDeg: number; longitudeEastDeg: number; elevationM: number; observerHeightM: number; label: string; horizonModel: import('./types').HorizonModel } {
  if (siteId === 'custom') {
    const lat = customLatDeg ?? -89.5;
    const lon = customLonEastDeg ?? 0;
    return {
      latitudeDeg: lat,
      longitudeEastDeg: lon,
      elevationM: 0,
      observerHeightM: 2,
      label: `Custom ${Math.abs(lat).toFixed(3)}°S ${lon.toFixed(3)}°E`,
      horizonModel: 'sphere_optimistic',
    };
  }
  const site = findSite(siteId);
  if (!site) {
    return {
      latitudeDeg: -89.5,
      longitudeEastDeg: 0,
      elevationM: 0,
      observerHeightM: 2,
      label: siteId,
      horizonModel: 'unknown',
    };
  }
  return {
    latitudeDeg: site.latitudeDeg,
    longitudeEastDeg: site.longitudeEastDeg,
    elevationM: site.surfaceElevationM,
    observerHeightM: site.observerHeightAboveGroundM,
    label: site.name,
    horizonModel: site.horizonModel,
  };
}
