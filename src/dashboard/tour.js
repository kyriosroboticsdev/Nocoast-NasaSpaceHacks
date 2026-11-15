// Welcome tutorial. Opens every time the app loads (per product ask) as a dismissible overlay, and can
// be reopened any time from the header "?" button. Four plain-language steps framed as the questions a
// visitor actually asks — what is this, where/when, will it have power, and the "day at the pole" moment.
// Self-contained: it builds its own DOM and only calls back into the app for the "Watch a day" hero.

const STEPS = [
  {
    title: "Will a Moon landing work here?",
    body: "NoCoast checks a south-pole landing site for one thing that decides missions: can the lander keep its power and stay in touch with Earth for the whole stay? You get a plain <b>GO / CAUTION / NO-GO</b> verdict, backed by real NASA terrain and Sun/Earth positions.",
    icon: "check",
  },
  {
    title: "1 · Where and when",
    body: "On the left, pick a <b>site</b> and a <b>landing date</b>, and how long the lander stays. Everything recalculates for that exact window. Switch to <b>Find a landing day</b> up top to see which dates work as a calendar.",
    icon: "pin",
  },
  {
    title: "2 · Will it have power?",
    body: "The drawer below gives the verdict and why. A real battery simulation charges from the panel in sunlight and drains in the dark — if it would hit its reserve before sunrise, that's a <b>NO-GO</b>. You also see the longest stretch with <b>no contact with Earth</b>.",
    icon: "warn",
  },
  {
    title: "3 · See a day at the pole",
    body: "At the south pole the Sun never really rises — it <b>circles the horizon</b>, skimming it for ~29 Earth days. Press <b>Watch a day</b> to see the Sun crawl around the 3D sky and the shadows stretch for kilometres. That extreme is the whole challenge.",
    icon: "sun",
    cta: "Watch a day at the pole",
  },
];

const svg = (name) => `<svg aria-hidden="true" class="tour-ic"><use href="#i-${name}"/></svg>`;

export function initTour({ onWatchDay } = {}) {
  const root = document.createElement("div");
  root.className = "tour";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "tour-title");
  root.innerHTML = `
    <div class="tour-scrim" data-close></div>
    <div class="tour-card" role="document">
      <button class="tour-x" data-close aria-label="Close the tips">${svg("cross")}</button>
      <div class="tour-badge" id="tour-badge"></div>
      <h2 id="tour-title"></h2>
      <p id="tour-body"></p>
      <div class="tour-foot">
        <div class="tour-dots" id="tour-dots" role="tablist" aria-label="Tour steps"></div>
        <div class="tour-nav">
          <button class="btn ghost" id="tour-back">Back</button>
          <button class="btn primary" id="tour-next">Next</button>
        </div>
      </div>
      <button class="link tour-skip" data-close>Skip — I'll explore</button>
    </div>`;
  document.body.append(root);

  const q = (id) => root.querySelector(id);
  let i = 0;

  function render() {
    const s = STEPS[i], last = i === STEPS.length - 1;
    q("#tour-badge").innerHTML = svg(s.icon);
    q("#tour-title").innerHTML = s.title;
    q("#tour-body").innerHTML = s.body;
    q("#tour-back").hidden = i === 0;
    const next = q("#tour-next");
    next.textContent = last ? "Got it" : "Next";
    next.classList.toggle("has-cta", !!s.cta);
    q("#tour-dots").innerHTML = STEPS.map((_, k) =>
      `<span class="tour-dot${k === i ? " on" : ""}" role="tab" aria-selected="${k === i}" aria-label="Step ${k + 1}"></span>`).join("");
    // The hero CTA only appears on the last step; it closes the tour and runs the animation.
    let cta = q("#tour-cta");
    if (s.cta) {
      if (!cta) { cta = document.createElement("button"); cta.id = "tour-cta"; cta.className = "btn primary tour-cta"; q(".tour-card").insertBefore(cta, q(".tour-foot")); }
      cta.innerHTML = `${svg("play")}${s.cta}`;
      cta.hidden = false;
    } else if (cta) cta.hidden = true;
  }

  function open(step = 0) {
    i = Math.max(0, Math.min(STEPS.length - 1, step));
    root.hidden = false;
    document.body.classList.add("tour-open");
    render();
    requestAnimationFrame(() => q("#tour-next").focus());
  }
  function close() {
    root.hidden = true;
    document.body.classList.remove("tour-open");
    document.querySelector("#help-btn")?.focus();
  }

  root.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  q("#tour-back").addEventListener("click", () => { if (i > 0) { i--; render(); } });
  q("#tour-next").addEventListener("click", () => { if (i < STEPS.length - 1) { i++; render(); } else close(); });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" && i < STEPS.length - 1) { i++; render(); }
    else if (e.key === "ArrowLeft" && i > 0) { i--; render(); }
  });
  // Hero button: close the tips, then hand off to the app to run the "day at the pole" animation.
  root.addEventListener("click", (e) => {
    if (e.target.closest("#tour-cta")) { close(); onWatchDay?.(); }
  });

  return { open, close };
}
