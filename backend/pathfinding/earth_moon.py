"""First-pass Earth<->Moon relay-satellite corridor, built on top of `graph.py`'s generic search.

This is deliberately simple and clearly labelled as such: a straight Earth-Moon line with a small ring
of lateral waypoint choices at each step along it — not a modelled orbit or trajectory (no propagation,
no patched conics, no thrust, no real transit-time estimate). It exists so the four objectives from the
challenge brief — maximize sunlit time, avoid obstacles, maximize Earth-comm time, minimize path length
— have a working, testable multi-objective search end to end. Swap this module out once real
orbital/obstacle data is available; `graph.py` and the `/api/pathfind` route don't need to change.

Bodies use the same bundled JPL DE421 kernel as the lander's Sun/Earth ephemeris (`backend/ephem.py`),
so no new data download is introduced.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache

import numpy as np
from skyfield.api import Loader

from ..config import DATA
from .graph import Node

MOON_RADIUS_KM = 1737.4
EARTH_RADIUS_KM = 6371.0


@dataclass(frozen=True)
class Obstacle:
    """A modelled keep-out zone (debris field, radiation belt, exclusion radius, ...). Position is an
    absolute point in the same barycentric ICRF frame as the corridor nodes."""
    position_km: tuple[float, float, float]
    radius_km: float


@lru_cache(maxsize=1)
def _kernel():
    load = Loader(str(DATA), verbose=False)
    ts = load.timescale(builtin=True)
    return ts, load("de421.bsp")


def _positions_km(epoch: datetime) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Earth, Moon, Sun positions (km) in the solar-system barycentric ICRF frame at `epoch`."""
    ts, eph = _kernel()
    t = ts.from_datetime(epoch)
    return eph["earth"].at(t).position.km, eph["moon"].at(t).position.km, eph["sun"].at(t).position.km


def _in_shadow(point_km: np.ndarray, sun_km: np.ndarray, body_km: np.ndarray, body_radius_km: float) -> bool:
    """Cylindrical shadow test (no penumbra, no umbra taper): `point` is in `body`'s shadow if it falls
    behind the body (away from the Sun) along the Sun-body axis, within `body_radius_km` of that axis."""
    axis = (sun_km - body_km)
    axis /= np.linalg.norm(axis)
    rel = point_km - body_km
    along = np.dot(rel, axis)
    if along >= 0:
        return False  # sunward side of the body: can't be in its shadow
    radial = np.linalg.norm(rel - along * axis)
    return bool(radial <= body_radius_km)


def _earth_occluded_by_moon(point_km: np.ndarray, earth_km: np.ndarray, moon_km: np.ndarray) -> bool:
    """True if the Moon's sphere blocks the line of sight from `point` back to Earth."""
    d = earth_km - point_km
    seg_len = np.linalg.norm(d)
    if seg_len == 0:
        return False
    d_hat = d / seg_len
    along = np.dot(moon_km - point_km, d_hat)
    if along <= 0 or along >= seg_len:
        return False  # Moon isn't between point and Earth along this segment
    closest = point_km + along * d_hat
    return bool(np.linalg.norm(moon_km - closest) <= MOON_RADIUS_KM)


def build_corridor_graph(epoch: datetime, layers: int = 24, lateral_steps: int = 4,
                          lateral_spread_km: float = 3000.0,
                          obstacles: list[Obstacle] | None = None) -> tuple[dict[str, Node], dict[str, list[str]]]:
    """A layered DAG of waypoints from Earth to the Moon at `epoch`: `layers` steps along the
    Earth-Moon line, each with a center node plus `lateral_steps` symmetric offset nodes around it (so
    the search has real detours to choose from), fully connected layer-to-layer. `time_s` on each node
    is a placeholder progress index (0..layers-1), not a propagated transit time.
    """
    earth_km, moon_km, sun_km = _positions_km(epoch)
    axis = moon_km - earth_km
    axis_hat = axis / np.linalg.norm(axis)

    # Any vector not parallel to axis_hat, Gram-Schmidt'd off it, gives one lateral in-plane direction;
    # its cross product with axis_hat gives the other. Together they span the plane perpendicular to
    # the Earth-Moon line at each layer.
    seed = np.array([0.0, 0.0, 1.0]) if abs(axis_hat[2]) < 0.9 else np.array([0.0, 1.0, 0.0])
    lat1 = seed - np.dot(seed, axis_hat) * axis_hat
    lat1 /= np.linalg.norm(lat1)
    lat2 = np.cross(axis_hat, lat1)

    obstacles = obstacles or []
    nodes: dict[str, Node] = {}
    edges: dict[str, list[str]] = {}
    layer_ids: list[list[str]] = []

    for li in range(layers):
        frac = li / (layers - 1) if layers > 1 else 0.0
        center = earth_km + axis * frac
        offsets = [(0.0, 0.0)] if li in (0, layers - 1) else [
            (0.0, 0.0),
            *[(lateral_spread_km * np.sin(2 * np.pi * k / lateral_steps),
               lateral_spread_km * np.cos(2 * np.pi * k / lateral_steps))
              for k in range(lateral_steps)],
        ]
        ids = []
        for oi, (o1, o2) in enumerate(offsets):
            pos = center + o1 * lat1 + o2 * lat2
            node_id = f"L{li}_{oi}"
            sunlit = not (_in_shadow(pos, sun_km, earth_km, EARTH_RADIUS_KM)
                          or _in_shadow(pos, sun_km, moon_km, MOON_RADIUS_KM))
            earth_visible = not _earth_occluded_by_moon(pos, earth_km, moon_km)
            blocked = any(np.linalg.norm(pos - np.array(ob.position_km)) <= ob.radius_km for ob in obstacles)
            nodes[node_id] = Node(
                id=node_id, position_km=tuple(float(c) for c in pos), time_s=float(li),
                sunlit=sunlit, earth_visible=earth_visible, blocked=blocked,
            )
            ids.append(node_id)
        layer_ids.append(ids)

    for li in range(layers - 1):
        for u in layer_ids[li]:
            edges[u] = list(layer_ids[li + 1])

    return nodes, edges


def start_id() -> str:
    return "L0_0"


def goal_id(layers: int) -> str:
    return f"L{layers - 1}_0"
