# Implementation summary — Lunar Landing Site Navigator

**Repo:** `d:\Documents\NoCoast_Space\Nocoast-NasaSpaceHacks`  
**Branch:** `preview` (from `vracton/terrain`)  
**Remote:** `origin/preview` on [kyriosroboticsdev/Nocoast-NasaSpaceHacks](https://github.com/kyriosroboticsdev/Nocoast-NasaSpaceHacks)

## What was built

End-to-end extension of the existing Vite / TypeScript / Three.js polar terrain explorer into a dual-mode **Lunar Landing Site Navigator**:

| Area | Delivered |
| --- | --- |
| Modes | **Planner** (dense metrics) and **Learn** (narrative + guided scenarios) sharing one scenario engine |
| Sites | CR1 / SR1 study points; curated catalog (Malapert, Peak near Shackleton, de Gerlache, Haworth); custom lat/lon |
| Horizons | 360° LOLA profiles for CR1/SR1 (5 m near-field + 320 m overview, 0.25°); sphere fallback with explicit optimistic flag |
| Ephemeris | Bundled JPL Horizons Sun/Earth az/el for Jan 2027; analytic fallback; optional live Horizons client |
| Assessment | Sunlight / Earth LOS windows, simultaneous ∩, blackouts, availability %, power proxy, sunset/Earthset countdowns, GO/RISKY/NO-GO |
| Viz | Existing 3D terrain + 360° skyline (Sun/Earth markers) + mission timeline (Gantt) |
| Compare | Side-by-side Site A / Site B with shared UTC window |
| UX layout | Related controls co-located with their viz: sites↔3D map, time scrubber↔skyline/timeline, thresholds↔metrics |
| Onboarding | First-visit spotlight tour (`src/ui/tour.ts`); completion in `localStorage` key `llsn-tour-v1`; **Replay tour** in header |
| Share / export | URL query state (`?mode=&site=&siteB=&date=&hours=&compare=`); JSON time-series export |
| Offline demo | Bundled `public/science/**` horizons + ephemeris |

## Phase commits on `preview`

| Phase | Commit subject (abbrev) |
| --- | --- |
| 0 | docs: add preview branch runbook for phase 0 hygiene |
| 1 | feat: add shared scenario engine and Planner/Learn shell |
| 2 | feat: ship LOLA 360 horizons for CR1/SR1 with skyline viz |
| 3 | feat: add Sun/Earth ephemeris with terrain obstruction and UTC scrubber |
| 4 | feat: assess sunlight, Earth LOS, blackouts, and power proxy |
| 5 | feat: add A/B compare timeline and curated catalog flags |
| 6 | feat: polish Learn mode narrative, guided scenarios, and disclosure |
| 7 | docs: harden demo runbook and add implementation validation summary |
| 8 | feat: co-locate controls with viz and add first-visit tour |

No Cursor `Co-authored-by` trailers were included on pushed commits.

## Key files

- `src/app.ts` — shell + science orchestration + tour boot
- `src/ui/tour.ts` — coach-mark / spotlight onboarding
- `src/main.ts` — terrain viewer (`startTerrain` API)
- `src/scenario/*` — shared state, catalog, URL sync
- `src/horizon/*`, `scripts/compute-horizons.mjs`, `public/science/horizons/*`
- `src/ephemeris/*`, `scripts/fetch-horizons.mjs`, `public/science/ephemeris/*`
- `src/assess/windows.ts` — mission assessment
- `src/viz/skyline.ts`, `src/viz/timeline.ts`
- `index.html` / `src/style.css` — clustered layout (map / assess / time-sky)
- `public/terrain/sites.json` — `horizonStatus: ready`
- `RUNBOOK.md`, `README.md`

## UX tour (re-run)

- Auto-starts once for first-time visitors (unless `localStorage.llsn-tour-v1 === 'done'`).
- Skip or finish marks the tour complete.
- **Replay tour** (header) clears the flag and restarts the walkthrough.
- Dev reset: `localStorage.removeItem('llsn-tour-v1')` then reload.

## How to use this for decisions

This tool **evaluates a scenario you specify**; it does not search for the best landing site or date.

1. **Pick Site A** (prefer CR1/SR1 for LOLA terrain horizons). Optionally enable compare and set Site B.
2. **Set mission start + duration** — that window is what GO / RISKY / NO-GO grades (sunlight %, Earth LOS %, blackouts, power proxy).
3. **Scrub** only to inspect *when* Sun/Earth are clear inside that window (skyline markers, elev, time-to-sunset/Earthset). Scrub does **not** change the viability badge.
4. **Change the start date** (or use Learn → Launch slip +14 days) or switch sites to see schedule/location sensitivity.
5. Tune **thresholds** if your antenna/power assumptions differ; share via **Copy link** or **Export JSON**.

**Planner:** treat the window grade + timeline bars as the decision artifacts; use scrub for ops timing.  
**Educator:** Learn mode + guided scenarios teach why small site/date moves matter; same engine as Planner.

Full requirements mapping and gap analysis: see `REQUIREMENTS_AUDIT.md`.

## How to run

```powershell
cd d:\Documents\NoCoast_Space\Nocoast-NasaSpaceHacks
npm.cmd ci
npm.cmd run dev
```

Build check: `npm.cmd run build`

## Limitations (honest)

- Custom / non-study curated sites use **sphere horizons** (optimistic / terrain unknown).
- Bundled Horizons series cover **Jan 2027** for CR1/SR1; other dates/sites use analytic fallback unless live Horizons is enabled.
- Near-field LOLA detail for horizons uses bundled focus windows (~1.28 km); far-field is 320 m overview out to 400 km.
- 3D display lighting ≠ authoritative observer Sun/Earth status.
- Full on-demand 5 m streaming still needs `/terrain/window` or local mosaic; demo works with bundled overview + focus bins.

## Validation checklist for Randy

### Smoke

- [x] `npm.cmd ci` succeeds
- [x] `npm.cmd run build` succeeds (tsc + vite)
- [x] `npm.cmd run dev` loads without console errors; terrain globe appears 

### Planner P0

- [x] Default load shows CR1 as Site A and SR1 as Site B with compare on
- [x] Zoom to site A flies into Connecting Ridge; markers visible
- [x] 360° skyline draws terrain profile (not flat) for CR1/SR1
- [x] UTC scrubber moves Sun/Earth markers; scrub label shows ephemeris source (bundled Horizons preferred)
- [ ] Metrics show sunlight %, Earth LOS %, simultaneous %, power proxy, blackouts, sunset/Earthset countdowns
- [ ] Viability badge shows GO / RISKY / NO-GO with a reason
- [ ] Timeline shows sunlight / Earth / both bars; scrubber line tracks

### Compare + catalog

- [ ] Toggle compare off hides Site B metrics; on restores them
- [ ] Switch Site B among curated catalog entries; sphere-horizon warning appears for non-study sites
- [ ] Custom lat/lon fields apply; horizon flag says optimistic sphere
- [ ] Guided **Compare CR1 vs SR1** and **Launch slip +14 days** update dates and metrics

### Learn mode

- [ ] Learn toggle shows narrative panel; guided buttons work
- [ ] Same numeric viability appears as Planner for the same scenario
- [ ] “Show technical details” reveals tech-only metric rows in Learn

### Share / offline

- [ ] Copy shareable link; paste in new tab restores mode/site/date
- [ ] Export JSON downloads a time-series payload with site A (and B if compare)
- [ ] With network disabled after first load of science JSON, CR1/SR1 still assess using bundled files

### Integrity

- [ ] `git log preview --format="%B---"` shows **no** `Co-authored-by: Cursor` on phase commits
- [ ] `git status` clean after pull of `origin/preview`
