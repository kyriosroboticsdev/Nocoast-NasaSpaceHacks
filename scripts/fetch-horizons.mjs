/**
 * Precompute Sun/Earth az/el series for curated study sites.
 * Tries JPL Horizons API; on failure writes analytic fallback (still demoable offline).
 * Analytic math is shared with src/ephemeris/analytic-math.mjs.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyticEarthAzEl,
  analyticSunAzEl,
} from './lib/analytic-math.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** Extended past Feb 1 so late-January + multi-week missions stay in-bundle when fetch succeeds. */
const START = '2027-01-01T00:00:00';
const STOP = '2027-03-01T00:00:00';
const STEP = '1 h';

const sites = [
  {
    siteId: 'connecting-ridge-cr1',
    latitudeDeg: -89.4555,
    longitudeEastDeg: 222.6192,
    altitudeKm: 1.951608,
  },
  {
    siteId: 'shackleton-rim-sr1',
    latitudeDeg: -89.7742,
    longitudeEastDeg: 203.4952,
    altitudeKm: 1.737218,
  },
];

function analyticSeries(body, site) {
  const samples = [];
  const start = Date.parse(START + 'Z');
  const stop = Date.parse(STOP + 'Z');
  for (let t = start; t <= stop; t += 3600_000) {
    const utc = new Date(t).toISOString();
    const ae = body === 'sun'
      ? analyticSunAzEl(utc, site.latitudeDeg, site.longitudeEastDeg)
      : analyticEarthAzEl(utc, site.latitudeDeg, site.longitudeEastDeg);
    samples.push({ utc, ...ae });
  }
  return {
    schemaVersion: '1.0',
    body,
    siteId: site.siteId,
    observer: {
      latitudeDeg: site.latitudeDeg,
      longitudeEastDeg: site.longitudeEastDeg,
      altitudeKm: site.altitudeKm,
    },
    stepHours: 1,
    source: 'analytic_fallback',
    samples,
    generatedAtUtc: new Date().toISOString(),
    notes: [
      'Analytic lunar topocentric series (Horizons unreachable during precompute).',
      'Shared model with src/ephemeris/analytic-math.mjs (calibrated near south pole).',
      'Replace by re-running with network for jpl_horizons provenance.',
    ],
  };
}

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function horizonsDateToIso(token) {
  const m = token.match(/^(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (!mon) return null;
  return `${m[1]}-${mon}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
}

function parseHorizonsTable(text) {
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  if (start < 0 || end < 0) throw new Error('missing SOE');
  const samples = [];
  for (const line of text.slice(start + 5, end).trim().split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(
      /^(\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2})\s+\S*\s+([+-]?\d+\.\d+)\s+([+-]?\d+\.\d+)/,
    );
    if (!m) continue;
    const utc = horizonsDateToIso(m[1]);
    if (!utc) continue;
    samples.push({ utc, azimuthDeg: Number(m[2]), elevationDeg: Number(m[3]) });
  }
  if (!samples.length) throw new Error('no samples');
  return samples;
}

async function fetchHorizons(body, site) {
  const command = body === 'sun' ? '10' : '399';
  const siteCoord = `'${site.longitudeEastDeg},${site.latitudeDeg},${site.altitudeKm}'`;
  const params = new URLSearchParams({
    format: 'text',
    COMMAND: `'${command}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'OBSERVER',
    CENTER: 'coord@301',
    COORD_TYPE: 'GEODETIC',
    SITE_COORD: siteCoord,
    START_TIME: `'${START.replace('T', ' ')}'`,
    STOP_TIME: `'${STOP.replace('T', ' ')}'`,
    STEP_SIZE: `'${STEP}'`,
    QUANTITIES: "'4'",
    CAL_FORMAT: 'CAL',
    ANG_FORMAT: 'DEG',
    EXTRA_PREC: 'YES',
  });
  const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (/ERROR/i.test(text.slice(0, 800))) throw new Error('Horizons error payload');
  const samples = parseHorizonsTable(text);
  return {
    schemaVersion: '1.0',
    body,
    siteId: site.siteId,
    observer: {
      latitudeDeg: site.latitudeDeg,
      longitudeEastDeg: site.longitudeEastDeg,
      altitudeKm: site.altitudeKm,
    },
    stepHours: 1,
    source: 'jpl_horizons',
    samples,
    generatedAtUtc: new Date().toISOString(),
    notes: [
      'Precomputed from JPL Horizons observer quantities 4 (az/el).',
      'Airless; no refraction.',
      `Coverage ${START}Z → ${STOP}Z.`,
    ],
  };
}

await mkdir(join(root, 'public/science/ephemeris'), { recursive: true });

for (const site of sites) {
  for (const body of ['sun', 'earth']) {
    let series;
    try {
      series = await fetchHorizons(body, site);
      console.log(`Horizons OK ${site.siteId} ${body} (${series.samples.length} samples)`);
    } catch (error) {
      console.warn(`Horizons failed ${site.siteId} ${body}: ${error.message} — analytic fallback`);
      series = analyticSeries(body, site);
    }
    const out = join(root, `public/science/ephemeris/${site.siteId}-${body}.json`);
    await writeFile(out, JSON.stringify(series));
    console.log(`wrote ${out}`);
  }
}
