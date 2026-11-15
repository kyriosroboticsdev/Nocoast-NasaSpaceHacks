import type { BodyId, EphemerisSeries, TopocentricSample } from './types';
import { sampleAnalyticSeries } from './analytic';

const HORIZONS_API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/** COMMAND codes: Sun=10, Earth=399. Center = lunar surface coords @ 301. */
const BODY_COMMAND: Record<BodyId, string> = {
  sun: '10',
  earth: '399',
};

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function horizonsDateToIso(token: string): string | null {
  const m = token.match(/^(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (!mon) return null;
  return `${m[1]}-${mon}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
}

function parseHorizonsTable(text: string): TopocentricSample[] {
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  if (start < 0 || end < 0) throw new Error('Horizons response missing SOE/EOE');
  const block = text.slice(start + 5, end).trim();
  const samples: TopocentricSample[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('****')) continue;
    const m = trimmed.match(
      /^(\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2})\s+\S*\s+([+-]?\d+\.\d+)\s+([+-]?\d+\.\d+)/,
    );
    if (!m) continue;
    const utc = horizonsDateToIso(m[1]);
    if (!utc) continue;
    samples.push({
      utc,
      azimuthDeg: Number(m[2]),
      elevationDeg: Number(m[3]),
    });
  }
  if (!samples.length) throw new Error('No Horizons az/el samples parsed');
  return samples;
}

export async function fetchHorizonsSeries(
  body: BodyId,
  siteId: string,
  latDeg: number,
  lonEastDeg: number,
  altitudeKm: number,
  startIso: string,
  stopIso: string,
  stepSize = '1 h',
): Promise<EphemerisSeries> {
  const siteCoord = `'${lonEastDeg},${latDeg},${altitudeKm}'`;
  const params = new URLSearchParams({
    format: 'text',
    COMMAND: `'${BODY_COMMAND[body]}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'OBSERVER',
    CENTER: 'coord@301',
    COORD_TYPE: 'GEODETIC',
    SITE_COORD: siteCoord,
    START_TIME: `'${startIso.slice(0, 19).replace('T', ' ')}'`,
    STOP_TIME: `'${stopIso.slice(0, 19).replace('T', ' ')}'`,
    STEP_SIZE: `'${stepSize}'`,
    QUANTITIES: "'4'",
    CAL_FORMAT: 'CAL',
    ANG_FORMAT: 'DEG',
    EXTRA_PREC: 'YES',
    CSV_FORMAT: 'NO',
  });

  const response = await fetch(`${HORIZONS_API}?${params}`);
  if (!response.ok) throw new Error(`Horizons HTTP ${response.status}`);
  const text = await response.text();
  if (/No ephemeris for target/i.test(text) || /ERROR/i.test(text.slice(0, 500))) {
    throw new Error('Horizons returned an error payload');
  }
  const samples = parseHorizonsTable(text);
  return {
    schemaVersion: '1.0',
    body,
    siteId,
    observer: { latitudeDeg: latDeg, longitudeEastDeg: lonEastDeg, altitudeKm },
    stepHours: 1,
    source: 'jpl_horizons',
    samples,
    generatedAtUtc: new Date().toISOString(),
    notes: ['Live JPL Horizons observer quantities (azimuth/elevation).', 'Airless geometric angles; no refraction.'],
  };
}

