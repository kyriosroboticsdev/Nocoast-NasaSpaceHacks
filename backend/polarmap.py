"""Hillshaded south-polar basemap (PNG) rendered from the LOLA DEM, for click-to-pick sites."""
from __future__ import annotations

import struct
import zlib
from functools import lru_cache

import numpy as np

from . import terrain
from .config import DATA, MOON_R_M

SIZE_PX = 1000
HALF_EXTENT_M = 60_000.0            # map spans +/-60 km from the pole (covers both 5 m site tiles)
M_PER_PX = 2 * HALF_EXTENT_M / SIZE_PX
PNG_PATH = DATA / f"polar_map_{SIZE_PX}_{int(HALF_EXTENT_M // 1000)}km.png"


def meta() -> dict:
    return {"size_px": SIZE_PX, "half_extent_m": HALF_EXTENT_M, "m_per_px": M_PER_PX, "moon_r_m": MOON_R_M}


def _png_gray(img: np.ndarray) -> bytes:
    h, w = img.shape
    raw = b"".join(b"\x00" + img[r].tobytes() for r in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


@lru_cache(maxsize=1)
def png_bytes() -> bytes:
    if PNG_PATH.exists():
        return PNG_PATH.read_bytes()
    c = (np.arange(SIZE_PX) + 0.5 - SIZE_PX / 2) * M_PER_PX
    x, y = np.meshgrid(c, -c)                       # row 0 = +y (toward lon 0)
    rho = np.hypot(x, y)
    lat = np.degrees(2 * np.arctan(rho / (2 * MOON_R_M)) - np.pi / 2)
    lon = np.degrees(np.arctan2(x, y))
    h, _fb = terrain.height_with_fallback(80.0, lat, lon)
    h = np.where(np.isnan(h), np.nanmean(h), h)
    gy, gx = np.gradient(h, M_PER_PX)
    # sun from upper-left, 30 deg up; mild vertical exaggeration so craters read clearly
    az, alt, ex = np.radians(315), np.radians(30), 2.0
    slope = np.arctan(ex * np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    elev = (h - np.percentile(h, 1)) / (np.percentile(h, 99) - np.percentile(h, 1))
    img = np.clip(0.75 * np.clip(shade, 0, 1) + 0.25 * np.clip(elev, 0, 1), 0, 1)
    data = _png_gray((img * 255).astype(np.uint8))
    PNG_PATH.write_bytes(data)
    return data
