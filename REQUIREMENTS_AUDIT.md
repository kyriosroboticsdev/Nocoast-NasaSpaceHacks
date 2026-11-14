# Requirements audit — Lunar Landing Site Navigator

**Date:** 2026-11-14  
**Branch:** `preview`  
**Challenge refs:** `../lunar-landing-site-navigator-details.md`, `../lunar-landing-site-navigator-resources.md`  
**Implementation:** Vite / TypeScript / Three.js app in this repo (`src/app.ts`, `src/assess/*`, `src/scenario/*`, `src/ui/*`, `public/science/**`)

## Executive verdict

The app **does meet the challenge’s core ask** as an intuitive site/date evaluator with Sun/Earth horizon visualization and power/comms metrics. It is **not** an optimizer that finds the best landing time/location for you. Randy’s instinct is correct: the **decision loop is evaluate-a-scenario**, not **search-for-a-scenario**. The scrubber mostly drives instantaneous skyline/countdowns; **GO / RISKY / NO-GO is a whole-mission-window grade** and only recomputes when site, mission start, duration, thresholds, or compare slot change.

**Coverage counts (matrix below):** **Implemented 14 · Partial 16 · Missing 5** (35 rows). Challenge “may include” language means Partial/Missing is expected, not automatic failure.

---

## 1. Requirements coverage matrix

Status key: **Implemented** = usable in UI/engine today · **Partial** = present but limited/incomplete · **Missing** = not present.

### Challenge summary / primary goal

| Requirement | Status | Evidence |
| --- | --- | --- |
| Intuitive tool to compare landing sites and dates quickly | **Partial** | Planner + Learn shell, A/B compare, date controls (`index.html`, `src/app.ts`). Comparison is manual scenario eval — no ranked search or “best date” helper. |
| Visualize Sun and Earth relative to horizon for power + DTE windows | **Implemented** | 360° skyline (`src/viz/skyline.ts`); assessment windows (`src/assess/windows.ts`). |

### Objectives (“Your solution may include”)

| Objective | Status | Evidence |
| --- | --- | --- |
| Curated notable landing sites (Apollo / CLPS / commercial / international) | **Partial** | Catalog: CR1, SR1 (study) + Malapert, Peak near Shackleton, de Gerlache, Haworth (`src/scenario/catalog.ts`). South-pole focused; **no Apollo or named CLPS mission targets** beyond study-region points. |
| Custom lunar coordinates | **Implemented** | Site select “Custom lat/lon” + Apply (`index.html`, `setCustomCoords` in `src/scenario/state.ts`). Horizon = optimistic sphere. |
| Side-by-side or sequential comparison of multiple sites | **Partial** | A/B compare with shared UTC window (`compare-toggle`, dual metrics, stacked timeline). No sequential multi-site queue or >2 sites. |
| Select landing dates/times; explore lunar days/seasons | **Partial** | Mission start + duration + scrubber (`index.html`). Guided “Launch slip +14 days”. **No season browser, lunar-day picker, or date-range explorer.** Bundled Horizons only covers ~Jan 2027 for CR1/SR1. |
| Display Sun/Earth vs horizon on chosen date | **Implemented** | Skyline markers + clear/blocked coloring (`src/viz/skyline.ts`, scrub path in `src/app.ts`). |
| Time remaining before sunset / Earthset | **Implemented** | `hoursToSunset` / `hoursToEarthset` — **do update with scrub** (`paintScrubOnly` in `src/app.ts`). |
| Solar elevation, sunlight duration, Earth visibility windows | **Implemented** | Metric grid + timeline bars (`renderMetricGrid`, `src/assess/windows.ts`, `src/viz/timeline.ts`). |
| Highlight viability of a site-date combination | **Implemented** | GO / RISKY / NO-GO + reason (`assessMission` viability rules). Tied to **mission window aggregates**, not scrub instant. |
| Multiple viz: 2D maps / 3D surface / creative | **Partial** | 3D LOLA terrain (`src/main.ts`), 2D skyline, Gantt timeline. No 2D illumination map or window overlay on the globe. |
| Animations or timeline views over a lunar day / multi-day | **Partial** | Interactive scrub + static timeline bars. **No play/animate button.** |
| Accessible to planners and educators / public | **Implemented** | Planner vs Learn modes, tour (`src/ui/tour.ts`), guided scenarios, provenance panel. |

### Potential considerations — technical

