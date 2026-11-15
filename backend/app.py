"""FastAPI server: Person 2 JSON API + verification dashboard.  Run:  python -m uvicorn backend.app:app"""
from __future__ import annotations

import logging
import threading
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import analysis, polarmap, slopes, terrain, terrain_window
from .config import CONTRACT, ROOT, SITES, TIME, parse_utc
from .pathfinding import earth_moon
from .pathfinding.graph import NoPathError, Weights, shortest_path
from .relay import DEFAULT_RELAY, RelayConfig

app = FastAPI(title="Lunar Navigator: Sun, Earth & Communication")
# The Azure-hosted frontend calls this API cross-origin (Static Web Apps can't link an Express-mode Container
# App as /api). Read-only public GET API with no cookies, so any origin may read it.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])
DIST = ROOT / "dist"
SOLAR_SITE_IDS = {"connecting-ridge-cr1", "shackleton-rim-sr1"}

_log = logging.getLogger("uvicorn.error")


@app.on_event("startup")
def _prewarm_horizon_profiles() -> None:
    """Warm the study-site horizon profiles at boot so the first real request isn't slow.

    horizon_profile() for a fresh location ray-marches 1440 azimuths out to 400 km (~10-13 s), then caches
    the result (memory + disk) for the life of the replica. These six sites are the dropdown options, so
    computing them once at startup — before any user arrives — keeps that one-time cost off the request
    path. Runs in a daemon thread so it never blocks startup or the health probe; per-site errors are logged
    and skipped (a cold site just falls back to computing on first request, as before).
    """
    def run() -> None:
        for s in SITES:
            try:
                terrain.horizon_profile(s["latitudeDeg"], s["longitudeEastDeg"])
                _log.info("pre-warmed horizon profile: %s", s.get("siteId"))
            except Exception:  # never let warming crash the worker
                _log.warning("horizon pre-warm failed: %s", s.get("siteId"), exc_info=True)

    threading.Thread(target=run, name="horizon-prewarm", daemon=True).start()


def _times(start_utc: str, end_utc: str):
    try:
        start, end = parse_utc(start_utc), parse_utc(end_utc)
        if start.microsecond or end.microsecond:
            raise ValueError("mission boundaries must be whole UTC seconds")
        return start, end
    except ValueError as e:
        raise HTTPException(400, f"bad UTC timestamp (expected {TIME['serialization']})") from e


def _relay_cfg(relay: bool, altitude_km: float, num_sats: int, inclination_deg: float,
               min_el_deg: float) -> RelayConfig | None:
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
            antennaBoresightAzimuthDeg: float | None = Query(None, ge=0, le=360),
            antennaBoresightElevationDeg: float | None = Query(None, ge=-90, le=90),
            antennaBeamwidthDeg: float = Query(analysis.DEFAULT_BEAMWIDTH_DEG, gt=0, le=180),
            relay: bool = Query(False), relayAltitudeKm: float = Query(DEFAULT_RELAY.altitude_km, ge=100, le=70000),
            relaySats: int = Query(DEFAULT_RELAY.num_sats, ge=1, le=8),
            relayInclinationDeg: float = Query(DEFAULT_RELAY.inclination_deg, ge=0, le=180),
            relayMinElevationDeg: float = Query(DEFAULT_RELAY.min_elevation_deg, ge=0, le=45)):
    start, end = _times(startUtc, endUtc)
    cfg = _relay_cfg(relay, relayAltitudeKm, relaySats, relayInclinationDeg, relayMinElevationDeg)
    try:
        analysis.check_window(start, end)
        site = analysis.solar_site(latitudeDeg, longitudeEastDeg)
        lat, lon = site["latitudeDeg"], site["longitudeEastDeg"]
        profile = terrain.horizon_profile(lat, lon)
        result = analysis.analyze(lat, lon, start, end, antennaMinElevationDeg, profile=profile,
                                  antenna_boresight_az=antennaBoresightAzimuthDeg,
                                  antenna_boresight_el=antennaBoresightElevationDeg,
                                  antenna_beamwidth_deg=antennaBeamwidthDeg, relay_cfg=cfg)
        result["site"]["siteId"] = site["siteId"]
        result["solarInput"], result["solarInputUnavailableReason"] = _solar_artifact(site, start, end, profile)
        return result
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


