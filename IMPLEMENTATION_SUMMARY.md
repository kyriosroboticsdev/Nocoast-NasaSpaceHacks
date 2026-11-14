# Implementation summary — Lunar Landing Site Navigator

**Repo:** `d:\Documents\NoCoast_Space\Nocoast-NasaSpaceHacks`  
**Branch:** `preview` (from `vracton/terrain`)  
**Remote:** `origin/preview` on [kyriosroboticsdev/Nocoast-NasaSpaceHacks](https://github.com/kyriosroboticsdev/Nocoast-NasaSpaceHacks)

## Metric explanations (Planner UX)

Accessible **?** tooltips (hover + keyboard focus, `aria-describedby`) on key statistics and thresholds explain **why the number matters** and **how it is calculated** from `assess/windows.ts` / GO gates:

- Sunlight %, Earth LOS %, **Sun ∩ Earth** (power while talking to Earth / no relay), mean power vs battery floor, peak power, longest sun/Earth blackouts, unknown hours, time to sunset/Earthset, scrub elev/clearance, viability grade, instant chip, and threshold inputs (min Earth el, panel area/eff/tilt, battery floor).
- Metric cards also show a live **power & comms primer** (hours + % + floor); Learn / decision-lead copy expand the same story. Honesty preserved: proxy watts, LOLA vs sphere, analytic vs JPL badges unchanged.

## What was built

End-to-end **find / compare / decide** navigator on the Vite / TypeScript / Three.js polar terrain explorer:

| Area | Delivered |
| --- | --- |
| Modes | **Planner** and **Learn** sharing one scenario engine |
| Decision loop | **Find best location**, **Rank catalog**, **Suggest better dates**, slip ±7/14, **Jump scrub to best ∩**, adopt/apply |
| Dual verdict | Mission **window grade** (GO/RISKY/NO-GO) + **at scrub time** chip (BOTH / SUNLIT / EARTH LOS / BLACKOUT) |
| Sites | CR1/SR1 (LOLA); curated polar; CLPS-style; Apollo 11–17; Chang’e-4; Chandrayaan-3; custom + **map pick** |
| Horizons | 360° LOLA for CR1/SR1 (az 0 = **true local north** ENU); sphere elsewhere; overview LOLA for search (**Adopt keeps overview**, not sphere) |
| Ephemeris | Bundled JPL for CR1/SR1 (extend via `science:ephemeris` when online); **no clamp past series end** (uncovered hours = unknown); calibrated analytic fallback (badged) |
| Assessment | Exact `[start,end]` sampling; sun/shadow/**unknown** hours; windows with transition midpoints; power = 0 when not sunlit |
| Ranking | Tiered authority: LOLA 5 m+JPL → overview → sphere/analytic (hard tier sort + score penalties); provenance badges |
| Viz | 3D terrain (default **mesh/wireframe**) + skyline + timeline with **best-window highlighter** + **Play**; mesh = polar 320 m LOLA (+ LOD) + **global LDEM 4 ppd** outside 87°S |
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
4. **Power is in search scoring** (not sunlight-only): soft score uses `meanPowerW` (panel area × efficiency × solar constant × incidence when sunlit); GO viability also requires `meanPowerW ≥ batteryFloorW`. Hit badges show mean power + floor.  
5. Hits plot as amber ◆ markers; **Adopt** sets custom Site A **and retains the overview LOLA horizon + elevation used for ranking** (not downgraded to sphere).  
6. UI labels honesty: coarse ranking, not meter-perfect / not global optimum. Prefer CR1/SR1 for study-grade LOLA.

### Mesh LOD (preview) — polar + global LDEM

**Outside-cap wireframe / real DEM — feasible at 4 ppd.**  
NASA SVS CGI Moon Kit `ldem_4.tif` is only ~4 MB (1440×720 float km). Offline script `npm run terrain:global-ldem` downloads it (cached under `.cache/`) and writes `public/terrain/global-ldem-4ppd.bin` (~2.0 MB Int16 meters). In **mesh** mode the viewer shows:
- **Polar cap:** existing **320 m LOLA** overview (+ dynamic LOD as below)
- **Outside cap:** displaced **global LDEM 4 ppd** wireframe (real elevation, ~7.5 km/px)

**Overlap avoided:** global mesh hard-clips south of **87°S** (`GLOBAL_HOLE_LAT_DEG`), fades heights to the reference sphere from **−86° → −87°**, and dims the textured globe (`opacity` + `depthWrite` off) while mesh is on — no flat sphere shell, no double-shell poke-through with the polar disc.

**Badge:** `POLAR 320 M LOLA · GLOBAL LDEM 4 PPD`

**Polar dynamic LOD (restored):**  
- Far / overview: full-cap **320 m LOLA** wireframe.  
- Zoomed (camera distance &lt; ~5.5 km to target): stream detail windows at **stride 8 (~40 m)** then **stride 4 (~20 m)** when closer — readable density, not solid blue.  
- **Never** mesh stride 1–2 (5–10 m). Relief/elevation still use 5–20 m.  
- When a fully valid detail window loads, the overview is **cut out under it** (same as relief) so tops/bottoms do not intersect. Edge fade into overview via `meshFor(..., parent)` keeps the join continuous.

## Key files

- `src/app.ts` — shell, adopt→3D sync, search/rank/date actions, marker wiring  
- `src/assess/search.ts` — load search catalog, region filter, rank candidates  
- `src/assess/decision.ts` — rank, date suggestions, best window, instant status, explainVerdict  
- `src/assess/windows.ts` — mission assessment  
- `src/main.ts` — terrain viewer, multi-category markers, mesh default, global LDEM wireframe, `setPickMode`  
- `scripts/build-global-ldem.mjs` — download SVS `ldem_4.tif` → `public/terrain/global-ldem-4ppd.bin`  
- `scripts/precompute-search-grid.mjs` — overview horizon grid precompute  
- `public/science/search/polar-cap-candidates.json` — bundled search candidates  
- `public/terrain/global-ldem-4ppd.bin` — compact Int16 global heights (~2 MB)  
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

- Custom / map-pick (non-adopted-search) sites use **sphere horizons** (optimistic).  
- Bundled Horizons cover CR1/SR1 from precompute range (target Jan–Mar 2027 when fetch succeeds); uncovered mission hours are **unknown**, not frozen Sun.  
- Analytic fallback is calibrated near the south pole vs bundled JPL (~1° Sun az there) but still **badged** — not study-grade alone.  
- Overview DEM reach along rays is typically **~80–145 km**, not 400 km; bearings that exit DEM before geometric closure are `gap`.  
- Regional search = **320 m overview** + ~10 km grid — exploration grade.  
- Quest VR runtime not shipped — JSON export for external viewers.  
- 3D lighting ≠ authoritative observer Sun/Earth status.

## Validation checklist for Randy

### Smoke

- [x] `npm.cmd run build` succeeds (tsc + vite)  
- [ ] `npm.cmd run dev` loads; terrain opens in **mesh** by default  
- [ ] Whole Moon mesh shows real LDEM relief at Apollo latitudes; polar still 320 m LOLA; badge `POLAR 320 M LOLA · GLOBAL LDEM 4 PPD`  

### Decision loop

- [ ] **Find best location** lists top-N with overview LOLA; amber ◆ markers appear; **Adopt** → coral ■ + camera  
- [ ] **Rank catalog** lists GO/RISKY/NO-GO; **Adopt** changes Site A + 3D focus  
- [ ] **Suggest better dates** / **Jump scrub** / Play / slip buttons still work  

### Markers / sync

- [ ] Catalog teal ● visible (toggleable); chosen always distinct; Site B violet ◎ when compare on  
- [ ] Click catalog/search marker adopts or focuses  
- [ ] Changing Site A / custom apply / map pick flies to that location (not a stale study pin)  

### Science fixes (post multi-model review)

- [ ] 1.5 h mission → sunlight % ≤ 100 (no 133% overshoot)  
- [ ] Adopt search hit → horizon flag shows overview LOLA (not sphere)  
- [ ] Share URL restores thresholds + scrub; globe pick latitude sign correct  

### Integrity

- [ ] Commits have **no** `Co-authored-by: Cursor`  
- [ ] Pushed to `origin/preview`
