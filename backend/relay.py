"""Lunar comms relay model: when is a landing site in contact with Earth *via an orbiting relay*,
not only direct-to-Earth (DTE)?

At the south pole Earth skims the horizon (~2-6 deg) and terrain blocks it for long stretches, so DTE
alone leaves big communication gaps. A relay constellation in a polar lunar orbit climbs high over the
pole and carries the link when Earth is hidden. This module computes, per site and time, whether *any*
relay satellite is simultaneously (a) above the site's terrain horizon and (b) able to see Earth itself.

Deliberately simplified and labelled as such, in the same spirit as the rest of this codebase:
  - Circular orbits (no eccentricity/frozen-orbit dwell), two-body Keplerian motion about the Moon.
  - Orbit elements are defined relative to the lunar equator at the mission epoch (a Lunar-Centred,
    lunar-axis-aligned inertial frame), then carried into the body-fixed MOON_ME frame per sample via
    Skyfield's frame rotation — the same frame the DTE/terrain model and LOLA topography use.
  - Relay->Earth line of sight is a Moon-sphere occultation test (no atmosphere, no antenna pattern).
It is good enough to show, honestly, how much communication a polar relay buys back. Swap in real
relay ephemerides (e.g. an ELFO constellation, or Lunar Pathfinder) without touching callers.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from .config import MOON_R_M
from .ephem import _bodies, enu_basis

MU_MOON_KM3_S2 = 4902.800066   # GM of the Moon
R_MOON_KM = MOON_R_M / 1000.0


@dataclass(frozen=True)
class RelayConfig:
    """A simple polar relay constellation. Defaults give strong south-pole coverage."""
    name: str = "polar-relay-3"
    altitude_km: float = 5000.0        # circular altitude above the lunar surface
    inclination_deg: float = 90.0      # 90 = polar, so each sat crosses over the pole every revolution
    num_sats: int = 3                  # phased so at least one is usually high over the pole
    min_elevation_deg: float = 5.0     # link needs the relay this far above the local horizon
    raan_spread_deg: float = 60.0      # how far the orbit planes are fanned out in longitude


DEFAULT_RELAY = RelayConfig()


def _relay_positions_me(cfg: RelayConfig, times: list[datetime]) -> np.ndarray:
    """Relay satellite positions in the body-fixed MOON_ME frame (km), shape (num_sats, 3, N)."""
    ts, eph, pc, frame = _bodies()
    t = ts.from_datetimes(times)
    secs = np.array([(tt - times[0]).total_seconds() for tt in times])      # seconds since epoch

    a = R_MOON_KM + cfg.altitude_km
    n = np.sqrt(MU_MOON_KM3_S2 / a ** 3)                                     # mean motion (rad/s)
    inc = np.radians(cfg.inclination_deg)

    # Orbit elements are set in a lunar-axis-aligned inertial frame (z = lunar north at epoch). We build
    # the per-sat position there, then rotate epoch-inertial -> ICRS -> MOON_ME(t).
    r_me = np.asarray(frame.rotation_at(t))                                  # ICRS -> MOON_ME, (3,3,N)
    r_me_epoch = np.asarray(frame.rotation_at(ts.from_datetimes([times[0]])))[..., 0]   # (3,3)
    lci_to_icrs = r_me_epoch.T                                               # MOON_ME(epoch) -> ICRS

    out = np.empty((cfg.num_sats, 3, len(times)))
    for s in range(cfg.num_sats):
        raan = np.radians(s * cfg.raan_spread_deg)
        theta0 = 2 * np.pi * s / cfg.num_sats                                # phase the sats around the orbit
        theta = theta0 + n * secs                                           # argument of latitude over time
        # Perifocal basis in the lunar-aligned inertial frame (z = lunar north).
        node = np.array([np.cos(raan), np.sin(raan), 0.0])                  # ascending-node direction
        q = np.array([-np.cos(inc) * np.sin(raan), np.cos(inc) * np.cos(raan), np.sin(inc)])
        pos_lci = a * (np.cos(theta)[:, None] * node + np.sin(theta)[:, None] * q)   # (N,3)
        pos_icrs = (lci_to_icrs @ pos_lci.T)                                # (3,N)
        out[s] = np.einsum("ijn,jn->in", r_me, pos_icrs)                    # -> MOON_ME(t), (3,N)
    return out


def _earth_positions_me(times: list[datetime]) -> np.ndarray:
    """Earth position relative to the Moon centre, in MOON_ME (km), shape (3, N)."""
    ts, eph, pc, frame = _bodies()
    t = ts.from_datetimes(times)
    earth_icrs = (eph["earth"] - eph["moon"]).at(t).position.km             # (3,N) in ICRS
    r_me = np.asarray(frame.rotation_at(t))
    return np.einsum("ijn,jn->in", r_me, earth_icrs)


def _sees_earth(relay_me: np.ndarray, earth_me: np.ndarray) -> np.ndarray:
    """True where the relay->Earth segment is not blocked by the Moon sphere. Shapes (3,N),(3,N)->(N,)."""
    r = relay_me                                   # (3,N)
    d = earth_me - r                               # (3,N)
    dlen = np.linalg.norm(d, axis=0)
    dhat = d / dlen
    tstar = -np.sum(r * dhat, axis=0)              # param of closest approach to Moon centre along segment
    inside = (tstar > 0) & (tstar < dlen)
    closest = r + tstar * dhat
    miss = np.linalg.norm(closest, axis=0)
    return ~(inside & (miss < R_MOON_KM))          # blocked only if the near approach dips below the surface


def relay_link(lat: float, lon: float, times: list[datetime],
               horizon_fn, margin_deg: float, cfg: RelayConfig = DEFAULT_RELAY) -> np.ndarray:
    """Boolean per-sample: is the site in contact with Earth via *any* relay satellite?

    A sat carries the link when it is above the site's terrain horizon (by `margin_deg`) and above the
    relay min-elevation, and the sat itself can see Earth. `horizon_fn(az_deg_array) -> horizon_deg_array`
    is the site's terrain horizon (same one the DTE model uses); `margin_deg` is the terrain-clearance margin.
    """
    basis = enu_basis(lat, lon)                    # rows: east, north, up (MOON_ME)
    east, north, up = basis[0], basis[1], basis[2]
    site_me = R_MOON_KM * up                       # site position in MOON_ME (km)

    relays = _relay_positions_me(cfg, times)       # (S,3,N)
    earth_me = _earth_positions_me(times)          # (3,N)

    linked = np.zeros(len(times), dtype=bool)
    for s in range(relays.shape[0]):
        topo = relays[s] - site_me[:, None]        # (3,N) site->relay in MOON_ME
        rng = np.linalg.norm(topo, axis=0)
        u = up @ topo
        e = east @ topo
        nth = north @ topo
        el_deg = np.degrees(np.arcsin(np.clip(u / rng, -1, 1)))
        az_deg = np.degrees(np.arctan2(e, nth)) % 360.0
        horizon = horizon_fn(az_deg)
        above = (el_deg > horizon + margin_deg) & (el_deg >= cfg.min_elevation_deg)
        linked |= above & _sees_earth(relays[s], earth_me)
    return linked
