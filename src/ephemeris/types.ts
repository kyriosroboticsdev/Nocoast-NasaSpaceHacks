export type BodyId = 'sun' | 'earth';

export type TopocentricSample = {
  utc: string;
  azimuthDeg: number;
  elevationDeg: number;
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
