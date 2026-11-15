# Preview update checked for this contribution

Fetched all remote branches on 2026-11-14. `preview` advanced from `364f82f` to
`6871774` with three commits:

| Commit | Teammate changes already present in the base |
| --- | --- |
| `9cc2400` | True-north terrain horizons and gap handling; corrected window accounting; bounded ephemeris interpolation; analytic and ranking-authority fixes; URL-state preservation. |
| `652a36e` | Mesh detail/coverage adjustments and search-result power badges. |
| `6871774` | Accessible metric tooltips and expanded Planner guidance. Solar help text was updated to describe the actual new model. |

The feature branch was fast-forwarded to `6871774` while retaining our
uncommitted solar work. Those three commits are teammates' existing history,
not part of our new solar commit. `main`, `setup/pr-workflow` and
`vracton/terrain` had no new commits relative to the earlier review.

Solar integration was adapted to the new nullable provider API and keeps the
new window, adoption/marker, authority-badge and Site B URL-state code.
Sun ephemerides retain the new coverage through March 1, with real AU distance
and 600-second cadence added. Earth files and terrain products are unchanged
by our contribution.

CR1's current horizon has no gap bins; SR1 has 11 gap bins out of 1440.
Gaps remain unknown. The upstream fixes have landed; the optional explicit
terrain-validation declaration used for solar comparison eligibility is still
absent. Our code does not label these estimates independently validated.

The new regression cases cover missing Sun/Earth independently and retaining
the upstream Site B coordinates/scrub state alongside panel orientation.

The final integration also keeps the new help controls and corrects their solar
formula, energy/coverage descriptions and fixed panel orientation semantics.
Phone tooltips are bounded to the viewport when focused.
