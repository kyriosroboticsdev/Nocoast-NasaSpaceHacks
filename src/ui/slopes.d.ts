export type SlopeSite = { id: string; name: string; lat: number; lon: number };
export type SlopeArea = {
  totalAreaM2: number; knownAreaM2: number; unknownAreaM2: number;
  withinAreaM2: number | null; aboveAreaM2: number | null;
  withinPatchFraction: number | null; coverageAreaFraction: number;
  limitDeg: number; widthM: number;
};
export function createSlopeView(host: HTMLElement, onChange?: () => void, requestUrl?: (path: string) => string): {
  setSite(site: SlopeSite | undefined): void;
  setSites(sites: SlopeSite[]): void;
  setActive(active: boolean): void;
  areaFor(site: SlopeSite): SlopeArea | null;
};
