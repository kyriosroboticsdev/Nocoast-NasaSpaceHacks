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

from . import relay as relay_model
from . import terrain
from .config import CONTRACT, FRAME_ID, SCHEMA_VERSION, SITES, SUPPORTED_END, SUPPORTED_START, TIME, VISIBILITY, fmt_utc
from .ephem import sun_earth, time_grid
from .relay import DEFAULT_RELAY, RelayConfig

BASE_STEP_S = float(TIME["baseStepSeconds"])
REFINE_STEP_S = float(TIME["eventRefinementStepSeconds"])
MAX_MISSION_S = float(TIME["maxMissionDurationSeconds"])
MARGIN = float(VISIBILITY["terrainClearanceMarginDeg"])
ANTENNA_MIN = float(VISIBILITY["antennaMinElevationDeg"])

UNKNOWN = -1   # state encoding: 1 visible, 0 not visible, -1 missing (serialised as null)
DEFAULT_BEAMWIDTH_DEG = 20.0


# ----------------------------------------------------------------------------- antenna pointing (extension)
def antenna_link_quality(earth_az: np.ndarray, earth_el: np.ndarray, earth_vis: np.ndarray,
                         boresight_az: float, boresight_el: float,
                         beamwidth_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """Simplified fixed-mount directional antenna (extension, not in contract v0.1 — no gain pattern, no
    multipath, no DSN scheduling, no real link budget; angles only).

    `off_boresight` is the great-circle angle between Earth's actual direction and a fixed antenna boresight,
    via the spherical law of cosines. `quality` is 1.0 on boresight, a raised-cosine rolloff to 0.0 at
    `beamwidth_deg / 2` (the "half-power beamwidth" edge), and forced to 0.0 whenever Earth is below the
    terrain/antenna-elevation gate (`earth_vis` is not 1) regardless of pointing.
    """
    b_az, b_el = np.radians(boresight_az), np.radians(boresight_el)
    e_az, e_el = np.radians(earth_az), np.radians(earth_el)
    cos_sep = np.sin(b_el) * np.sin(e_el) + np.cos(b_el) * np.cos(e_el) * np.cos(e_az - b_az)
    off_boresight = np.degrees(np.arccos(np.clip(cos_sep, -1.0, 1.0)))
    half_power = max(beamwidth_deg, 1e-6) / 2.0
    rolloff = np.cos(np.radians(90.0 * np.minimum(off_boresight, half_power) / half_power)) ** 2
    quality = np.where((off_boresight <= half_power) & (earth_vis == 1), rolloff, 0.0)
    return off_boresight, quality


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


def evaluate(lat: float, lon: float, times: list[datetime], profile: dict, antenna_min: float,
             relay_cfg: RelayConfig | None = None) -> dict:
    e = sun_earth(lat, lon, times)
    e["sun_hz"] = terrain.mask_at(profile["elevationDeg"], e["sun_az"])
    e["earth_hz"] = terrain.mask_at(profile["elevationDeg"], e["earth_az"])
    e["sun_vis"] = _state(e["sun_el"], e["sun_hz"] + MARGIN)
    e["earth_vis"] = _state(e["earth_el"], np.maximum(e["earth_hz"] + MARGIN, antenna_min))
    if relay_cfg is not None:
        linked = relay_model.relay_link(
            lat, lon, times, lambda az: terrain.mask_at(profile["elevationDeg"], az), MARGIN, relay_cfg)
        e["relay_vis"] = linked.astype(np.int8)
        # A relay can only add a link. It never removes direct-to-Earth, including unknowns.
        e["comm_vis"] = np.where(linked, np.int8(1), e["earth_vis"]).astype(np.int8)
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
            profile: dict | None = None, antenna_boresight_az: float | None = None,
            antenna_boresight_el: float | None = None, antenna_beamwidth_deg: float = DEFAULT_BEAMWIDTH_DEG,
            relay_cfg: RelayConfig | None = DEFAULT_RELAY) -> dict:
    check_window(start, end)
    lon = lon % 360.0
    antenna_min = ANTENNA_MIN if antenna_min is None else float(antenna_min)
    profile = profile or terrain.horizon_profile(lat, lon)

    base_t = time_grid(start, end, BASE_STEP_S)
    base = evaluate(lat, lon, base_t, profile, antenna_min, relay_cfg)

    flip_flags = (np.diff(base["sun_vis"]) != 0) | (np.diff(base["earth_vis"]) != 0)
    if relay_cfg is not None:
        flip_flags |= np.diff(base["comm_vis"]) != 0
    flips = np.nonzero(flip_flags)[0]
    k_per = int(BASE_STEP_S // REFINE_STEP_S)
    ref_t = [base_t[i] + timedelta(seconds=REFINE_STEP_S * k) for i in flips for k in range(1, k_per)]
    keys = ["sun_vis", "earth_vis"] + (["relay_vis", "comm_vis"] if relay_cfg is not None else [])
    if ref_t:
        ref = evaluate(lat, lon, ref_t, profile, antenna_min, relay_cfg)
        order = np.argsort(np.array([t.timestamp() for t in base_t + ref_t]))
        all_t = [(base_t + ref_t)[i] for i in order]
        merged = {key: np.concatenate([base[key], ref[key]])[order] for key in keys}
    else:
        all_t = base_t
        merged = {key: base[key] for key in keys}
    sun_s, earth_s = merged["sun_vis"], merged["earth_vis"]
    comm_eff_s = merged["comm_vis"] if relay_cfg is not None else earth_s
    both_s = np.where((sun_s == UNKNOWN) | (earth_s == UNKNOWN), UNKNOWN, sun_s & earth_s).astype(np.int8)
    both_eff_s = np.where((sun_s == UNKNOWN) | (comm_eff_s == UNKNOWN), UNKNOWN, sun_s & comm_eff_s).astype(np.int8)

    total_s = (end - start).total_seconds()

    def block(s: np.ndarray, body: str | None) -> dict:
        w = _runs(all_t, end, s, 1, start)
        g = _runs(all_t, end, s, 0, start)
        u = _runs(all_t, end, s, UNKNOWN, start)
        return {"windows": w, "gaps": g, "unknown": u, "summary": _summary(w, g, u, total_s),
                "events": _events(all_t, s, body) if body else []}

    sun, comm, both = block(sun_s, "sun"), block(earth_s, "earth"), block(both_s, None)
    comm_eff = block(comm_eff_s, None) if relay_cfg is not None else comm
    both_eff = block(both_eff_s, None) if relay_cfg is not None else both
    relay_only = block(merged["relay_vis"].astype(np.int8), None) if relay_cfg is not None else None
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
            "relayVisible": vis(base["relay_vis"]) if relay_cfg is not None else None,
            "earthOrRelayVisible": vis(base["comm_vis"]) if relay_cfg is not None else None,
            "sunAngularRadiusDeg": r(base["sun_r"]), "earthAngularRadiusDeg": r(base["earth_r"]),
            "sunDistanceKm": r(base["sun_dist_km"], 3), "earthDistanceKm": r(base["earth_dist_km"], 3),
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
        "commsEffective": None if relay_cfg is None else {
            "mode": "dte+relay", "windows": comm_eff["windows"], "blackouts": comm_eff["gaps"],
            "unknown": comm_eff["unknown"], "summary": comm_eff["summary"]},
        "sunAndCommunicationEffective": None if relay_cfg is None else {
            "windows": both_eff["windows"], "unknown": both_eff["unknown"], "summary": both_eff["summary"]},
        "relay": None if relay_cfg is None else {
            "config": {"name": relay_cfg.name, "altitudeKm": relay_cfg.altitude_km,
                       "inclinationDeg": relay_cfg.inclination_deg, "numSats": relay_cfg.num_sats,
                       "minElevationDeg": relay_cfg.min_elevation_deg, "raanSpreadDeg": relay_cfg.raan_spread_deg},
            "windows": relay_only["windows"], "blackouts": relay_only["gaps"], "summary": relay_only["summary"],
            "addedCommsSeconds": (None if comm_eff["summary"]["totalSeconds"] is None
                                  or comm["summary"]["totalSeconds"] is None
                                  else comm_eff["summary"]["totalSeconds"] - comm["summary"]["totalSeconds"]),
            "model": "circular-polar-constellation-v1 (simplified; see backend/relay.py)"},
        "events": sorted(sun["events"] + comm["events"], key=lambda ev: ev["timeUtc"]),
        "antenna": _antenna_block(base_t, base["earth_az"], base["earth_el"], base["earth_vis"],
                                  antenna_boresight_az, antenna_boresight_el, antenna_beamwidth_deg),
    }


