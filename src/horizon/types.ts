export type HorizonBin = {
  /** Azimuth clockwise from true north (deg), 0–360. */
  azimuthDeg: number;
  /** Signed elevation of terrain horizon (deg). Negative = below sphere horizon. */
  elevationDeg: number | null;
  /** Max ray distance used (m), or null if unknown. */
  distanceM: number | null;
  status: 'ok' | 'gap' | 'sphere';
};

export type HorizonProfile = {
  schemaVersion: string;
  siteId: string;
  frameId: string;
  observer: {
    latitudeDeg: number;
    longitudeEastDeg: number;
    surfaceElevationM: number;
    heightAboveGroundM: number;
  };
  spacingDeg: number;
  model: 'lola_terrain' | 'sphere_optimistic';
  sources: string[];
  notes: string[];
  bins: HorizonBin[];
  generatedAtUtc: string;
};

export function sphereHorizon(siteId: string, lat: number, lon: number, elevM = 0, heightM = 2): HorizonProfile {
  const bins: HorizonBin[] = [];
  for (let i = 0; i < 360; i++) {
    // Geometric lunar sphere horizon for a small observer height (deg).
    // dip ≈ acos(R/(R+h)) in radians → degrees; ~0.06° for 2 m — treat as 0 for planning.
    bins.push({
      azimuthDeg: i,
      elevationDeg: 0,
      distanceM: null,
      status: 'sphere',
    });
  }
  return {
    schemaVersion: '1.0',
    siteId,
    frameId: 'MOON_ME_DE421',
    observer: {
      latitudeDeg: lat,
      longitudeEastDeg: lon,
      surfaceElevationM: elevM,
      heightAboveGroundM: heightM,
    },
    spacingDeg: 1,
    model: 'sphere_optimistic',
    sources: ['analytic lunar reference sphere'],
    notes: [
      'Optimistic / terrain-unknown sphere horizon.',
      'Real polar ridges and craters are not represented; treat as upper-bound visibility.',
    ],
    bins,
    generatedAtUtc: new Date().toISOString(),
  };
}

/** Interpolate horizon elevation at an arbitrary azimuth; null if gap. */
export function horizonElevationAt(profile: HorizonProfile, azimuthDeg: number): number | null {
  const az = ((azimuthDeg % 360) + 360) % 360;
  const bins = profile.bins;
  if (!bins.length) return null;
  const spacing = profile.spacingDeg;
  const i0 = Math.floor(az / spacing) % bins.length;
  const i1 = (i0 + 1) % bins.length;
  const a = bins[i0];
  const b = bins[i1];
  if (a.elevationDeg == null || b.elevationDeg == null) return null;
  if (a.status === 'gap' || b.status === 'gap') return null;
  const t = (az - a.azimuthDeg) / spacing;
  return a.elevationDeg + (b.elevationDeg - a.elevationDeg) * t;
}