| Consideration | Status | Evidence |
| --- | --- | --- |
| Ephemeris (JPL Horizons or pre-computed) | **Implemented** | Bundled CR1/SR1 Jan 2027 JSON (`public/science/ephemeris/*`); analytic fallback; live Horizons client exists but **`allowLive: false`** in `computeSlot`. |
| Lunar topography (LOLA) for surface + horizons | **Partial** | 3D mosaic + LOLA 360° horizons for **CR1/SR1 only**. Curated/custom → sphere horizon. |
| No atmosphere / geometric horizon (no refraction) | **Implemented** | Notes in Horizons fetch + provenance; sphere and terrain horizons are geometric (`src/horizon/types.ts`, ephemeris notes). |
| Solar elevation prominent for power | **Implemented** | Instant sun elev (scrub) + clear elev (tech) + irradiance/power proxy. |

### Potential considerations — UX

| Consideration | Status | Evidence |
| --- | --- | --- |
| Rapid scenario comparison (many site-date combos) | **Partial** | Fast A/B + shareable URL. No scenario matrix, saved presets beyond 4 guided buttons, or batch eval. |
| Clearly communicate time-to-sunset / Earthset | **Implemented** | Metric rows; scrub updates them. Control hint under scrubber. |
| Make lunar vs terrestrial extremes apparent | **Partial** | Learn narrative copy; no explicit Earth-analog comparison viz. |
| Show why small location/date changes have large impact | **Partial** | Guided CR1↔SR1 + slip demo; tour. **No neighborhood search or auto “what if I move 500 m”.** |

### Potential considerations — data & accuracy

| Consideration | Status | Evidence |
| --- | --- | --- |
| Account for real topography affecting horizons | **Partial** | LOLA profiles for study sites; sphere_optimistic elsewhere with UI warning (`horizon-flag-*`). |
| Earth’s libration / orbital variations | **Partial** | Bundled Horizons includes real geometry; analytic fallback has **simplified** optical libration (`src/ephemeris/analytic.ts`). |
| Represent steep slopes / deep craters / extreme shadow | **Partial** | 3D terrain + jagged LOLA skyline for study sites; no PSR/shadow map product. |

### Potential considerations — engagement & impact

| Consideration | Status | Evidence |
| --- | --- | --- |
| Support science ↔ engineering coordination | **Partial** | Shared URL state + JSON export; no collaborative annotations or requirement checklists. |
| Respond quickly when schedule/location must change | **Partial** | Manual date/site edits + Launch slip guide. **No “suggest better date” or ranked alternatives.** |
| Educational tool for students / public | **Implemented** | Learn mode, tour, guided scenarios, plain-language taglines. |

### Challenge resources (usage, not features)

| Resource | Status | Evidence |
| --- | --- | --- |
| Quickmap | Linked | Footer links in `index.html` / README — not embedded. |
| Moon Trek | Linked | Same. |
| JPL Horizons | **Implemented** (bundled + client) | `public/science/ephemeris/*`, `src/ephemeris/horizons.ts`. |
| CSA Moon Exploration | Linked | README cite. |

---

## 2. What the product actually does today (user mental model)

### Mental model in one sentence

**You pick a site (and optional Site B), a mission start + length, and optional power/comms thresholds; the tool grades that whole window and lets you scrub inside it to see instantaneous Sun/Earth geometry — it does not search for the best site or date.**

### Inputs the user can change

| Input | Where | Effect class |
| --- | --- | --- |
| Site A / Site B (catalog or custom lat/lon) | Map cluster selects | **Full recompute** |
| Compare on/off | Checkbox | **Full recompute** (B slot) |
| Mission start (UTC) | Mission time | **Full recompute** |
| Mission duration (Earth hours) | Mission time | **Full recompute** |
| Time scrubber | Mission time | **Scrub-only paint** |
| Thresholds (min Earth el, panel area/eff, battery floor) | Assessment settings | **Full recompute** |
| Planner / Learn mode | Header | UI shell only (same engine) |
| Guided scenarios | Learn panel | Sets site(s) + dates → **full recompute** |
| Share link / export JSON | Provenance | I/O only |

### What recomputes when (code path)

```
UI change → setScenario / setScrubUtc / …
         → subscribeScenario(syncControlsFromState)
         → isScrubOnlyChange?
              YES → scheduleScrubPaint → paintScrubOnly → paintAssessment
              NO  → debounce → recompute → computeSlot × A/B → assessMission → paintAssessment
```

**Full recompute key** (`recompute` in `src/app.ts`): primary, secondary, `startUtc`, `durationHours`, thresholds, `compareEnabled`.  
**Explicitly excluded from the key:** `scrubUtc`.

`assessMission` (`src/assess/windows.ts`) samples the mission at ~1 h steps, builds sunlight / Earth LOS / simultaneous windows, aggregates %, blackouts, mean/peak power proxy, then assigns viability from **window totals** vs thresholds.

