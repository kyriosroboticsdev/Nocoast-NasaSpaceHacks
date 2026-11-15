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

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache

import numpy as np
from skyfield.api import Loader

from ..config import DATA
from .graph import Node, Weights

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
                          lateral_spread_km: float = 3000.0, lateral_rings: int = 1,
                          spacing: str = "uniform",
                          obstacles: list[Obstacle] | None = None) -> tuple[dict[str, Node], dict[str, list[str]]]:
    """A layered DAG of waypoints from Earth to the Moon at `epoch`: `layers` steps along the
    Earth-Moon line, each with a center node plus `lateral_steps` symmetric offset nodes around it (so
    the search has real detours to choose from), fully connected layer-to-layer. `time_s` on each node
    is a placeholder progress index (0..layers-1), not a propagated transit time.

    `lateral_rings` places those offset nodes on that many *concentric* rings around the center, at
    radii ``lateral_spread_km * r / lateral_rings`` for r in 1..lateral_rings (so the outermost ring is
    always at the full spread). More rings give the search finer radial resolution — it can shave a
    small obstacle or shadow with a small sideways correction instead of swinging out the full spread.

    `spacing` controls how the layers are distributed along the Earth-Moon line:
      - ``"uniform"`` (default): evenly spaced.
      - ``"cosine"``: clustered toward both ends via ``0.5*(1 - cos(pi*u))``, so the sampling is densest
        near Earth and the Moon. That is exactly where the shadow-cylinder entry/exit and the Moon's
        comm-occlusion edge fall, so the lit/comm transitions get resolved far more finely for the same
        number of layers; the sparser middle cruise is where little changes.
    """
    if spacing not in ("uniform", "cosine"):
        raise ValueError(f"spacing must be 'uniform' or 'cosine', got {spacing!r}")
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

    rings = max(1, lateral_rings)
    # The lateral offsets shared by every interior layer: the on-axis center plus `lateral_steps`
    # points on each of `rings` concentric circles. Computed once, not per layer.
    ring_offsets = [(0.0, 0.0)]
    for r in range(1, rings + 1):
        radius = lateral_spread_km * r / rings
        ring_offsets.extend(
            (radius * np.sin(2 * np.pi * k / lateral_steps), radius * np.cos(2 * np.pi * k / lateral_steps))
            for k in range(lateral_steps)
        )

    obstacles = obstacles or []
    nodes: dict[str, Node] = {}
    edges: dict[str, list[str]] = {}
    layer_ids: list[list[str]] = []

    for li in range(layers):
        u = li / (layers - 1) if layers > 1 else 0.0  # uniform progress in [0, 1]
        frac = 0.5 * (1.0 - np.cos(np.pi * u)) if spacing == "cosine" else u
        center = earth_km + axis * frac
        # Earth and Moon endpoints are single on-axis anchor nodes; interior layers fan out.
        offsets = [(0.0, 0.0)] if li in (0, layers - 1) else ring_offsets
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


def distance_heuristic(nodes: dict[str, Node], goal: str, weights: Weights) -> Callable[[str], float]:
    """An admissible, consistent A* heuristic for `graph.shortest_path` on a corridor graph.

    Every non-distance term in `graph._edge_cost` is non-negative, so the cheapest any route from a
    node to the goal can cost is its straight-line distance priced at the distance weight. That is a
    true lower bound on remaining cost (admissible) and obeys the triangle inequality (consistent), so
    A* with it returns the exact same optimum as Dijkstra while expanding far fewer nodes. If distance
    carries no weight the bound is 0 and A* degrades gracefully to Dijkstra."""
    goal_pos = np.array(nodes[goal].position_km)

    def h(node_id: str) -> float:
        return weights.distance * float(np.linalg.norm(np.array(nodes[node_id].position_km) - goal_pos))

    return h


def _segment_pierces_sphere(p0: np.ndarray, p1: np.ndarray, center: np.ndarray, radius_km: float) -> bool:
    """True if the straight segment p0->p1 passes within `radius_km` of `center`. Uses the exact
    closest point on the segment (clamped projection), so it catches obstacles a hop flies *through*
    even when both endpoints sit outside the keep-out sphere."""
    d = p1 - p0
    seg_sq = float(np.dot(d, d))
    if seg_sq == 0.0:
        closest = p0
    else:
        t = float(np.dot(center - p0, d) / seg_sq)
        t = min(1.0, max(0.0, t))  # clamp to the segment, not the infinite line
        closest = p0 + t * d
    return bool(np.linalg.norm(center - closest) <= radius_km)


def segment_obstacle_penalty(obstacles: list[Obstacle], weights: Weights) -> Callable[[Node, Node], float]:
    """An `edge_penalty` for `graph.shortest_path`: charges `weights.obstacle_penalty` to any hop whose
    straight segment pierces a keep-out sphere, even between two clear waypoints. The corridor's layers
    are ~16,000 km apart, far wider than a typical exclusion radius, so node-only blocking alone would
    let the search thread a long hop right through a small obstacle; this closes that gap."""
    spheres = [(np.array(ob.position_km), ob.radius_km) for ob in obstacles]

    def penalty(a: Node, b: Node) -> float:
        if not spheres:
            return 0.0
        p0 = np.array(a.position_km)
        p1 = np.array(b.position_km)
        if any(_segment_pierces_sphere(p0, p1, c, r) for c, r in spheres):
            return weights.obstacle_penalty
        return 0.0

    return penalty


def segment_lighting(epoch: datetime, samples: int = 8) -> Callable[[Node, Node], tuple[float, float]]:
    """A `lighting` function for `graph.shortest_path`: the fraction of a hop that is sunlit and in
    Earth-comm, found by sampling `samples` evenly spaced points along the segment and testing each
    against the real shadow-cylinder and Moon-occlusion geometry at `epoch`.

    The corridor's layers sit ~16,000 km apart, so a hop can dip through Earth's shadow (or behind the
    Moon) between two waypoints that are themselves both lit; charging darkness only by the endpoint
    node's flag misses that entirely. Sampling the segment prices and reports it honestly. The Sun,
    Earth and Moon positions are fixed per epoch and captured once here, not recomputed per call."""
    earth_km, moon_km, sun_km = _positions_km(epoch)
    fracs = np.linspace(0.0, 1.0, max(2, samples))

    def lighting(a: Node, b: Node) -> tuple[float, float]:
        p0 = np.array(a.position_km)
        p1 = np.array(b.position_km)
        lit = 0
        comm = 0
        for t in fracs:
            p = p0 + t * (p1 - p0)
            if not (_in_shadow(p, sun_km, earth_km, EARTH_RADIUS_KM)
                    or _in_shadow(p, sun_km, moon_km, MOON_RADIUS_KM)):
                lit += 1
            if not _earth_occluded_by_moon(p, earth_km, moon_km):
                comm += 1
        n = len(fracs)
        return lit / n, comm / n

    return lighting