export async function loadBundledSeries(
  body: BodyId,
  siteId: string,
  baseUrl: string,
): Promise<EphemerisSeries | null> {
  try {
    const url = `${baseUrl}science/ephemeris/${siteId}-${body}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as EphemerisSeries;
    return { ...data, source: data.source === 'jpl_horizons' ? 'bundled' : data.source };
  } catch {
    return null;
  }
}

/**
 * Interpolate within series span only. Returns null outside coverage —
 * never clamps to the last sample (that froze Sun/Earth past Feb 1).
 */
export function interpolateSeries(series: EphemerisSeries, utcIso: string): TopocentricSample | null {
  const t = Date.parse(utcIso);
  const samples = series.samples;
  if (!samples.length || !Number.isFinite(t)) return null;
  const t0 = Date.parse(samples[0].utc);
  const t1 = Date.parse(samples[samples.length - 1].utc);
  const eps = 1000; // 1 s tolerance at endpoints
  if (t < t0 - eps || t > t1 + eps) return null;
  if (t <= t0) return { ...samples[0], utc: utcIso };
  if (t >= t1) return { ...samples[samples.length - 1], utc: utcIso };
  // Ten-minute playback uses logarithmic lookup.
  let lo = 1, hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Date.parse(samples[mid].utc) < t) lo = mid + 1;
    else hi = mid;
  }
  {
    const i = lo - 1;
    const a = Date.parse(samples[i].utc), b = Date.parse(samples[i + 1].utc);
    if (t >= a && t <= b) {
      const u = (t - a) / (b - a);
      const a0 = samples[i].azimuthDeg;
      let da = samples[i + 1].azimuthDeg - a0;
      if (da > 180) da -= 360;
      if (da < -180) da += 360;
      return {
        utc: utcIso,
        azimuthDeg: ((a0 + da * u) % 360 + 360) % 360,
        elevationDeg: samples[i].elevationDeg + (samples[i + 1].elevationDeg - samples[i].elevationDeg) * u,
        rangeAu: samples[i].rangeAu != null && samples[i + 1].rangeAu != null
          ? samples[i].rangeAu! + (samples[i + 1].rangeAu! - samples[i].rangeAu!) * u : undefined,
      };
    }
  }
  return null;
}

export type EphemerisProvider = {
  /** Null when the requested time is outside covered ephemeris (unknown). */
  get: (body: BodyId, utcIso: string) => TopocentricSample | null;
  sourceLabel: string;
  series: Partial<Record<BodyId, EphemerisSeries>>;
  /** True when any requested mission hour may be uncovered. */
  hasCoverageGaps?: boolean;
};

function seriesCoversStart(series: EphemerisSeries, startUtc: string): boolean {
  if (!series.samples.length) return false;
  const t0 = Date.parse(series.samples[0].utc);
  const t1 = Date.parse(series.samples[series.samples.length - 1].utc);
  const start = Date.parse(startUtc);
  return Number.isFinite(start) && start >= t0 && start <= t1;
}

function seriesEndClipped(series: EphemerisSeries, startUtc: string, durationHours: number): boolean {
  if (!series.samples.length) return false;
  const t1 = Date.parse(series.samples[series.samples.length - 1].utc);
  const end = Date.parse(startUtc) + durationHours * 3600_000;
  return end > t1 + 1000;
}

/** Sync analytic-only provider for dense regional search (no bundled/live lookup). */
export function createAnalyticProvider(options: {
  siteId: string;
  latDeg: number;
  lonEastDeg: number;
  altitudeKm: number;
  startUtc: string;
  durationHours: number;
  stepHours?: number;
}): EphemerisProvider {
  const step = options.stepHours ?? 2;
  const series: Partial<Record<BodyId, EphemerisSeries>> = {
    sun: sampleAnalyticSeries(
      'sun', options.siteId, options.latDeg, options.lonEastDeg, options.altitudeKm,
      options.startUtc, options.durationHours, step,
    ),
    earth: sampleAnalyticSeries(
      'earth', options.siteId, options.latDeg, options.lonEastDeg, options.altitudeKm,
      options.startUtc, options.durationHours, step,
    ),
  };
  return {
    series,
    sourceLabel: 'analytic fallback (search)',
    get(body, utcIso) {
      const s = series[body];
      if (!s) return null;
      return interpolateSeries(s, utcIso);
    },
  };
}

/**
 * Resolve ephemeris for a site: bundled (if start in coverage) → live Horizons (optional) → analytic.
 * Times past series end return null from get() — assessment marks those hours unknown.
 */
export async function createEphemerisProvider(options: {
  siteId: string;
  latDeg: number;
  lonEastDeg: number;
  altitudeKm: number;
  startUtc: string;
  durationHours: number;
  baseUrl: string;
  allowLive?: boolean;
  /** When true, prefer analytic over silent partial clamp for out-of-bundle starts. */
  preferAnalyticOutsideBundle?: boolean;
}): Promise<EphemerisProvider> {
  const series: Partial<Record<BodyId, EphemerisSeries>> = {};
  let sourceLabel = 'analytic';
  let hasCoverageGaps = false;

  for (const body of ['sun', 'earth'] as BodyId[]) {
    const bundled = await loadBundledSeries(body, options.siteId, options.baseUrl);
    if (bundled && seriesCoversStart(bundled, options.startUtc)) {
      series[body] = bundled;
      if (seriesEndClipped(bundled, options.startUtc, options.durationHours)) {
        hasCoverageGaps = true;
        sourceLabel = 'bundled Horizons (partial — uncovered hours unknown)';
      } else {
        sourceLabel = 'bundled Horizons';
      }
      continue;
    }
    if (options.allowLive) {
      try {
        const stop = new Date(Date.parse(options.startUtc) + options.durationHours * 3600_000).toISOString();
        series[body] = await fetchHorizonsSeries(
          body,
          options.siteId,
          options.latDeg,
          options.lonEastDeg,
          options.altitudeKm,
          options.startUtc,
          stop,
        );
        sourceLabel = 'live Horizons';
        continue;
      } catch {
        // fall through
      }
    }
    series[body] = sampleAnalyticSeries(
      body,
      options.siteId,
      options.latDeg,
      options.lonEastDeg,
      options.altitudeKm,
      options.startUtc,
      options.durationHours,
      1,
    );
    if (sourceLabel === 'analytic' || sourceLabel.startsWith('bundled')) {
      sourceLabel = bundled && !seriesCoversStart(bundled, options.startUtc)
        ? 'analytic fallback (outside bundled range)'
        : 'analytic fallback';
    }
  }

  return {
    series,
    sourceLabel,
    hasCoverageGaps,
    get(body, utcIso) {
      const s = series[body];
      if (!s) return null;
      // Analytic series covers the requested window by construction.
      if (s.source === 'analytic_fallback') {
        return interpolateSeries(s, utcIso) ?? (() => {
          const ae = sampleAnalyticSeries(
            body, options.siteId, options.latDeg, options.lonEastDeg, options.altitudeKm, utcIso, 0, 1,
          ).samples[0];
          return ae;
        })();
      }
      // Bundled / live: never clamp past end — null → unknown assessment hour.
      return interpolateSeries(s, utcIso);
    },
  };
}
