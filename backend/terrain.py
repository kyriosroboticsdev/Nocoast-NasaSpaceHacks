"""Terrain heights and 360-degree horizon profiles per the team contract (horizon section).

Sources, all spherical polar stereographic about the south pole (R = 1737.4 km):
    rho = 2R tan(pi/4 + lat/2),  x = rho sin(lon),  y = rho cos(lon)
  * PGDA 5 m site tiles (GeoTIFF float32, pixel-is-area)  -> 0-5 km band
  * LOLA LDEM_80S_80M  (PDS IMG int16 * 0.5 m)              -> 5-100 km band
  * LOLA LDEM_75S_240M (PDS IMG int16 * 0.5 m)              -> 100-400 km band
Verified: the 5 m bilinear height at CR1 / SR1 reproduces the contract's surfaceElevationM exactly.

If a band's designated source has no data at a sample, the next coarser source is used and the profile is
flagged terrainQuality="fallback" (contract: fallback profiles are excluded from terrain ranking).
A horizon profile produced by the terrain module (Person 1) can be loaded with load_profile().
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from .config import CONTRACT, DATA, HORIZON, LDEMS, MOON_R_M, OBSERVER_HEIGHT_M, PGDA_TILES, SCHEMA_VERSION

AZ_START = float(HORIZON["azimuthStartDeg"])
AZ_STEP = float(HORIZON["azimuthStepDeg"])
N_AZ = int(HORIZON["sampleCount"])
AZIMUTHS = AZ_START + AZ_STEP * np.arange(N_AZ)
CACHE_DIR = DATA / "horizon_cache"


def _xy(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    rho = 2.0 * MOON_R_M * np.tan(np.pi / 4 + la / 2)
    return rho * np.sin(lo), rho * np.cos(lo)


def _bilinear(d: np.ndarray, row: np.ndarray, col: np.ndarray, valid: np.ndarray, scale: float) -> np.ndarray:
    r = np.where(valid, row, 0.0)
    c = np.where(valid, col, 0.0)
    r0, c0 = np.floor(r).astype(np.intp), np.floor(c).astype(np.intp)
    fr, fc = r - r0, c - c0
    h = ((d[r0, c0] * (1 - fc) + d[r0, c0 + 1] * fc) * (1 - fr)
         + (d[r0 + 1, c0] * (1 - fc) + d[r0 + 1, c0 + 1] * fc) * fr) * scale
    return np.where(valid, h, np.nan)


class Ldem:
    """PDS polar LDEM (int16 DN, height = DN * 0.5 m)."""

    def __init__(self, name: str):
        _url, n, scale, offset, max_lat = LDEMS[name]
        self.name, self.n, self.pixel_m, self.offset, self.max_lat = name, n, scale, offset, max_lat
        self.data = np.fromfile(DATA / name, dtype="<i2").reshape(n, n)

    def height(self, lat, lon):
        x, y = _xy(lat, lon)
        col = self.offset + x / self.pixel_m
        row = self.offset - y / self.pixel_m
        ok = (lat <= self.max_lat) & (col >= 0) & (row >= 0) & (col < self.n - 1) & (row < self.n - 1)
        return _bilinear(self.data, row, col, ok, 0.5)


class PgdaTile:
    """PGDA 5 m GeoTIFF tile (float32 heights in m, NaN = no data, pixel-is-area)."""

    def __init__(self, path: Path):
        import tifffile

        with tifffile.TiffFile(path) as t:
            page = t.pages[0]
            self.data = page.asarray().astype(np.float32)
            self.pixel_m = float(page.tags["ModelPixelScaleTag"].value[0])
            tp = page.tags["ModelTiepointTag"].value
        self.x0, self.y0 = float(tp[3]), float(tp[4])   # upper-left corner of the upper-left pixel
        self.name = path.name
        self.rows, self.cols = self.data.shape

    def height(self, lat, lon):
        x, y = _xy(lat, lon)
        col = (x - self.x0) / self.pixel_m - 0.5
        row = (self.y0 - y) / self.pixel_m - 0.5
        ok = (col >= 0) & (row >= 0) & (col < self.cols - 1) & (row < self.rows - 1)
        return _bilinear(self.data, row, col, ok, 1.0)


@lru_cache(maxsize=1)
def sources() -> dict[float, list]:
    """pixel scale (m) -> list of sources with that scale."""
    out: dict[float, list] = {}
    for url in PGDA_TILES.values():
        p = DATA / url.rsplit("/", 1)[1]
        if p.exists():
            out.setdefault(5.0, []).append(PgdaTile(p))
    for name in LDEMS:
        g = Ldem(name)
        out.setdefault(g.pixel_m, []).append(g)
    return out


def _height_from(scale: float, lat, lon) -> np.ndarray:
    h = np.full(np.shape(lat), np.nan)
    for src in sources().get(scale, []):
        miss = np.isnan(h)
        if not miss.any():
            break
        h[miss] = src.height(lat[miss], lon[miss])
    return h


def height_with_fallback(scale: float, lat, lon) -> tuple[np.ndarray, np.ndarray]:
    """Heights from the designated scale, falling back to coarser scales. Returns (h, used_fallback)."""
    lat, lon = np.broadcast_arrays(np.asarray(lat, float), np.asarray(lon, float))
    h = _height_from(scale, lat, lon)
    fb = np.zeros(h.shape, bool)
    for coarser in sorted(s for s in sources() if s > scale):
        miss = np.isnan(h)
        if not miss.any():
            break
        h2 = np.full(h.shape, np.nan)
        h2[miss] = _height_from(coarser, lat[miss], lon[miss])
        fill = miss & ~np.isnan(h2)
        h[fill], fb[fill] = h2[fill], True
    return h, fb


def site_height(lat: float, lon: float) -> tuple[float | None, str | None]:
    for scale in sorted(sources()):
        h = float(_height_from(scale, np.array([lat]), np.array([lon]))[0])
        if not np.isnan(h):
            return h, f"bilinear-{scale:g}m-{'PGDA' if scale == 5 else 'LOLA-LDEM'}-DEM"
    return None, None


MIN_RAY_DISTANCE_M = 5.0   # project decision: one 5 m DEM pixel; the DEM cannot resolve terrain closer than that


# Project decision: ray step = pixelScaleM / subdivision. Near the observer the elevation angle (dh/d) changes
# quickly with d, so the 5 m band samples the bilinear surface every 0.625 m. With this setting, halving every
# step changes no CR1/SR1 horizon sample by more than 0.025 deg (contract numericalConvergenceTargetDeg = 0.05);
# see tests/test_terrain.py::test_horizon_convergence.
RAY_SUBDIVISION = (8, 1, 1)


def _band_ranges(step_factor: float = 1.0) -> list[tuple[np.ndarray, float]]:
    """Ray sample distances per band. step_factor < 1 refines all bands (nested) for convergence tests."""
    out = []
    for b, sub in zip(HORIZON["distanceBands"], RAY_SUBDIVISION, strict=True):
        scale = float(b["pixelScaleM"])
        step = scale * step_factor / sub
        lo = max(float(b["startM"]), MIN_RAY_DISTANCE_M)
        hi = min(float(b["endM"]), float(HORIZON["maxRayDistanceM"]))
        first = np.ceil(lo / step) * step
        d = np.arange(first, hi + 0.5 * step, step)
        d = d[(d > float(b["startM"]) - 1e-9) & (d <= hi)] if b["startM"] > 0 else d[d <= hi]
        out.append((d, scale))
    return out


def compute_profile(lat: float, lon: float, step_factor: float = 1.0) -> dict:
    """Horizon elevation (deg) at the contract's 1440 azimuths. step_factor<1 is for convergence tests."""
    h0, h0_method = site_height(lat, lon)
    base = {"source": "computed", "azimuthStartDeg": AZ_START, "azimuthStepDeg": AZ_STEP, "sampleCount": N_AZ,
            "siteElevationM": h0, "siteElevationMethod": h0_method,
            "observerHeightAboveGroundM": OBSERVER_HEIGHT_M}
    if h0 is None:
        return {**base, "terrainQuality": "none", "fallbackSampleFraction": None, "missingSampleFraction": None,
                "elevationDeg": [None] * N_AZ}

    phi, lam = np.radians(lat), np.radians(lon)
    up = np.array([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])
    east = np.array([-np.sin(lam), np.cos(lam), 0.0])
    north = np.cross(up, east)
    r0 = MOON_R_M + h0 + OBSERVER_HEIGHT_M

    best = np.full(N_AZ, -np.inf)
    any_data = np.zeros(N_AZ, bool)
    n_total = n_fb = n_missing = 0
    for d_band, scale in _band_ranges(step_factor):
        for a0 in range(0, N_AZ, 180):                      # chunk azimuths to bound memory
            th = np.radians(AZIMUTHS[a0:a0 + 180])[:, None]
            delta = (d_band / MOON_R_M)[None, :]
            dirs = np.cos(th)[..., None] * north + np.sin(th)[..., None] * east
            p = np.cos(delta)[..., None] * up + np.sin(delta)[..., None] * dirs
            lat2 = np.degrees(np.arcsin(np.clip(p[..., 2], -1, 1)))
            lon2 = np.degrees(np.arctan2(p[..., 1], p[..., 0]))
            h1, fb = height_with_fallback(scale, lat2, lon2)
            r1 = MOON_R_M + h1
            el = np.degrees(np.arctan2(r1 * np.cos(delta) - r0, r1 * np.sin(delta)))
            ok = ~np.isnan(el)
            best[a0:a0 + 180] = np.maximum(best[a0:a0 + 180], np.where(ok, el, -np.inf).max(axis=1))
            any_data[a0:a0 + 180] |= ok.any(axis=1)
            n_total += el.size
            n_fb += int(fb.sum())
            n_missing += int((~ok).sum())
    elev = [round(float(v), 5) if a else None for v, a in zip(best, any_data, strict=True)]
    quality = "contract" if n_fb == 0 and n_missing == 0 else "fallback"
    return {**base, "terrainQuality": quality, "fallbackSampleFraction": n_fb / n_total,
            "missingSampleFraction": n_missing / n_total, "elevationDeg": elev}


