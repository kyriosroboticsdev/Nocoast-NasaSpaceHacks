"""Relay-augmented communication: a polar relay must add contact at sites where direct-to-Earth fails,
without ever reducing it, and the joint optimiser must rank sites by sun+comms."""
from __future__ import annotations

from datetime import datetime, timezone

from backend import analysis
from backend.relay import RelayConfig

START = datetime(2027, 1, 15, tzinfo=timezone.utc)
END = datetime(2027, 1, 22, tzinfo=timezone.utc)
# A spot where Earth never clears the local terrain horizon over this window (DTE ~ 0%).
DTE_POOR = (-86.0, 45.0)


def test_relay_adds_comms_where_direct_to_earth_fails():
    r = analysis.analyze(*DTE_POOR, START, END)
    dte = r["communication"]["summary"]["percentOfMission"]
    eff = r["commsEffective"]["summary"]["percentOfMission"]
    assert dte < 5.0                      # direct-to-Earth is essentially dead here
    assert eff > 80.0                     # the relay buys most of it back
    assert r["relay"]["addedCommsSeconds"] > 0


def test_relay_never_reduces_direct_to_earth():
    # At a good comms site DTE is already high; effective must be >= DTE, never worse.
    r = analysis.analyze(-89.45, 222.6, START, END)
    assert (r["commsEffective"]["summary"]["percentOfMission"] + 1e-9
            >= r["communication"]["summary"]["percentOfMission"])


def test_single_relay_has_real_gaps_not_always_on():
    # One satellite cannot cover the pole continuously — it must rise and set.
    r = analysis.analyze(*DTE_POOR, START, END, relay_cfg=RelayConfig(num_sats=1))
    pct = r["relay"]["summary"]["percentOfMission"]
    assert 0.0 < pct < 95.0
    assert r["relay"]["summary"]["windowCount"] > 1


def test_more_sats_never_reduce_relay_coverage():
    one = analysis.analyze(*DTE_POOR, START, END, relay_cfg=RelayConfig(num_sats=1))
    three = analysis.analyze(*DTE_POOR, START, END, relay_cfg=RelayConfig(num_sats=3))
    assert (three["relay"]["summary"]["percentOfMission"]
            >= one["relay"]["summary"]["percentOfMission"] - 1e-9)


def test_relay_off_omits_relay_fields():
    r = analysis.analyze(*DTE_POOR, START, END, relay_cfg=None)
    assert r["relay"] is None and r["commsEffective"] is None
    assert r["series"]["relayVisible"] is None


def test_effective_simultaneous_is_subset_of_each():
    r = analysis.analyze(*DTE_POOR, START, END)
    both = r["sunAndCommunicationEffective"]["summary"]["percentOfMission"]
    assert both <= r["sun"]["summary"]["percentOfMission"] + 1e-9
    assert both <= r["commsEffective"]["summary"]["percentOfMission"] + 1e-9


def test_sweep_carries_objective_and_best_day():
    sw = analysis.landing_sweep(*DTE_POOR, START, sweep_days=5, mission_s=7 * 86400)
    present = [d for d in sw["days"] if not d.get("missing")]
    assert present and sw["bestDateUtc"] is not None
    for d in present:
        assert d["commWithRelayPercent"] >= d["commPercent"] - 1e-9     # relay only adds
        assert 0.0 <= d["objectiveScore"] <= 100.0
    assert sw["bestScore"] == max(d["objectiveScore"] for d in present)


def test_optimize_ranks_sites_and_picks_a_best():
    sites = [{"id": "good", "lat": -89.45, "lon": 222.6}, {"id": "poor", "lat": DTE_POOR[0], "lon": DTE_POOR[1]}]
    out = analysis.optimize(sites, START, sweep_days=4, mission_s=7 * 86400)
    assert out["best"] is not None
    scores = [r["objectiveScore"] for r in out["ranked"] if r.get("objectiveScore") is not None]
    assert scores == sorted(scores, reverse=True)       # ranked best-first
    assert out["best"]["objectiveScore"] == scores[0]
