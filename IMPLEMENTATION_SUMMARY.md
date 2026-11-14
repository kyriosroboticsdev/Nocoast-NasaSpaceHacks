# Implementation summary — Lunar Landing Site Navigator

**Repo:** `d:\Documents\NoCoast_Space\Nocoast-NasaSpaceHacks`  
**Branch:** `preview` (from `vracton/terrain`)  
**Remote:** `origin/preview` on [kyriosroboticsdev/Nocoast-NasaSpaceHacks](https://github.com/kyriosroboticsdev/Nocoast-NasaSpaceHacks)

## What was built

End-to-end **find / compare / decide** navigator on the Vite / TypeScript / Three.js polar terrain explorer:

| Area | Delivered |
| --- | --- |
| Modes | **Planner** and **Learn** sharing one scenario engine |
| Decision loop | **Find best location**, **Rank catalog**, **Suggest better dates**, slip ±7/14, **Jump scrub to best ∩**, adopt/apply |
| Dual verdict | Mission **window grade** (GO/RISKY/NO-GO) + **at scrub time** chip (BOTH / SUNLIT / EARTH LOS / BLACKOUT) |
| Sites | CR1/SR1 (LOLA); curated polar; CLPS-style; Apollo 11–17; Chang’e-4; Chandrayaan-3; custom + **map pick** |
| Horizons | 360° LOLA for CR1/SR1; sphere_optimistic elsewhere with UI flag; coarse LOLA overview for regional search |
| Ephemeris | Bundled Jan 2027 Horizons for CR1/SR1; analytic fallback; coverage guard |
| Assessment | Sunlight / Earth LOS / ∩ windows, blackouts, %, power proxy, panel tilt, sunset/Earthset |
| Viz | 3D terrain (default **mesh/wireframe**) + skyline + timeline with **best-window highlighter** + **Play** |
| Markers | Three categories on mesh: **catalog** (teal ●), **search** (amber ◆), **chosen** (coral ■) + Site B **compare** (violet ◎) |
| Adopt → 3D | Site A changes / Adopt / map pick / custom apply **always** re-focus camera + chosen marker (no mystery CR1 snap) |
| Compare | Side-by-side Site A / Site B with compare marker |
| Onboarding | Tour; guided scenarios incl. Apollo contrast + Rank + Find best location |
| Share / export | URL query state; JSON export includes ranking + regional search + date suggestions |
| Offline demo | Bundled `public/science/**` horizons + ephemeris + search grid |

## Decision workflow (how to use)

1. Set **mission start + duration** (or Quick windows / slip buttons).  
2. Read **Mission window grade** + availability % — that is the site-date decision.  
3. Optionally **Find best location** (coarse polar overview grid) → Adopt a search hit; or **Rank catalog** → Adopt; or **Suggest better dates** → Apply a slip.  
4. **Jump scrub to best ∩** (or Play) to inspect ops timing; watch the **At scrub time** chip — it does not change the window grade.  
5. **Pick on map** / custom lat-lon for exploratory sphere assessments (labeled optimistic).  
6. Tune thresholds; **Copy link** / **Export JSON**.

**Planner:** window grade + search/rank/date helpers are the decision artifacts; scrub/play for ops timing.  
**Educator:** Learn narrative + dynamic why-win/fail tip + Apollo vs CR1 + Play animation.

Full requirements mapping: `REQUIREMENTS_AUDIT.md`.

## Regional search (how it works)

1. Offline: `npm run science:search` → `scripts/precompute-search-grid.mjs` writes `public/science/search/polar-cap-candidates.json` (~262 points, ~10 km spacing, 87°S–90°S).  
2. Each candidate stores compact **LOLA 320 m overview** horizon elev bins (2° azimuth, 640 m ray step to 250 km) — **no 5 m near-field**.  
3. In-app **Find best location** filters by region (full cap or around Site A radius), scores with `assessMission` + analytic ephemeris (2 h steps), ranks top-N.  
4. Hits plot as amber ◆ markers; **Adopt** sets custom Site A → coral ■ chosen marker + camera fly.  
5. UI labels honesty: coarse ranking, not meter-perfect / not global optimum. Prefer CR1/SR1 for study-grade LOLA.

## Key files

- `src/app.ts` — shell, adopt→3D sync, search/rank/date actions, marker wiring  
- `src/assess/search.ts` — load search catalog, region filter, rank candidates  
- `src/assess/decision.ts` — rank, date suggestions, best window, instant status, explainVerdict  
- `src/assess/windows.ts` — mission assessment  
- `src/main.ts` — terrain viewer, multi-category markers, mesh default, `setPickMode`  
- `scripts/precompute-search-grid.mjs` — overview horizon grid precompute  
- `public/science/search/polar-cap-candidates.json` — bundled search candidates  
- `index.html` / `src/style.css` — decision panel, marker legend, search controls  

## How to run

```powershell
cd d:\Documents\NoCoast_Space\Nocoast-NasaSpaceHacks
npm.cmd ci
npm.cmd run dev
```

Build check: `npm.cmd run build`  
Regenerate search grid: `npm.cmd run science:search`

## Limitations (honest)

- Custom / non-study catalog sites use **sphere horizons** (optimistic).  
- Bundled Horizons = **Jan 2027** for CR1/SR1; other dates/sites → analytic unless live enabled.  
- Regional search = **320 m overview** + ~10 km grid — useful for exploration, not meter-perfect siting.  
- Quest VR runtime not shipped — JSON export for external viewers.  
- 3D lighting ≠ authoritative observer Sun/Earth status.

## Validation checklist for Randy

### Smoke

- [x] `npm.cmd run build` succeeds (tsc + vite)  
- [ ] `npm.cmd run dev` loads; terrain opens in **mesh** by default  

### Decision loop

- [ ] **Find best location** lists top-N with overview LOLA; amber ◆ markers appear; **Adopt** → coral ■ + camera  
- [ ] **Rank catalog** lists GO/RISKY/NO-GO; **Adopt** changes Site A + 3D focus  
- [ ] **Suggest better dates** / **Jump scrub** / Play / slip buttons still work  

### Markers / sync

- [ ] Catalog teal ● visible (toggleable); chosen always distinct; Site B violet ◎ when compare on  
- [ ] Click catalog/search marker adopts or focuses  
- [ ] Changing Site A / custom apply / map pick flies to that location (not a stale study pin)  

### Integrity

- [ ] Commits have **no** `Co-authored-by: Cursor`  
- [ ] Pushed to `origin/preview`