def _solar_artifact(site: dict, start, end, profile: dict | None = None):
    try:
        return analysis.solar_input(site, start, end, profile), None
    except analysis.SolarInputUnavailable as exc:
        return None, str(exc)


def _solar_endpoint_result(site: dict, start_utc: str, end_utc: str):
    start, end = _times(start_utc, end_utc)
    try:
        artifact, reason = _solar_artifact(site, start, end)
        return artifact if artifact is not None else {
            "solarInput": None, "solarInputUnavailableReason": reason,
            "siteId": site["siteId"], "site": {"latitudeDeg": site["latitudeDeg"],
                                              "longitudeEastDeg": site["longitudeEastDeg"]},
        }
    except analysis.WindowError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/solar_input")
def coordinate_solar_input(latitudeDeg: float = Query(..., ge=-90, le=90),
                           longitudeEastDeg: float = Query(..., ge=-360, le=360),
                           startUtc: str = TIME["defaultStartUtc"], endUtc: str = TIME["defaultEndUtc"]):
    """Power input at measured coordinates; unavailable terrain stays explicitly unknown."""
    return _solar_endpoint_result(analysis.solar_site(latitudeDeg, longitudeEastDeg), startUtc, endUtc)


@app.get("/api/solar_input/{site_id}")
def solar_input(site_id: str, startUtc: str = TIME["defaultStartUtc"], endUtc: str = TIME["defaultEndUtc"]):
    """Person 3 solar-input 0.1.0 for any catalog site, using the same coordinate-based model."""
    return _solar_endpoint_result(_site(site_id), startUtc, endUtc)


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
             missionSeconds: float = Query(1209600, gt=0),
             antennaMinElevationDeg: float | None = Query(None, ge=-5, le=60),
             relay: bool = Query(True), relaySats: int = Query(DEFAULT_RELAY.num_sats, ge=1, le=8),
             relayAltitudeKm: float = Query(DEFAULT_RELAY.altitude_km, ge=100, le=70000),
             wSun: float = Query(1.0, ge=0), wComm: float = Query(1.3, ge=0), wBoth: float = Query(0.8, ge=0),
             extraSites: Annotated[list[str] | None, Query()] = None):
    """Find the site and landing day that maximise sunlight plus effective Earth contact."""
    first = parse_utc(firstDayUtc).replace(hour=0, minute=0, second=0)
    candidates = [{"id": s["siteId"], "name": s.get("displayName"),
                   "lat": s["latitudeDeg"], "lon": s["longitudeEastDeg"]}
                  for s in SITES]
    for i, pair in enumerate(extraSites or []):
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


@app.get("/api/terrain_slopes")
def terrain_slopes(latitudeDeg: float = Query(..., ge=-90, le=-60),
                   longitudeEastDeg: float = Query(..., ge=-360, le=360),
                   halfExtentM: float = Query(620, ge=100, le=2000), n: int = Query(249, ge=17, le=401)):
    """Preliminary local slope screen from the 5 m DEM only, in degrees from radial up."""
    try:
        return slopes.local_slope_grid(round(latitudeDeg, 6), round(longitudeEastDeg % 360, 6), halfExtentM, n)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except OSError as e:
        raise HTTPException(503, "Terrain files unavailable. Run python -m scripts.fetch_data, then retry.") from e


@app.get("/api/polar_map/meta")
def polar_map_meta():
    return polarmap.meta()


