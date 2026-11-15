"""Production twin of the Vite dev middleware in vite.config.mjs (`elevationWindow`).

Serves 257x257 float32 little-endian height windows sampled from the NASA PGDA LOLA 5 m/px south-polar
mosaic, so the deployed site (Azure Static Web Apps -> /api/* -> this backend) gets the same detailed
terrain the dev server gives locally. Same validation, same sampling (every `stride`-th pixel of the
full-resolution window), same output bytes.

The 40000x40000 mosaic (2.5 GB BigTIFF, 256 px deflate tiles) is never downloaded whole: tifffile parses
its directory over HTTP range requests and only the tiles a window touches are fetched and decoded, one
plain range request each (like geotiff.js `maxRanges: 0` in the dev server; GDAL /vsicurl/ produced
corrupt reads against this server). Finished windows are cached on local disk and, when configured, in
the Azure Blob cache (backend/azure_cache.py), so container cold starts don't re-read NASA.
"""
from __future__ import annotations

import io
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np

from . import azure_cache
from .config import ROOT

MOSAIC_URL = "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/ldem_87s_5mpp.tif"
LOCAL_MOSAIC = ROOT / ".cache" / "polar-full.tif"
WINDOW_CACHE = ROOT / ".cache" / "polar-windows"
SIZE = 257
MOSAIC_PX = 40000
STRIDES = (1, 2, 4, 8)

# Mirrors the dev server's "at most 2 concurrent reads" guard (503 when busy).
_slots = threading.BoundedSemaphore(2)
_open_lock = threading.Lock()


class InvalidWindow(ValueError):
    pass


class Busy(RuntimeError):
    pass


def validate(column: int, row: int, stride: int) -> None:
    extent = (SIZE - 1) * stride + 1
    if stride not in STRIDES or column < 0 or row < 0 or column + extent > MOSAIC_PX or row + extent > MOSAIC_PX:
        raise InvalidWindow("Invalid terrain window")


def _fetch(url: str, offset: int, length: int) -> bytes:
    req = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{offset + length - 1}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        if r.status != 206:
            raise OSError(f"server ignored range request (HTTP {r.status})")
        data = r.read()
    if len(data) != length:
        raise OSError("short range read")
    return data


class _HttpRangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests (just enough for tifffile's header parse)."""

    def __init__(self, url: str):
        self.url, self.pos = url, 0
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30) as r:
            self.size = int(r.headers["Content-Length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, buf):
        n = min(len(buf), self.size - self.pos)
        if n <= 0:
            return 0
        data = _fetch(self.url, self.pos, n)
        buf[:n] = data
        self.pos += n
        return n


@lru_cache(maxsize=1)
def _page():
    """(first IFD page, file handle, url-or-None). Validated like the dev server's openMosaic()."""
    import tifffile

    if LOCAL_MOSAIC.exists():
        fh, url = open(LOCAL_MOSAIC, "rb"), None
    else:
        fh, url = io.BufferedReader(_HttpRangeFile(MOSAIC_URL), 1 << 16), MOSAIC_URL
    page = tifffile.TiffFile(fh).pages[0]
    tie = tuple(page.tags["ModelTiepointTag"].value[3:5])
    scale = tuple(page.tags["ModelPixelScaleTag"].value[:2])
    if page.shape != (MOSAIC_PX, MOSAIC_PX) or not page.is_tiled or page.dtype != np.float32 \
            or tie != (-100000, 100000) or scale != (5, 5):
        raise RuntimeError("Unexpected projection or dimensions for the polar mosaic")
    return page, fh, url


def _read(column: int, row: int, stride: int) -> bytes:
    with _open_lock:
        page, fh, url = _page()
    th, tw = page.tilelength, page.tilewidth
    tiles_across = -(-MOSAIC_PX // tw)
    extent = (SIZE - 1) * stride + 1
    out = np.empty((extent, extent), dtype=np.float32)
    tiles = [(ty, tx) for ty in range(row // th, (row + extent - 1) // th + 1)
             for tx in range(column // tw, (column + extent - 1) // tw + 1)]

    def load(tile_yx):
        ty, tx = tile_yx
        index = ty * tiles_across + tx
        offset, count = int(page.dataoffsets[index]), int(page.databytecounts[index])
        if url:
            raw = _fetch(url, offset, count)
        else:
            with _open_lock:
                fh.seek(offset)
                raw = fh.read(count)
        tile = page.decode(raw, index)[0].reshape(th, tw)
        y0, x0 = ty * th, tx * tw
        ys, xs = max(row, y0), max(column, x0)
        ye, xe = min(row + extent, y0 + th), min(column + extent, x0 + tw)
        out[ys - row:ye - row, xs - column:xe - column] = tile[ys - y0:ye - y0, xs - x0:xe - x0]

    # Up to 81 tiles for a stride-8 window; fetch them concurrently (each is its own range request).
    with ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(load, tiles))
    return np.ascontiguousarray(out[::stride, ::stride], dtype="<f4").tobytes()


def window_bytes(column: int, row: int, stride: int) -> tuple[bytes, str]:
    """Returns (257*257*4 bytes, source tag). Raises InvalidWindow / Busy."""
    validate(column, row, stride)
    name = f"{column}-{row}-{stride}.bin"
    path = WINDOW_CACHE / name
    expected = SIZE * SIZE * 4
    if path.exists() and path.stat().st_size == expected:
        return path.read_bytes(), "local-cache"
    if azure_cache.download_if_cached(f"polar-windows/{name}", path) and path.stat().st_size == expected:
        return path.read_bytes(), "blob-cache"
    if not _slots.acquire(blocking=False):
        raise Busy("Terrain reader busy")
    try:
        data = _read(column, row, stride)
    finally:
        _slots.release()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(path)
    azure_cache.upload(f"polar-windows/{name}", path)
    return data, "remote"
