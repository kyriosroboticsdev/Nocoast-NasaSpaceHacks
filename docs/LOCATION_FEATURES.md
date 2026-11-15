# Features at selected locations

Site-dependent tools use the active coordinates, not a CR1/SR1 whitelist.

- Map clicks and coordinate entry set Site A, show mission results and synchronize
  the terrain explorer, skyline and slope screen.
- Slopes request the chosen coordinates. Changing Site A resets a previously
  selected Site B slope view back to A. Other comparisons retain their own positions.
- `/api/terrain_slopes` defaults to `resolution=auto`. It retains the original
  5 m grid where the fine tiles cover the window. Otherwise it can compute a
  uniform 80 m or 240 m estimate from available LOLA data. Returned sample count,
  spacing, baseline, sources and model ID identify the actual resolution. The
  fixed 1.24 km square comparison window is preserved. `resolution=fine` retains
  the original fine-only behavior. Gaps and tile seams stay unknown.
- Panel orientation and landing-delay calculations evaluate the selected A/B
  locations, including custom coordinates. Duplicate positions are evaluated
  once, and canonical backend identities are retained for replay.
- The dashboard date/site search includes saved and unsaved custom points.
  Applying its result selects the corresponding location as well as its date.
- Regional search still pre-screens the overview grid, then recalculates the
  shortlisted coordinates through the live science path. Adopting a result
  prefers live terrain and ephemerides over the old analytic handoff.
- Mission exports use the current point's analysis, solar input/output, battery
  mission, relay, dates and equipment settings for all locations. CSV output
  continues to use the point's power artifact.

Real source coverage remains a requirement for numerical results. The available
polarmosaics are not global lunar fine terrain. Missing data remains unknown;
coarse slope estimates are visibly labeled and cannot resolve small hazards.

Verification: 133 JavaScript tests, 125 Python tests, Ruff and production build.
Browser checks: Peak Near Shackleton shows a 5 m slope grid; a custom point at
89.5°S, 270°E shows an 80 m DEM estimate with 88.57 m sample spacing. The slope
picker follows that point even when it previously displayed Site B. Actual
backend-to-simulator checks completed delay and panel optimization for that
custom point and Peak Near Shackleton.

Restart the Python science server as well as the frontend after updating.
On Windows, run `./run.ps1` from the checkout and open the URL printed by Vite.
