"""Refresh only CR1/SR1 Sun bundles with 10-minute airless az/el and range.

Python standard library. Sequential JPL requests, cached raw responses in .cache.
Fail without replacing any bundle if either response is invalid; never fabricate
an analytic fallback. Existing Earth bundles are owned by the visibility module.
"""
import csv
import hashlib
import io
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = json.loads((ROOT / 'docs/solar/TEAM_DEFAULTS.json').read_text('utf-8'))
START = datetime(2027, 1, 1, tzinfo=timezone.utc)
STOP = datetime(2027, 3, 1, tzinfo=timezone.utc)
EXPECTED_SAMPLES = int((STOP - START).total_seconds() / 600) + 1


def iso(value):
    return value.isoformat(timespec='seconds').replace('+00:00', 'Z')


def parse_samples(text):
    if 'MEAN_ME' not in text or '1737.4' not in text:
        raise ValueError('Verify lunar Mean Earth observer frame and reference radius')
    before, body = text.split('$$SOE', 1)
    body = body.split('$$EOE', 1)[0]
    header = next(line for line in before.splitlines() if 'Azi_(a-app)' in line and 'delta' in line)
    columns = next(csv.reader([header]))
    columns = [c.strip() for c in columns]
    az, el, distance = [columns.index(key) for key in ('Azi_(a-app)', 'Elev_(a-app)', 'delta')]
    samples = []
    for row in csv.reader(io.StringIO(body)):
        if not row:
            continue
        utc = datetime.strptime(row[0].strip(), '%Y-%b-%d %H:%M:%S').replace(tzinfo=timezone.utc)
        a, e, r = (float(row[i]) for i in (az, el, distance))
        if not all(math.isfinite(v) for v in (a, e, r)) or not (0 <= a < 360 and -90 <= e <= 90 and 0.9 < r < 1.1):
            raise ValueError('Invalid azimuth, elevation or AU range')
        expected = START + timedelta(seconds=600 * len(samples))
        if utc != expected:
            raise ValueError(f'Unexpected sample time: {utc}, expected {expected}')
        samples.append(dict(utc=iso(utc), azimuthDeg=a, elevationDeg=e, rangeAu=r))
    if len(samples) != EXPECTED_SAMPLES or samples[-1]['utc'] != iso(STOP):
        raise ValueError('Incomplete Sun bundle')
    return samples


def fetch_site(site):
    altitude = (site['surfaceElevationM'] + 2) / 1000
    params = {
        'format': 'json', 'COMMAND': "'10'", 'OBJ_DATA': "'NO'", 'MAKE_EPHEM': "'YES'",
        'EPHEM_TYPE': "'OBSERVER'", 'CENTER': "'coord@301'", 'COORD_TYPE': "'GEODETIC'",
        'SITE_COORD': f"'{site['longitudeEastDeg']},{site['latitudeDeg']},{altitude:.12f}'",
        'START_TIME': "'2027-01-01 00:00'", 'STOP_TIME': "'2027-03-01 00:00'",
        'STEP_SIZE': "'10 min'", 'QUANTITIES': "'4,20'", 'APPARENT': "'AIRLESS'",
        'CSV_FORMAT': "'YES'", 'TIME_TYPE': "'UT'", 'TIME_DIGITS': "'SECONDS'", 'RANGE_UNITS': "'AU'",
    }
    query = urlencode(params)
    cache = ROOT / '.cache' / ('solar-' + hashlib.sha256(query.encode()).hexdigest() + '.json')
    if cache.exists():
        payload = json.loads(cache.read_text('utf-8'))
    else:
        request = Request('https://ssd.jpl.nasa.gov/api/horizons.api?' + query,
                          headers={'User-Agent': 'Nocoast-Lunar-Solar/0.1'})
        with urlopen(request, timeout=60) as response:
            payload = json.load(response)
        if payload.get('error'):
            raise ValueError(payload['error'])
        parse_samples(payload['result'])
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(payload), encoding='utf-8')
    return dict(schemaVersion='1.1', body='sun', siteId=site['siteId'],
                frameId=DEFAULTS['frameId'], observerHeightAboveGroundM=2,
                observer=dict(latitudeDeg=site['latitudeDeg'], longitudeEastDeg=site['longitudeEastDeg'], altitudeKm=altitude),
                stepHours=1 / 6, source='jpl_horizons', origin='jpl_horizons', request=params,
                samples=parse_samples(payload['result']), generatedAtUtc=iso(datetime.now(timezone.utc)),
                notes=['NASA JPL Horizons quantities 4 (az/el) and 20 (observer range in AU).',
                       'Airless apparent directions; UTC; lunar MEAN_ME frame; 1737.4 km sphere.',
                       '10-minute samples; shadow transitions are not event-refined.'])


if __name__ == '__main__':
    bundles = [fetch_site(site) for site in DEFAULTS['sites']]
    destination = ROOT / 'public/science/ephemeris'
    for bundle in bundles:
        target = destination / (bundle['siteId'] + '-sun.json')
        # Both responses have passed validation before any bundle is written.
        target.write_text(json.dumps(bundle, separators=(',', ':')) + '\n', encoding='utf-8')
        print(f"Saved {target.name}: {len(bundle['samples'])} samples, with AU range")
