"""FastAPI server: Person 2 JSON API + verification dashboard.  Run:  python -m uvicorn backend.app:app"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import analysis, polarmap, terrain
from .config import CONTRACT, ROOT, SITES, TIME, parse_utc
from .relay import DEFAULT_RELAY, RelayConfig

app = FastAPI(title="Lunar Navigator: Sun, Earth & Communication")
DIST = ROOT / "dist"


def _times(start_utc: str, end_utc: str):
    try:
        return parse_utc(start_utc), parse_utc(end_utc)
    except ValueError as e:
        raise HTTPException(400, f"bad UTC timestamp (expected {TIME['serialization']})") from e


def _relay_cfg(relay: bool, altitude_km: float, num_sats: int, inclination_deg: float, min_el_deg: float) -> RelayConfig | None:
    """Build a relay config from query params, or None when the relay is switched off."""
    if not relay:
        return None
    return RelayConfig(altitude_km=altitude_km, num_sats=num_sats,
                       inclination_deg=inclination_deg, min_elevation_deg=min_el_deg)


def _weights(w_sun: float, w_comm: float, w_both: float) -> dict:
    return {"sun": w_sun, "comm": w_comm, "both": w_both}


def _site(site_id: str) -> dict:
    for s in SITES:
        if s["siteId"] == site_id:
            return s
    raise HTTPException(404, f"unknown siteId {site_id}")


@app.get("/api/contract")
def contract():
    return CONTRACT


@app.get("/api/sites")
def sites():
    return SITES


@app.get("/api/analyze")
def analyze(latitudeDeg: float = Query(..., ge=-90, le=90),
            longitudeEastDeg: float = Query(..., ge=-360, le=360),
            startUtc: str = TIME["defaultStartUtc"], endUtc: str = TIME["defaultEndUtc"],
            antennaMinElevationDeg: float | None = Query(None, ge=-5, le=60),
            relay: bool = Query(True), relayAltitudeKm: float = Query(DEFAULT_RELAY.altitude_km, ge=100, le=70000),
            relaySats: int = Query(DEFAULT_RELAY.num_sats, ge=1, le=8),
            relayInclinationDeg: float = Query(DEFAULT_RELAY.inclination_deg, ge=0, le=180),
            relayMinElevationDeg: float = Query(DEFAULT_RELAY.min_elevation_deg, ge=0, le=45)):
    start, end = _times(startUtc, endUtc)
    cfg = _relay_cfg(relay, relayAltitudeKm, relaySats, relayInclinationDeg, relayMinElevationDeg)
    try:
        return analysis.analyze(latitudeDeg, longitudeEastDeg, start, end, antennaMinElevationDeg, relay_cfg=cfg)
    except analysis.WindowError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/export/{site_id}")
def export(site_id: str, startUtc: str = TIME["defaultStartUtc"], endUtc: str = TIME["defaultEndUtc"],
           antennaMinElevationDeg: float | None = Query(None, ge=-5, le=60)):
    """Quest-app time series for a contract site, as a downloadable JSON file."""
    s = _site(site_id)
    start, end = _times(startUtc, endUtc)
    try:
        r = analysis.analyze(s["latitudeDeg"], s["longitudeEastDeg"], start, end, antennaMinElevationDeg)
    except analysis.WindowError as e:
        raise HTTPException(400, str(e)) from e
    r["site"]["siteId"] = site_id
    fname = f"{site_id}_{startUtc[:10]}_{endUtc[:10]}.json"
    return JSONResponse(r, headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.get("/api/solar_input/{site_id}")
def solar_input(site_id: str, startUtc: str = TIME["defaultStartUtc"], endUtc: str = TIME["defaultEndUtc"]):
    """Person 3 power-model input (`solar-input` 0.1.0) for a contract site, built from this backend's Sun data."""
    s = _site(site_id)
    start, end = _times(startUtc, endUtc)
    try:
        return analysis.solar_input(s, start, end)
    except analysis.WindowError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/sweep")
