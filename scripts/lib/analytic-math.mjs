/**
 * Shared analytic selenographic → topocentric math for Node precompute scripts.
 * Keep formulas in sync with src/ephemeris/analytic.ts.
 * Calibrated against bundled JPL Horizons for CR1 Jan 2027 (Sun az ≤~1°, el ≤~0.1°).
 * Illustrative elsewhere — always badge as analytic, not JPL.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function wrap360(deg) {
  return ((deg % 360) + 360) % 360;
}

export function wrap180(deg) {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

/**
 * Approximate Sun direction in mean lunar body-fixed frame.
 * Synodic longitude decreases in the Moon-fixed frame (~360°/29.530589 d).
 * Solar latitude uses the ~346.6 d nodical period (±~1.54° obliquity).
 */
export function sunSelenographic(utcMs) {
  const day = utcMs / 86400000;
  const synodic = 360 / 29.530588853;
  // Epoch/lon0 fit to bundled CR1 Horizons (Jan 2027); sign must be negative.
  const lonDeg = wrap360(32.5 - synodic * (day - 20897));
  const latDeg = 1.6 * Math.sin((2 * Math.PI * (day - 20858.5)) / 346.6);
  return { lonDeg, latDeg };
}

/**
 * Approximate mean-Earth direction with optical libration (simplified).
 */
export function earthSelenographic(utcMs) {
  const day = utcMs / 86400000;
  const epoch = 20896;
  const D = (day - epoch) * (360 / 27.321661);
  const F = (day - epoch) * (360 / 27.212221);
  const lonDeg = wrap180(-1 + 6.9 * Math.sin(D * DEG) + 1.2 * Math.sin(2 * D * DEG));
  const latDeg = 6.9 * Math.sin(F * DEG) + 0.7 * Math.sin((F + D) * DEG);
  return { lonDeg, latDeg };
}

/** Convert body selenographic lon/lat to topocentric az/el at a surface site. */
export function bodyAzEl(siteLatDeg, siteLonEastDeg, bodyLonDeg, bodyLatDeg) {
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

export function analyticSunAzEl(utcIso, latDeg, lonEastDeg) {
  const { lonDeg, latDeg: bodyLat } = sunSelenographic(Date.parse(utcIso));
  return bodyAzEl(latDeg, lonEastDeg, lonDeg, bodyLat);
}

export function analyticEarthAzEl(utcIso, latDeg, lonEastDeg) {
  const { lonDeg, latDeg: bodyLat } = earthSelenographic(Date.parse(utcIso));
  return bodyAzEl(latDeg, lonEastDeg, lonDeg, bodyLat);
}
