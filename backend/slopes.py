"""Local 5 m DEM steepness, measured from the radial up at each sample.

This is a terrain screening product, not a landing-safety or roughness model.
Fine mode uses PGDA 5 m tiles. Auto mode can use native 80/240 m grids, explicitly labeled.
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np

from . import terrain
from .config import FRAME_ID, MOON_R_M
from .ephem import enu_basis

MODEL_ID = "pgda-5m-central-normal-radial-up-v1"


def grid_directions(half_extent_m: float, n: int, pixel_m: float = 5) -> np.ndarray:
    """Unit radial directions in the center's ENU frame; rows south to north."""
    if not np.isfinite(half_extent_m) or not 100 <= half_extent_m <= 2000:
        raise ValueError("halfExtentM must be between 100 and 2000 metres")
    if not isinstance(n, int) or n < (17 if pixel_m == 5 else 3) or n > 401 or n % 2 == 0:
        raise ValueError("n must be an odd integer between 17 and 401")
    spacing = 2 * half_extent_m / (n - 1)
    if spacing < pixel_m:
        raise ValueError("grid spacing must be at least the 5 m DEM pixel spacing")
    ax = np.linspace(-half_extent_m, half_extent_m, n)
    east, north = np.meshgrid(ax, ax)
    distance = np.hypot(east, north)
    # sin(d/R)/d -> 1/R at the center; np.sinc uses sin(pi*x)/(pi*x).
    factor = np.sinc(distance / (np.pi * MOON_R_M)) / MOON_R_M
    return np.stack([east * factor, north * factor, np.cos(distance / MOON_R_M)], axis=-1)


def slope_degrees(elevation_m: np.ndarray, radial_directions: np.ndarray) -> np.ndarray:
    """Centered cardinal-neighbor surface normal relative to each cell's radial up.

    A center and all four neighboring DEM heights must be finite. Edges and gaps
    stay NaN. There is no one-sided filling, elevation exaggeration or shadow input.
    """
    h = np.asarray(elevation_m, dtype=float)
    p = np.asarray(radial_directions, dtype=float)
    if h.ndim != 2 or min(h.shape) < 3 or p.shape != (*h.shape, 3):
        raise ValueError("elevations and radial directions must form matching 2D grids")
    if not np.all(np.isfinite(p)) or not np.allclose(np.linalg.norm(p, axis=-1), 1, atol=1e-12, rtol=0):
        raise ValueError("radial directions must be finite unit vectors")
    xyz = (MOON_R_M + h)[..., None] * p
    east = xyz[1:-1, 2:] - xyz[1:-1, :-2]
    north = xyz[2:, 1:-1] - xyz[:-2, 1:-1]
    normal = np.cross(east, north)
    up = p[1:-1, 1:-1]
    valid = (np.isfinite(h[1:-1, 1:-1]) & np.isfinite(h[1:-1, 2:])
             & np.isfinite(h[1:-1, :-2]) & np.isfinite(h[2:, 1:-1]) & np.isfinite(h[:-2, 1:-1])
             & (np.linalg.norm(normal, axis=-1) > 0))
    angle = np.degrees(np.arctan2(np.linalg.norm(np.cross(normal, up), axis=-1),
                                  np.abs(np.sum(normal * up, axis=-1))))
    out = np.full(h.shape, np.nan)
    out[1:-1, 1:-1] = np.where(valid, angle, np.nan)
    return out


