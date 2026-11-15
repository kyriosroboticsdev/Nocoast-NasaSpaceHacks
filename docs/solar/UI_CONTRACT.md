# Solar controls UI contract

Use the existing dark, dense planning dashboard and its controls/metric grids.
Job: set area, efficiency, tilt from horizontal and true-north facing bearing;
read instantaneous watts, mission watt-hours, coverage and provenance.
Desktop 1440 x 1000; narrow 390 x 844. Inputs must have visible labels and
keyboard focus; metric text must wrap without horizontal overflow.

Loading: existing status reports assessment update. Success: metrics and exports
use the same calculation. Empty/error: unknown power with a specific reason;
return to CR1/SR1 January 2027 or correct the invalid panel input. Partial: total
and mean remain unknown, known-energy subtotal and coverage remain visible.
Preliminary terrain: visible qualification until upstream validation is supplied.
Permission state does not apply: all calculations are local, no login/write API.
Reference: index.html threshold controls and src/style.css metric grid.
