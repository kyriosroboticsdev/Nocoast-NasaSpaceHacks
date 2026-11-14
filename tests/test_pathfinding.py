"""Tests for backend/pathfinding/: the generic multi-objective search (graph.py) and the Earth<->Moon
corridor builder on top of it (earth_moon.py)."""
from __future__ import annotations

from datetime import datetime, timezone

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