def horizon_profile(lat: float, lon: float) -> dict:
    """Cached (memory + disk) computed profile."""
    return _profile_cached(round(lat, 6), round(lon % 360.0, 6))


@lru_cache(maxsize=64)
def _profile_cached(lat: float, lon: float) -> dict:
    key = hashlib.sha1(json.dumps([SCHEMA_VERSION, CONTRACT["horizon"], CONTRACT["observerHeightAboveGroundM"],
                                   lat, lon, sorted(PGDA_TILES)]).encode()).hexdigest()[:16]
    path = CACHE_DIR / f"{key}.json"
    if path.exists():
        return json.loads(path.read_text())
    prof = compute_profile(lat, lon)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(prof))
    return prof


def load_profile(path: Path) -> dict:
    """Load a horizon profile from another module (e.g. Person 1's terrain pipeline) and validate the grid."""
    prof = json.loads(Path(path).read_text())
    if (prof.get("sampleCount") != N_AZ or float(prof.get("azimuthStepDeg")) != AZ_STEP
            or float(prof.get("azimuthStartDeg")) != AZ_START or len(prof.get("elevationDeg", [])) != N_AZ):
        raise ValueError(f"{path}: horizon grid does not match contract ({N_AZ} samples, {AZ_STEP} deg step)")
    prof.setdefault("source", f"file:{Path(path).name}")
    prof.setdefault("terrainQuality", "contract")
    return prof


