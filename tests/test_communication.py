"""Visibility rules, events, windows and blackouts vs the team contract."""
import re

import numpy as np
import pytest

from backend import analysis
from backend.config import SITES, parse_utc

CR1 = SITES[0]
START, END = parse_utc("2027-01-01T00:00:00Z"), parse_utc("2027-01-31T00:00:00Z")
TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


@pytest.fixture(scope="module")
def cr1():
    return analysis.analyze(CR1["latitudeDeg"], CR1["longitudeEastDeg"], START, END)


def test_strict_greater_than():
    s = analysis._state(np.array([1.0, 1.0, 1.0]), np.array([0.999, 1.0, np.nan]))
    assert s.tolist() == [1, 0, analysis.UNKNOWN]


def test_timestamps_serialised_per_contract(cr1):
    assert all(TS.match(t) for t in cr1["series"]["timesUtc"][:50])
    assert all(TS.match(e["timeUtc"]) for e in cr1["events"])
    assert cr1["series"]["timesUtc"][0] == "2027-01-01T00:00:00Z"
    assert cr1["series"]["timesUtc"][-1] < "2027-01-31T00:00:00Z"            # end-exclusive


def test_events_bracketed_to_60s(cr1):
    assert cr1["events"], "expected at least one rise/set in 30 days"
    assert all(e["bracketSeconds"] == 60 for e in cr1["events"])


@pytest.mark.parametrize("key,ups,downs", [("communication", "windows", "blackouts"),
                                          ("sun", "sunlitWindows", "darkPeriods")])
def test_windows_and_gaps_tile_the_mission(cr1, key, ups, downs):
    blk = cr1[key]
    spans = sorted(blk[ups] + blk[downs], key=lambda w: w["startUtc"])
    assert spans[0]["startUtc"] == cr1["startUtc"] and spans[-1]["endUtc"] == cr1["endUtc"]
    for a, b in zip(spans, spans[1:], strict=False):
        assert a["endUtc"] == b["startUtc"]                                  # start-inclusive/end-exclusive
    total = sum(w["durationSeconds"] for w in spans)
    assert total == (END - START).total_seconds()
    longest = max((g["durationSeconds"] for g in blk[downs]), default=0)
    assert blk["summary"]["longestGapSeconds"] == longest


def test_series_agrees_with_windows(cr1):
    s = cr1["series"]
    wins = [(parse_utc(w["startUtc"]), parse_utc(w["endUtc"])) for w in cr1["communication"]["windows"]]
    for t, v in zip(s["timesUtc"][::37], s["earthVisible"][::37], strict=True):
        tt = parse_utc(t)
        assert v == any(a <= tt < b for a, b in wins)


def test_antenna_min_elevation_constraint():
    lo = analysis.analyze(CR1["latitudeDeg"], CR1["longitudeEastDeg"], START, END, antenna_min=0.0)
    hi = analysis.analyze(CR1["latitudeDeg"], CR1["longitudeEastDeg"], START, END, antenna_min=3.0)
    never = analysis.analyze(CR1["latitudeDeg"], CR1["longitudeEastDeg"], START, END, antenna_min=60.0)
    assert hi["communication"]["summary"]["percentOfMission"] <= lo["communication"]["summary"]["percentOfMission"]
    assert never["communication"]["summary"]["percentOfMission"] == 0


def test_simultaneous_windows_subset(cr1):
    both = cr1["sunAndCommunication"]["summary"]["percentOfMission"]
    assert both <= cr1["sun"]["summary"]["percentOfMission"] + 1e-9
    assert both <= cr1["communication"]["summary"]["percentOfMission"] + 1e-9


@pytest.mark.parametrize("start,end", [("2026-12-31T00:00:00Z", "2027-01-10T00:00:00Z"),
                                       ("2027-12-20T00:00:00Z", "2028-01-02T00:00:00Z"),
                                       ("2027-01-01T00:00:00Z", "2027-03-03T00:00:00Z"),   # > 60 days
                                       ("2027-01-05T00:00:00Z", "2027-01-05T00:00:00Z")])
def test_window_limits(start, end):
    with pytest.raises(analysis.WindowError):
        analysis.check_window(parse_utc(start), parse_utc(end))
