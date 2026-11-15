"""Analytic terrain geometry, missing-data behavior and the real 5 m DEM handoff."""
import numpy as np
import pytest

from backend import slopes
from backend.config import MOON_R_M, SITES


@pytest.mark.parametrize("height", [0, 2000, -3000])
def test_level_sphere_does_not_become_a_slope(height):
    p = slopes.grid_directions(620, 249)
    s = slopes.slope_degrees(np.full((249, 249), height), p)
    assert np.nanmax(s) < 1e-6
    assert np.isnan(s[0]).all() and np.isnan(s[-1]).all()
    assert np.isnan(s[:, 0]).all() and np.isnan(s[:, -1]).all()


@pytest.mark.parametrize(("east_grade", "north_grade"), [(0.1, 0), (0, -0.2), (0.1, 0.2), (-0.7, -0.8)])
def test_known_plane_slope_and_axis_orientation(east_grade, north_grade):
    p = slopes.grid_directions(100, 41)
    # Plane z=R+2000 + east_grade*x + north_grade*y, intersected by radial rays.
    radius = (MOON_R_M + 2000) / (p[..., 2] - east_grade * p[..., 0] - north_grade * p[..., 1])
    h = radius - MOON_R_M
    s = slopes.slope_degrees(h, p)
    assert s[20, 20] == pytest.approx(np.degrees(np.arctan(np.hypot(east_grade, north_grade))), abs=1e-6)
    if east_grade:
        assert (h[20, 21] > h[20, 19]) == (east_grade > 0)
    assert p[0, 20, 1] < 0 < p[-1, 20, 1]  # south-to-north rows
    assert p[20, 0, 0] < 0 < p[20, -1, 0]  # west-to-east columns


def test_missing_center_and_cardinal_neighbors_stay_unknown():
    p = slopes.grid_directions(100, 41)
    h = np.zeros((41, 41))
    h[20, 20] = np.nan
    s = slopes.slope_degrees(h, p)
    for j, i in [(20, 20), (19, 20), (21, 20), (20, 19), (20, 21)]:
        assert np.isnan(s[j, i])
    assert np.isfinite(s[19, 19])  # diagonal is not part of the documented stencil


@pytest.mark.parametrize(("half", "n"), [(620, 248), (620, 401), (0, 249), (2001, 249), (620, 15)])
def test_invalid_or_oversampled_grids_are_rejected(half, n):
    with pytest.raises(ValueError):
        slopes.grid_directions(half, n)


def test_grid_shape_and_directions_are_checked():
    with pytest.raises(ValueError):
        slopes.slope_degrees(np.zeros((4, 4)), np.ones((4, 4, 3)))
    with pytest.raises(ValueError):
        slopes.slope_degrees(np.zeros((4, 4)), np.zeros((3, 3, 3)))


@pytest.mark.parametrize("site", SITES, ids=lambda s: s["siteId"])
def test_real_site_grid_preserves_contract_and_finite_values(site):
    d = slopes.local_slope_grid(site['latitudeDeg'], site['longitudeEastDeg'])
    assert d['frameId'] == 'MOON_ME_DE421'
    assert d['gridSpacingM'] == 5 and d['gradientBaselineM'] == 10
    assert d['rowOrder'] == 'south-to-north' and d['columnOrder'] == 'west-to-east'
    assert d['fineElevationFraction'] == 1
    assert 0.95 < d['knownFraction'] <= (247 * 247) / (249 * 249)
    assert d['centerSlopeDeg'] == d['slopeDeg'][(249 * 249 - 1) // 2]
    assert 0 <= d['centerSlopeDeg'] <= 90
    assert all(x is None or np.isfinite(x) and 0 <= x <= 90 for x in d['slopeDeg'])
    assert len(d['sources']) >= 1


def test_no_fine_coverage_is_unknown_even_where_coarse_dem_exists():
    d = slopes.local_slope_grid(-80, 0, 100, 41)
    assert d['knownFraction'] == 0 and d['fineElevationFraction'] == 0
    assert d['centerSlopeDeg'] is None and all(x is None for x in d['slopeDeg'])


def test_gap_in_fine_dem_is_not_filled_from_coarse_sources(monkeypatch):
    class Fine:
        name = 'synthetic-fine'
        def height(self, lat, lon):
            return np.full(lat.shape, np.nan)
    class Coarse:
        def height(self, lat, lon):
            pytest.fail('Slope screen must not sample coarse fallback')
    monkeypatch.setattr(slopes.terrain, 'sources', lambda: {5.0: [Fine()], 80.0: [Coarse()]})
    d = slopes.local_slope_grid(-89, 17.1234, 100, 41)
    assert d['knownFraction'] == 0


def test_different_tile_elevation_offsets_do_not_create_fake_slope(monkeypatch):
    class West:
        name = 'west-tile'
        def height(self, lat, lon):
            return np.where(lon < 17.7, 0., np.nan)
    class East:
        name = 'east-tile'
        def height(self, lat, lon):
            return np.full(lat.shape, 100.)
    monkeypatch.setattr(slopes.terrain, 'sources', lambda: {5.0: [West(), East()]})
    d = slopes.local_slope_grid(-89, 17.7, 100, 41)
    values = [x for x in d['slopeDeg'] if x is not None]
    assert d['sources'] == ['west-tile', 'east-tile']
    assert 0 < d['knownFraction'] < (39 * 39) / (41 * 41)
    assert max(values) < 1e-6


def test_route_rejects_bad_grids_and_returns_missing_data_errors(monkeypatch):
    # Direct route call avoids introducing a new HTTP test dependency.
    from fastapi import HTTPException

    from backend.app import terrain_slopes
    with pytest.raises(HTTPException) as exc:
        terrain_slopes(-89, 0, 620, 248)
    assert exc.value.status_code == 400
    def fail(*args):
        raise OSError('missing file')
    monkeypatch.setattr(slopes, 'local_slope_grid', fail)
    with pytest.raises(HTTPException) as exc:
        terrain_slopes(-89, 0, 620, 249)
    assert exc.value.status_code == 503
