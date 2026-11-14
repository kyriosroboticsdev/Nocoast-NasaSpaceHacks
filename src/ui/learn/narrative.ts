/** Plain-language Learn-mode copy shared with the shell. */

export const LEARN_INTRO = {
  title: 'Why the south pole is hard',
  paragraphs: [
    'Near 90°S, the Sun stays low and skims a jagged horizon. Ridges a few kilometers away can block sunlight for days, and Earth may sit just above or below the local terrain — so power and communications rise and fall together with landing site and date.',
    'This Learn view uses the same scenario engine as Planner. Rank sites and Suggest better dates show why one site/date wins and another fails; adopt with one click. Enable “Show technical details” for raw thresholds.',
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
  {
    id: 'apollo',
    label: 'Apollo 11 vs CR1',
    blurb: 'Equatorial heritage vs polar study — Earth-day contrast.',
  },
  {
    id: 'rank',
    label: 'Rank this window',
    blurb: 'Score the curated catalog for the current UTC mission window.',
  },
] as const;

export const PROVENANCE_BULLETS = [
  'Horizons: bundled JPL observer az/el for CR1/SR1 (precomputed range); uncovered hours unknown; analytic fallback is calibrated near the pole and always badged.',
  'Terrain horizons: LOLA 5 m near-field + 320 m overview for CR1/SR1; gaps are never invented.',
  'Custom / curated / Apollo / CLPS sites use an optimistic sphere horizon — labeled in the UI.',
  'Rank and date helpers use the same assessMission engine as the viability badges.',
  '3D display lighting is illustrative and is not the authoritative Sun/Earth status.',
  'Quest VR runtime is not shipped — export JSON for external / headset viewers.',
];
