export type BodyId = 'sun' | 'earth';

export type TopocentricSample = {
  utc: string;
  azimuthDeg: number;
  elevationDeg: number;
  /** Observer-to-body range, AU; required for solar power (Horizons quantity 20). */
  rangeAu?: number;
};

export type EphemerisSeries = {
  schemaVersion: string;
  body: BodyId;
  siteId: string;
  observer: {
    latitudeDeg: number;
    longitudeEastDeg: number;
    altitudeKm: number;
  };
  stepHours: number;
  source: 'jpl_horizons' | 'analytic_fallback' | 'bundled';
  origin?: 'jpl_horizons';
  frameId?: string;
  observerHeightAboveGroundM?: number;
  request?: Record<string, string>;
  samples: TopocentricSample[];
  generatedAtUtc: string;
  notes: string[];
};

export type BodyState = {
  body: BodyId;
  azimuthDeg: number;
  elevationDeg: number;
  /** Elevation above terrain horizon; null if horizon unknown. */
  clearElevationDeg: number | null;
  aboveHorizon: boolean | null;
  source: string;
};