def sweep(latitudeDeg: float = Query(..., ge=-90, le=90), longitudeEastDeg: float = Query(..., ge=-360, le=360),
          firstDayUtc: str = TIME["supportedStartUtc"], sweepDays: int = Query(90, ge=1, le=366),
          missionSeconds: float = Query(2592000, gt=0),
          antennaMinElevationDeg: float | None = Query(None, ge=-5, le=60),
          relay: bool = Query(True), relaySats: int = Query(DEFAULT_RELAY.num_sats, ge=1, le=8),
          relayAltitudeKm: float = Query(DEFAULT_RELAY.altitude_km, ge=100, le=70000),
          wSun: float = Query(1.0, ge=0), wComm: float = Query(1.3, ge=0), wBoth: float = Query(0.8, ge=0)):
    first = parse_utc(firstDayUtc).replace(hour=0, minute=0, second=0)
    cfg = _relay_cfg(relay, relayAltitudeKm, relaySats, DEFAULT_RELAY.inclination_deg, DEFAULT_RELAY.min_elevation_deg)
    try:
        return analysis.landing_sweep(latitudeDeg, longitudeEastDeg, first, sweepDays, missionSeconds,
                                      antennaMinElevationDeg, relay_cfg=cfg, weights=_weights(wSun, wComm, wBoth))
    except analysis.WindowError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/optimize")
def optimize(firstDayUtc: str = TIME["supportedStartUtc"], sweepDays: int = Query(30, ge=1, le=120),
             missionSeconds: float = Query(1209600, gt=0), antennaMinElevationDeg: float | None = Query(None, ge=-5, le=60),
             relay: bool = Query(True), relaySats: int = Query(DEFAULT_RELAY.num_sats, ge=1, le=8),
             relayAltitudeKm: float = Query(DEFAULT_RELAY.altitude_km, ge=100, le=70000),
             wSun: float = Query(1.0, ge=0), wComm: float = Query(1.3, ge=0), wBoth: float = Query(0.8, ge=0),
             extraSites: list[str] = Query(default=[])):
    """Find the (site, landing day) that maximises sun + communication over the contract sites (plus any
    `extraSites=lat,lon` candidates). Returns the single best pick and the full ranking."""
    first = parse_utc(firstDayUtc).replace(hour=0, minute=0, second=0)
    candidates = [{"id": s["siteId"], "name": s.get("displayName"), "lat": s["latitudeDeg"], "lon": s["longitudeEastDeg"]}
                  for s in SITES]
    for i, pair in enumerate(extraSites):
        try:
            la, lo = (float(x) for x in pair.split(","))
        except ValueError as e:
            raise HTTPException(400, f"extraSites must be 'lat,lon'; got {pair!r}") from e
        candidates.append({"id": f"custom-{i}", "name": f"Custom {i + 1}", "lat": la, "lon": lo})
    cfg = _relay_cfg(relay, relayAltitudeKm, relaySats, DEFAULT_RELAY.inclination_deg, DEFAULT_RELAY.min_elevation_deg)
    try:
        return analysis.optimize(candidates, first, sweepDays, missionSeconds, antennaMinElevationDeg,
                                 relay_cfg=cfg, weights=_weights(wSun, wComm, wBoth))
    except analysis.WindowError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/local_terrain")
def local_terrain(latitudeDeg: float = Query(..., ge=-90, le=-60),
                  longitudeEastDeg: float = Query(..., ge=-360, le=360),
                  halfExtentM: float = Query(6000, ge=100, le=20000), n: int = Query(241, ge=17, le=321)):
    """Height grid around a site (for the 3D sky view), from the same NASA terrain maps as the horizons."""
    return terrain.local_grid(round(latitudeDeg, 6), round(longitudeEastDeg % 360.0, 6), halfExtentM, n)


@app.get("/api/polar_map/meta")
def polar_map_meta():
    return polarmap.meta()


@app.get("/api/polar_map.png")
def polar_map_png():
    return Response(polarmap.png_bytes(), media_type="image/png", headers={"Cache-Control": "max-age=86400"})


# Production: serve the built website (`npm run build` -> dist/) from the same server as the API.
# During development, Vite serves the pages and proxies /api here instead.
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="site")
