"""Person 2 module: Sun/Earth visibility, events, communication windows and blackouts (team contract v0.1).

Models (contract `visibility`):
  sunModel   center-binary-v1                     Sun visible  <=> sunEl  >  horizon(sunAz)  + terrainClearanceMargin
  earthModel earth-center-line-of-sight-proxy-v1  Earth visible <=> earthEl > max(horizon(earthAz) + margin,
                                                                                 antennaMinElevation)
  boundaryComparison strict-greater-than; missing horizon -> null state; Earth eclipses of the Sun not modelled.

Time (contract `time`): UTC, base step 600 s, intervals start-inclusive / end-exclusive. Every base-step state
change is re-sampled every 60 s inside its 600 s bracket, so each event time is bracketed to 60 s:
an event's `timeUtc` is the first 60 s sample in the new state, `bracketStartUtc` the last sample before it.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np

from . import terrain
from .config import CONTRACT, FRAME_ID, SCHEMA_VERSION, SUPPORTED_END, SUPPORTED_START, TIME, VISIBILITY, fmt_utc
from .ephem import sun_earth, time_grid

BASE_STEP_S = float(TIME["baseStepSeconds"])
REFINE_STEP_S = float(TIME["eventRefinementStepSeconds"])
MAX_MISSION_S = float(TIME["maxMissionDurationSeconds"])
MARGIN = float(VISIBILITY["terrainClearanceMarginDeg"])
ANTENNA_MIN = float(VISIBILITY["antennaMinElevationDeg"])

UNKNOWN = -1   # state encoding: 1 visible, 0 not visible, -1 missing (serialised as null)


class WindowError(ValueError):
    pass


def check_window(start: datetime, end: datetime) -> None:
    if start < SUPPORTED_START or end > SUPPORTED_END:
        raise WindowError(f"window must lie within {TIME['supportedStartUtc']} .. {TIME['supportedEndUtc']}")
    dur = (end - start).total_seconds()
    if dur <= 0:
        raise WindowError("endUtc must be after startUtc")
    if dur > MAX_MISSION_S:
        raise WindowError(f"mission longer than maxMissionDurationSeconds ({int(MAX_MISSION_S)} s)")


# ----------------------------------------------------------------------------- visibility
def _state(el: np.ndarray, threshold: np.ndarray) -> np.ndarray:
    s = (el > threshold).astype(np.int8)                     # strict-greater-than
    s[np.isnan(threshold)] = UNKNOWN
    return s


def evaluate(lat: float, lon: float, times: list[datetime], profile: dict, antenna_min: float) -> dict:
    e = sun_earth(lat, lon, times)
    e["sun_hz"] = terrain.mask_at(profile["elevationDeg"], e["sun_az"])
    e["earth_hz"] = terrain.mask_at(profile["elevationDeg"], e["earth_az"])
    e["sun_vis"] = _state(e["sun_el"], e["sun_hz"] + MARGIN)
    e["earth_vis"] = _state(e["earth_el"], np.maximum(e["earth_hz"] + MARGIN, antenna_min))
    return e


# ----------------------------------------------------------------------------- intervals
def _runs(times: list[datetime], end: datetime, s: np.ndarray, value: int, mission_start: datetime) -> list[dict]:
    """Maximal runs where s == value. Sample j covers [times[j], times[j+1]) (last one up to `end`)."""
    out, j, n = [], 0, len(s)
    while j < n:
        if s[j] != value:
            j += 1
            continue
        k = j
        while k + 1 < n and s[k + 1] == value:
            k += 1
        t0, t1 = times[j], (times[k + 1] if k + 1 < n else end)
        out.append({"startUtc": fmt_utc(t0), "endUtc": fmt_utc(t1),
                    "durationSeconds": int((t1 - t0).total_seconds()),
                    "truncatedAtMissionStart": t0 == mission_start, "truncatedAtMissionEnd": t1 == end})
        j = k + 1
    return out


def _events(times: list[datetime], s: np.ndarray, body: str) -> list[dict]:
    out = []
    for j in range(1, len(s)):
        a, b = int(s[j - 1]), int(s[j])
        if a == b or UNKNOWN in (a, b):
            continue
        out.append({"body": body, "type": "rise" if b == 1 else "set", "timeUtc": fmt_utc(times[j]),
                    "bracketStartUtc": fmt_utc(times[j - 1]),
                    "bracketSeconds": int((times[j] - times[j - 1]).total_seconds())})
    return out


def _summary(windows: list[dict], gaps: list[dict], unknown: list[dict], total_s: float) -> dict:
    has_unknown = bool(unknown)
    up = sum(w["durationSeconds"] for w in windows)
    return {
        "percentOfMission": None if has_unknown else 100.0 * up / total_s,
        "totalSeconds": None if has_unknown else up,
        "windowCount": len(windows),
        "longestWindowSeconds": max((w["durationSeconds"] for w in windows), default=0),
        "longestGapSeconds": None if has_unknown else max((g["durationSeconds"] for g in gaps), default=0),
        "unknownSeconds": sum(u["durationSeconds"] for u in unknown),
    }


# ----------------------------------------------------------------------------- main entry
def analyze(lat: float, lon: float, start: datetime, end: datetime, antenna_min: float | None = None,
            profile: dict | None = None) -> dict:
    check_window(start, end)
    lon = lon % 360.0
    antenna_min = ANTENNA_MIN if antenna_min is None else float(antenna_min)
    profile = profile or terrain.horizon_profile(lat, lon)

    base_t = time_grid(start, end, BASE_STEP_S)
    base = evaluate(lat, lon, base_t, profile, antenna_min)

    # refine every base bracket in which either state changes
    flips = np.nonzero((np.diff(base["sun_vis"]) != 0) | (np.diff(base["earth_vis"]) != 0))[0]
    k_per = int(BASE_STEP_S // REFINE_STEP_S)
    ref_t = [base_t[i] + timedelta(seconds=REFINE_STEP_S * k) for i in flips for k in range(1, k_per)]
    if ref_t:
        ref = evaluate(lat, lon, ref_t, profile, antenna_min)
        order = np.argsort(np.array([t.timestamp() for t in base_t + ref_t]))
        all_t = [(base_t + ref_t)[i] for i in order]
        sun_s = np.concatenate([base["sun_vis"], ref["sun_vis"]])[order]
        earth_s = np.concatenate([base["earth_vis"], ref["earth_vis"]])[order]
    else:
        all_t, sun_s, earth_s = base_t, base["sun_vis"], base["earth_vis"]
    both_s = np.where((sun_s == UNKNOWN) | (earth_s == UNKNOWN), UNKNOWN, sun_s & earth_s).astype(np.int8)

    total_s = (end - start).total_seconds()

    def block(s: np.ndarray, body: str | None) -> dict:
        w = _runs(all_t, end, s, 1, start)
        g = _runs(all_t, end, s, 0, start)
        u = _runs(all_t, end, s, UNKNOWN, start)
        return {"windows": w, "gaps": g, "unknown": u, "summary": _summary(w, g, u, total_s),
                "events": _events(all_t, s, body) if body else []}

    sun, comm, both = block(sun_s, "sun"), block(earth_s, "earth"), block(both_s, None)
    rankable = profile.get("terrainQuality") == "contract" or bool(VISIBILITY["allowFallbackInTerrainRanking"])

    def r(a, nd=5):
        return [None if np.isnan(v) else round(float(v), nd) for v in np.asarray(a, float)]

    def vis(a):
        return [None if v == UNKNOWN else bool(v) for v in a]

    return {
        "schemaVersion": SCHEMA_VERSION,
        "frameId": FRAME_ID,
        "site": {"latitudeDeg": lat, "longitudeEastDeg": lon, "surfaceElevationM": profile.get("siteElevationM"),
                 "surfaceElevationMethod": profile.get("siteElevationMethod"),
                 "terrainQuality": profile.get("terrainQuality"), "horizonSource": profile.get("source"),
                 "rankable": rankable},
        "startUtc": fmt_utc(start), "endUtc": fmt_utc(end),
        "baseStepSeconds": int(BASE_STEP_S), "eventRefinementStepSeconds": int(REFINE_STEP_S),
        "visibility": {**VISIBILITY, "antennaMinElevationDeg": antenna_min},
        "horizon": {k: profile[k] for k in ("azimuthStartDeg", "azimuthStepDeg", "sampleCount", "elevationDeg")},
        "series": {
            "timesUtc": [fmt_utc(t) for t in base_t],
            "sunAzimuthDeg": r(base["sun_az"]), "sunElevationDeg": r(base["sun_el"]),
            "sunHorizonDeg": r(base["sun_hz"]), "sunVisible": vis(base["sun_vis"]),
            "earthAzimuthDeg": r(base["earth_az"]), "earthElevationDeg": r(base["earth_el"]),
            "earthHorizonDeg": r(base["earth_hz"]), "earthVisible": vis(base["earth_vis"]),
            "sunAngularRadiusDeg": r(base["sun_r"]), "earthAngularRadiusDeg": r(base["earth_r"]),
            "sunEnu": [r(v, 6) for v in base["sun_enu"]], "earthEnu": [r(v, 6) for v in base["earth_enu"]],
            # extension (not in contract v0.1): Earth's north pole and prime meridian as ENU unit vectors
            "earthNorthPoleEnu": [r(v, 4) for v in base["earth_pole_enu"]],
            "earthPrimeMeridianEnu": [r(v, 4) for v in base["earth_prime_enu"]],
        },
        "sun": {"sunlitWindows": sun["windows"], "darkPeriods": sun["gaps"], "unknown": sun["unknown"],
                "summary": sun["summary"]},
        "communication": {"windows": comm["windows"], "blackouts": comm["gaps"], "unknown": comm["unknown"],
                          "summary": comm["summary"]},
        "sunAndCommunication": {"windows": both["windows"], "unknown": both["unknown"],
                                "summary": both["summary"]},
        "events": sorted(sun["events"] + comm["events"], key=lambda ev: ev["timeUtc"]),
    }


# ----------------------------------------------------------------------------- Person 3 solar handoff
AU_KM = 149_597_870.7
SOLAR_SCHEMA = "0.1.0"


def solar_input(site: dict, start: datetime, end: datetime, profile: dict | None = None) -> dict:
    """`solar-input` envelope for Person 3's power model (docs/solar/INPUT_CONTRACT.md on the solar branch).

    Samples: every 600 s base sample, plus 60 s samples inside each bracket where Sun visibility changes (so each
    sunrise/sunset is explicit to 60 s), plus the exact mission end boundary. Each sample carries the Sun's
    topocentric az/el, observer-to-Sun range in AU, and the binary terrain visibility of the interval that follows.
    """
    check_window(start, end)
    lat, lon = site["latitudeDeg"], site["longitudeEastDeg"] % 360.0
    profile = profile or terrain.horizon_profile(lat, lon)
    base_t = time_grid(start, end, BASE_STEP_S)
    base = evaluate(lat, lon, base_t, profile, ANTENNA_MIN)
    flips = np.nonzero(np.diff(base["sun_vis"]) != 0)[0]
    k_per = int(BASE_STEP_S // REFINE_STEP_S)
    ref_t = [base_t[i] + timedelta(seconds=REFINE_STEP_S * k) for i in flips for k in range(1, k_per)]
    times = sorted(base_t + ref_t + [end])
    e = evaluate(lat, lon, times, profile, ANTENNA_MIN)
    samples = []
    for j, t in enumerate(times):
        az = round(float(e["sun_az"][j]), 6) % 360.0
        vis = int(e["sun_vis"][j])
        samples.append({
            "timeUtc": fmt_utc(t),
            "sun": {"azimuthDeg": 0.0 if az >= 360.0 else az, "elevationDeg": round(float(e["sun_el"][j]), 6),
                    "rangeAu": round(float(e["sun_dist_km"][j]) / AU_KM, 12)},
            "solarVisibleFraction": None if vis == UNKNOWN else float(vis),
            "quality": {"status": "missing", "reason": "horizon_missing"} if vis == UNKNOWN
            else {"status": "valid", "reason": None},
        })
    hz_id = f"person2-horizon:{site['siteId']}:{profile.get('terrainQuality')}:{profile.get('profileHash', 'computed')}"
    art = f"person2:{site['siteId']}:{fmt_utc(start)}:{fmt_utc(end)}"
    return {
        "schemaVersion": SOLAR_SCHEMA, "artifactType": "solar-input", "artifactId": art, "scenarioId": art,
        "generatedAtUtc": fmt_utc(datetime.now(tz=start.tzinfo).replace(microsecond=0)),
        "label": f"{site.get('displayName', site['siteId'])} solar input (Person 2 backend)",
        "frameId": FRAME_ID, "siteId": site["siteId"],
        "site": {"latitudeDeg": site["latitudeDeg"], "longitudeEastDeg": site["longitudeEastDeg"],
                 "surfaceElevationM": profile.get("siteElevationM", site.get("surfaceElevationM")),
                 "referenceRadiusM": int(CONTRACT["referenceRadiusM"])},
        "observerHeightAboveGroundM": 2,
        "time": {"startUtc": fmt_utc(start), "endUtc": fmt_utc(end), "baseStepSeconds": int(BASE_STEP_S),
                 "visibilityInterpolation": "previous-sample-hold"},
        "provenance": {
            "ephemeris": {"provider": "Skyfield + JPL DE421 (Person 2 backend)",
                          "kernels": ["de421.bsp", "moon_pa_de421_1900-2050.bpc", "moon_080317.tf", "pck00010.tpc"],
                          "validation": "checked against JPL Horizons coord@301 (tests/test_ephemeris.py)"},
            "visibility": {"provider": "Person 2 backend analysis.evaluate", "mode": "terrain",
                           "sunModel": "center-binary-v1", "horizonArtifactId": hz_id,
                           "horizonObserverHeightAboveGroundM": 2,
                           "terrainQuality": profile.get("terrainQuality"),
                           "timing": "600 s base samples; 60 s samples in every bracket where Sun visibility changes"},
        },
        "samples": samples,
    }


# ----------------------------------------------------------------------------- landing-date sweep
def _longest(flag: np.ndarray) -> int:
    best = cur = 0
    for f in flag:
        cur = cur + 1 if f else 0
        best = max(best, cur)
    return best


def landing_sweep(lat: float, lon: float, first_day: datetime, sweep_days: int, mission_s: float,
                  antenna_min: float | None = None) -> dict:
    """Score each candidate landing day (00:00 UTC) over the mission window, from base-step samples only."""
    lon = lon % 360.0
    antenna_min = ANTENNA_MIN if antenna_min is None else float(antenna_min)
    if mission_s <= 0 or mission_s > MAX_MISSION_S:
        raise WindowError("mission duration out of range")
    days = [first_day + timedelta(days=d) for d in range(sweep_days)]
    days = [d for d in days if d >= SUPPORTED_START and d + timedelta(seconds=mission_s) <= SUPPORTED_END]
    if not days:
        raise WindowError("no landing day in range fits the supported window")
    profile = terrain.horizon_profile(lat, lon)
    times = time_grid(days[0], days[-1] + timedelta(seconds=mission_s), BASE_STEP_S)
    e = evaluate(lat, lon, times, profile, antenna_min)
    per_day = int(86400 // BASE_STEP_S)
    win = int(np.ceil(mission_s / BASE_STEP_S))
    h = BASE_STEP_S / 3600.0
    rows = []
    for k, d in enumerate(days):
        i = k * per_day
        sv, ev = e["sun_vis"][i:i + win], e["earth_vis"][i:i + win]
        if (sv == UNKNOWN).any() or (ev == UNKNOWN).any():
            rows.append({"dateUtc": fmt_utc(d), "missing": True})
            continue
        both = sv & ev
        first_sun_change = np.nonzero(sv != sv[0])[0]
        first_comm_change = np.nonzero(ev != ev[0])[0]
        rows.append({
            "dateUtc": fmt_utc(d), "missing": False,
            "commPercent": round(100.0 * ev.mean(), 1),
            "sunlitPercent": round(100.0 * sv.mean(), 1),
            "sunAndCommPercent": round(100.0 * both.mean(), 1),
            "longestBlackoutHours": round(_longest(ev == 0) * h, 1),
            "longestDarkHours": round(_longest(sv == 0) * h, 1),
            "sunVisibleAtLanding": bool(sv[0]), "earthVisibleAtLanding": bool(ev[0]),
            "hoursUntilSunChange": round(first_sun_change[0] * h, 1) if first_sun_change.size else None,
            "hoursUntilCommChange": round(first_comm_change[0] * h, 1) if first_comm_change.size else None,
        })
    return {"schemaVersion": SCHEMA_VERSION, "latitudeDeg": lat, "longitudeEastDeg": lon,
            "missionSeconds": int(mission_s), "antennaMinElevationDeg": antenna_min,
            "sampling": f"base-step {int(BASE_STEP_S)} s, no event refinement",
            "rankable": profile.get("terrainQuality") == "contract"
            or bool(CONTRACT["visibility"]["allowFallbackInTerrainRanking"]),
            "days": rows}
