/** Canonical scenario types shared by Planner and Learn modes. */

export type AppMode = 'planner' | 'learn';

export type HorizonModel =
  | 'lola_terrain'
  | 'lola_overview_coarse'
  | 'sphere_optimistic'
  | 'unknown';

export type HorizonStatus =
  | 'ready'
  | 'horizon_missing'
  | 'sphere_fallback'
  | 'partial';

export type SiteCatalogEntry = {
  siteId: string;
  name: string;
  publishedLabel: string;
  latitudeDeg: number;
  longitudeEastDeg: number;
  surfaceElevationM: number;
  observerHeightAboveGroundM: number;
  category: 'study' | 'curated' | 'apollo' | 'clps' | 'international' | 'custom';
  notes?: string;
  horizonStatus: HorizonStatus;
  horizonModel: HorizonModel;
  horizonUrl?: string;
  terrainFocusKey?: string;
};

export type ScenarioThresholds = {
  /** Minimum clear Earth elevation (deg) for usable antenna link. */
  minEarthElevationDeg: number;
  /** Active panel area (m²). */
  panelAreaM2: number;
  /** Panel efficiency 0–1. */
  panelEfficiency: number;
  /** Panel normal tilt from local up (deg); 0 = face-up horizontal. */
  panelTiltDeg: number;
  /** Bearing of panel normal, clockwise from true north (deg). */
  panelAzimuthDeg: number;
  /** Rough continuous draw floor (W) for battery-risk framing. */
  batteryFloorW: number;
};

export type ScenarioSlot = {
  id: 'A' | 'B';
  siteId: string;
  /** Custom override when siteId === 'custom'. */
  customLatDeg?: number;
  customLonEastDeg?: number;
  label?: string;
};

export type ScenarioState = {
  mode: AppMode;
  /** Mission start UTC (ISO). */
  startUtc: string;
  /** Mission duration in Earth hours. */
  durationHours: number;
  /** Scrubber time within the mission window (ISO). */
  scrubUtc: string;
  compareEnabled: boolean;
  primary: ScenarioSlot;
  secondary: ScenarioSlot;
  thresholds: ScenarioThresholds;
  showTechnicalDetails: boolean;
};

export type ViabilityGrade = 'GO' | 'RISKY' | 'NO-GO' | 'UNKNOWN';

export const DEFAULT_THRESHOLDS: ScenarioThresholds = {
  minEarthElevationDeg: 5,
  panelAreaM2: 2,
  panelEfficiency: 0.28,
  panelTiltDeg: 0,
  panelAzimuthDeg: 0,
  batteryFloorW: 40,
};

/** Default demo domain matches team note: 2027 January. */
export const DEFAULT_START_UTC = '2027-01-15T00:00:00.000Z';
export const DEFAULT_DURATION_HOURS = 168; // 7 Earth days

export function createDefaultScenario(): ScenarioState {
  return {
    mode: 'planner',
    startUtc: DEFAULT_START_UTC,
    durationHours: DEFAULT_DURATION_HOURS,
    scrubUtc: DEFAULT_START_UTC,
    compareEnabled: true,
    primary: { id: 'A', siteId: 'connecting-ridge-cr1' },
    secondary: { id: 'B', siteId: 'shackleton-rim-sr1' },
    thresholds: { ...DEFAULT_THRESHOLDS },
    showTechnicalDetails: false,
  };
}
