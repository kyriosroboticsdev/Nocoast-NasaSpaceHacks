const STORAGE_KEY = 'llsn-tour-v1';

export type TourStep = {
  id: string;
  title: string;
  body: string;
  /** data-tour attribute value on the highlighted region */
  target: string;
  /** Advance automatically when the user interacts with the target */
  advanceOn?: 'change' | 'input' | 'click';
  /** Prefer Next when interaction isn't natural */
  preferNext?: boolean;
};

const STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    body: 'This tool compares lunar south-pole landing sites for solar power and Earth communications. We’ll walk through the main controls — interact with the highlighted area, or tap Next.',
    target: 'mode',
    preferNext: true,
  },
  {
    id: 'mode',
    title: 'Planner vs Learn',
    body: 'Planner is the dense assessment workspace. Learn adds a short narrative and guided scenarios using the same science engine. Try switching modes, or press Next.',
    target: 'mode',
    advanceOn: 'click',
  },
  {
    id: 'site',
    title: 'Pick a landing site',
    body: 'Site A drives the 3D map, skyline, and primary metrics. Study points (CR1 / SR1) use LOLA terrain horizons; other sites fall back to an optimistic sphere.',
    target: 'site',
    advanceOn: 'change',
  },
  {
    id: 'map',
    title: 'Explore the terrain',
    body: 'Orbit, pan, and zoom the polar cap. Use Zoom to site A / Full polar cap / Whole Moon beside the map. The 3D lighting is illustrative — viability comes from the assessment below.',
    target: 'map',
    preferNext: true,
  },
  {
    id: 'compare',
    title: 'Compare Site B',
    body: 'Enable side-by-side compare to grade a second site over the same UTC window. Timeline bars stack A and B when compare is on.',
    target: 'compare',
    advanceOn: 'change',
  },
  {
    id: 'time',
    title: 'Mission time',
    body: 'Set the mission start and length, then scrub through the window. The scrubber sits next to the skyline so you can watch Sun and Earth move as time changes.',
    target: 'time',
    advanceOn: 'input',
  },
  {
    id: 'skyline',
    title: '360° skyline',
    body: 'The jagged profile is local terrain elevation vs azimuth. Sun and Earth markers update with the scrubber — clear means above the horizon for that sample.',
    target: 'skyline',
    preferNext: true,
  },
  {
    id: 'timeline',
    title: 'Mission timeline',
    body: 'Bars show sunlight, Earth line-of-sight, and simultaneous windows across the mission. The vertical marker tracks the scrubber.',
    target: 'timeline',
    preferNext: true,
  },
  {
    id: 'viability',
    title: 'Viability grade',
    body: 'GO / RISKY / NO-GO summarizes sunlight, Earth LOS, blackouts, and power proxy for the current scenario. Site B metrics appear when compare is enabled.',
    target: 'viability',
    preferNext: true,
  },
  {
    id: 'thresholds',
    title: 'Assessment settings',
    body: 'Planner thresholds (Earth elevation floor, panel size/efficiency, battery floor) sit beside the metrics they affect. In Learn mode, use “Show technical details” instead.',
    target: 'thresholds',
    preferNext: true,
  },
];

type TourController = {
  start: (force?: boolean) => void;
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
  });
}

export function createTour(root: HTMLElement): TourController {
  let index = 0;
  let active = false;
  let targetEl: HTMLElement | null = null;
  let advanceHandler: ((e: Event) => void) | null = null;
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

  function detachAdvance() {
    if (targetEl && advanceHandler) {
      targetEl.removeEventListener('change', advanceHandler, true);
      targetEl.removeEventListener('input', advanceHandler, true);
      targetEl.removeEventListener('click', advanceHandler, true);
    }
    advanceHandler = null;
  }

  function clearTarget() {
    detachAdvance();
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
    if (to >= STEPS.length) {
      finish();
      return;
    }
    if (to < 0) to = 0;
    index = to;
    const step = STEPS[index];
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

    const showNext = step.preferNext || !step.advanceOn;
    card.innerHTML = `
      <div class="tour-step">STEP ${index + 1} / ${STEPS.length}</div>
      <h2 id="tour-title">${step.title}</h2>
      <p>${step.body}</p>
      <div class="tour-actions">
        ${index > 0 ? '<button type="button" data-tour-act="back">Back</button>' : ''}
        ${showNext ? '<button type="button" data-tour-act="next">Next</button>' : '<button type="button" data-tour-act="next">Next</button>'}
        <button type="button" class="tour-skip" data-tour-act="skip">Skip</button>
      </div>
    `;

    if (step.advanceOn) {
      advanceHandler = (e: Event) => {
        // Ignore clicks on tour chrome
        if ((e.target as HTMLElement).closest?.('.tour-card')) return;
        if (!targetEl?.contains(e.target as Node)) return;
        window.setTimeout(() => go(index + 1), 80);
      };
      targetEl.addEventListener(step.advanceOn, advanceHandler, true);
    }

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

  function start(force = false) {
    if (active) return;
    if (!force && isComplete()) return;
    if (force) clearComplete();
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
