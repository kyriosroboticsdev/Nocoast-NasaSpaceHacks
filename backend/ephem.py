"""Sun / Earth topocentric azimuth-elevation for a point on the Moon.

Skyfield + JPL DE421 + the NAIF lunar frame MOON_ME_DE421 (contract frameId), i.e. the same body-fixed
frame LOLA topography is published in. Azimuth is clockwise from local north; elevation is above the local
horizontal plane; ENU unit vectors are in the local East-North-Up basis (contract localVectorBasis).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from functools import lru_cache

import numpy as np
from skyfield.api import Loader, PlanetaryConstants

from .config import DATA, EARTH_RADIUS_KM, FRAME_ID, SUN_RADIUS_KM


@lru_cache(maxsize=1)
def _bodies():
    load = Loader(str(DATA), verbose=False)
    ts = load.timescale(builtin=True)
    eph = load("de421.bsp")
    pc = PlanetaryConstants()
    pc.read_text(load("moon_080317.tf"))
    pc.read_text(load("pck00010.tpc"))
    pc.read_binary(load("moon_pa_de421_1900-2050.bpc"))
    frame = pc.build_frame_named(FRAME_ID)
    return ts, eph, pc, frame


def time_grid(start: datetime, end: datetime, step_s: float) -> list[datetime]:
    """Start-inclusive, end-exclusive grid."""
    n = int(np.ceil((end - start).total_seconds() / step_s))
    return [start + timedelta(seconds=step_s * i) for i in range(n)]


def sun_earth(lat: float, lon: float, times: list[datetime]) -> dict[str, np.ndarray]:
    """Az/el (deg), angular radius (deg), distance (km) and ENU unit vectors of Sun and Earth from (lat, lon)."""
    ts, eph, pc, frame = _bodies()
    t = ts.from_datetimes(times)
    site = eph["moon"] + pc.build_latlon_degrees(frame, lat, lon)
    out: dict[str, np.ndarray] = {}
    for key, body, radius_km in (("sun", eph["sun"], SUN_RADIUS_KM), ("earth", eph["earth"], EARTH_RADIUS_KM)):
        alt, az, dist = site.at(t).observe(body).apparent().altaz()
        el, a = alt.radians, az.radians
        out[f"{key}_el"] = alt.degrees
        out[f"{key}_az"] = az.degrees % 360.0
        out[f"{key}_dist_km"] = dist.km
        out[f"{key}_r"] = np.degrees(np.arcsin(radius_km / dist.km))
        out[f"{key}_enu"] = np.stack([np.cos(el) * np.sin(a), np.cos(el) * np.cos(a), np.sin(el)], axis=-1)
    return out


# Backwards-compatible name used by tests.
def sun_earth_altaz(lat: float, lon: float, times: list[datetime]) -> dict[str, np.ndarray]:
    return sun_earth(lat, lon, times)
