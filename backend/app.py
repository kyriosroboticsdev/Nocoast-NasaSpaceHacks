"""FastAPI server: Person 2 JSON API + verification dashboard.  Run:  python -m uvicorn backend.app:app"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import analysis, polarmap, terrain
from .config import CONTRACT, ROOT, SITES, TIME, parse_utc
from .pathfinding import earth_moon
from .pathfinding.graph import NoPathError, Weights, shortest_path

app = FastAPI(title="Lunar Navigator: Sun, Earth & Communication")
DIST = ROOT / "dist"


def _times(start_utc: str, end_utc: str):
    try:
        return parse_utc(start_utc), parse_utc(end_utc)
    except ValueError as e:
        raise HTTPException(400, f"bad UTC timestamp (expected {TIME['serialization']})") from e


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
            antennaBoresightAzimuthDeg: float | None = Query(None, ge=0, le=360),
            antennaBoresightElevationDeg: float | None = Query(None, ge=-90, le=90),
            antennaBeamwidthDeg: float = Query(analysis.DEFAULT_BEAMWIDTH_DEG, gt=0, le=180)):
    start, end = _times(startUtc, endUtc)
    try:
        return analysis.analyze(latitudeDeg, longitudeEastDeg, start, end, antennaMinElevationDeg,
                                antenna_boresight_az=antennaBoresightAzimuthDeg,
                                antenna_boresight_el=antennaBoresightElevationDeg,
                                antenna_beamwidth_deg=antennaBeamwidthDeg)
    except analysis.WindowError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/export/{site_id}")
def export(site_id: str, startUtc: str = TIME["defaultStartUtc"], endUtc: str = TIME["defaultEndUtc"],
           antennaMinElevationDeg: float | None = Query(None, ge=-5, le=60),
           antennaBoresightAzimuthDeg: float | None = Query(None, ge=0, le=360),
           antennaBoresightElevationDeg: float | None = Query(None, ge=-90, le=90),
           antennaBeamwidthDeg: float = Query(analysis.DEFAULT_BEAMWIDTH_DEG, gt=0, le=180)):
    """Quest-app time series for a contract site, as a downloadable JSON file."""
    s = _site(site_id)
    start, end = _times(startUtc, endUtc)
    try:
        r = analysis.analyze(s["latitudeDeg"], s["longitudeEastDeg"], start, end, antennaMinElevationDeg,
                             antenna_boresight_az=antennaBoresightAzimuthDeg,
                             antenna_boresight_el=antennaBoresightElevationDeg,
                             antenna_beamwidth_deg=antennaBeamwidthDeg)
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
          antennaMinElevationDeg: float | None = Query(None, ge=-5, le=60)):
    first = parse_utc(firstDayUtc).replace(hour=0, minute=0, second=0)
    try:
        return analysis.landing_sweep(latitudeDeg, longitudeEastDeg, first, sweepDays, missionSeconds,
                                      antennaMinElevationDeg)
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


@app.get("/api/pathfind")
def pathfind(epochUtc: str = TIME["defaultStartUtc"], layers: int = Query(24, ge=2, le=200),
             lateralSteps: int = Query(4, ge=3, le=12), lateralSpreadKm: float = Query(3000.0, gt=0),
             wDistance: float = Query(1.0, ge=0), wDarkness: float = Query(1.0, ge=0),
             wNoComm: float = Query(1.0, ge=0)):
    """Best Earth<->Moon relay-satellite path at a single epoch: a weighted multi-objective shortest
    path that trades off sunlit time (no battery reliance), obstacle avoidance, Earth-comm time and
    distance (see backend/pathfinding/). First-pass model: a straight-line corridor with lateral detour
    options, no propagated trajectory and no real obstacle catalog yet
    (backend/pathfinding/earth_moon.py)."""
    epoch = parse_utc(epochUtc)
    nodes, edges = earth_moon.build_corridor_graph(epoch, layers=layers, lateral_steps=lateralSteps,
                                                    lateral_spread_km=lateralSpreadKm)
    weights = Weights(distance=wDistance, darkness=wDarkness, no_comm=wNoComm)
    try:
        result = shortest_path(nodes, edges, earth_moon.start_id(), earth_moon.goal_id(layers), weights)
    except (NoPathError, KeyError) as e:
        raise HTTPException(400, str(e)) from e
    return {
        "epochUtc": epochUtc,
        "waypoints": [
            {"id": nid, "positionKm": list(nodes[nid].position_km), "sunlit": nodes[nid].sunlit,
             "earthVisible": nodes[nid].earth_visible, "blocked": nodes[nid].blocked}
            for nid in result.node_ids
        ],
        "totalDistanceKm": result.total_distance_km,
        "sunlitFraction": result.sunlit_fraction,
        "earthCommFraction": result.earth_comm_fraction,
        "obstaclesTouched": result.obstacles_touched,
        "cost": result.cost,
    }


# Production: serve the built website (`npm run build` -> dist/) from the same server as the API.
# During development, Vite serves the pages and proxies /api here instead.
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="site")
