"""Generic multi-objective weighted shortest-path search.

Routes a relay satellite between two points (Earth and the Moon, in this project) by combining four
objectives into one non-negative edge cost, then running ordinary Dijkstra:

  - shortest distance      (so the path isn't gratuitously long)
  - maximum sunlit time    (so solar panels alone can power the craft, no battery reliance)
  - maximum Earth comms    (so direct-to-Earth contact is available as much of the trip as possible)
  - obstacle avoidance     (a large fixed penalty for any edge touching a modelled keep-out zone)

This module only knows about an abstract graph of `Node`s and an adjacency list — it has no notion of
Earth, the Moon, or orbital mechanics. See `earth_moon.py` for the concrete graph this project builds
with it. Keeping the search generic means it's also directly reusable for the lander's terrain-horizon
routing problems this team already has (e.g. rover path planning), not just the orbital case.
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Node:
    id: str
    position_km: tuple[float, float, float]
    time_s: float               # mission-elapsed seconds; carried through for client-side playback
    sunlit: bool                # True if this waypoint is not inside any body's shadow
    earth_visible: bool         # True if line-of-sight back to Earth isn't blocked by the Moon
    blocked: bool = False       # True if inside a modelled obstacle's keep-out radius


@dataclass(frozen=True)
class Weights:
    """Per-km penalties. Defaults weight all four objectives equally; `obstacle_penalty` is a large
    fixed additive cost (not per-km) so any blocked edge is avoided unless truly unavoidable."""
    distance: float = 1.0
    darkness: float = 1.0
    no_comm: float = 1.0
    obstacle_penalty: float = 1.0e6


@dataclass(frozen=True)
class PathResult:
    node_ids: list[str]
    total_distance_km: float
    sunlit_fraction: float
    earth_comm_fraction: float
    obstacles_touched: int
    cost: float


class NoPathError(ValueError):
    pass


def _edge_cost(a: Node, b: Node, weights: Weights) -> float:
    dist_km = math.dist(a.position_km, b.position_km)
    cost = weights.distance * dist_km
    if not b.sunlit:
        cost += weights.darkness * dist_km
    if not b.earth_visible:
        cost += weights.no_comm * dist_km
    if a.blocked or b.blocked:
        cost += weights.obstacle_penalty
    return cost


def shortest_path(nodes: dict[str, Node], edges: dict[str, list[str]], start: str, goal: str,
                   weights: Weights = Weights()) -> PathResult:
    """Dijkstra over `edges` (adjacency list: node id -> reachable neighbor ids), minimizing the
    composite cost in `_edge_cost`. Every term in that cost is non-negative, so plain Dijkstra is exact
    here; an A* heuristic isn't needed at the node counts `earth_moon.build_corridor_graph` produces
    (low thousands)."""
    if start not in nodes:
        raise KeyError(f"start node {start!r} not in graph")
    if goal not in nodes:
        raise KeyError(f"goal node {goal!r} not in graph")

    dist: dict[str, float] = {start: 0.0}
    prev: dict[str, str] = {}
    visited: set[str] = set()
    pq: list[tuple[float, str]] = [(0.0, start)]

    while pq:
        d, u = heapq.heappop(pq)
        if u in visited:
            continue
        visited.add(u)
        if u == goal:
            break
        for v in edges.get(u, ()):
            if v in visited:
                continue
            nd = d + _edge_cost(nodes[u], nodes[v], weights)
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))

    if goal not in dist:
        raise NoPathError(f"no path from {start!r} to {goal!r}")

    path = [goal]
    while path[-1] != start:
        path.append(prev[path[-1]])
    path.reverse()

    total_km = 0.0
    sunlit_km = 0.0
    comm_km = 0.0
    obstacles_touched = 0
    for a_id, b_id in zip(path, path[1:]):
        a, b = nodes[a_id], nodes[b_id]
        seg_km = math.dist(a.position_km, b.position_km)
        total_km += seg_km
        if b.sunlit:
            sunlit_km += seg_km
        if b.earth_visible:
            comm_km += seg_km
        if a.blocked or b.blocked:
            obstacles_touched += 1

    return PathResult(
        node_ids=path,
        total_distance_km=total_km,
        sunlit_fraction=(sunlit_km / total_km) if total_km else 1.0,
        earth_comm_fraction=(comm_km / total_km) if total_km else 1.0,
        obstacles_touched=obstacles_touched,
        cost=dist[goal],
    )
