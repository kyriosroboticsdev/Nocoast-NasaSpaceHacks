export type Panel = { areaM2: number; efficiency: number; tiltDeg: number; azimuthDeg: number; referenceIrradianceWm2: number };
export type Quality = { status: 'valid' | 'missing'; reason: string | null };
export type SolarSample = {
  timeUtc: string;
  sun: { azimuthDeg: number | null; elevationDeg: number | null; rangeAu: number | null };
  solarVisibleFraction: number | null;
  quality: Quality;
};
export type SolarInput = {
  schemaVersion: '0.1.0'; artifactType: 'solar-input'; artifactId: string; scenarioId: string;
  /** Stable catalog ID or coordinate-based ID; numeric coordinates identify the observer. */
  generatedAtUtc: string; label: string; frameId: string; siteId: string;
  site: { latitudeDeg: number; longitudeEastDeg: number; surfaceElevationM: number; referenceRadiusM: number };
  observerHeightAboveGroundM: number;
  time: { startUtc: string; endUtc: string; baseStepSeconds: number; visibilityInterpolation: 'previous-sample-hold' };
  provenance: {
    ephemeris: { provider: string; [key: string]: unknown };
    visibility: { provider: string; mode: 'terrain' | 'local-plane-demo' | 'synthetic-test'; sunModel: string;
      horizonArtifactId?: string; horizonObserverHeightAboveGroundM?: number; [key: string]: unknown };
  };
  samples: SolarSample[];
};
export type PowerSample = {
  timeUtc: string; solarVisibleFraction: number | null;
  normalIrradianceWm2: number | null; incidenceCosine: number | null; incidenceAngleDeg: number | null;
  panelIrradianceWm2: number | null; unobstructedPowerW: number | null; powerW: number | null;
  sunDirectionEnu: number[] | null; panelNormalEnu: number[]; quality: Quality;
};
export type PowerResult = {
  schemaVersion: string; artifactType: 'power'; artifactId: string; scenarioId: string; generatedAtUtc: string;
  frameId: string; siteId: string; site: SolarInput['site']; observerHeightAboveGroundM: number;
  sourceArtifactId: string; provenance: SolarInput['provenance']; model: { id: string; integration: string; exclusions: string[]; partialDiskApproximation: string };
  units: Record<string, string>; panel: Panel; time: SolarInput['time'];
  summary: { durationSeconds: number; knownSeconds: number; unknownSeconds: number; coverageFraction: number;
    totalEnergyWh: number | null; knownEnergyWh: number; meanPowerW: number | null; sampledPeakPowerW: number | null;
    knownUnobstructedEnergyWh: number; knownObstructionLossWh: number; complete: boolean; eligibleForTerrainComparison: boolean };
  samples: PowerSample[];
  intervals: { startUtc: string; endUtc: string; durationSeconds: number; energyWh: number | null;
    unobstructedEnergyWh: number | null; solarVisibleFraction: number | null; quality: Quality; cumulativeKnownEnergyWh: number }[];
};
export const MODEL_ID: string;
export const SOLAR_REFERENCE_W_M2: number;
export const FRAME_ID: string;
export const SITES: Readonly<Record<string, { latitudeDeg: number; longitudeEastDeg: number }>>;
export function validatePanel(panel: Panel): Panel;
export function validateScenario(input: SolarInput): SolarInput;
export function validateSite(siteId: string, site: SolarInput['site']): SolarInput['site'];
export function utcMilliseconds(value: string, name?: string): number;
export function sunDirectionEnu(azimuthDeg: number, elevationDeg: number): number[];
export function panelNormalEnu(tiltDeg: number, azimuthDeg: number): number[];
export function solarIrradianceWm2(rangeAu: number, reference?: number): number;
export function calculatePower(sample: SolarSample, panel: Panel): PowerSample;
export function simulate(input: SolarInput, panel: Panel): PowerResult;
export function resultCsv(result: PowerResult): string;
