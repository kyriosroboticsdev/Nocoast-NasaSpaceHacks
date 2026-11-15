# Terrain slope screen

Coordinate extension: the UI requests `resolution=auto` for the selected point.
Fine responses retain the original model ID. Coarse responses use
`lola-dem-central-normal-radial-up-v1`, with `demPixelSpacingM` 80 or 240 and a
smaller odd `n` (at least 3). Grid spacing must be at least the DEM pixel spacing;
the difference baseline remains twice the grid spacing. Both modes preserve the
requested window, coordinate identity, nulls, coverage and explicit source labels.
Changing Site A resets the slope picker to that active point. The fine-mode
contract below describes the original 5 m case only.


Purpose: inspect steepness around the selected landing site alongside power and
communication conditions. Add a collapsible section below the current Planner's
3D viewer; retain its dark palette, Site A/B controls and mission results. A separate flat,
north-up map keeps colors independent of simulated lighting and visual exaggeration.

Primary action: open **Terrain slopes and area comparison**, choose Site A or B,
inspect terrain and change the screening limit.
The center mark is the existing site, not a new location-selection workflow.
Map orientation is local north up, east right. Default extent is 1.24 km square,
5 m grid spacing and a 10 m central-difference baseline. Only existing 5 m PGDA
coverage is used. Unknown/edge samples remain gray. The example 10-degree threshold
is a project control, not a NASA or vehicle safety limit. No mission grade changes.

Hierarchy: site/extent -> estimated area within limit and site comparison -> map -> numeric inspection and coverage -> color legend
and threshold -> limitations. Never label a green pixel a safe landing spot.
Touch/click and arrow keys provide numeric alternatives to color. Visible focus,
associated labels, status messages and a reset-to-center control support inspection.
Targets: 1440x900 and 390x844. On narrow screens allow the slope view to grow
vertically; keep controls, legend and limitations readable without page overflow.

States: loading replaces stale results with a status; empty means no 5 m coverage
and suggests the polar study sites; locations outside the supported south-polar
region show Unknown without sending an invalid API request. Partial shows known cells and gray gaps with coverage; error
offers retry; success shows the map; permission is not applicable (local read-only
API, no account or write action). Abort requests on site/view changes and never
display a late result under another site's name. Invalid thresholds retain the
last valid map and show an explicit message. Cache only successful responses.

Area comparisons always use the same 1.24 km square window and slope limit.
Report unknown area separately; all-unknown terrain has an unknown qualifying
area, while known steep terrain can legitimately have zero qualifying area.
Provide both the local comparison table and the metric below the Planner's Site A/B cards.
Count clipped node footprints, not n² full cells. State that total qualifying
patches need not form one continuous landing zone and do not certify safety.
