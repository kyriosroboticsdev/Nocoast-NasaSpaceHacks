const STORAGE_KEY = 'llsn-tour-v1';

export type TourStep = {
  id: string;
  title: string;
  body: string;
  /** data-tour attribute value on the highlighted region */
  target: string;
};

/** Default 4-step tour, framed as the questions a first-time visitor actually has. */
const QUICK_STEPS: TourStep[] = [
  {
    id: 'q-where',
    title: 'Where are you landing?',
    body: 'Pick a landing site — Site A drives the 3D map and the verdicts below. Drag the map to orbit the Moon’s south pole, scroll to zoom.',
    target: 'site',
  },
  {
    id: 'q-when',
    title: 'When are you going?',
    body: 'Set the mission start and length, then drag the time slider to live through the mission hour by hour. At the lunar pole, the date changes everything.',
    target: 'time',
  },
  {
    id: 'q-power',
    title: 'Will you have power?',
    body: 'The big cards show sunlight and solar power for your chosen week, and GO / RISKY / NO-GO sums it all up. Tap ? on any number for what it means.',
    target: 'viability',
  },
  {
    id: 'q-phone',
    title: 'Can you phone home?',
    body: 'A lander also needs to see Earth to talk to it. If your verdict looks bad, use Rank known sites or Suggest better dates — the tool finds alternatives for you. Want every control explained? Press Full tour up top.',
    target: 'decision',
  },
];

const FULL_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    body: 'This tool compares lunar south-pole landing sites for solar power and Earth communications. We’ll walk through the main controls — tap Next to continue.',
    target: 'mode',
  },
  {
    id: 'mode',
    title: 'Planner vs Learn',
    body: 'Planner is the dense assessment workspace. Learn adds a short narrative and guided scenarios using the same science engine. Press Next when you’re ready.',
    target: 'mode',
  },
  {
    id: 'site',
    title: 'Pick a landing site',
    body: 'Site A drives the 3D map, skyline, and primary metrics. Study points (CR1 / SR1) use LOLA terrain horizons; other sites fall back to an optimistic sphere.',
    target: 'site',
  },
  {
    id: 'map',
    title: 'Explore the terrain',
    body: 'Orbit, pan, and zoom the polar cap. Use Zoom to site A / Full polar cap / Whole Moon beside the map. The 3D lighting is illustrative — viability comes from the assessment below.',
    target: 'map',
  },
  {
    id: 'compare',
    title: 'Compare Site B',
    body: 'Enable side-by-side compare to grade a second site over the same UTC window. Timeline bars stack A and B when compare is on.',
    target: 'compare',
  },
  {
    id: 'decision',
    title: 'Find · compare · decide',
    body: 'Use Rank known sites to score the catalog for this UTC window, Suggest better dates to slip the start, and Jump to best stretch to inspect the longest sun-and-Earth stretch. Adopt/Apply jumps the scenario in one click.',
    target: 'decision',
  },
  {
    id: 'time',
    title: 'Mission time',
    body: 'Set mission start and length first — those define the window being graded. Play animates the time slider for education. The slider does not change GO / RISKY / NO-GO; changing start, duration, or site does.',
    target: 'time',
  },
  {
    id: 'skyline',
    title: '360° skyline',
    body: 'The jagged profile is local terrain elevation vs azimuth. Sun and Earth markers update with the scrubber — clear means above the horizon for that sample.',
    target: 'skyline',
  },
  {
    id: 'timeline',
    title: 'Mission timeline',
    body: 'Bars show sunlight, Earth contact, and both-at-once. A dashed highlight marks the best simultaneous (or best single) window — use Jump to best stretch to land on it.',
    target: 'timeline',
  },
  {
    id: 'viability',
    title: 'Window grade vs slider',
    body: 'Mission window grade (GO / RISKY / NO-GO) scores the whole start→end span. Cards show sunlight, Earth contact, sun + Earth together (power while talking to Earth), average watts vs battery floor, and gaps — tap ? for how each is calculated. The “At slider time” chip is a separate instant status.',
    target: 'viability',
  },
  {
    id: 'thresholds',
    title: 'Assessment settings',
    body: 'Planner thresholds (min Earth elevation, panel area/efficiency/tilt, battery floor) sit beside the metrics they affect. In Learn mode, use “Show technical details” instead.',
    target: 'thresholds',
  },
];

export type TourVariant = 'quick' | 'full';

type TourController = {
  start: (force?: boolean, variant?: TourVariant) => void;
  destroy: () => void;
};

function isComplete(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'done';
  } catch {
    return false;
  }
}

function markComplete() {
  try {
    localStorage.setItem(STORAGE_KEY, 'done');
  } catch {
    /* ignore quota / private mode */
  }
}

function clearComplete() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function padRect(rect: DOMRect, pad = 8) {
  return {
    top: Math.max(8, rect.top - pad),
    left: Math.max(8, rect.left - pad),
    width: Math.min(window.innerWidth - 16, rect.width + pad * 2),
    height: Math.min(window.innerHeight - 16, rect.height + pad * 2),
  };
}