def mask_at(elevation_deg: list, az_deg: np.ndarray) -> np.ndarray:
    """Linear interpolation between profile samples (wraps 360). NaN if either neighbour is missing."""
    m = np.array([np.nan if v is None else v for v in elevation_deg], float)
    x = np.concatenate([AZIMUTHS, [AZ_START + 360.0]])
    y = np.concatenate([m, m[:1]])
    a = np.mod(np.asarray(az_deg) - AZ_START, 360.0) + AZ_START
    i = np.clip(np.searchsorted(x, a, side="right") - 1, 0, N_AZ - 1)
    f = (a - x[i]) / AZ_STEP
    return y[i] * (1 - f) + y[i + 1] * f


@lru_cache(maxsize=16)
def local_grid(lat: float, lon: float, half_extent_m: float, n: int) -> dict:
    """Terrain around a site for 3D viewers: an n x n grid on the site's tangent plane (east x north, metres),
    giving each point's height above the site's local horizontal plane (Moon curvature included).

    Row j runs south->north and column i west->east, both from -half_extent_m to +half_extent_m. Heights come
    from the 5 m PGDA tiles where they exist, else the 80 m / 240 m LOLA maps; missing points are null.
    """
    from .ephem import enu_basis

    east, north, up = enu_basis(lat, lon)
    ax = np.linspace(-half_extent_m, half_extent_m, n)
    e, nn = np.meshgrid(ax, ax)
    d = np.hypot(e, nn)
    delta = d / MOON_R_M
    with np.errstate(invalid="ignore", divide="ignore"):
        de, dn = np.where(d > 0, e / d, 0.0), np.where(d > 0, nn / d, 0.0)
    p = (np.cos(delta)[..., None] * up
         + np.sin(delta)[..., None] * (de[..., None] * east + dn[..., None] * north))
    lat2 = np.degrees(np.arcsin(np.clip(p[..., 2], -1, 1)))
    lon2 = np.degrees(np.arctan2(p[..., 1], p[..., 0])) % 360.0
    h, fb = height_with_fallback(5.0, lat2, lon2)
    h0, _ = site_height(lat, lon)
    z = (MOON_R_M + h) * np.cos(delta) - (MOON_R_M + (h0 if h0 is not None else 0.0))
    ok = ~np.isnan(z)
    return {
        "latitudeDeg": lat, "longitudeEastDeg": lon, "halfExtentM": half_extent_m, "n": n,
        "siteElevationM": h0,
        "heightsM": [None if not k else round(float(v), 2) for v, k in zip(z.ravel(), ok.ravel(), strict=True)],
        "fine5mFraction": float(np.mean(ok & ~fb)), "missingFraction": float(np.mean(~ok)),
        "rowOrder": "south-to-north", "columnOrder": "west-to-east",
    }