# extension (not in contract v0.1): simplified fixed-mount directional antenna pointing + link quality
def _antenna_block(times: list[datetime], earth_az: np.ndarray, earth_el: np.ndarray, earth_vis: np.ndarray,
                   boresight_az: float | None, boresight_el: float | None, beamwidth_deg: float) -> dict:
    note = ("Simplified fixed-mount pointing + raised-cosine rolloff vs beamwidth edge; no gain pattern, "
            "multipath, or DSN scheduling modelled. Not a real RF link budget.")
    if boresight_az is None or boresight_el is None:
        return {"modeled": False, "note": note}
    off, quality = antenna_link_quality(earth_az, earth_el, earth_vis, boresight_az, boresight_el, beamwidth_deg)
    visible_quality = quality[earth_vis == 1]
    return {
        "modeled": True,
        "boresightAzimuthDeg": boresight_az, "boresightElevationDeg": boresight_el,
        "beamwidthDeg": beamwidth_deg,
        "onBoresightFractionOfCommWindow": float((quality > 0).sum() / max(int((earth_vis == 1).sum()), 1)),
        "meanLinkQualityWhileVisible": float(visible_quality.mean()) if visible_quality.size else None,
        "series": {
            "timesUtc": [fmt_utc(t) for t in times],
            "offBoresightDeg": [round(float(v), 3) for v in off],
            "linkQuality": [round(float(v), 4) for v in quality],
        },
        "note": note,
    }


