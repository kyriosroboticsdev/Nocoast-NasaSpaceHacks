# Mission controls UI contract

Extend the existing dense, dark planning tool. The job is to set a fixed panel,
constant load, storage limits and communication requirements, inspect shortages
and battery energy, then compare orientations/sites and finite landing delays.
Use existing controls, metric grids, focus styles and plain tables; no new UI
framework. Target viewports: 1440x1000 and 390x844.

Primary actions: edit battery/requirements, optimize tested panel/site choices,
test delays, cancel, and explicitly apply a result. Controls have visible units
and labels. Event offsets are physical seconds from landing; playback does not
change consumption. Battery chart shows Wh, reserve and blank unknown regions.

Loading: live job progress and cancel; no partial best result. Empty: explain
missing study-site data and recommend covered dates. Error: explain rejected
settings/search budget and preserve last valid scenario. Partial: null totals,
unknown cases and incomplete comparisons remain explicit. Success: show tested
grid/offset scope and apply controls, with data/validation qualification.
Permission: not applicable; local calculations and user-initiated downloads.

Inspect focus, keyboard help, narrow tables, long reasons and tooltip bounds.
Reference: existing assessment cards, settings column and metric-help controls.
