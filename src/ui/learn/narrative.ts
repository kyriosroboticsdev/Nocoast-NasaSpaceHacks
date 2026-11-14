/** Plain-language Learn-mode copy shared with the shell. */

export const LEARN_INTRO = {
  title: 'Why the south pole is hard',
  paragraphs: [
    'Near 90°S, the Sun stays low and skims a jagged horizon. Ridges a few kilometers away can block sunlight for days, and Earth may sit just above or below the local terrain — so power and communications rise and fall together with landing site and date.',
    'This Learn view uses the same scenario engine as Planner. Guided picks jump to curated comparisons; enable “Show technical details” when you want the raw thresholds behind GO / RISKY / NO-GO.',
  ],
};

export const GUIDED = [
  {
    id: 'cr1-jan',
    label: 'CR1 · mid-January 2027',
    blurb: 'Connecting Ridge study point with LOLA terrain horizons.',
  },
  {
    id: 'sr1-jan',
    label: 'SR1 · same week',
    blurb: 'Shackleton Rim — compare how a short ridge move changes windows.',
  },
  {
    id: 'compare',
    label: 'Compare CR1 vs SR1',
    blurb: 'Side-by-side power and Earth LOS for the default mission week.',
  },
  {
    id: 'slip',
    label: 'Launch slip +14 days',
    blurb: 'Same sites, slipped start — see which stays more viable.',
  },
] as const;

export const PROVENANCE_BULLETS = [
  'Horizons: bundled JPL observer az/el for CR1/SR1 (Jan 2027); analytic fallback otherwise.',
  'Terrain horizons: LOLA 5 m near-field + 320 m overview; gaps are never invented.',
  'Custom / curated non-study sites use an optimistic sphere horizon — labeled in the UI.',
  '3D display lighting is illustrative and is not the authoritative Sun/Earth status.',
];