# ----------------------------------------------------------------------------- Person 3 solar handoff
AU_KM = 149_597_870.7
SOLAR_SCHEMA = "0.1.0"


class SolarInputUnavailable(ValueError):
    """A visibility result can exist without enough terrain geometry for power."""


def solar_site(latitude_deg: float, longitude_east_deg: float) -> dict:
    """Canonical six-decimal coordinates shared with the terrain cache and solar identity."""
    lat, lon = float(latitude_deg), float(longitude_east_deg)
    if not np.isfinite(lat) or not -90 <= lat <= 90 or not np.isfinite(lon):
        raise WindowError("site coordinates must be finite lunar latitude/longitude degrees")
    lat, lon = round(lat, 6), round(lon % 360, 6) % 360
    lat = 0.0 if lat == 0 else lat
    lon = 0.0 if lon == 0 else lon
    for site in SITES:
        if abs(site["latitudeDeg"] - lat) < 1e-9 and abs(site["longitudeEastDeg"] % 360 - lon) < 1e-9:
            return {**site, "latitudeDeg": lat, "longitudeEastDeg": lon}
    return {"siteId": f"moon-{lat:.6f}-{lon:.6f}", "latitudeDeg": lat, "longitudeEastDeg": lon,
            "displayName": f"{lat:.6f} degrees latitude, {lon:.6f} degrees east"}