### Scrub vs full recompute (Randy’s core question)

| Display | Updates on scrub? | Updates on start/duration/site/thresholds? |
| --- | --- | --- |
| GO / RISKY / NO-GO + reason | **No** | **Yes** |
| Sunlight % / Earth LOS % / ∩ % | **No** (whole-window) | **Yes** |
| Mean / peak power proxy | **No** | **Yes** |
| Longest blackouts | **No** | **Yes** |
| Timeline bar geometry | **No** (marker only moves) | **Yes** |
| Time to sunset / Earthset | **Yes** | **Yes** |
| Sun/Earth elev (scrub) + clear elev | **Yes** | **Yes** |
| Skyline Sun/Earth markers | **Yes** | **Yes** |
| Timeline vertical scrub line | **Yes** | **Yes** |
| Horizon model / ephemeris source flag | **No** | **Yes** (on recompute) |

So: **scrub moves skyline + instantaneous numbers + countdowns; it does not change the viability badge or availability percentages.** That is by design in code, but **easy to misread** because the scrubber sits next to the “verdict” visually and the tour does not spell out “verdict = whole window.”

### Does viability actually change with date?

**Yes, when mission start or duration changes** — `recompute` runs and rebuilds samples. Within the **bundled Jan 1–Feb 1 2027** Horizons coverage for CR1/SR1, grades and windows should move (e.g. guided slip +14 days).

**Critical caveat:** For CR1/SR1, `createEphemerisProvider` preferred bundled series whenever present. If the mission **start** falls **outside** that bundled range, samples were previously **clamped** to the series endpoints, so out-of-range dates could look nearly static. A small guard now falls back to analytic when start is outside the bundled coverage (see §4 / commit notes). Ends that overrun Feb 1 while starting inside January may still clip and are labeled in the source string when detected.

### What “confidence” means (there is no Confidence %)

The UI does **not** expose a numeric “confidence” score. Planners may be reading one of these instead:

1. **Horizon model flag** (`horizon-flag-a/b`):  
   - `LOLA terrain` = measured 360° LOLA profile for that study site.  
   - `optimistic sphere` = geometric sphere only; **terrain unknown → typically optimistic** (understates obstruction). Viability may even force RISKY for sphere sites with weak sunlight (`assessMission` sphere branch).
2. **Ephemeris source** on the scrub label / flag: `bundled Horizons` (preferred for demo) vs `analytic fallback` (~1–3° illustrative) vs live (disabled in demo).
3. **Viability reason text** (margin / partial / insufficient / sphere caveat).

Treat sphere + analytic as **demo-grade**, LOLA + bundled Horizons as **study-grade for the demo domain**.

### How a mission planner would use this

1. Set **Site A** to a study point (CR1/SR1) when you need terrain-aware horizons.  
2. Set **mission start + duration** to the candidate landing/ops window (stay in Jan 2027 for highest-fidelity ephemeris).  
3. Read **GO/RISKY/NO-GO**, availability %, blackouts, mean power — that is the site-date verdict.  
4. **Scrub** to inspect *when* sun/Earth clear inside that window (ops timing), using skyline + timeline.  
5. Enable **compare**, set Site B, same UTC window — trade sites.  
6. Change **start date** (or use Launch slip guide) to see schedule sensitivity.  
7. Tune **thresholds** if your antenna floor / power system differs.  
8. **Copy link / export JSON** to share the scenario.

Custom / curated non-study sites: use for **relative** exploration only; always read the sphere warning.

### How an educator would use this

1. Start in **Learn**; run guided CR1 → SR1 → Compare → Slip.  
2. Replay the **tour** so students see map ↔ skyline ↔ timeline ↔ grade.  
3. Scrub to show Sun skimming a jagged horizon; flip dates to show schedule sensitivity.  
4. Optionally show technical elevations; stress that 3D lighting is illustrative.

---

## 3. Gap analysis vs Randy’s concern

### “UI works but decision-making loop is unclear”

**Confirmed.** The product evaluates a **pre-specified** scenario. The intended loop is:

> choose site(s) → choose window → read window grade → scrub to understand timing → change site or start → compare again

What is missing for a clear “choose landing time/location” workflow:

| Gap | Why it hurts |
| --- | --- | |
| No optimization / ranking (“best site for this date”, “best week for this site”) | User must guess dates manually |
| No neighborhood / alternate-location search | Custom coords feel like a dead end without LOLA |
| Scrub does not affect GO/RISKY | Feels like “risk is static” even when the window grade is live |
| Tour/copy under-explain window vs instant | Users assume scrub = new assessment |
| Catalog heavily pre-chosen; only 2 terrain-truth sites | Exploring alternatives is labeled optimistic and less trustworthy |
| No “suggest better date” / date-slip helper beyond one button | Schedule-change story from the challenge is only half-supported |
| No best-window highlighter on the timeline | User must visually hunt green ∩ bars |

