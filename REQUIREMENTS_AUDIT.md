# Requirements audit — Lunar Landing Site Navigator

**Date:** 2026-11-14 (updated after decision-loop implementation)  
**Branch:** `preview`  
**Challenge refs:** `../lunar-landing-site-navigator-details.md`, `../lunar-landing-site-navigator-resources.md`  
**Implementation:** Vite / TypeScript / Three.js app in this repo (`src/app.ts`, `src/assess/*`, `src/scenario/*`, `src/ui/*`, `public/science/**`)

## Executive verdict

The app now supports an interactive **find / compare / decide** loop: **Find best location** on a coarse LOLA-overview polar grid, rank catalog sites for the selected UTC window, suggest nearby launch-slip dates, highlight the best sun ∩ Earth stretch on the timeline, and keep **mission window grade** separate from **at-scrub-time** ops status. Adopt/Site A changes sync the 3D chosen marker + camera. Default terrain layer is mesh/wireframe. Core science (LOLA horizons for CR1/SR1, bundled Horizons, assessMission) is unchanged. Meter-perfect on-demand 5 m LOLA for every point and Quest VR runtime remain deferred with honest UI labels.

**Coverage counts (matrix below):** **Implemented 27 · Partial 6 · Missing / deferred 2** (35 rows). Challenge “may include” language means Partial/deferred is expected for true stretch science.

---

## 1. Requirements coverage matrix

Status key: **Implemented** = usable in UI/engine today · **Partial** = present but limited/incomplete · **Missing** = not present / deferred with reason.

### Challenge summary / primary goal

| Requirement | Status | Evidence |
| --- | --- | --- |
| Intuitive tool to compare landing sites and dates quickly | **Implemented** | Planner + Learn; A/B compare; **Rank sites** + **Suggest better dates** + slip buttons (`index.html`, `src/assess/decision.ts`, `src/app.ts`). |
| Visualize Sun and Earth relative to horizon for power + DTE windows | **Implemented** | 360° skyline (`src/viz/skyline.ts`); assessment windows (`src/assess/windows.ts`); ∩ prominence on timeline. |

### Objectives (“Your solution may include”)

| Objective | Status | Evidence |
| --- | --- | --- |
| Curated notable landing sites (Apollo / CLPS / commercial / international) | **Implemented** | Catalog groups: study, curated polar, CLPS-style, Apollo 11–17, Chang’e-4, Chandrayaan-3 (`src/scenario/catalog.ts`). Non-study = sphere_optimistic, labeled. |
| Custom lunar coordinates | **Implemented** | Custom lat/lon + **Pick on map** crosshair mode (`TerrainApi.setPickMode`, sphere warning). |
| Side-by-side or sequential comparison of multiple sites | **Partial** | A/B compare + ranked catalog list (adopt any row). Still max 2 live metric columns; no >2 simultaneous panels. |
| Select landing dates/times; explore lunar days/seasons | **Implemented** | Mission start/duration; Quick windows (early/mid/late Jan 2027, ~1 lunar day); slip helper ±3…±21 d; season fidelity note for bundled vs analytic. |
| Display Sun/Earth vs horizon on chosen date | **Implemented** | Skyline markers + clear/blocked coloring. |
| Time remaining before sunset / Earthset | **Implemented** | Updates with scrub (`paintScrubOnly`). |
| Solar elevation, sunlight duration, Earth visibility windows | **Implemented** | Metric grid (window vs scrub groups) + timeline bars. |
| Highlight viability of a site-date combination | **Implemented** | Window GO/RISKY/NO-GO + instant BOTH/SUNLIT/EARTH LOS/BLACKOUT dual display; NO-GO prompts. |
| Multiple viz: 2D maps / 3D surface / creative | **Partial** | 3D LOLA terrain, 2D skyline, Gantt timeline with best-window highlight. No 2D illumination map overlay on the globe. |
| Animations or timeline views over a lunar day / multi-day | **Implemented** | Play/Pause scrub animation + speed + static timeline bars + best-window highlighter. |
| Accessible to planners and educators / public | **Implemented** | Planner/Learn; tour (window vs scrub + decision step); guided scenarios incl. Apollo contrast + Rank; dynamic why-win/fail tip. |

### Potential considerations — technical