def solar_input(site: dict, start: datetime, end: datetime, profile: dict | None = None) -> dict:
    """`solar-input` envelope for Person 3's power model (docs/solar/INPUT_CONTRACT.md on the solar branch).

    Samples: every 600 s base sample, plus 60 s samples inside each bracket where Sun visibility changes (so each
    sunrise/sunset is explicit to 60 s), plus the exact mission end boundary. Each sample carries the Sun's
    topocentric az/el, observer-to-Sun range in AU, and the binary terrain visibility of the interval that follows.
    """
    check_window(start, end)
    lat = round(float(site["latitudeDeg"]), 6)
    lon = round(float(site["longitudeEastDeg"]) % 360, 6) % 360
    profile = profile or terrain.horizon_profile(lat, lon)
    elevation = profile.get("siteElevationM")
    if elevation is None or not np.isfinite(elevation) or not -15000 <= elevation <= 15000:
        raise SolarInputUnavailable(
            "Measured surface elevation is unavailable at this location; solar power is unknown.")
    observer_height = profile.get("observerHeightAboveGroundM", CONTRACT["observerHeightAboveGroundM"])
    if observer_height != CONTRACT["observerHeightAboveGroundM"]:
        raise SolarInputUnavailable("Terrain observer height does not match the shared 2 m solar convention.")
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
        "site": {"latitudeDeg": lat, "longitudeEastDeg": lon,
                 "surfaceElevationM": float(elevation),
                 "referenceRadiusM": int(CONTRACT["referenceRadiusM"])},
        "observerHeightAboveGroundM": 2,
        "time": {"startUtc": fmt_utc(start), "endUtc": fmt_utc(end), "baseStepSeconds": int(BASE_STEP_S),
                 "visibilityInterpolation": "previous-sample-hold"},
        "provenance": {
            "ephemeris": {"provider": "Skyfield + JPL DE421 (Person 2 backend)",
                          "kernels": ["de421.bsp", "moon_pa_de421_1900-2050.bpc", "moon_080317.tf", "pck00010.tpc"],
                          "validation": "checked against JPL Horizons coord@301 (tests/test_ephemeris.py)",
                          "observerModel": "Skyfield reference surface; terrain elevation is used by the horizon"},
            "visibility": {"provider": "Person 2 backend analysis.evaluate", "mode": "terrain",
                           "sunModel": "center-binary-v1", "horizonArtifactId": hz_id,
                           "horizonObserverHeightAboveGroundM": 2,
                           "terrainQuality": profile.get("terrainQuality"),
                           "horizonSource": profile.get("source"),
                           "surfaceElevationMethod": profile.get("siteElevationMethod"),
                           "validation": profile.get("validation") or {"status": "pending"},
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


OBJECTIVE_WEIGHTS = {"sun": 1.0, "comm": 1.3, "both": 0.8}


def objective_score(sun_pct: float, comm_pct: float, both_pct: float, weights: dict | None = None) -> float:
    """0–100 score from sunlight, effective Earth contact, and the overlap of the two."""
    w = weights or OBJECTIVE_WEIGHTS
    denom = w["sun"] + w["comm"] + w["both"]
    if denom <= 0:
        raise WindowError("at least one objective weight must be positive")
    return (w["sun"] * sun_pct + w["comm"] * comm_pct + w["both"] * both_pct) / denom


def landing_sweep(lat: float, lon: float, first_day: datetime, sweep_days: int, mission_s: float,
                  antenna_min: float | None = None, relay_cfg: RelayConfig | None = DEFAULT_RELAY,
                  weights: dict | None = None) -> dict:
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
    e = evaluate(lat, lon, times, profile, antenna_min, relay_cfg)
    per_day = int(86400 // BASE_STEP_S)
    win = int(np.ceil(mission_s / BASE_STEP_S))
    h = BASE_STEP_S / 3600.0
    rows, best = [], None
    for k, d in enumerate(days):
        i = k * per_day
        sv, ev = e["sun_vis"][i:i + win], e["earth_vis"][i:i + win]
        cv = e["comm_vis"][i:i + win] if relay_cfg is not None else ev
        if (sv == UNKNOWN).any() or (ev == UNKNOWN).any() or (cv == UNKNOWN).any():
            rows.append({"dateUtc": fmt_utc(d), "missing": True})
            continue
        both = sv & ev
        both_eff = sv & cv
        sun_pct, comm_pct = 100.0 * sv.mean(), 100.0 * cv.mean()
        both_pct = 100.0 * both_eff.mean()
        first_sun_change = np.nonzero(sv != sv[0])[0]
        first_comm_change = np.nonzero(cv != cv[0])[0]
        score = round(objective_score(sun_pct, comm_pct, both_pct, weights), 1)
        row = {
            "dateUtc": fmt_utc(d), "missing": False,
            "commPercent": round(100.0 * ev.mean(), 1),
            "commWithRelayPercent": round(comm_pct, 1),
            "sunlitPercent": round(sun_pct, 1),
            "sunAndCommPercent": round(100.0 * both.mean(), 1),
            "sunAndCommWithRelayPercent": round(both_pct, 1),
            "objectiveScore": score,
            "longestBlackoutHours": round(_longest(ev == 0) * h, 1),
            "longestBlackoutWithRelayHours": round(_longest(cv == 0) * h, 1),
            "longestDarkHours": round(_longest(sv == 0) * h, 1),
            "sunVisibleAtLanding": bool(sv[0]), "earthVisibleAtLanding": bool(ev[0]),
            "hoursUntilSunChange": round(first_sun_change[0] * h, 1) if first_sun_change.size else None,
            "hoursUntilCommChange": round(first_comm_change[0] * h, 1) if first_comm_change.size else None,
        }
        rows.append(row)
        if best is None or score > best[1]:
            best = (fmt_utc(d), score)
    return {"schemaVersion": SCHEMA_VERSION, "latitudeDeg": lat, "longitudeEastDeg": lon,
            "missionSeconds": int(mission_s), "antennaMinElevationDeg": antenna_min,
            "sampling": f"base-step {int(BASE_STEP_S)} s, no event refinement",
            "relay": None if relay_cfg is None else {"name": relay_cfg.name, "numSats": relay_cfg.num_sats,
                                                     "altitudeKm": relay_cfg.altitude_km},
            "objectiveWeights": weights or OBJECTIVE_WEIGHTS,
            "bestDateUtc": best[0] if best else None, "bestScore": best[1] if best else None,
            "rankable": profile.get("terrainQuality") == "contract"
            or bool(CONTRACT["visibility"]["allowFallbackInTerrainRanking"]),
            "days": rows}


def optimize(sites: list[dict], first_day: datetime, sweep_days: int, mission_s: float,
             antenna_min: float | None = None, relay_cfg: RelayConfig | None = DEFAULT_RELAY,
             weights: dict | None = None) -> dict:
    """Rank sites and landing days by sunlight plus effective Earth contact."""
    ranked = []
    for site in sites:
        try:
            sweep = landing_sweep(site["lat"], site["lon"], first_day, sweep_days, mission_s,
                                  antenna_min, relay_cfg, weights)
        except WindowError as ex:
            ranked.append({**_site_id(site), "error": str(ex)})
            continue
        best_day = next((d for d in sweep["days"] if not d.get("missing")
                         and d["dateUtc"] == sweep["bestDateUtc"]), None)
        ranked.append({
            **_site_id(site), "rankable": sweep["rankable"],
            "bestDateUtc": sweep["bestDateUtc"], "objectiveScore": sweep["bestScore"],
            "commWithRelayPercent": best_day and best_day.get("commWithRelayPercent"),
            "commPercent": best_day and best_day.get("commPercent"),
            "sunlitPercent": best_day and best_day.get("sunlitPercent"),
            "sunAndCommWithRelayPercent": best_day and best_day.get("sunAndCommWithRelayPercent"),
            "longestBlackoutWithRelayHours": best_day and best_day.get("longestBlackoutWithRelayHours"),
        })
    scored = [r for r in ranked if r.get("objectiveScore") is not None]
    scored.sort(key=lambda r: r["objectiveScore"], reverse=True)
    ranked.sort(key=lambda r: (r.get("objectiveScore") is None, -(r.get("objectiveScore") or 0)))
    return {"schemaVersion": SCHEMA_VERSION, "missionSeconds": int(mission_s),
            "objectiveWeights": weights or OBJECTIVE_WEIGHTS,
            "relay": None if relay_cfg is None else {"name": relay_cfg.name, "numSats": relay_cfg.num_sats},
            "best": scored[0] if scored else None, "ranked": ranked}


def _site_id(site: dict) -> dict:
    return {"id": site.get("id"), "name": site.get("name"),
            "latitudeDeg": round(float(site["lat"]), 6), "longitudeEastDeg": round(float(site["lon"]) % 360.0, 6)}
