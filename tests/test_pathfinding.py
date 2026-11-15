"""Tests for backend/pathfinding/: the generic multi-objective search (graph.py) and the Earth<->Moon
corridor builder on top of it (earth_moon.py)."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pytest

from backend.pathfinding import earth_moon
from backend.pathfinding.graph import Node, NoPathError, Weights, shortest_path


def _toy_graph():
    """start -> A -> goal is short but dark and comm-dead the whole way.
    start -> B -> goal is 3x longer but fully sunlit and in comm the whole way."""
    nodes = {
        "start": Node("start", (0, 0, 0), 0, sunlit=True, earth_visible=True),
        "A": Node("A", (1, 0, 0), 1, sunlit=False, earth_visible=False),
        "B": Node("B", (0, 3, 0), 1, sunlit=True, earth_visible=True),
        "goal": Node("goal", (2, 0, 0), 2, sunlit=True, earth_visible=True),
    }
    edges = {"start": ["A", "B"], "A": ["goal"], "B": ["goal"]}
    return nodes, edges


def test_distance_only_prefers_shorter_dark_path():
    nodes, edges = _toy_graph()
    result = shortest_path(nodes, edges, "start", "goal", Weights(distance=1.0, darkness=0.0, no_comm=0.0))
    assert result.node_ids == ["start", "A", "goal"]


def test_sunlight_and_comm_weighting_prefers_longer_lit_path():
    nodes, edges = _toy_graph()
    result = shortest_path(nodes, edges, "start", "goal", Weights(distance=1.0, darkness=5.0, no_comm=5.0))
    assert result.node_ids == ["start", "B", "goal"]
    assert result.sunlit_fraction == 1.0
    assert result.earth_comm_fraction == 1.0


def test_obstacle_penalty_is_avoided_when_alternative_exists():
    nodes, edges = _toy_graph()
    nodes["A"] = Node("A", (1, 0, 0), 1, sunlit=True, earth_visible=True, blocked=True)
    result = shortest_path(nodes, edges, "start", "goal", Weights(distance=1.0, darkness=0.0, no_comm=0.0))
    assert result.node_ids == ["start", "B", "goal"]
    assert result.obstacles_touched == 0


def test_missing_goal_raises_keyerror():
    nodes, edges = _toy_graph()
    with pytest.raises(KeyError):
        shortest_path(nodes, edges, "start", "nowhere")


def test_disconnected_graph_raises_nopatherror():
    nodes, edges = _toy_graph()
    nodes["island"] = Node("island", (9, 9, 9), 0, sunlit=True, earth_visible=True)
    with pytest.raises(NoPathError):
        shortest_path(nodes, edges, "start", "island")


def test_earth_moon_corridor_end_to_end():
    """Smoke test against the real bundled DE421 kernel: the search must return a complete,
    physically-sane path (monotonic distance budget, fractions in [0, 1])."""
    epoch = datetime(2027, 1, 15, tzinfo=timezone.utc)
    layers = 12
    nodes, edges = earth_moon.build_corridor_graph(epoch, layers=layers, lateral_steps=4)
    result = shortest_path(nodes, edges, earth_moon.start_id(), earth_moon.goal_id(layers))

    assert result.node_ids[0] == earth_moon.start_id()
    assert result.node_ids[-1] == earth_moon.goal_id(layers)
    assert len(result.node_ids) == layers
    assert 300_000 < result.total_distance_km < 500_000  # Earth-Moon distance is ~384,400 km
    assert 0.0 <= result.sunlit_fraction <= 1.0
    assert 0.0 <= result.earth_comm_fraction <= 1.0


def test_astar_heuristic_returns_same_optimum_as_dijkstra():
    """A* with an admissible heuristic must return the exact same path and cost as plain Dijkstra;
    the heuristic only changes *how many* nodes get expanded, never the answer."""
    nodes, edges = _toy_graph()
    weights = Weights(distance=1.0, darkness=5.0, no_comm=5.0)

    def h(node_id):  # straight-line distance to goal, priced at the distance weight: admissible
        gp = np.array(nodes["goal"].position_km)
        return weights.distance * float(np.linalg.norm(np.array(nodes[node_id].position_km) - gp))

    dijkstra = shortest_path(nodes, edges, "start", "goal", weights)
    astar = shortest_path(nodes, edges, "start", "goal", weights, heuristic=h)
    assert astar.node_ids == dijkstra.node_ids
    assert astar.cost == pytest.approx(dijkstra.cost)


def test_zero_heuristic_is_exactly_dijkstra():
    nodes, edges = _toy_graph()
    weights = Weights(distance=1.0, darkness=5.0, no_comm=5.0)
    plain = shortest_path(nodes, edges, "start", "goal", weights)
    zeroed = shortest_path(nodes, edges, "start", "goal", weights, heuristic=lambda _nid: 0.0)
    assert zeroed.node_ids == plain.node_ids
    assert zeroed.cost == pytest.approx(plain.cost)


def test_corridor_astar_matches_dijkstra_on_real_graph():
    """On the real DE421-backed corridor the A* heuristic from `earth_moon.distance_heuristic` must be
    exact — same waypoints and cost as Dijkstra — for a non-trivial multi-objective weighting."""
    epoch = datetime(2027, 1, 15, tzinfo=timezone.utc)
    layers = 20
    weights = Weights(distance=1.0, darkness=2.0, no_comm=1.5)
    nodes, edges = earth_moon.build_corridor_graph(epoch, layers=layers, lateral_steps=6, lateral_rings=3)
    goal = earth_moon.goal_id(layers)

    dijkstra = shortest_path(nodes, edges, earth_moon.start_id(), goal, weights)
    heuristic = earth_moon.distance_heuristic(nodes, goal, weights)
    astar = shortest_path(nodes, edges, earth_moon.start_id(), goal, weights, heuristic=heuristic)
    assert astar.node_ids == dijkstra.node_ids
    assert astar.cost == pytest.approx(dijkstra.cost)


def test_concentric_rings_add_waypoints_and_allow_finer_detours():
    """More lateral rings give the interior layers more waypoints at intermediate radii, so the search
    can dodge a small obstacle with a smaller sideways correction (and a cheaper total path) than the
    single full-spread ring allows."""
    epoch = datetime(2027, 1, 15, tzinfo=timezone.utc)
    layers = 12
    mid_id = f"L{layers // 2}_0"
    nodes_probe, _ = earth_moon.build_corridor_graph(epoch, layers=layers, lateral_steps=6)
    # A small obstacle on the axis at mid-corridor; well inside the 3000 km full spread.
    obstacle = earth_moon.Obstacle(position_km=nodes_probe[mid_id].position_km, radius_km=800.0)

    earth_km, moon_km, _ = earth_moon._positions_km(epoch)
    axis_hat = (moon_km - earth_km) / np.linalg.norm(moon_km - earth_km)

    def max_lateral_excursion(result, graph_nodes):
        worst = 0.0
        for nid in result.node_ids:
            rel = np.array(graph_nodes[nid].position_km) - earth_km
            worst = max(worst, float(np.linalg.norm(rel - np.dot(rel, axis_hat) * axis_hat)))
        return worst

    coarse_nodes, coarse_edges = earth_moon.build_corridor_graph(
        epoch, layers=layers, lateral_steps=6, lateral_rings=1, obstacles=[obstacle])
    fine_nodes, fine_edges = earth_moon.build_corridor_graph(
        epoch, layers=layers, lateral_steps=6, lateral_rings=4, obstacles=[obstacle])

    assert len(fine_nodes) > len(coarse_nodes)  # extra rings really add waypoints

    coarse = shortest_path(coarse_nodes, coarse_edges, earth_moon.start_id(), earth_moon.goal_id(layers))
    fine = shortest_path(fine_nodes, fine_edges, earth_moon.start_id(), earth_moon.goal_id(layers))

    assert coarse.obstacles_touched == 0 and fine.obstacles_touched == 0  # both clear the obstacle
    # The finer graph clears it with a tighter detour and a shorter overall path.
    assert max_lateral_excursion(fine, fine_nodes) < max_lateral_excursion(coarse, coarse_nodes)
    assert fine.total_distance_km <= coarse.total_distance_km


def test_edge_penalty_avoids_obstacle_pierced_between_clear_endpoints():
    """The node-based `blocked` flag can't see a keep-out zone a straight hop flies *through* when both
    its endpoints sit outside the zone. A segment-aware `edge_penalty` must catch and route around it."""
    nodes = {
        "start": Node("start", (0, 0, 0), 0, sunlit=True, earth_visible=True),
        "B": Node("B", (0, 5, 0), 1, sunlit=True, earth_visible=True),
        "goal": Node("goal", (10, 0, 0), 2, sunlit=True, earth_visible=True),
    }
    edges = {"start": ["B", "goal"], "B": ["goal"]}
    weights = Weights(distance=1.0, darkness=0.0, no_comm=0.0)

    # Sphere straddling the straight start->goal segment at (5,0,0); neither endpoint is inside it.
    center, radius = np.array([5.0, 0.0, 0.0]), 1.0

    def edge_penalty(a, b):
        p0, p1 = np.array(a.position_km), np.array(b.position_km)
        d = p1 - p0
        t = max(0.0, min(1.0, float(np.dot(center - p0, d) / np.dot(d, d))))
        closest = p0 + t * d
        return 1.0e6 if np.linalg.norm(center - closest) <= radius else 0.0

    direct = shortest_path(nodes, edges, "start", "goal", weights)
    assert direct.node_ids == ["start", "goal"]  # without the penalty it hops straight through

    routed = shortest_path(nodes, edges, "start", "goal", weights, edge_penalty=edge_penalty)
    assert routed.node_ids == ["start", "B", "goal"]  # detours around the sphere
    assert routed.obstacles_touched == 0


def test_corridor_segment_obstacle_penalty_routes_around_between_layer_obstacle():
    """A small keep-out sphere parked between two layers — too small for any *node* to fall inside —
    is still pierced by the straight center-to-center hop. `segment_obstacle_penalty` must detect that
    and force a detour; the node-only model alone would thread right through it."""
    from backend.pathfinding.earth_moon import _segment_pierces_sphere

    epoch = datetime(2027, 1, 15, tzinfo=timezone.utc)
    layers = 12
    weights = Weights(distance=1.0, darkness=0.0, no_comm=0.0)
    nodes, edges = earth_moon.build_corridor_graph(epoch, layers=layers, lateral_steps=6, lateral_spread_km=3000.0)

    k = layers // 2
    a_pos = np.array(nodes[f"L{k}_0"].position_km)
    b_pos = np.array(nodes[f"L{k + 1}_0"].position_km)
    center = (a_pos + b_pos) / 2.0  # midway between two adjacent on-axis nodes
    obstacle = earth_moon.Obstacle(position_km=tuple(center), radius_km=500.0)

    # No node lands inside this sphere (layers are ~16,000 km apart; the midpoint is ~8,000 km away).
    assert not any(np.linalg.norm(np.array(n.position_km) - center) <= 500.0 for n in nodes.values())

    def pierces_any_hop(result):
        return any(_segment_pierces_sphere(np.array(nodes[u].position_km), np.array(nodes[v].position_km),
                                           center, 500.0)
                   for u, v in zip(result.node_ids, result.node_ids[1:], strict=False))

    # Without a segment-aware penalty the cheapest path is the straight center line, which pierces it.
    naive = shortest_path(nodes, edges, earth_moon.start_id(), earth_moon.goal_id(layers), weights)
    assert pierces_any_hop(naive)

    # With it, the search detours so no hop pierces the sphere.
    edge_penalty = earth_moon.segment_obstacle_penalty([obstacle], weights)
    routed = shortest_path(nodes, edges, earth_moon.start_id(), earth_moon.goal_id(layers), weights,
                           heuristic=earth_moon.distance_heuristic(nodes, earth_moon.goal_id(layers), weights),
                           edge_penalty=edge_penalty)
    assert not pierces_any_hop(routed)
    assert routed.obstacles_touched == 0


def test_lighting_hook_prices_and_reports_segment_fractions():
    """A `lighting` hook must price darkness/lost-comm from the fraction of the hop in shadow / out of
    comm (not the endpoint flag), and report those same fractions — cost and metrics stay in lockstep."""
    nodes = {
        "start": Node("start", (0, 0, 0), 0, sunlit=True, earth_visible=True),
        "goal": Node("goal", (10, 0, 0), 1, sunlit=True, earth_visible=True),
    }
    edges = {"start": ["goal"]}
    weights = Weights(distance=1.0, darkness=2.0, no_comm=4.0)

    # Node flags say fully lit / in comm; the hook says the segment is half-lit and a quarter in comm.
    plain = shortest_path(nodes, edges, "start", "goal", weights)
    assert plain.cost == pytest.approx(10.0)  # distance only
    assert plain.sunlit_fraction == 1.0 and plain.earth_comm_fraction == 1.0

    lit = shortest_path(nodes, edges, "start", "goal", weights, lighting=lambda a, b: (0.5, 0.25))
    # 10 (dist) + 2*(1-0.5)*10 (dark) + 4*(1-0.25)*10 (no-comm) = 10 + 10 + 30
    assert lit.cost == pytest.approx(50.0)
    assert lit.sunlit_fraction == pytest.approx(0.5)
    assert lit.earth_comm_fraction == pytest.approx(0.25)


def test_lighting_hook_reroutes_around_a_dark_segment():
    """Two routes identical to the node-flag model; a hook that sees one route's hops dip through shadow
    must push the search onto the longer-but-lit route."""
    nodes = {
        "start": Node("start", (0, 0, 0), 0, sunlit=True, earth_visible=True),
        "M": Node("M", (5, 0, 0), 1, sunlit=True, earth_visible=True),
        "B": Node("B", (0, 5, 0), 1, sunlit=True, earth_visible=True),
        "goal": Node("goal", (10, 0, 0), 2, sunlit=True, earth_visible=True),
    }
    edges = {"start": ["M", "B"], "M": ["goal"], "B": ["goal"]}
    weights = Weights(distance=1.0, darkness=5.0, no_comm=0.0)

    # Node flags alone pick the short straight hop through M.
    assert shortest_path(nodes, edges, "start", "goal", weights).node_ids == ["start", "M", "goal"]

    def lighting(a, b):  # any hop touching M is fully dark; everything else fully lit
        return (0.0, 1.0) if "M" in (a.id, b.id) else (1.0, 1.0)

    routed = shortest_path(nodes, edges, "start", "goal", weights, lighting=lighting)
    assert routed.node_ids == ["start", "B", "goal"]
    assert routed.sunlit_fraction == pytest.approx(1.0)


def test_cosine_spacing_clusters_layers_near_the_endpoints():
    """`spacing="cosine"` must put the layers closer together near Earth and the Moon (where the shadow
    and comm edges live) and farther apart through the middle cruise, vs uniform for the same count."""
    epoch = datetime(2027, 1, 15, tzinfo=timezone.utc)
    layers = 21

    def center_gaps(spacing):
        nodes, _ = earth_moon.build_corridor_graph(epoch, layers=layers, lateral_steps=4, spacing=spacing)
        centers = [np.array(nodes[f"L{i}_0"].position_km) for i in range(layers)]
        end_gap = float(np.linalg.norm(centers[1] - centers[0]))
        mid = layers // 2
        mid_gap = float(np.linalg.norm(centers[mid + 1] - centers[mid]))
        return end_gap, mid_gap

    uni_end, uni_mid = center_gaps("uniform")
    cos_end, cos_mid = center_gaps("cosine")
    assert uni_end == pytest.approx(uni_mid, rel=1e-6)  # uniform is, well, uniform
    assert cos_end < uni_end          # denser at the endpoints
    assert cos_mid > uni_mid          # sparser through the middle


def test_build_corridor_rejects_unknown_spacing():
    epoch = datetime(2027, 1, 15, tzinfo=timezone.utc)
    with pytest.raises(ValueError):
        earth_moon.build_corridor_graph(epoch, layers=6, spacing="quadratic")


def test_segment_lighting_returns_valid_fractions_and_is_exact_when_lit():
    """`segment_lighting` must return (sunlit, comm) fractions in [0, 1]; for this fully-sunlit transfer
    epoch the chosen path's reported fractions come out at 1.0 under sampling, matching the node model."""
    epoch = datetime(2027, 1, 15, tzinfo=timezone.utc)
    layers = 16
    nodes, edges = earth_moon.build_corridor_graph(epoch, layers=layers, lateral_steps=4)
    lighting = earth_moon.segment_lighting(epoch, samples=8)

    for u, vs in edges.items():
        for v in vs:
            sunlit_frac, comm_frac = lighting(nodes[u], nodes[v])
            assert 0.0 <= sunlit_frac <= 1.0 and 0.0 <= comm_frac <= 1.0

    goal = earth_moon.goal_id(layers)
    sampled = shortest_path(nodes, edges, earth_moon.start_id(), goal, Weights(),
                            heuristic=earth_moon.distance_heuristic(nodes, goal, Weights()), lighting=lighting)
    assert sampled.sunlit_fraction == pytest.approx(1.0)
    assert sampled.earth_comm_fraction == pytest.approx(1.0)


def test_earth_moon_obstacle_is_routed_around():
    epoch = datetime(2027, 1, 15, tzinfo=timezone.utc)
    layers = 8
    nodes, _ = earth_moon.build_corridor_graph(epoch, layers=layers, lateral_steps=4)
    mid_id = f"L{layers // 2}_0"
    # Radius smaller than the default lateral_spread_km (3000 km): the center node is blocked but the
    # ring of lateral alternatives at that same layer is not, so a detour actually exists to find.
    obstacle = earth_moon.Obstacle(position_km=nodes[mid_id].position_km, radius_km=1000.0)

    nodes_blocked, edges_blocked = earth_moon.build_corridor_graph(
        epoch, layers=layers, lateral_steps=4, obstacles=[obstacle],
    )
    assert nodes_blocked[mid_id].blocked

    result = shortest_path(nodes_blocked, edges_blocked, earth_moon.start_id(), earth_moon.goal_id(layers))
    assert mid_id not in result.node_ids
    assert result.obstacles_touched == 0
