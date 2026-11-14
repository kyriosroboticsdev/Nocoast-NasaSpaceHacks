# Lunar Landing Site Navigator — Runbook

Local development branch for the NASA Space Apps Lunar Landing Site Navigator extension of the polar terrain explorer.

## Repo layout

- Workspace: `d:\Documents\NoCoast_Space`
- App checkout: `d:\Documents\NoCoast_Space\Nocoast-NasaSpaceHacks`
- Base branch: `vracton/terrain`
- Working branch: `preview` (local + origin)

Challenge context markdown lives beside the checkout:

- `d:\Documents\NoCoast_Space\lunar-landing-site-navigator-details.md`
- `d:\Documents\NoCoast_Space\lunar-landing-site-navigator-resources.md`

## First-time setup

```powershell
cd d:\Documents\NoCoast_Space
git clone --branch vracton/terrain https://github.com/kyriosroboticsdev/Nocoast-NasaSpaceHacks.git Nocoast-NasaSpaceHacks
cd Nocoast-NasaSpaceHacks
git checkout -b preview
npm.cmd ci
npm.cmd run dev
```

Requires Node.js 22.12+.

## Daily loop

```powershell
cd d:\Documents\NoCoast_Space\Nocoast-NasaSpaceHacks
npm.cmd run dev
```

Type-check / production build:

```powershell
npm.cmd run build
npm.cmd run preview
```

## Science data regeneration (optional)

```powershell
npm.cmd run science
```

Bundled horizons and ephemeris under `public/science/` support offline demos without re-fetching.

## Branch rules

- Implement on `preview` only.
- One coherent commit at the end of each plan phase (0–7), then push `preview` to origin.
- Do not force-push. Do not rewrite git config. Do not add Cursor co-author trailers.