@lru_cache(maxsize=16)
def local_slope_grid(lat: float, lon: float, half_extent_m: float = 620, n: int = 249,
                     resolution: str = "fine") -> dict:
    if not np.isfinite(lat) or not -90 <= lat <= -60 or not np.isfinite(lon):
        raise ValueError("site must have finite coordinates in the south polar region")
    lon %= 360
    if resolution not in ("auto", "fine"):
        raise ValueError("resolution must be auto or fine")
    grid_directions(half_extent_m, n)  # Validate the requested fine grid before adapting its spacing.

    def sample(scale, count):
        directions = grid_directions(half_extent_m, count, scale)
        moon_dirs = directions @ enu_basis(lat, lon)
        latitudes = np.degrees(np.arcsin(np.clip(moon_dirs[..., 2], -1, 1)))
        longitudes = np.degrees(np.arctan2(moon_dirs[..., 1], moon_dirs[..., 0])) % 360
        heights = np.full((count, count), np.nan)
        owners = np.full((count, count), -1, dtype=np.int16)
        used_sources = []
        for source_id, source in enumerate(terrain.sources().get(scale, [])):
            missing = ~np.isfinite(heights)
            if not missing.any():
                break
            sampled = source.height(latitudes[missing], longitudes[missing])
            if np.isfinite(sampled).any():
                used_sources.append(source.name)
            heights[missing] = sampled
            owners[missing] = np.where(np.isfinite(sampled), source_id, -1)
        return directions, heights, owners, used_sources

    pixel_m = 5
    directions, heights, owners, used_sources = sample(pixel_m, n)
    fine_fraction = float(np.isfinite(heights).mean())
    if resolution == "auto" and fine_fraction < .9:
        best_coverage = fine_fraction
        for scale in (80, 240):
            count = min(n, int(2 * half_extent_m // scale) + 1)
            if count % 2 == 0:
                count -= 1
            if count < 3:
                continue  # Window is too small to support a slope at this native resolution.
            candidate = sample(scale, count)
            coverage = float(np.isfinite(candidate[1]).mean())
            if coverage > best_coverage:
                pixel_m, n = scale, count
                directions, heights, owners, used_sources = candidate
                best_coverage = coverage
            if coverage >= .9:
                break
    slopes = slope_degrees(heights, directions)
    # Independently adjusted overlapping DEM tiles can have elevation offsets.
    # Never turn their stitch boundary into a spurious terrain slope.
    center = owners[1:-1, 1:-1]
    same_source = ((center >= 0) & (center == owners[1:-1, 2:]) & (center == owners[1:-1, :-2])
                   & (center == owners[2:, 1:-1]) & (center == owners[:-2, 1:-1]))
    slopes[1:-1, 1:-1] = np.where(same_source, slopes[1:-1, 1:-1], np.nan)
    known = np.isfinite(slopes)
    mid = n // 2
    spacing = 2 * half_extent_m / (n - 1)
    return {
        "schemaVersion": "1.0", "artifactType": "terrain-slope-grid",
        "modelId": MODEL_ID if pixel_m == 5 else "lola-dem-central-normal-radial-up-v1",
        "frameId": FRAME_ID, "referenceRadiusM": MOON_R_M,
        "latitudeDeg": lat, "longitudeEastDeg": lon,
        "halfExtentM": half_extent_m, "n": n, "gridSpacingM": spacing,
        "demPixelSpacingM": pixel_m, "resolutionMode": resolution, "gradientBaselineM": 2 * spacing,
        "rowOrder": "south-to-north", "columnOrder": "west-to-east",
        "slopeDeg": [
            round(float(v), 4) if k else None for v, k in zip(slopes.ravel(), known.ravel(), strict=True)
        ],
        "knownFraction": float(known.mean()), "fineElevationFraction": fine_fraction,
        "centerSlopeDeg": round(float(slopes[mid, mid]), 4) if known[mid, mid] else None,
        "sources": used_sources, "validationStatus": "preliminary",
        "notes": [
            "Slope is relative to local radial up; lunar curvature is included in geometry, "
            "not treated as terrain slope.",
            "Centered differences use the center and four neighboring heights; edges and missing stencils are null.",
            "Stencils crossing between separate DEM tiles are null to avoid artificial slopes from tile offsets.",
            "Each grid uses one DEM resolution; coarse estimates are never presented as 5 m slopes.",
            "DEM pixel spacing is not obstacle resolution. No uncertainty propagation or landing safety certification.",
        ],
    }
