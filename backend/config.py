"""Shared constants and paths. Everything numeric comes from the team contract JSON."""
import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONTRACT_PATH = ROOT / "contract" / "lunar-navigator.v0.1.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

SCHEMA_VERSION = CONTRACT["schemaVersion"]
FRAME_ID = CONTRACT["frameId"]
MOON_R_M = float(CONTRACT["referenceRadiusM"])
OBSERVER_HEIGHT_M = float(CONTRACT["observerHeightAboveGroundM"])
SITES = CONTRACT["sites"]

TIME = CONTRACT["time"]
HORIZON = CONTRACT["horizon"]
VISIBILITY = CONTRACT["visibility"]

TIME_FMT = "%Y-%m-%dT%H:%M:%SZ"   # contract: YYYY-MM-DDTHH:mm:ssZ


def parse_utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(UTC)


def fmt_utc(t: datetime) -> str:
    return t.astimezone(UTC).strftime(TIME_FMT)


SUPPORTED_START = parse_utc(TIME["supportedStartUtc"])
SUPPORTED_END = parse_utc(TIME["supportedEndUtc"])

SUN_RADIUS_KM = 695_700.0
EARTH_RADIUS_KM = 6_371.0

PDS_POLAR = ("https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/"
             "lrolol_1xxx/data/lola_gdr/polar/img/")
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"

# Global polar mosaics (PDS3 IMG, int16 DN * 0.5 m), used for the 80 m and 240 m distance bands.
# name -> (url, size_px, scale_m, projection_offset_px, max_lat (edge of coverage))
LDEMS = {
    "LDEM_80S_80M.IMG": (PDS_POLAR + "ldem_80s_80m.img", 7600, 80.0, 3799.5, -80.0),
    "LDEM_75S_240M.IMG": (PDS_POLAR + "ldem_75s_240m.img", 3812, 240.0, 1905.5, -75.0),
}

# PGDA 5 m site tiles (GeoTIFF float32), used for the 0-5 km band.
PGDA_TILES = {s["pgdaTileId"]: s["demUrl"] for s in SITES}

KERNELS = {
    "de421.bsp": "https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de421.bsp",
    "moon_pa_de421_1900-2050.bpc": NAIF + "pck/moon_pa_de421_1900-2050.bpc",
    "moon_080317.tf": NAIF + "fk/satellites/moon_080317.tf",
    "pck00010.tpc": NAIF + "pck/pck00010.tpc",
}