### Is risk assessment static?

**Not statically hardcoded** — it recomputes from samples when site/start/duration/thresholds change.  
**It is static with respect to the scrubber**, which matches Randy’s observation that scrubbing mostly moves skyline/numbers.

Within Jan 2027 for CR1/SR1, changing start date **should** change viability. If it appeared frozen for dates far from January, that was the bundled-ephemeris clamp issue (§2).

### Pre-chosen spots vs exploring

- **Authoritative path:** CR1 / SR1.  
- **Exploratory path:** curated catalog + custom lat/lon with explicit sphere disclaimer.  
- Challenge ask for rich curated lists (Apollo, international, etc.) is only lightly covered.

### Missing guidance that would make the workflow obvious

- One-line always-visible: “Verdict grades the **mission window**; scrub explores **instants** inside it.”  
- Call-to-action after a NO-GO: “Try another start date or Site B.”  
- Teach that availability % is the decision metric; scrub elev is situational awareness.

---

## 4. Recommendations (prioritized)

### Quick wins (docs / UX clarity — low code)

1. **Always-visible decision caption** under the viability badge: window grade vs scrub instant.  
2. **Tour step** that explicitly says scrub does not change GO/RISKY.  
3. **Metric grouping labels:** “Mission window” vs “At scrub time.”  
4. **After NO-GO**, soft prompts: change start ±7/14 days; enable compare.  
5. **“How to use this for decisions”** in `IMPLEMENTATION_SUMMARY.md` / Learn tip (this audit + summary update).  
6. **Ephemeris coverage guard** (trivial engine fix): do not silently clamp CR1/SR1 to Jan when start is outside bundled range — fall back to analytic and label the source.

### Medium features (clear product value)

1. **Best-window highlighter** on timeline (longest simultaneous ∩ segment).  
2. **Date slip helper:** buttons −14 / −7 / +7 / +14 days that keep site/duration and refresh grade.  
3. **Rank sites for selected date:** score catalog (+ custom) for current window; table sorted by simultaneous % or viability.  
4. **Scrub-linked “instant status” chip** (SUNLIT / EARTH LOS / BOTH / BLACKOUT) so scrub has an obvious ops readout without implying the window grade moved.  
5. **Play animation** along the scrubber for education.

### Larger features (challenge stretch / planner-grade)

1. On-demand LOLA horizons for custom points (or denser catalog).  
2. Live Horizons toggle with caching for arbitrary dates.  
3. Neighborhood search / small lat-lon grid around Site A.  
4. Multi-scenario matrix (sites × candidate weeks).  
5. “Suggest better date” optimizer over a search range (maximize simultaneous hours / minimize blackout).  
6. 2D map overlay of illumination / Earth visibility.

---

## 5. Critical findings (loud)

1. **Scrub ≠ viability** — by design; poorly communicated.  
2. **No find-best-time/location loop** — evaluate-only tool.  
3. **Bundled Horizons Jan 2027 only** for CR1/SR1; out-of-range starts previously clamped (misleadingly static). **Trivial fix applied:** `createEphemerisProvider` now uses bundled only when mission start is inside the series span; otherwise analytic with an explicit source label. Ends past Feb 1 while starting in January may still clip (`bundled Horizons (end clipped)`).  
4. **Custom/curated sites are optimistic** — planners must not treat them as LOLA-grade.  
5. **Live Horizons disabled** in the demo path (`allowLive: false`).

No separate “confidence” metric exists; use horizon + ephemeris provenance flags.

---

## 6. Count summary

| Status | Count |
| --- | ---: |
| Implemented | 14 |
| Partial | 16 |
| Missing | 5 |
| **Total matrix rows** | **35** |

**Missing (explicit):** Apollo/international catalog depth as first-class sites; season/lunar-day explorer; play animation; optimization/ranking/neighborhood search; numeric confidence score (N/A — never specified by challenge, noted for Randy’s question).

---

## 7. Suggested demo script (makes the loop obvious)

1. Load defaults (CR1 vs SR1, mid-Jan 2027, compare on) → read dual viability.  
2. Scrub across the week → watch skyline; note badge **unchanged**.  
3. Click **Launch slip +14 days** → watch badge/metrics **change**.  
4. Switch Site B among curated entries → note sphere warning.  
5. Learn mode → same numbers, narrative framing.

That sequence is the product’s intended proof of the challenge story: **small date or site moves matter — and you discover them by changing the scenario, not by scrubbing alone.**
