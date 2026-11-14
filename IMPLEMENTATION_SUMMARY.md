# Implementation summary — Lunar Landing Site Navigator

**Repo:** `d:\Documents\NoCoast_Space\Nocoast-NasaSpaceHacks`  
**Branch:** `preview` (from `vracton/terrain`)  
**Remote:** `origin/preview` on [kyriosroboticsdev/Nocoast-NasaSpaceHacks](https://github.com/kyriosroboticsdev/Nocoast-NasaSpaceHacks)

## What was built

End-to-end **find / compare / decide** navigator on the Vite / TypeScript / Three.js polar terrain explorer:

| Area | Delivered |
| --- | --- |
| Modes | **Planner** and **Learn** sharing one scenario engine |
| Decision loop | **Rank sites**, **Suggest better dates**, slip ±7/14, **Jump scrub to best ∩**, adopt/apply |
| Dual verdict | Mission **window grade** (GO/RISKY/NO-GO) + **at scrub time** chip (BOTH / SUNLIT / EARTH LOS / BLACKOUT) |
| Sites | CR1/SR1 (LOLA); curated polar; CLPS-style; Apollo 11–17; Chang’e-4; Chandrayaan-3; custom + **map pick** |
| Horizons | 360° LOLA for CR1/SR1; sphere_optimistic elsewhere with UI flag |
| Ephemeris | Bundled Jan 2027 Horizons for CR1/SR1; analytic fallback; coverage guard |
| Assessment | Sunlight / Earth LOS / ∩ windows, blackouts, %, power proxy, panel tilt, sunset/Earthset |
| Viz | 3D terrain + skyline + timeline with **best-window highlighter** + **Play** scrub animation |
| Compare | Side-by-side Site A / Site B |
| Onboarding | Tour (decision + window-vs-scrub steps); guided scenarios incl. Apollo contrast + Rank |
| Share / export | URL query state; JSON export includes ranking + date suggestions |
| Offline demo | Bundled `public/science/**` horizons + ephemeris |

## Decision workflow (how to use)

1. Set **mission start + duration** (or Quick windows / slip buttons).  
2. Read **Mission window grade** + availability % — that is the site-date decision.  
3. Optionally **Rank sites** → Adopt a better catalog candidate; or **Suggest better dates** → Apply a slip.  
4. **Jump scrub to best ∩** (or Play) to inspect ops timing; watch the **At scrub time** chip — it does not change the window grade.  
5. **Pick on map** / custom lat-lon for exploratory sphere assessments (labeled optimistic).  
6. Tune thresholds (min Earth el, panel area/eff/**tilt**, battery floor); **Copy link** / **Export JSON**.

**Planner:** window grade + rank/date helpers are the decision artifacts; scrub/play for ops timing.  
**Educator:** Learn narrative + dynamic why-win/fail tip + Apollo vs CR1 + Play animation.

Full requirements mapping: `REQUIREMENTS_AUDIT.md`.

## Key files

- `src/app.ts` — shell, decision actions, play, map-pick wiring  
- `src/assess/decision.ts` — rank, date suggestions, best window, instant status, explainVerdict  
- `src/assess/windows.ts` — mission assessment  
- `src/viz/timeline.ts` — Gantt + best-window highlight  
- `src/scenario/catalog.ts` — expanded catalog  
- `src/main.ts` — terrain viewer + `setPickMode`  
- `src/ui/tour.ts` — onboarding  
- `index.html` / `src/style.css` — decision panel, dual verdict, play controls  

## How to run

```powershell
cd d:\Documents\NoCoast_Space\Nocoast-NasaSpaceHacks
npm.cmd ci
npm.cmd run dev
```

Build check: `npm.cmd run build`

## Limitations (honest)

- Custom / non-study catalog sites use **sphere horizons** (optimistic).  
- Bundled Horizons = **Jan 2027** for CR1/SR1; other dates/sites → analytic unless live enabled.  
- **Neighborhood search deferred** — LOLA only at CR1/SR1 (UI note in decision panel).  
- Quest VR runtime not shipped — JSON export for external viewers.  
- 3D lighting ≠ authoritative observer Sun/Earth status.

## Validation checklist for Randy

### Smoke

- [x] `npm.cmd run build` succeeds (tsc + vite)  
- [ ] `npm.cmd run dev` loads; terrain globe appears  

### Decision loop

- [ ] **Rank sites** lists catalog with GO/RISKY/NO-GO and %; **Adopt** changes Site A  
- [ ] **Suggest better dates** lists slips; **Apply** changes start  
- [ ] **Jump scrub to best ∩** moves scrubber; timeline shows dashed highlight  
- [ ] Scrub / **Play** updates instant chip; window grade stays until start/site change  
- [ ] Slip −14/−7/+7/+14 buttons recompute grade  

### Sites / custom

- [ ] Catalog shows Apollo / CLPS / international groups; sphere warning on non-study  
- [ ] **Pick on map** sets custom Site A; Esc cancels; sphere flag shown  
- [ ] Custom lat/lon Apply works; CR1/SR1 still LOLA  

### Learn / tour

- [ ] Learn tip updates with why-win/fail language after assess  
- [ ] Guided **Apollo 11 vs CR1** and **Rank this window** work  
- [ ] Tour mentions window grade vs scrub + decision panel  

### Share / offline

- [ ] Copy link restores mode/site/date  
- [ ] Export JSON includes samples (+ ranking/date suggestions when run)  
- [ ] CR1/SR1 still assess offline from bundled science JSON  

### Integrity

- [ ] Commits have **no** `Co-authored-by: Cursor`  
- [ ] Pushed to `origin/preview`
