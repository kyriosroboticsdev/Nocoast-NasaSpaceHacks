# Development guide

Day-to-day commands for working on the Lunar Landing Site Navigator. For the project overview and
quick demo, see the [README](../README.md).

## Setup

Requires Node.js 22.12+.

```bash
git clone https://github.com/kyriosroboticsdev/Nocoast-NasaSpaceHacks.git
cd Nocoast-NasaSpaceHacks
git checkout preview
npm ci
npm run dev
```

(Windows: `npm.cmd` in place of `npm`.)

## Daily loop

```bash
npm run dev        # local dev server with hot reload
npm run build      # type-check (tsc --noEmit) + production build
npm run preview    # serve the production build
```

## Optional: the live science backend

The frontend works fully offline on bundled data by default. Running the Person 2 Python backend
alongside it upgrades terrain horizons and Sun/Earth ephemeris to live, computed-on-demand data for
any south-polar point — see [`backend/README` via docs/PERSON2_COMMS.md](./PERSON2_COMMS.md) and
[`PERSON2_INTEGRATION_REPORT.md`](./PERSON2_INTEGRATION_REPORT.md) for how that's wired in.

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m scripts.fetch_data      # downloads real NASA DEM/SPICE data, one-time
.venv/bin/python -m uvicorn backend.app:app --port 8765   # in one terminal
npm run dev                                                # in another
```

`vite.config.mjs` proxies `/api` to `http://127.0.0.1:8765` automatically; the app detects the
backend and uses it, falling back to bundled data if it isn't running.

## Regenerating bundled science data (optional)

```bash
npm run science
```

`science:horizons` works offline from bundled DEM windows; `science:ephemeris` needs network access
for live JPL Horizons and falls back to an analytic series if unreachable.

## Branch conventions

- Feature work happens on `preview` (or a branch based on it) before merging; `main` is the
  longer-lived trunk.
- Prefer one coherent commit per logical change over a pile of fixups.
- Do not force-push shared branches. Do not rewrite git config.
