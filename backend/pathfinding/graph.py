"""Generic multi-objective weighted shortest-path search.

Routes a relay satellite between two points (Earth and the Moon, in this project) by combining four
objectives into one non-negative edge cost, then running a best-first search (Dijkstra, or A* when a
heuristic is supplied):

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
from collections.abc import Callable
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


EdgePenalty = Callable[[Node, Node], float]
# Returns (sunlit_fraction, comm_fraction) of the segment a->b, each in [0, 1].
Lighting = Callable[[Node, Node], tuple[float, float]]


def _segment_lit_comm(a: Node, b: Node, lighting: Lighting | None) -> tuple[float, float]:
    """Fraction of the hop a->b that is sunlit and in Earth-comm. With `lighting` we sample along the
    segment; without it we fall back to the destination node's own flags (1.0 or 0.0) — the long-standing
    endpoint approximation. Kept in one place so cost and reporting can never disagree."""
    if lighting is not None:
        return lighting(a, b)
    return (1.0 if b.sunlit else 0.0), (1.0 if b.earth_visible else 0.0)


def _edge_cost(a: Node, b: Node, weights: Weights, edge_penalty: EdgePenalty | None = None,
               lighting: Lighting | None = None) -> float:
    dist_km = math.dist(a.position_km, b.position_km)
    sunlit_frac, comm_frac = _segment_lit_comm(a, b, lighting)
    cost = weights.distance * dist_km
    cost += weights.darkness * (1.0 - sunlit_frac) * dist_km
    cost += weights.no_comm * (1.0 - comm_frac) * dist_km
    if a.blocked or b.blocked:
        cost += weights.obstacle_penalty
    if edge_penalty is not None:
        cost += edge_penalty(a, b)
    return cost


def shortest_path(nodes: dict[str, Node], edges: dict[str, list[str]], start: str, goal: str,
                   weights: Weights = Weights(), *,
                   heuristic: Callable[[str], float] | None = None,
                   edge_penalty: EdgePenalty | None = None,
                   lighting: Lighting | None = None) -> PathResult:
    """Best-first search over `edges` (adjacency list: node id -> reachable neighbor ids), minimizing
    the composite cost in `_edge_cost`.

    With `heuristic=None` this is plain Dijkstra. Every cost term is non-negative, so Dijkstra is exact.

    Pass a `heuristic(node_id) -> float` lower bound on the remaining cost to `goal` to run A* instead:
    the frontier is ordered by ``g + h`` so the search is steered toward the goal and expands far fewer
    nodes, while still returning the exact optimum. The heuristic must be *admissible* (never
    overestimates the true remaining cost); if it is also *consistent* (``h(a) <= cost(a,b) + h(b)``),
    the settled-node skip below stays valid. `earth_moon.distance_heuristic` supplies one that is both.
    The `cost` on the returned `PathResult` is always the true path cost ``g``, never ``g + h``.

    Pass `edge_penalty(a, b) -> float` (non-negative) to charge a cost that depends on the *segment*
    a->b, not just its endpoints — e.g. a keep-out zone a straight hop would pierce even though both
    waypoints sit outside it. It is added on top of the node-based cost and is included in the obstacle
    accounting below (a segment with a positive penalty counts as touching an obstacle). Any admissible
    `heuristic` stays admissible since the penalty only *raises* true costs. `earth_moon.segment_obstacle_penalty`
    supplies one for the corridor's keep-out spheres.

    Pass `lighting(a, b) -> (sunlit_fraction, comm_fraction)` to price *and report* darkness and lost
    comms from the fraction of each hop actually in shadow / out of Earth-comm, instead of charging the
    whole hop by whether its destination node happens to be lit. This catches a segment that dips
    through shadow between two sunlit waypoints — which the layers are too far apart to see otherwise.
    Both fractions are in [0, 1], so the distance-only `heuristic` stays admissible.
    `earth_moon.segment_lighting` supplies one that samples the real shadow/occlusion geometry."""
    if start not in nodes:
        raise KeyError(f"start node {start!r} not in graph")
    if goal not in nodes:
        raise KeyError(f"goal node {goal!r} not in graph")

    h = heuristic or (lambda _nid: 0.0)
    dist: dict[str, float] = {start: 0.0}  # g-scores: best known true cost from `start`
    prev: dict[str, str] = {}
    visited: set[str] = set()
    # Frontier entries are (g + h, g, node): priority steers the search, g breaks ties toward
    # already-cheaper paths, and we carry g explicitly so h is never folded into the recorded cost.
    pq: list[tuple[float, float, str]] = [(h(start), 0.0, start)]

    while pq:
        _priority, d, u = heapq.heappop(pq)
        if u in visited:
            continue
        visited.add(u)
        if u == goal:
            break
        for v in edges.get(u, ()):
            if v in visited:
                continue
            nd = d + _edge_cost(nodes[u], nodes[v], weights, edge_penalty, lighting)
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd + h(v), nd, v))

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
    for a_id, b_id in zip(path, path[1:], strict=False):
        a, b = nodes[a_id], nodes[b_id]
        seg_km = math.dist(a.position_km, b.position_km)
        sunlit_frac, comm_frac = _segment_lit_comm(a, b, lighting)
        total_km += seg_km
        sunlit_km += sunlit_frac * seg_km
        comm_km += comm_frac * seg_km
        if a.blocked or b.blocked or (edge_penalty is not None and edge_penalty(a, b) > 0):
            obstacles_touched += 1

    return PathResult(
        node_ids=path,
        total_distance_km=total_km,
        sunlit_fraction=(sunlit_km / total_km) if total_km else 1.0,
        earth_comm_fraction=(comm_km / total_km) if total_km else 1.0,
        obstacles_touched=obstacles_touched,
        cost=dist[goal],
    )
