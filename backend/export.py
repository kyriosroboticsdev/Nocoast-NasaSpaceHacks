"""Export Sun/Earth/communication time series for the Quest app (contract v0.1).

    python -m backend.export                                   # both contract sites, default window
    python -m backend.export --site connecting-ridge-cr1 --start 2027-03-01T00:00:00Z --end 2027-04-30T00:00:00Z
    python -m backend.export --horizon person1/cr1.horizon.json --site connecting-ridge-cr1

Output: exports/<siteId>_<start>_<end>.json. Series vectors are ENU (contract localVectorBasis); for Unity
(contract unityFinalAxes x=east, y=up, z=north) use  new Vector3(e, u, n).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import analysis, terrain
from .config import ROOT, SITES, TIME, parse_utc


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", choices=[s["siteId"] for s in SITES], action="append")
    ap.add_argument("--start", default=TIME["defaultStartUtc"])
    ap.add_argument("--end", default=TIME["defaultEndUtc"])
    ap.add_argument("--antenna-min-elevation", type=float, default=None)
    ap.add_argument("--horizon", help="horizon profile JSON from the terrain module (single --site only)")
    ap.add_argument("--out", default=str(ROOT / "exports"))
    a = ap.parse_args()

    chosen = [s for s in SITES if not a.site or s["siteId"] in a.site]
    if a.horizon and len(chosen) != 1:
        ap.error("--horizon needs exactly one --site")
    out = Path(a.out) if Path(a.out).is_absolute() else ROOT / a.out
    out.mkdir(parents=True, exist_ok=True)
    for s in chosen:
        prof = terrain.load_profile(Path(a.horizon)) if a.horizon else None
        r = analysis.analyze(s["latitudeDeg"], s["longitudeEastDeg"], parse_utc(a.start), parse_utc(a.end),
                             a.antenna_min_elevation, profile=prof)
        r["site"]["siteId"] = s["siteId"]
        path = out / f"{s['siteId']}_{a.start[:10]}_{a.end[:10]}.json"
        path.write_text(json.dumps(r, separators=(",", ":")))
        c = r["communication"]["summary"]
        print(f"{path}  comm {c['percentOfMission']:.1f}%  longest blackout {c['longestGapSeconds'] / 3600:.1f} h  "
              f"events {len(r['events'])}")


if __name__ == "__main__":
    main()
