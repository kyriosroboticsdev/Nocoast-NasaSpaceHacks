"""The solar-input handoff to Person 3's power model (docs/solar/INPUT_CONTRACT.md on the solar branch)."""
from backend import analysis
from backend.config import SITES, parse_utc


def test_solar_input_envelope_and_samples():
    site = SITES[0]
    start, end = parse_utc("2027-01-01T00:00:00Z"), parse_utc("2027-01-31T00:00:00Z")
    d = analysis.solar_input(site, start, end)
    assert d["schemaVersion"] == "0.1.0" and d["artifactType"] == "solar-input"
    assert d["frameId"] == "MOON_ME_DE421" and d["siteId"] == site["siteId"]
    assert d["site"]["latitudeDeg"] == site["latitudeDeg"] and d["site"]["referenceRadiusM"] == 1737400
    assert d["observerHeightAboveGroundM"] == 2
    assert d["time"]["baseStepSeconds"] == 600 and d["time"]["visibilityInterpolation"] == "previous-sample-hold"
    assert d["provenance"]["visibility"]["mode"] == "terrain"

    s = d["samples"]
    times = [parse_utc(x["timeUtc"]) for x in s]
    assert times[0] == start and times[-1] == end                       # exact mission boundaries
    gaps = [(b - a).total_seconds() for a, b in zip(times, times[1:], strict=False)]
    assert all(0 < g <= 600 for g in gaps)                              # strictly increasing, no gap > 600 s
    assert any(g == 60 for g in gaps)                                   # sunrise/sunset refined to 60 s
    for x in s:
        assert 0 <= x["sun"]["azimuthDeg"] < 360
        assert 0.97 < x["sun"]["rangeAu"] < 1.03
        assert x["solarVisibleFraction"] in (0.0, 1.0)
        assert x["quality"] == {"status": "valid", "reason": None}


def test_solar_visibility_matches_analysis():
    site = SITES[1]
    start, end = parse_utc("2027-03-01T00:00:00Z"), parse_utc("2027-03-15T00:00:00Z")
    d = analysis.solar_input(site, start, end)
    r = analysis.analyze(site["latitudeDeg"], site["longitudeEastDeg"], start, end)
    lit = {w["startUtc"] for w in r["sun"]["sunlitWindows"]}
    rises = [x["timeUtc"] for a, x in zip(d["samples"], d["samples"][1:], strict=False)
             if a["solarVisibleFraction"] == 0 and x["solarVisibleFraction"] == 1]
    assert set(rises) <= lit                                            # same sunrise times as the analysis
