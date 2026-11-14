# Next-level plan — making the Lunar Landing Site Navigator understandable for everyone

**Date:** 2026-11-14
**Context:** Challenge brief re-checked against the live app (Planner + Learn, CR1 vs SR1 default, dev build). Feature coverage is already strong (27/35 implemented per `REQUIREMENTS_AUDIT.md`). The gap is no longer *what the tool can do* — it is *who can understand it*. The challenge explicitly asks for a tool that serves "mission planners, educators, **and the public**" and judges "Accessibility across skill levels." Today the app reads like an engineering console at every level, including Learn mode.

## Honest assessment of today's UX

What a first-time visitor sees:

1. An 11-step tour over a wall of dense text.
2. A 3D map that defaults to a **green wireframe grid** — it does not look like the Moon.
3. Jargon everywhere, even in Learn mode: "Sun ∩ Earth", "Earth LOS availability", "mean power proxy", "sphere-optimistic horizon", "analytic fallback badged", "scrub", "DTE-up hours". The ∩ symbol alone excludes most non-technical readers.
4. Caveats and provenance notes mixed into the main flow (great for judges' rigor, fatal for first impressions).
5. Strong bones underneath: GO / RISKY / NO-GO verdicts, A/B compare, rank/suggest/adopt loop, skyline + timeline, guided scenarios. These are the right anchors — they just need a translation layer.

**Principle for everything below: don't dumb it down, layer it.** Keep the engine and the expert view; add a simple layer on top and make it the default.

---

## Phase 1 — First impression (highest impact, ~1 day)

1. **Plain-English verdict sentence, front and center.**
   The engine already computes everything needed. Above the metric grid, render one generated sentence per site, e.g.:
   > "Landing at **Connecting Ridge on Jan 15, 2027**: the Sun shines all week ☀️, but you lose contact with Earth for up to **2.1 days** 📡 — risky without a big battery or a relay satellite."
   (Extend `explainVerdict` in `src/assess/decision.ts`; it's most of the way there.)

2. **Make the Moon look like the Moon.** Default terrain layer → `relief` (Lunar surface) instead of `mesh` wireframe. Keep wireframe as an option. A visitor's first 3 seconds should say "that's the lunar south pole," not "that's a CAD program."

3. **Kill the ∩ symbol in the simple layer.** Rename everywhere user-facing:
   - "Sun ∩ Earth" → "Sun + Earth together" (tooltip: "hours you can charge batteries *while* talking to Earth")
   - "Earth LOS" → "Can see Earth"
   - "Scrub" → "Time slider"
   - "Mean power proxy" → "Average solar power"
   - "Blackout" → "No contact with Earth"

4. **Shorten the tour to 4 steps** framed as questions a person would actually ask: *Where am I landing? → When? → Will I have power? → Can I phone home?* Keep the long tour behind "Full tour."

## Phase 2 — Progressive disclosure (~1–2 days)

5. **Invert "Show technical details."** Simple view by default: verdict sentence, 4 big metric cards (Sunlight, Earth contact, Power, Longest blackout) each with an icon, a big number, and a one-line meaning ("Enough sun to charge batteries 7 of 7 days"). Expert toggle reveals today's full grid, thresholds, and provenance. Judges get both; the public never sees "panel tilt °" unless they ask.

6. **Everyday analogies in Learn mode.**
   - "A lunar day lasts ~29.5 Earth days — one sunrise per month."
   - "At the south pole the Sun never gets higher than a winter sunset does on Earth."
   - "Losing Earth line-of-sight is like a 2-day dead zone with no cell signal — and no one can come help."

7. **Why-it-matters micro-copy on NO-GO.** When a scenario fails, say the human consequence: "Your lander's batteries would die on day 3, before sunrise reaches the panels."

## Phase 3 — Visual storytelling (~2–3 days)

8. **Redesign the timeline as a 'mission week calendar.'** Replace Gantt-style labeled bars with day columns, ☀️ / 📡 icons, green/amber/red day shading, and hoverable tooltips. The current canvas is accurate but unreadable without training.

9. **Animated "day at the pole" hero moment.** Wire the existing Play animation to the 3D view: Sun marker crawls along the horizon, terrain shading follows (display-grade, keep the existing disclaimer). One Play press should produce the "whoa, the Sun just circles the horizon" moment — this is the challenge's "make lunar vs terrestrial extremes apparent" line, and it's currently buried in a 140-px canvas.

10. **2D illumination overlay on the map** (closes an audit "Partial"): color the polar cap by sunlight % for the chosen window, so *why location matters* is visible at a glance instead of only in ranked lists.

## Phase 4 — Engagement & reach (~2–3 days, parallelizable)

11. **"Mission Designer" game mode.** Reuse the engine: give the player a budget (battery size, launch window), let them pick a site + date, score the mission 0–100 with a shareable result card. Educators and the public get a reason to stay; judges see the "educational game" format the brief explicitly invites.

12. **Share cards.** "Copy shareable link" already exists — add "Download result card": a PNG with the verdict sentence, site, date, and mini-timeline for posting/presenting.

13. **Deploy to a public URL** (static Vite build — Vercel/GitHub Pages) so judges and the public can try it without Node. Add a 60-second README GIF.

14. **Accessibility & mobile pass:** color-blind-safe palette for GO/RISKY/NO-GO (add icons ✓/!/✗, never color alone), larger default font, responsive single-column layout on phones, aria labels for canvas visuals (text summary alternative — the verdict sentence already is one).

## Phase 5 — Stretch (if time remains)

- Multi-site matrix (>2 columns) for planner power users.
- PSR (permanently shadowed region) shading on the polar map.
- Narrated/subtitled 60-second intro story in Learn mode.
- Localization scaffold (strings are already mostly centralized).

---

## Suggested owner split

| Workstream | Files | Who |
| --- | --- | --- |
| Verdict sentences, metric renames, simple/expert toggle | `src/ui/*`, `src/assess/decision.ts`, `index.html` | Person 1 |
| Terrain default, illumination overlay, animated sun | `src/main.ts`, `src/viz/*` | Person 2 |
| Timeline calendar redesign, share cards | `src/viz/timeline`, new `src/viz/card.ts` | Person 3 |
| Game mode, deploy, README/GIF | `src/scenario/*`, CI | Person 4 |

## What NOT to change

- The assessment engine, honesty labels, and provenance notes — they're a differentiator with judges. Move them behind the expert toggle; do not delete them.
- The decision loop (Find best location / Rank / Suggest dates / Adopt) — it directly answers the brief's "respond quickly when schedules change" consideration.
