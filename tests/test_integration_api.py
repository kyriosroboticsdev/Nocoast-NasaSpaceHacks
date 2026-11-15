"""Coordinate power handoff at the HTTP boundary, with actual JPL geometry and mocked terrain."""
import pytest
from fastapi.testclient import TestClient

from backend import analysis, terrain
from backend.app import app
from backend.config import SITES

client = TestClient(app)
WINDOW = {"startUtc": "2027-01-15T00:00:00Z", "endUtc": "2027-01-15T01:00:00Z"}


@pytest.fixture
def measured_profile(monkeypatch):
    calls = []

    def profile(lat, lon):
        calls.append((lat, lon))
        return {"azimuthStartDeg": 0, "azimuthStepDeg": 0.25, "sampleCount": 1440,
                "elevationDeg": [0.0] * 1440, "siteElevationM": 1200 + lon,
                "siteElevationMethod": "synthetic API-boundary fixture", "source": "test terrain fixture",
                "observerHeightAboveGroundM": 2, "terrainQuality": "fallback"}

    monkeypatch.setattr(terrain, "horizon_profile", profile)
    return calls


@pytest.mark.parametrize("site", SITES, ids=lambda site: site["siteId"])
def test_all_catalog_sites_receive_solar_input(site, measured_profile):
    response = client.get(f"/api/solar_input/{site['siteId']}", params=WINDOW)
    assert response.status_code == 200
    artifact = response.json()
    assert artifact["siteId"] == site["siteId"]
    assert artifact["site"]["latitudeDeg"] == site["latitudeDeg"]
    assert artifact["site"]["longitudeEastDeg"] == site["longitudeEastDeg"]
    assert artifact["site"]["surfaceElevationM"] == 1200 + site["longitudeEastDeg"]
    assert artifact["provenance"]["visibility"]["terrainQuality"] == "fallback"
    assert artifact["provenance"]["visibility"]["validation"]["status"] == "pending"
    assert len(measured_profile) == 1


def test_analysis_reuses_one_profile_and_preserves_antenna_and_relay(measured_profile):
    site = SITES[2]
    response = client.get("/api/analyze", params={**WINDOW, "latitudeDeg": site["latitudeDeg"],
        "longitudeEastDeg": site["longitudeEastDeg"], "relay": "true",
        "antennaBoresightAzimuthDeg": 0, "antennaBoresightElevationDeg": 5})
    assert response.status_code == 200
    result = response.json()
    assert result["antenna"]["modeled"] and result["relay"] is not None
    assert result["solarInput"]["siteId"] == site["siteId"]
    assert result["solarInput"]["site"]["surfaceElevationM"] == result["site"]["surfaceElevationM"]
    assert result["solarInputUnavailableReason"] is None
    assert len(measured_profile) == 1


def test_custom_coordinates_are_canonical_and_date_specific(measured_profile):
    query = {**WINDOW, "latitudeDeg": -88.12345649, "longitudeEastDeg": -10.12345649}
    a = client.get("/api/analyze", params=query).json()
    b = client.get("/api/analyze", params={**query, "latitudeDeg": -87.12345649}).json()
    shifted = client.get("/api/analyze", params={**query, "startUtc": "2027-01-16T00:00:00Z",
                                               "endUtc": "2027-01-16T01:00:00Z"}).json()
    artifact = a["solarInput"]
    assert artifact["siteId"] == "moon--88.123456-349.876544"
    assert artifact["siteId"] == a["site"]["siteId"]
    assert artifact["site"]["latitudeDeg"] == a["site"]["latitudeDeg"] == -88.123456
    assert artifact["site"]["longitudeEastDeg"] == a["site"]["longitudeEastDeg"] == 349.876544
    assert artifact["siteId"] != b["solarInput"]["siteId"]
    assert artifact["artifactId"] != shifted["solarInput"]["artifactId"]
    assert artifact["samples"][0]["sun"] != shifted["solarInput"]["samples"][0]["sun"]
    assert a["relay"] is None and a["commsEffective"] is None
    direct = client.get("/api/solar_input", params=query).json()
    assert direct["siteId"] == artifact["siteId"]
    assert direct["samples"] == artifact["samples"]
    assert measured_profile[0] == (-88.123456, 349.876544)


def test_longitude_wrapping_keeps_the_same_identity_and_samples(measured_profile):
    query = {**WINDOW, "latitudeDeg": -88.12345649}
    a = client.get("/api/solar_input", params={**query, "longitudeEastDeg": -10.12345649}).json()
    b = client.get("/api/solar_input", params={**query, "longitudeEastDeg": 349.87654351}).json()
    assert a["siteId"] == b["siteId"]
    assert a["site"] == b["site"]
    assert a["samples"] == b["samples"]
    assert analysis.solar_site(-0.0, 359.9999999)["siteId"] == analysis.solar_site(0, 0)["siteId"]


