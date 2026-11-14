/**
 * Analytic topocentric Sun/Earth for lunar surface (airless).
 * Intended as offline/demo fallback when bundled Horizons series or live API
 * are unavailable. Accuracy is illustrative (~1–3°) near the south pole —
 * prefer bundled JPL Horizons samples when present.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function wrap360(deg: number) {
  return ((deg % 360) + 360) % 360;
}

function wrap180(deg: number) {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

/** Julian centuries from J2000. */
function centuries(utcMs: number) {
  return (utcMs / 86400000 - 10957.5) / 36525;
}

/**
 * Approximate Sun direction in mean lunar body-fixed frame.
 * Uses a reduced selenographic solar longitude / latitude model driven by
 * the synodic month and the ~1.54° lunar obliquity to the ecliptic.
 */
function sunSelenographic(utcMs: number): { lonDeg: number; latDeg: number } {
  const T = centuries(utcMs);
  // Mean elongation / solar motion proxy in Moon-fixed frame (~360°/29.530589 d).
  const synodic = 360 / 29.530588853;
  const day = utcMs / 86400000;
  // Epoch chosen so Jan 2027 demo sits mid-range; calibrated for polar demos.
  const lonDeg = wrap360(124.2 + synodic * (day - 20897));
  // Solar latitude relative to lunar equator ~ ±1.54° with ~346.6 d and yearly terms.
  const latDeg = 1.54 * Math.sin((lonDeg + 12.5 * T) * DEG) + 0.15 * Math.sin((2 * lonDeg) * DEG);
  return { lonDeg, latDeg };
}

/**
 * Approximate mean-Earth direction with optical libration (simplified).
 */
function earthSelenographic(utcMs: number): { lonDeg: number; latDeg: number } {
  const day = utcMs / 86400000;
  const D = (day - 20897) * (360 / 27.321661); // anomalistic-ish
  const F = (day - 20897) * (360 / 27.212221);
  // Optical libration amplitudes (deg), reduced model.
  const lonDeg = wrap180(6.3 * Math.sin(D * DEG) + 1.2 * Math.sin(2 * D * DEG));
  const latDeg = 6.9 * Math.sin(F * DEG) + 0.7 * Math.sin((F + D) * DEG);
  return { lonDeg, latDeg };
}

/** Convert body selenographic lon/lat to topocentric az/el at a surface site. */
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

  // Unit vector to body in lunar MCF (mean Earth / polar).
  const bx = Math.cos(δ) * Math.cos(α);
  const by = Math.cos(δ) * Math.sin(α);
  const bz = Math.sin(δ);

  // Local ENU basis at site (east, north, up) in same MCF.
  const ux = Math.cos(φ) * Math.cos(λ);
  const uy = Math.cos(φ) * Math.sin(λ);
  const uz = Math.sin(φ);
  const east = [-Math.sin(λ), Math.cos(λ), 0];
  const north = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
  const up = [ux, uy, uz];

  const e = east[0] * bx + east[1] * by + east[2] * bz;
  const n = north[0] * bx + north[1] * by + north[2] * bz;
  const u = up[0] * bx + up[1] * by + up[2] * bz;

  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, u))) * RAD;
  const azimuthDeg = wrap360(Math.atan2(e, n) * RAD);
  return { azimuthDeg, elevationDeg };
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
  const n = Math.max(1, Math.round(hours / stepHours));
  for (let i = 0; i <= n; i++) {
    const utc = new Date(start + i * stepHours * 3600_000).toISOString();
    const ae = body === 'sun'
      ? analyticSunAzEl(utc, latDeg, lonEastDeg)
      : analyticEarthAzEl(utc, latDeg, lonEastDeg);
    samples.push({ utc, ...ae });
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
      'Prefer bundled Horizons series for curated sites when available.',
    ],
  };
}