| Consideration | Status | Evidence |
| --- | --- | --- |
| Ephemeris (JPL Horizons or pre-computed) | **Implemented** | Bundled CR1/SR1 Jan 2027; analytic fallback; live client exists (`allowLive: false`). Coverage guard when start outside bundle. |
| Lunar topography (LOLA) for surface + horizons | **Partial** | 3D mosaic + LOLA 360° for **CR1/SR1 only**. Curated/custom/Apollo/CLPS → sphere, flagged. On-demand LOLA for arbitrary points **deferred** (compute cost / mosaic coverage). |
| No atmosphere / geometric horizon (no refraction) | **Implemented** | Notes in Horizons fetch + provenance. |
| Solar elevation prominent for power | **Implemented** | Instant sun elev + clear elev + irradiance/power proxy; panel area/eff/**tilt** in thresholds. |

### Potential considerations — UX

| Consideration | Status | Evidence |
| --- | --- | --- |
| Rapid scenario comparison (many site-date combos) | **Implemented** | Regional find-best + rank catalog; date-slip search; A/B; shareable URL; guided presets. |
| Clearly communicate time-to-sunset / Earthset | **Implemented** | Metric rows; scrub updates; dual verdict caption. |
| Make lunar vs terrestrial extremes apparent | **Implemented** | Learn Earth-analog copy; Apollo 11 vs CR1 guided compare. |
| Show why small location/date changes have large impact | **Partial** | Rank + regional overview search + date helper + guided CR1↔SR1/slip + dynamic explainVerdict. Dense 5 m neighborhood optimizer still deferred; search uses ~10 km / 320 m overview with honesty labels. |

### Potential considerations — data & accuracy

| Consideration | Status | Evidence |
| --- | --- | --- |
| Account for real topography affecting horizons | **Partial** | LOLA for study sites; sphere elsewhere with warning. |
| Earth’s libration / orbital variations | **Partial** | Bundled Horizons includes real geometry; analytic fallback simplified. |
| Represent steep slopes / deep craters / extreme shadow | **Partial** | 3D terrain + jagged LOLA skyline for study sites; no PSR/shadow map product. |

### Potential considerations — engagement & impact

| Consideration | Status | Evidence |
| --- | --- | --- |
| Support science ↔ engineering coordination | **Partial** | Shared URL + JSON export (incl. ranking/date suggestions). No collaborative annotations. |
| Respond quickly when schedule/location must change | **Implemented** | Rank sites; Suggest better dates; ±7/14 slip; adopt/apply; NO-GO prompts. |
| Educational tool for students / public | **Implemented** | Learn mode, tour, guided scenarios, why-win/fail narrative, play animation. |

### Challenge resources (usage, not features)

| Resource | Status | Evidence |
| --- | --- | --- |
| Quickmap | Linked | Footer links. |
| Moon Trek | Linked | Same. |
| JPL Horizons | **Implemented** (bundled + client) | `public/science/ephemeris/*`, `src/ephemeris/horizons.ts`. |
| CSA Moon Exploration | Linked | README cite. |

---

## 2. Decision loop (post-implementation mental model)

**You set a mission window → read window grade + scrub ops status → Rank sites or Suggest dates → Adopt/Apply → jump scrub to best ∩ to inspect timing.**

| Action | Effect |
| --- | --- |
| Find best location | Scores ~262 polar-cap candidates (LOLA 320 m overview horizons) for the mission window; top-N as search markers; Adopt → custom Site A |
| Rank catalog sites | Scores study + curated + CLPS + Apollo + international (+ custom A) with assessMission; sorted list with GO/RISKY/NO-GO and % metrics; Adopt sets Site A |
| Suggest better dates | Scores start slips ±3…±21 d for current Site A; Apply sets mission start |
| Jump scrub to best ∩ | Moves scrubber to longest simultaneous (else sun / Earth) window |
| Play | Animates scrub for education; instant chip updates; window grade stays put |
| Pick on map | Sets custom Site A from terrain click (sphere horizon) |

**Scrub vs window grade (unchanged engine rule, clearer UI):**

| Display | Updates on scrub? | Updates on start/duration/site/thresholds? |
| --- | --- | --- |
| Mission window GO / RISKY / NO-GO | **No** | **Yes** |
| Availability % / blackouts / mean power | **No** | **Yes** |
| At scrub time chip (BOTH / …) | **Yes** | **Yes** |
| Time to sunset / Earthset, elev, skyline | **Yes** | **Yes** |
| Timeline bars / best-window highlight | Marker only / highlight fixed until recompute | **Yes** |

---

## 3. Deferred / cannot fully ship (honest)

| Item | Why deferred | Best available stub |
| --- | --- | --- |
| On-demand LOLA horizons for every lat/lon | Requires denser mosaic + offline compute; only CR1/SR1 profiles shipped | Sphere horizon + explicit optimistic flag; Pick on map / custom coords |
| Meter-perfect “better spot 500 m away” optimizer | Needs dense 5 m LOLA at every neighbor | Coarse ~10 km overview search shipped with honesty labels; CR1/SR1 remain study-grade |
| Live Horizons for arbitrary dates in demo | Offline/demo path; network + rate limits | Analytic fallback labeled; `allowLive` exists but false |
| Quest / VR runtime | Out of scope for this web demo | JSON export notes Quest-shaped time series for external viewers |
| 2D illumination / Earth-visibility globe overlay | Stretch viz | Timeline ∩ bars + skyline remain primary |
| Multi-scenario matrix (>2 live columns) | UX complexity | Rank list + A/B compare cover rapid multi-site eval |
| Numeric “confidence %” | Never specified by challenge | Horizon model + ephemeris source provenance flags |

---

## 4. Recommendations status

### Quick wins — **done**
Always-visible window vs scrub caption; tour step; metric grouping; NO-GO prompts; decision docs; ephemeris coverage guard.

### Medium features — **done**
Best-window highlighter; date slip helper; rank sites; instant status chip; play animation.

### Larger / stretch — **partial or deferred**
On-demand 5 m LOLA for arbitrary points; live Horizons toggle; dense sub-km neighborhood optimizer; multi-scenario matrix; full season optimizer beyond slip search; 2D map overlay.

---

## 5. Count summary

| Status | Count |
| --- | ---: |
| Implemented | 27 |
| Partial | 6 |
| Missing / deferred | 2 |
| **Total matrix rows** | **35** |

**Still Partial:** A/B only (not >2 panels); no 2D illumination globe overlay; LOLA only at study sites; analytic libration; no PSR product; share/export without collaborative annotations.  
**Still deferred (Missing):** Neighborhood optimizer; Quest VR runtime (export stub only).

---

## 6. Suggested demo script (decision loop)

1. Defaults (CR1 vs SR1, mid-Jan 2027) → read dual window grades + scrub chips.  
2. Scrub / Play → chips move; badges stay.  
3. **Jump scrub to best ∩** → land on highlighted timeline stretch.  
4. **Suggest better dates** → Apply a better slip if offered.  
5. **Rank sites** → Adopt Malapert or an Apollo site; note sphere warning.  
6. Learn → Apollo 11 vs CR1; read dynamic why-win/fail tip.  
7. Pick on map → custom sphere assessment; Copy link / Export JSON.
