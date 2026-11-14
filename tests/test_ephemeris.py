"""Ephemeris regression vs JPL Horizons (independent of our SPICE/Skyfield chain)."""
from datetime import UTC, datetime

import numpy as np
import pytest

from backend.ephem import sun_earth

T0 = datetime(2026, 12, 1, tzinfo=UTC)

# JPL Horizons, observer coord@301 (geodetic lon,lat,0), APPARENT=AIRLESS, QUANTITIES=4, 2026-12-01 00:00 UTC
HORIZONS = [
    # lat, lon, sun_az, sun_el, earth_az, earth_el
    (26.1322, 3.6339, 265.834283, 5.117023, 172.792102, 64.930078),
    (-89.9, 0.0, 280.061257, 1.487607, 6.669263, -1.510879),
    (-69.373, 32.319, 248.557252, -6.278795, 333.065396, 16.934495),
]


@pytest.mark.parametrize(("lat", "lon", "saz", "sel", "eaz", "eel"), HORIZONS)
def test_matches_horizons(lat, lon, saz, sel, eaz, eel):
    r = sun_earth(lat, lon, [T0])
    tol = 0.01  # deg; observed agreement ~1e-4 deg. Not a physical accuracy claim (contract: null).
    assert abs(r["sun_az"][0] - saz) < tol and abs(r["sun_el"][0] - sel) < tol
    assert abs(r["earth_az"][0] - eaz) < tol and abs(r["earth_el"][0] - eel) < tol


def test_enu_vectors_consistent_with_azel():
    r = sun_earth(-89.4555, 222.6192, [T0])
    e, n, u = r["earth_enu"][0]
    assert np.isclose(np.hypot(e, n), np.cos(np.radians(r["earth_el"][0])))
    assert np.isclose(np.degrees(np.arctan2(e, n)) % 360, r["earth_az"][0])
    assert np.isclose(np.degrees(np.arcsin(u)), r["earth_el"][0])
