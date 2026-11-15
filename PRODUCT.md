# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: a mission planner** deciding whether a lunar south-pole landing site and date can work. They need the go/no-go answer first and the numbers behind it close at hand.

**Secondary audiences** (confirmed): NASA Space Apps 2026 judges and the curious public. They are served by the same tool through plain wording and an opt-in Advanced mode. They do not get a separate experience.

## Product Purpose

Lunar Navigator evaluates landing sites near the lunar south pole. It answers one core question in under a minute: **"Is this site viable on this date?"** The planner picks a site and a landing date and gets **GO / CAUTION / NO-GO / CAN'T TELL**, with the reasons:

- sunlight
- solar power versus need
- longest darkness versus battery
- Earth contact (direct-to-Earth comms windows)

Success means the planner reaches a defensible verdict quickly and can see exactly why.

## Positioning

The verdict comes from real terrain and ephemeris, not idealised geometry:

- **Terrain:** LOLA horizon profiles at 5 m to 240 m resolution.
- **Ephemeris:** JPL DE421, with exact Sun and Earth rise and set windows.
- **Power:** Person 3's validated power model.

Unknowns stay explicit. The tool never guesses.

## Operating Context

- Built for NASA Space Apps 2026 (lunar landing site evaluation challenge) by a three-person team:
  - Person 1: terrain explorer (`terrain.html`, `src/main.ts`).
  - Person 2: Sun, Earth and comms analysis plus the dashboard (`index.html`, `src/dashboard/`, `backend/`).
  - Person 3: solar power model (`src/power/model.mjs`).
- Run locally with `./run.ps1`:
  - The FastAPI science API runs on :8765.
  - The Vite front end runs on :5173 and proxies `/api`.
- Current sites are Connecting Ridge (CR1) and Shackleton Rim (SR1). Terrain coverage is south polar only (75°S and below).

## Capabilities and Constraints

**Working today:**

- Sun and Earth visibility windows: windows + gaps + unknown always equal the mission duration.
- Site comparison and landing-day and delay analysis.
- A 3D sky and terrain view.
- Solar power simulation with a configurable panel.
- Viability verdict against lander needs: power W, battery hours, comms blackout hours.

**Non-negotiable:**

- **Only official NASA/JPL data.** Every number must be traceable to its source. Show "unknown" or "can't tell" rather than fabricating or interpolating past the data.
- **Simple + Advanced modes.** Plain-language wording is the default. Expert detail (angles, raw windows, provenance, CSV) is one toggle away.

**Open decisions:**

- Famous landing sites and coordinate entry, which depend on whether global terrain data is added.
- Real lander thresholds and panel defaults (Person 3).
- Microsoft Azure integration.

## Evidence on Hand

- Real computed results from the backend for CR1 and SR1 (see `docs/PERSON2_COMMS.md`).
- The test suite in `tests/`.
- Earth textures in `public/sky/` are placeholders with unclear provenance. They must be replaced with NASA Blue Marble and Black Marble before release.
- There are no user testimonials, mission endorsements or external validations. Never invent any.

## Product Principles

1. **Verdict first, evidence one step away.** The answer leads, and the reasons sit directly under it.
2. **A tool, not a brochure.** Inputs and results stay on one working surface. Explanation supports the task and never replaces it.
3. **Honest about uncertainty.** Unknown is a first-class state, distinct from good or bad.
4. **Plain by default, expert on demand.** The same data serves both the public and engineers, at two levels of detail.
5. **Every number has a source.** Traceability to NASA data is part of the product.
