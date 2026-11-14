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
    // Typical: 2027-Jan-15 00:00 *i  az  elev ...
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
  // Horizons SITE_COORD: longitude, latitude, altitude km (body-fixed).
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

function interpolateSeries(series: EphemerisSeries, utcIso: string): TopocentricSample | null {
  const t = Date.parse(utcIso);
  const samples = series.samples;
  if (!samples.length) return null;
  if (t <= Date.parse(samples[0].utc)) return samples[0];
  if (t >= Date.parse(samples[samples.length - 1].utc)) return samples[samples.length - 1];
  for (let i = 0; i < samples.length - 1; i++) {
    const t0 = Date.parse(samples[i].utc);
    const t1 = Date.parse(samples[i + 1].utc);
    if (t >= t0 && t <= t1) {
      const u = (t - t0) / (t1 - t0);
      const a0 = samples[i].azimuthDeg;
      let da = samples[i + 1].azimuthDeg - a0;
      if (da > 180) da -= 360;
      if (da < -180) da += 360;
      return {
        utc: utcIso,
        azimuthDeg: ((a0 + da * u) % 360 + 360) % 360,
        elevationDeg: samples[i].elevationDeg + (samples[i + 1].elevationDeg - samples[i].elevationDeg) * u,
      };
    }
  }
  return null;
}

export type EphemerisProvider = {
  get: (body: BodyId, utcIso: string) => TopocentricSample;
  sourceLabel: string;
  series: Partial<Record<BodyId, EphemerisSeries>>;
};

/**
 * Resolve ephemeris for a site: bundled → live Horizons (optional) → analytic.
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
}): Promise<EphemerisProvider> {
  const series: Partial<Record<BodyId, EphemerisSeries>> = {};
  let sourceLabel = 'analytic';

  for (const body of ['sun', 'earth'] as BodyId[]) {
    const bundled = await loadBundledSeries(body, options.siteId, options.baseUrl);
    if (bundled) {
      series[body] = bundled;
      sourceLabel = 'bundled Horizons';
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
    if (sourceLabel === 'analytic') sourceLabel = 'analytic fallback';
  }

  return {
    series,
    sourceLabel,
    get(body, utcIso) {
      const s = series[body];
      if (s) {
        const sample = interpolateSeries(s, utcIso);
        if (sample) return sample;
      }
      const ae = body === 'sun'
        ? sampleAnalyticSeries('sun', options.siteId, options.latDeg, options.lonEastDeg, options.altitudeKm, utcIso, 0, 1).samples[0]
        : sampleAnalyticSeries('earth', options.siteId, options.latDeg, options.lonEastDeg, options.altitudeKm, utcIso, 0, 1).samples[0];
      return ae;
    },
  };
}
