"""Simplified directional-antenna pointing / link quality (extension, not in contract v0.1).

Pure math on synthetic az/el/visibility arrays — no ephemeris or DEM data needed.
"""
import numpy as np
import pytest

from backend import analysis


def test_on_boresight_full_quality_when_visible():
    off, quality = analysis.antenna_link_quality(
        earth_az=np.array([90.0]), earth_el=np.array([10.0]), earth_vis=np.array([1]),
        boresight_az=90.0, boresight_el=10.0, beamwidth_deg=20.0,
    )
    assert off[0] < 1e-3   # float noise through arccos(clip(cos_sep, -1, 1)) near exact boresight
    assert quality[0] == pytest.approx(1.0)


def test_zero_quality_when_earth_not_visible_even_on_boresight():
    off, quality = analysis.antenna_link_quality(
        earth_az=np.array([90.0]), earth_el=np.array([10.0]), earth_vis=np.array([0]),
        boresight_az=90.0, boresight_el=10.0, beamwidth_deg=20.0,
    )
    assert quality[0] == 0.0


def test_zero_quality_outside_beamwidth():
    off, quality = analysis.antenna_link_quality(
        # same elevation as boresight, 40 deg az apart: great-circle separation is <= the az delta (a circle
        # of constant elevation off the pole isn't a great circle), but still well outside the 10 deg
        # half-power edge for beamwidth_deg=20.
        earth_az=np.array([130.0]), earth_el=np.array([10.0]), earth_vis=np.array([1]),
        boresight_az=90.0, boresight_el=10.0, beamwidth_deg=20.0,
    )
    assert off[0] > 30.0
    assert quality[0] == 0.0


def test_quality_decreases_monotonically_with_off_boresight():
    az = np.array([90.0, 95.0, 100.0, 105.0])
    _off, quality = analysis.antenna_link_quality(
        earth_az=az, earth_el=np.full(4, 10.0), earth_vis=np.ones(4, dtype=int),
        boresight_az=90.0, boresight_el=10.0, beamwidth_deg=20.0,
    )
    assert np.all(np.diff(quality) <= 1e-12)


def test_antenna_block_unmodeled_by_default():
    block = analysis._antenna_block([], np.array([]), np.array([]), np.array([]), None, None,
                                    analysis.DEFAULT_BEAMWIDTH_DEG)
    assert block["modeled"] is False
    assert "note" in block
