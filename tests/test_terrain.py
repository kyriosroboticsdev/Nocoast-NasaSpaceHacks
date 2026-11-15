"""Terrain sources and horizon profiles vs the team contract."""
import numpy as np
import pytest

from backend import terrain
from backend.config import HORIZON, SITES


@pytest.mark.parametrize("site", SITES, ids=lambda s: s["siteId"])
def test_surface_elevation_matches_contract(site):
    h, method = terrain.site_height(site["latitudeDeg"], site["longitudeEastDeg"])
    assert method == site["surfaceElevationMethod"]
    assert h == pytest.approx(site["surfaceElevationM"], abs=1e-6)


def test_ldem_orientation():
    h = lambda lat, lon: float(terrain.height_with_fallback(80.0, np.array([lat]), np.array([lon]))[0][0])  # noqa: E731
    assert h(-85.988, 2.053) > 5000      # Malapert massif
    assert h(-89.67, 129.8) < -2000      # Shackleton floor
    assert h(-87.45, 356.0) < -3000      # Haworth floor


# Real LOLA coverage, not every candidate site: these two sit on prominent massifs/plateaus where the
# 80-400 km bands have a handful of genuinely sparse laser-return samples (<1% of all ray samples,
# never enough to blank out any azimuth's own elevation — see `None not in elevationDeg` below). The
# contract's "contract" quality requires zero gaps anywhere in the full ray-cast, so these two
# correctly land on "fallback" and are excluded from ranking (contract `allowFallbackInTerrainRanking:
# false`) — an honest reflection of the real data, not something to force by moving the site.
KNOWN_FALLBACK_QUALITY_SITES = {"leibnitz-beta-plateau", "malapert-massif"}


@pytest.mark.parametrize("site", SITES, ids=lambda s: s["siteId"])
def test_profile_grid_and_quality(site):
    p = terrain.horizon_profile(site["latitudeDeg"], site["longitudeEastDeg"])
    assert p["sampleCount"] == HORIZON["sampleCount"] == len(p["elevationDeg"])
    assert p["azimuthStepDeg"] == HORIZON["azimuthStepDeg"]
    if site["siteId"] in KNOWN_FALLBACK_QUALITY_SITES:
        assert p["terrainQuality"] == "fallback"
        assert 0 < p["missingSampleFraction"] < 0.02
    else:
        assert p["terrainQuality"] == "contract"
        assert p["fallbackSampleFraction"] == 0 and p["missingSampleFraction"] == 0
    assert None not in p["elevationDeg"]


@pytest.mark.slow
@pytest.mark.parametrize("site", SITES, ids=lambda s: s["siteId"])
def test_horizon_convergence(site):
    a = np.array(terrain.compute_profile(site["latitudeDeg"], site["longitudeEastDeg"])["elevationDeg"])
    b = np.array(terrain.compute_profile(site["latitudeDeg"], site["longitudeEastDeg"], step_factor=0.5)
                 ["elevationDeg"])
    assert np.abs(a - b).max() <= HORIZON["numericalConvergenceTargetDeg"]


def test_outside_dem_is_null():
    p = terrain.horizon_profile(0.674, 23.473)   # Apollo 11: no polar DEM coverage
    assert p["terrainQuality"] == "none" and p["elevationDeg"][0] is None


def test_mask_interpolation_and_missing():
    prof = [float(i % 2) for i in range(terrain.N_AZ)]
    assert terrain.mask_at(prof, np.array([0.125]))[0] == pytest.approx(0.5)
    assert terrain.mask_at(prof, np.array([359.875]))[0] == pytest.approx(0.5)   # wraps
    prof[1] = None
    assert np.isnan(terrain.mask_at(prof, np.array([0.1]))[0])