@app.get("/api/polar_map.png")
def polar_map_png():
    return Response(polarmap.png_bytes(), media_type="image/png", headers={"Cache-Control": "max-age=86400"})


@app.get("/api/pathfind")
def pathfind(epochUtc: str = TIME["defaultStartUtc"], layers: int = Query(24, ge=2, le=200),
             lateralSteps: int = Query(4, ge=3, le=12), lateralSpreadKm: float = Query(3000.0, gt=0),
             lateralRings: int = Query(1, ge=1, le=6), spacing: str = Query("uniform", pattern="^(uniform|cosine)$"),
             shadowSamples: int = Query(1, ge=1, le=32),
             wDistance: float = Query(1.0, ge=0), wDarkness: float = Query(1.0, ge=0),
             wNoComm: float = Query(1.0, ge=0)):
    """Best Earth<->Moon relay-satellite path at a single epoch: a weighted multi-objective shortest
    path that trades off sunlit time (no battery reliance), obstacle avoidance, Earth-comm time and
    distance (see backend/pathfinding/). First-pass model: a straight-line corridor with lateral detour
    options, no propagated trajectory and no real obstacle catalog yet
    (backend/pathfinding/earth_moon.py). `lateralRings` adds concentric detour radii for finer paths;
    `spacing=cosine` clusters layers near Earth/Moon where the shadow and comm edges fall; `shadowSamples`
    > 1 prices darkness/comms from the fraction of each hop in shadow/out-of-comm instead of its endpoint.
    The search is A* (exact, but faster than plain Dijkstra as the corridor grows)."""
    epoch = parse_utc(epochUtc)
    obstacles: list[earth_moon.Obstacle] = []  # no real keep-out catalog wired in yet
    nodes, edges = earth_moon.build_corridor_graph(epoch, layers=layers, lateral_steps=lateralSteps,
                                                    lateral_spread_km=lateralSpreadKm,
                                                    lateral_rings=lateralRings, spacing=spacing,
                                                    obstacles=obstacles)
    weights = Weights(distance=wDistance, darkness=wDarkness, no_comm=wNoComm)
    goal = earth_moon.goal_id(layers)
    heuristic = earth_moon.distance_heuristic(nodes, goal, weights)
    # Edge-level keep-out avoidance (segments a long hop would pierce between two clear waypoints).
    # No-op while the catalog is empty; applied automatically once obstacles are supplied.
    edge_penalty = earth_moon.segment_obstacle_penalty(obstacles, weights) if obstacles else None
    # Edge-sampled shadow/comm: price darkness/lost-comms by the fraction of each hop in shadow, not
    # just the destination node's flag. Only worth it when the hops are long enough to dip through
    # shadow between two lit waypoints; opt in with shadowSamples > 1.
    lighting = earth_moon.segment_lighting(epoch, shadowSamples) if shadowSamples > 1 else None
    try:
        result = shortest_path(nodes, edges, earth_moon.start_id(), goal, weights,
                               heuristic=heuristic, edge_penalty=edge_penalty, lighting=lighting)
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


@app.get("/api/terrain/window")
def terrain_window_route(column: int = Query(..., ge=0), row: int = Query(..., ge=0), stride: int = Query(...),
                         size: int = Query(257), source: str = Query("auto")):
    """129x129 or 257x257 float32 LE heights from the NASA 5 m polar mosaic; production twin of the Vite dev
    middleware in vite.config.mjs (see backend/terrain_window.py)."""
    try:
        data, source = terrain_window.window_bytes(column, row, stride, size, source)
    except terrain_window.InvalidWindow as e:
        raise HTTPException(400, str(e)) from e
    except terrain_window.Busy as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:
        raise HTTPException(502, "Could not read the NASA terrain mosaic") from e
    return Response(data, media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=86400", "X-Terrain-Source": source})


# Production: serve the built website (`npm run build` -> dist/) from the same server as the API.
# During development, Vite serves the pages and proxies /api here instead.
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="site")
