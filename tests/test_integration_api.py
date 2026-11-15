"""Exercise the assembled API rather than only the separate science functions."""
import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.config import SITES

client = TestClient(app)
WINDOW = {"startUtc": "2027-01-15T00:00:00Z", "endUtc": "2027-01-15T01:00:00Z"}


def test_analysis_preserves_antenna_relay_and_solar_handoff():
    site = SITES[0]
    response = client.get("/api/analyze", params={
        **WINDOW, "latitudeDeg": site["latitudeDeg"], "longitudeEastDeg": site["longitudeEastDeg"],
        "relay": "true", "antennaBoresightAzimuthDeg": 0, "antennaBoresightElevationDeg": 5,
    })
    assert response.status_code == 200
    r = response.json()
    assert r["relay"] is not None and r["antenna"]["modeled"]
    assert r["solarInput"]["siteId"] == site["siteId"]
    assert r["solarInput"]["time"]["endUtc"] == WINDOW["endUtc"]
    assert r["solarInput"]["provenance"]["visibility"]["validation"]["status"] == "pending"
    assert r["commsEffective"]["summary"]["totalSeconds"] >= r["communication"]["summary"]["totalSeconds"]
    standalone = client.get(f"/api/solar_input/{site['siteId']}", params=WINDOW).json()
    assert standalone["samples"] == r["solarInput"]["samples"]


def test_navigator_defaults_to_direct_contact_and_extra_sites_keep_power_unknown():
    r = client.get("/api/analyze", params={**WINDOW, "latitudeDeg": SITES[2]["latitudeDeg"],
                                          "longitudeEastDeg": SITES[2]["longitudeEastDeg"]}).json()
    assert r["relay"] is None and r["solarInput"] is None
    response = client.get(f"/api/solar_input/{SITES[2]['siteId']}", params=WINDOW)
    assert response.status_code == 400
    assert "CR1 and SR1" in response.json()["detail"]


@pytest.mark.parametrize("path", ["/", "/navigator.html", "/terrain.html"])
def test_all_production_pages_are_built_and_served(path):
    response = client.get(path)
    assert response.status_code == 200
    assert '<html lang="en">' in response.text


def test_zero_objective_weights_fail_clearly_instead_of_dividing_by_zero():
    response = client.get("/api/sweep", params={"latitudeDeg": SITES[0]["latitudeDeg"],
                          "longitudeEastDeg": SITES[0]["longitudeEastDeg"], "sweepDays": 1,
                          "missionSeconds": 3600, "relay": "false", "wSun": 0, "wComm": 0, "wBoth": 0})
    assert response.status_code == 400
    assert "positive" in response.json()["detail"]
