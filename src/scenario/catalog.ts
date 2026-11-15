import type { SiteCatalogEntry } from './types';

/**
 * Curated landing sites for rapid comparison.
 * Study sites (CR1/SR1) match sites.json and ship bundled LOLA terrain horizons offline.
 * Four of the "curated" entries (Malapert Massif, Peak Near Shackleton, de Gerlache Rim 1,
 * Leibnitz Beta Plateau) are the other official NASA Artemis III candidate landing regions with a
 * real published PGDA 5 m DEM (pgda.gsfc.nasa.gov/products/78) — coordinates and elevation here are
 * computed directly from those GeoTIFFs (tile center, bilinear sample), not approximated. They get a
 * real measured horizon from the live Person 2 backend (contract/lunar-navigator.v0.1.json lists all
 * six real tiles), but — like every non-CR1/SR1 entry — fall back to sphere_optimistic in the
 * static/offline build, since no bundled horizon JSON exists for them yet. UI must surface that flag
 * so planners never treat an un-upgraded entry as measured.
 * The remaining curated / Apollo / CLPS / international entries have no published 5 m DEM at all and
 * always use sphere_optimistic.
 */
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
    name: 'Malapert Massif',
    publishedLabel: 'MAL',
    latitudeDeg: -85.994785,
    longitudeEastDeg: 359.764216,
    surfaceElevationM: 4783.796733394672,
    observerHeightAboveGroundM: 2,
    category: 'curated',
    notes: 'Official NASA Artemis III candidate landing region. Real LOLA 5 m PGDA elevation data exists '
      + '(pgda.gsfc.nasa.gov, Site23) — shows a measured terrain horizon when the live science backend is '
      + 'running (see docs/PERSON2_COMMS.md), sphere-optimistic in the offline/bundled demo otherwise.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'peak-near-shackleton',
    name: 'Peak Near Shackleton',
    publishedLabel: 'PNS',
    latitudeDeg: -88.811008,
    longitudeEastDeg: 123.690068,
    surfaceElevationM: 1645.248585134862,
    observerHeightAboveGroundM: 2,
    category: 'curated',
    notes: 'Official NASA Artemis III candidate landing region. Real LOLA 5 m PGDA elevation data exists '
      + '(pgda.gsfc.nasa.gov, Site07) — shows a measured terrain horizon when the live science backend is '
      + 'running, sphere-optimistic in the offline/bundled demo otherwise.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'de-gerlache-rim-1',
    name: 'de Gerlache Rim 1',
    publishedLabel: 'DGR1',
    latitudeDeg: -88.683418,
    longitudeEastDeg: 292.067900,
    surfaceElevationM: 1793.7308968628276,
    observerHeightAboveGroundM: 2,
    category: 'curated',
    notes: 'Official NASA Artemis III candidate landing region. Real LOLA 5 m PGDA elevation data exists '
      + '(pgda.gsfc.nasa.gov, Site11) — shows a measured terrain horizon when the live science backend is '
      + 'running, sphere-optimistic in the offline/bundled demo otherwise.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'leibnitz-beta-plateau',
    name: 'Leibnitz Beta Plateau',
    publishedLabel: 'LBP',
    latitudeDeg: -85.426577,
    longitudeEastDeg: 31.742761,
    surfaceElevationM: 6398.685706239586,
    observerHeightAboveGroundM: 2,
    category: 'curated',
    notes: 'Official NASA Artemis III candidate landing region — one of the highest-elevation candidates '
      + '(a mountain plateau, favorable for near-continuous sunlight). Real LOLA 5 m PGDA elevation data '
      + 'exists (pgda.gsfc.nasa.gov, Site20) — shows a measured terrain horizon when the live science '
      + 'backend is running, sphere-optimistic in the offline/bundled demo otherwise.',
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
  {
    siteId: 'nobile-rim',
    name: 'Nobile crater rim (polar)',
    publishedLabel: 'NOB',
    latitudeDeg: -85.2,
    longitudeEastDeg: 55.0,
    surfaceElevationM: 1000,
    observerHeightAboveGroundM: 2,
    category: 'curated',
    notes: 'Polar crater rim region discussed for ice and CLPS-style targeting. Sphere horizon.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  // ---- CLPS / commercial-style targets (confirmed landing coordinates where available; sphere horizons) ----
  {
    siteId: 'clps-im1-odysseus',
    name: 'IM-1 Odysseus · Malapert A',
    publishedLabel: 'IM1',
    latitudeDeg: -80.13,
    longitudeEastDeg: 1.44,
    surfaceElevationM: 2579,
    observerHeightAboveGroundM: 2,
    category: 'clps',
    notes: 'Confirmed actual landing site of Intuitive Machines’ Odysseus (22 Feb 2024, first US lunar soft '
      + 'landing since Apollo 17), verified by LRO/LROC imagery at 80.13°S 1.44°E, 2579 m elevation, '
      + 'near the Malapert A crater. Sphere horizon in this tool (no published 5 m PGDA DEM at this location).',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'clps-im2-athena',
    name: 'IM-2 Athena · Mons Mouton',
    publishedLabel: 'IM2',
    latitudeDeg: -84.7906,
    longitudeEastDeg: 29.1957,
    surfaceElevationM: 5321.132013645425,
    observerHeightAboveGroundM: 2,
    category: 'clps',
    notes: 'Confirmed actual landing site of Intuitive Machines’ Athena (6 Mar 2025) at 84.7906°S '
      + '29.1957°E on Mons Mouton — the southernmost lunar landing to date, and the high plateau '
      + 'originally the planned site of NASA’s cancelled VIPER rover before IM-2 took the slot. '
      + 'Elevation measured from the real LOLA 80 m polar DEM (no 5 m PGDA tile at this location, so '
      + 'horizon stays sphere-optimistic in this tool; the elevation figure itself is real LOLA data).',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'clps-prl-shalton',
    name: 'Shackleton–de Gerlache ridge (CLPS-style)',
    publishedLabel: 'SDR',
    latitudeDeg: -89.0,
    longitudeEastDeg: 210.0,
    surfaceElevationM: 1600,
    observerHeightAboveGroundM: 2,
    category: 'clps',
    notes: 'Representative CLPS-region ridge between Shackleton and de Gerlache. Sphere horizon.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  // ---- Apollo heritage (non-polar; sphere; educational contrast) ----
  {
    siteId: 'apollo-11',
    name: 'Apollo 11 · Sea of Tranquility',
    publishedLabel: 'A11',
    latitudeDeg: 0.67408,
    longitudeEastDeg: 23.47297,
    surfaceElevationM: -1900,
    observerHeightAboveGroundM: 2,
    category: 'apollo',
    notes: 'Equatorial heritage site — Earth LOS and solar day differ sharply from polar ops. Sphere horizon; outside polar mosaic.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'apollo-12',
    name: 'Apollo 12 · Oceanus Procellarum',
    publishedLabel: 'A12',
    latitudeDeg: -3.01239,
    longitudeEastDeg: 336.5781,
    surfaceElevationM: -1500,
    observerHeightAboveGroundM: 2,
    category: 'apollo',
    notes: 'Equatorial heritage site for Earth-analog contrast in Learn mode. Sphere horizon.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'apollo-14',
    name: 'Apollo 14 · Fra Mauro',
    publishedLabel: 'A14',
    latitudeDeg: -3.6453,
    longitudeEastDeg: 342.5229,
    surfaceElevationM: -1000,
    observerHeightAboveGroundM: 2,
    category: 'apollo',
    notes: 'Equatorial heritage site. Sphere horizon; outside polar mosaic.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'apollo-15',
    name: 'Apollo 15 · Hadley–Apennine',
    publishedLabel: 'A15',
    latitudeDeg: 26.1322,
    longitudeEastDeg: 3.6339,
    surfaceElevationM: -2000,
    observerHeightAboveGroundM: 2,
    category: 'apollo',
    notes: 'Mid-latitude heritage site. Sphere horizon.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'apollo-16',
    name: 'Apollo 16 · Descartes',
    publishedLabel: 'A16',
    latitudeDeg: -8.9734,
    longitudeEastDeg: 15.5011,
    surfaceElevationM: -500,
    observerHeightAboveGroundM: 2,
    category: 'apollo',
    notes: 'Equatorial highland heritage site. Sphere horizon.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'apollo-17',
    name: 'Apollo 17 · Taurus–Littrow',
    publishedLabel: 'A17',
    latitudeDeg: 20.1908,
    longitudeEastDeg: 30.7717,
    surfaceElevationM: -1500,
    observerHeightAboveGroundM: 2,
    category: 'apollo',
    notes: 'Last Apollo landing — useful Earth-day contrast vs polar blackouts. Sphere horizon.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  // ---- International / other programs (approximate; educational) ----
  {
    siteId: 'chang-e-4',
    name: 'Chang\'e-4 · Von Kármán (farside)',
    publishedLabel: 'CE4',
    latitudeDeg: -45.4446,
    longitudeEastDeg: 177.5991,
    surfaceElevationM: -5900,
    observerHeightAboveGroundM: 2,
    category: 'international',
    notes: 'Farside site — direct Earth LOS is blocked by the Moon; relay-dependent. Sphere horizon; DTE will show as poor by design.',
    horizonStatus: 'sphere_fallback',
    horizonModel: 'sphere_optimistic',
  },
  {
    siteId: 'chandrayaan3',
    name: 'Chandrayaan-3 · near 69°S',
    publishedLabel: 'CH3',
    latitudeDeg: -69.373,
    longitudeEastDeg: 32.319,
    surfaceElevationM: -500,
    observerHeightAboveGroundM: 2,
    category: 'international',
    notes: 'Near-polar Indian landing region — bridges equatorial Apollo and true south-pole geometry. Sphere horizon.',
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
      label: `Custom ${Math.abs(lat).toFixed(3)}°${lat < 0 ? 'S' : 'N'} ${lon.toFixed(3)}°E`,
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

export const CATALOG_GROUP_LABELS: Record<string, string> = {
  study: 'Study points (LOLA horizons)',
  curated: 'Curated polar candidates',
  clps: 'CLPS / commercial-style (approx.)',
  apollo: 'Apollo heritage (equatorial contrast)',
  international: 'International / other programs',
};