def test_missing_surface_elevation_remains_unknown_instead_of_zero(monkeypatch):
    def missing_profile(*_):
        return {"azimuthStartDeg": 0, "azimuthStepDeg": 0.25, "sampleCount": 1440,
                "elevationDeg": [None] * 1440, "siteElevationM": None, "terrainQuality": "none",
                "observerHeightAboveGroundM": 2, "source": "missing measured terrain"}

    monkeypatch.setattr(terrain, "horizon_profile", missing_profile)
    query = {**WINDOW, "latitudeDeg": 0, "longitudeEastDeg": 0}
    response = client.get("/api/analyze", params=query)
    assert response.status_code == 200
    result = response.json()
    assert result["solarInput"] is None
    assert "surface elevation" in result["solarInputUnavailableReason"]
    assert result["site"]["surfaceElevationM"] is None
    assert result["series"]["sunElevationDeg"]
    assert result["sun"]["summary"]["percentOfMission"] is None
    direct = client.get("/api/solar_input", params=query)
    assert direct.status_code == 200
    assert direct.json()["solarInput"] is None
    assert "surface elevation" in direct.json()["solarInputUnavailableReason"]
    # A catalog coordinate must not substitute its catalog height when the actual terrain is missing.
    named = client.get(f"/api/solar_input/{SITES[0]['siteId']}", params=WINDOW).json()
    assert named["solarInput"] is None


def test_known_surface_with_missing_horizon_returns_missing_visibility(monkeypatch):
    monkeypatch.setattr(terrain, "horizon_profile", lambda *_: {
        "azimuthStartDeg": 0, "azimuthStepDeg": 0.25, "sampleCount": 1440,
        "elevationDeg": [None] * 1440, "siteElevationM": 1400, "terrainQuality": "none",
        "observerHeightAboveGroundM": 2, "source": "partial terrain fixture"})
    response = client.get("/api/analyze", params={**WINDOW, "latitudeDeg": -88.1, "longitudeEastDeg": 35})
    assert response.status_code == 200
    result = response.json()
    assert result["solarInputUnavailableReason"] is None
    assert result["solarInput"]["site"]["surfaceElevationM"] == 1400
    assert all(s["solarVisibleFraction"] is None and s["quality"]["status"] == "missing"
               for s in result["solarInput"]["samples"])


@pytest.mark.parametrize("params,status", [
    ({"latitudeDeg": -91, "longitudeEastDeg": 0}, 422),
    ({"latitudeDeg": -88, "longitudeEastDeg": 0, "startUtc": "bad"}, 400),
    ({"latitudeDeg": -88, "longitudeEastDeg": 0, "startUtc": "2027-01-15T00:00:00.500Z"}, 400),
    ({"latitudeDeg": -88, "longitudeEastDeg": 0, "endUtc": "2027-04-01T00:00:00Z"}, 400),
    ({"latitudeDeg": -88, "longitudeEastDeg": 0, "endUtc": WINDOW["startUtc"]}, 400),
])
def test_coordinate_endpoint_rejects_invalid_coordinates_or_windows(params, status, measured_profile):
    for path in ["/api/analyze", "/api/solar_input"]:
        response = client.get(path, params={**WINDOW, **params})
        assert response.status_code == status
    assert measured_profile == []


def test_existing_unknown_catalog_id_stays_404():
    assert client.get("/api/solar_input/not-a-catalog-site", params=WINDOW).status_code == 404


@pytest.mark.parametrize("lat,lon", [(-88.811008, 123.690068), (-89.45, 222.6)])
def test_real_nasa_profile_and_ephemeris_supply_power_input_beyond_two_old_ids(lat, lon):
    response = client.get("/api/analyze", params={**WINDOW, "latitudeDeg": lat, "longitudeEastDeg": lon})
    assert response.status_code == 200
    result = response.json()
    artifact = result["solarInput"]
    assert artifact is not None and result["solarInputUnavailableReason"] is None
    assert artifact["site"]["surfaceElevationM"] == result["site"]["surfaceElevationM"]
    assert artifact["samples"][0]["timeUtc"] == WINDOW["startUtc"]
    assert artifact["samples"][-1]["timeUtc"] == WINDOW["endUtc"]
    assert all(0.97 < sample["sun"]["rangeAu"] < 1.03 for sample in artifact["samples"])
    assert artifact["provenance"]["visibility"]["validation"]["status"] == "pending"
