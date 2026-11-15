/**
 * Analytic topocentric Sun/Earth for lunar surface (airless).
 * Offline/demo fallback when bundled Horizons or live API are unavailable.
 * Calibrated near the south pole against bundled JPL (Jan 2027 CR1: Sun az typically
 * within ~1°). Still badge as analytic — not a substitute for Horizons elsewhere.
 * Keep in sync with scripts/lib/analytic-math.mjs (used by fetch-horizons).
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function wrap360(deg: number) {
  return ((deg % 360) + 360) % 360;
}

function wrap180(deg: number) {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

function sunSelenographic(utcMs: number): { lonDeg: number; latDeg: number } {
  const day = utcMs / 86400000;
  const synodic = 360 / 29.530588853;
  // Epoch/lon0 fit to bundled CR1 Horizons (Jan 2027); synodic sign must be negative.
  const lonDeg = wrap360(32.5 - synodic * (day - 20897));
  const latDeg = 1.6 * Math.sin((2 * Math.PI * (day - 20858.5)) / 346.6);
  return { lonDeg, latDeg };
}

function earthSelenographic(utcMs: number): { lonDeg: number; latDeg: number } {
  const day = utcMs / 86400000;
  const epoch = 20896;
  const D = (day - epoch) * (360 / 27.321661);
  const F = (day - epoch) * (360 / 27.212221);
  const lonDeg = wrap180(-1 + 6.9 * Math.sin(D * DEG) + 1.2 * Math.sin(2 * D * DEG));
  const latDeg = 6.9 * Math.sin(F * DEG) + 0.7 * Math.sin((F + D) * DEG);
  return { lonDeg, latDeg };
}

function bodyAzEl(
  siteLatDeg: number,
  siteLonEastDeg: number,
  bodyLonDeg: number,
  bodyLatDeg: number,
): { azimuthDeg: number; elevationDeg: number } {
  const φ = siteLatDeg * DEG;
  const λ = siteLonEastDeg * DEG;
  const δ = bodyLatDeg * DEG;
  const α = bodyLonDeg * DEG;

  const bx = Math.cos(δ) * Math.cos(α);
  const by = Math.cos(δ) * Math.sin(α);
  const bz = Math.sin(δ);

  const east = [-Math.sin(λ), Math.cos(λ), 0];
  const north = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
  const up = [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];

  const e = east[0] * bx + east[1] * by + east[2] * bz;
  const n = north[0] * bx + north[1] * by + north[2] * bz;
  const u = up[0] * bx + up[1] * by + up[2] * bz;

  return {
    azimuthDeg: wrap360(Math.atan2(e, n) * RAD),
    elevationDeg: Math.asin(Math.max(-1, Math.min(1, u))) * RAD,
  };
}

export function analyticSunAzEl(utcIso: string, latDeg: number, lonEastDeg: number) {
  const { lonDeg, latDeg: bodyLat } = sunSelenographic(Date.parse(utcIso));
  return bodyAzEl(latDeg, lonEastDeg, lonDeg, bodyLat);
}

export function analyticEarthAzEl(utcIso: string, latDeg: number, lonEastDeg: number) {
  const { lonDeg, latDeg: bodyLat } = earthSelenographic(Date.parse(utcIso));
  return bodyAzEl(latDeg, lonEastDeg, lonDeg, bodyLat);
}

export function sampleAnalyticSeries(
  body: 'sun' | 'earth',
  siteId: string,
  latDeg: number,
  lonEastDeg: number,
  altitudeKm: number,
  startIso: string,
  hours: number,
  stepHours: number,
): import('./types').EphemerisSeries {
  const samples = [];
  const start = Date.parse(startIso);
  const end = start + Math.max(0, hours) * 3600_000;
  const stepMs = Math.max(1e-6, stepHours) * 3600_000;
  for (let t = start; t < end - 1e-6; t += stepMs) {
    const utc = new Date(t).toISOString();
    const ae = body === 'sun'
      ? analyticSunAzEl(utc, latDeg, lonEastDeg)
      : analyticEarthAzEl(utc, latDeg, lonEastDeg);
    samples.push({ utc, ...ae });
  }
  const endUtc = new Date(end).toISOString();
  if (!samples.length || samples[samples.length - 1].utc !== endUtc) {
    const ae = body === 'sun'
      ? analyticSunAzEl(endUtc, latDeg, lonEastDeg)
      : analyticEarthAzEl(endUtc, latDeg, lonEastDeg);
    samples.push({ utc: endUtc, ...ae });
  }
  return {
    schemaVersion: '1.0',
    body,
    siteId,
    observer: { latitudeDeg: latDeg, longitudeEastDeg: lonEastDeg, altitudeKm },
    stepHours,
    source: 'analytic_fallback',
    samples,
    generatedAtUtc: new Date().toISOString(),
    notes: [
      'Analytic lunar topocentric fallback (not JPL Horizons).',
      'Calibrated near south pole vs bundled Jan 2027 Horizons; badge provenance in UI.',
      'Prefer bundled Horizons series for curated sites when available.',
    ],
  };
}