function placeCard(card: HTMLElement, hole: ReturnType<typeof padRect>) {
  const cardW = Math.min(360, window.innerWidth - 32);
  const spaceBelow = window.innerHeight - (hole.top + hole.height);
  const preferBelow = spaceBelow > 180 || hole.top < 160;
  let top = preferBelow ? hole.top + hole.height + 14 : hole.top - 14;
  let left = Math.min(Math.max(16, hole.left), window.innerWidth - cardW - 16);

  card.style.width = `${cardW}px`;
  card.style.left = `${left}px`;
  card.style.top = preferBelow ? `${top}px` : 'auto';
  card.style.bottom = preferBelow ? 'auto' : `${window.innerHeight - hole.top + 14}px`;

  // Keep card on-screen after layout
  requestAnimationFrame(() => {
    const cr = card.getBoundingClientRect();
    if (cr.bottom > window.innerHeight - 12) {
      card.style.top = 'auto';
      card.style.bottom = '16px';
    }
    if (cr.top < 12) {
      card.style.top = '16px';
      card.style.bottom = 'auto';
    }
    // The spotlighted target renders above the card (it must beat the dim overlay), so any
    // overlap hides the card's buttons. When a tall target overlaps, dock the card beside it.
    const cr2 = card.getBoundingClientRect();
    const overlaps = !(
      cr2.right < hole.left
      || cr2.left > hole.left + hole.width
      || cr2.bottom < hole.top
      || cr2.top > hole.top + hole.height
    );
    if (overlaps) {
      const rightSpace = window.innerWidth - (hole.left + hole.width);
      if (rightSpace > cardW + 28) {
        card.style.left = `${hole.left + hole.width + 14}px`;
      } else if (hole.left > cardW + 28) {
        card.style.left = `${hole.left - cardW - 14}px`;
      }
      card.style.top = `${Math.max(16, Math.min(hole.top, window.innerHeight - cr2.height - 16))}px`;
      card.style.bottom = 'auto';
    }
  });
}

export function createTour(root: HTMLElement): TourController {
  let index = 0;
  let steps: TourStep[] = QUICK_STEPS;
  let active = false;
  let targetEl: HTMLElement | null = null;
  let resizeObs: ResizeObserver | null = null;

  const spotlight = document.createElement('div');
  spotlight.className = 'tour-spotlight';
  spotlight.setAttribute('aria-hidden', 'true');

  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'tour-title');

  root.append(spotlight, card);

  function clearTarget() {
    if (targetEl) targetEl.classList.remove('tour-target-active');
    targetEl = null;
  }

  function finish() {
    active = false;
    document.body.classList.remove('tour-active');
    clearTarget();
    root.hidden = true;
    markComplete();
    resizeObs?.disconnect();
    resizeObs = null;
  }

  function skip() {
    finish();
  }

  function layout() {
    if (!active || !targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    const hole = padRect(rect);
    spotlight.style.top = `${hole.top}px`;
    spotlight.style.left = `${hole.left}px`;
    spotlight.style.width = `${hole.width}px`;
    spotlight.style.height = `${hole.height}px`;
    placeCard(card, hole);
  }

  function go(to: number) {
    if (to >= steps.length) {
      finish();
      return;
    }
    if (to < 0) to = 0;
    index = to;
    const step = steps[index];
    clearTarget();

    const found = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!found) {
      go(index + 1);
      return;
    }
    // Reveal learn panel target if needed
    if (step.target === 'learn') {
      const panel = document.getElementById('learn-panel');
      if (panel?.hidden) {
        document.getElementById('mode-learn')?.click();
      }
    }

    targetEl = found;
    targetEl.classList.add('tour-target-active');
    targetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    card.innerHTML = `
      <div class="tour-step">STEP ${index + 1} / ${steps.length}</div>
      <h2 id="tour-title">${step.title}</h2>
      <p>${step.body}</p>
      <div class="tour-actions">
        ${index > 0 ? '<button type="button" data-tour-act="back">Back</button>' : ''}
        <button type="button" data-tour-act="next">Next</button>
        <button type="button" class="tour-skip" data-tour-act="skip">Skip</button>
      </div>
    `;

    layout();
  }

  card.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tour-act]');
    if (!btn) return;
    const act = btn.dataset.tourAct;
    if (act === 'next') go(index + 1);
    else if (act === 'back') go(index - 1);
    else if (act === 'skip') skip();
  });

  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onResize, true);

  function start(force = false, variant: TourVariant = 'quick') {
    if (active) return;
    if (!force && isComplete()) return;
    if (force) clearComplete();
    steps = variant === 'full' ? FULL_STEPS : QUICK_STEPS;
    active = true;
    document.body.classList.add('tour-active');
    root.hidden = false;
    index = 0;
    resizeObs = new ResizeObserver(() => layout());
    resizeObs.observe(document.documentElement);
    go(0);
  }

  function destroy() {
    finish();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize, true);
    root.replaceChildren();
  }

  return { start, destroy };
}

export { STORAGE_KEY as TOUR_STORAGE_KEY };
