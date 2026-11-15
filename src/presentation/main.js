// Guided walkthrough. The real planner runs in the frame; this script moves its camera and clock, presses
// its buttons, and puts a short explanation beside each tool. Space advances once a step has finished.
const frame = document.getElementById("app");
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const MOVE = 1100;          // every transition between tools stays under 1.5 s

let win, doc, demo;
const q = (sel) => doc.querySelector(sel);

function tween(ms, fn, ease = easeInOut) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    (function step(now) {
      const t = clamp((now - t0) / ms, 0, 1);
      fn(ease(t), t);
      if (t < 1) requestAnimationFrame(step); else resolve();
    })(t0);
  });
}
async function waitFor(test, timeout = 30000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (test()) return true; await sleep(150); }
  return false;
}

// ------------------------------------------------------------------ the planner in the frame
const FRAME_CSS = `
  html { scrollbar-width: none; }
  html::-webkit-scrollbar { display: none; }
  .workspace-header, .scene-tools, .scene-now, .mission-sheet, .mission-dock, .scene-hint, .more-tools, .sheet-reopen {
    transition: opacity 1.1s cubic-bezier(.45,0,.2,1), translate 1.1s cubic-bezier(.45,0,.2,1);
  }
  html.present-bare :is(.workspace-header, .scene-tools, .scene-now, .mission-sheet, .mission-dock, .scene-hint, .more-tools, .sheet-reopen, .map-panel) {
    opacity: 0; pointer-events: none;
  }
  html.present-bare :is(.mission-sheet, .mission-dock) { translate: 0 22px; }
  html.present-bare .workspace-header { translate: 0 -14px; }
  html.present-bare .sky3d-label.compass { opacity: 0; }
  .sky3d-label { transition: opacity .8s; }
  .mission-sheet h1:focus { outline: none; }
  .present-target { transition: box-shadow .6s cubic-bezier(.45,0,.2,1); }
  .present-focus { box-shadow: 0 0 0 2px #ffd166, 0 0 0 9px #ffd16633 !important; }
  .present-row {
    position: absolute; z-index: 5; pointer-events: none; border: 2px solid #fff; border-radius: 7px; opacity: 0;
    transition: top .6s cubic-bezier(.45,0,.2,1), opacity .6s, border-color .6s, box-shadow .6s;
  }
`;
function focusOn(sel) {
  doc.querySelectorAll(".present-focus").forEach((e) => e.classList.remove("present-focus"));
  const el = sel && q(sel);
  if (!el) return;
  el.classList.add("present-target");
  requestAnimationFrame(() => el.classList.add("present-focus"));
}
function scrollToY(y) {
  const from = win.scrollY, to = clamp(y, 0, doc.documentElement.scrollHeight - win.innerHeight);
  return tween(MOVE, (e) => win.scrollTo(0, lerp(from, to, e)));
}
const scrollToEl = (sel, pad = 18) => scrollToY(q(sel).getBoundingClientRect().top + win.scrollY - pad);
const press = (sel) => q(sel)?.click();
function setField(sel, value) {
  const el = q(sel); if (!el) return;
  el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
}

// ------------------------------------------------------------------ camera and clock
const series = () => demo.result.series;
const count = () => demo.result._t.length;
const perHour = () => 3600000 / (demo.result._t[1] - demo.result._t[0]);
function firstRise(body, from = 1) {
  const v = series()[`${body}Visible`];
  for (let i = Math.max(1, from); i < v.length; i++) if (v[i] && !v[i - 1]) return i;
  return -1;
}
const turn = (from, to) => from + ((((to - from) % 360) + 540) % 360 - 180);   // shortest way round
function bodyView(body, i, fov) {
  const s = series(), k = clamp(Math.round(i), 0, count() - 1);
  return { yaw: s[`${body}AzimuthDeg`][k], pitch: Math.max(s[`${body}ElevationDeg`][k], -1) + fov * .12, fov };
}
function panTo(view, ms = MOVE) {
  const a = demo.view, yaw = turn(a.yaw, view.yaw);
  return tween(ms, (e) => demo.look({
    yaw: (lerp(a.yaw, yaw, e) + 360) % 360, pitch: lerp(a.pitch, view.pitch ?? a.pitch, e),
    fov: lerp(a.fov, view.fov ?? a.fov, e), lift: lerp(a.lift, view.lift ?? 0, e) }));
}
/** Run the clock from one sample to another, optionally keeping a body in frame. */
function runClock(from, to, ms, body, fov = 46) {
  return tween(ms, (e) => {
    const i = lerp(from, to, e);
    demo.setTime(i);
    if (body) demo.look(bodyView(body, i, fov));
  }, (t) => (t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2));
}

// ------------------------------------------------------------------ text column
let total = 0;
async function caption(side, n, title, html) {
  const cap = $("caption");
  cap.classList.remove("show");
  await sleep(document.body.dataset.side === "none" ? 0 : 320);
  document.body.dataset.side = side;
  $("count").textContent = n ? `${n} of ${total}` : "";
  $("cap-title").textContent = title;
  $("cap-body").innerHTML = html;
  $("pmap").hidden = true; $("pmap").classList.remove("show");
  cap.classList.add("show");
}
function hint(text) {
  const el = $("hint");
  if (!text) { el.classList.remove("show"); return; }
  el.innerHTML = text; el.classList.add("show");
}
const siteName = () => q("#site")?.selectedOptions[0]?.textContent?.trim() || "the landing site";

// ------------------------------------------------------------------ the steps
let plan = null;      // sample indices chosen from the real Sun and Earth data for this site and stay
function makePlan() {
  const n = count(), h = perHour();
  const sunUp = firstRise("sun"), earthUp = firstRise("earth");
  const first = Math.min(...[sunUp, earthUp].filter((i) => i > 0), Math.round(n * .35));
  return { sunUp, earthUp, start: clamp(Math.round(first - 14 * h), 0, n - 1), h };
}
function rowMarker() {
  let m = q(".present-row");
  if (!m) { m = doc.createElement("div"); m.className = "present-row"; q("#mission-dock").append(m); }
  return m;
}
function markRow(k, color) {
  const m = rowMarker();
  if (k == null) { m.style.opacity = 0; return; }
  const strip = q("#strip").getBoundingClientRect(), dock = q("#mission-dock").getBoundingClientRect();
  Object.assign(m.style, { left: `${strip.left - dock.left - 6}px`, width: `${strip.width + 12}px`,
    top: `${strip.top - dock.top + 4 + k * 16 - 5}px`, height: "20px", borderColor: color,
    boxShadow: `0 0 14px ${color}`, opacity: 1 });
  document.querySelectorAll("#cap-body .key i").forEach((el, j) => el.classList.toggle("on", j === k));
}

const steps = [
  { // 1
    async run(n) {
      plan = makePlan();
      const s = series(), aimAt = plan.sunUp > 0 ? plan.sunUp : plan.start;
      const yaw0 = s.sunAzimuthDeg[aimAt];
      doc.documentElement.classList.add("present-bare");
      demo.setTime(plan.start);
      demo.look({ yaw: yaw0 - 70, pitch: -62, fov: 78, lift: 460 });
      await caption("float", n, `Landing at ${siteName()}`,
        `<p>This is the view from the lander's camera on the way down. The ground and the ridges are built from NASA's LOLA elevation data for this spot.</p>
         <p>The Sun is still behind the terrain, so the only light is earthshine.</p>`);
      $("veil").classList.add("gone");
      await tween(7600, (e, t) => demo.look({
        lift: 460 * (1 - t) ** 2.3, pitch: lerp(-62, 3, easeInOut(t)), yaw: yaw0 - 70 * (1 - easeOut(t)), fov: lerp(78, 70, t) }), (t) => t);
      // touchdown: the camera settles on its legs
      await tween(900, (_, t) => demo.look({ lift: 0, pitch: 3 - 2.2 * Math.exp(-5 * t) * Math.cos(16 * t) * (1 - t) }), (t) => t);
    },
  },
  { // 2
    async run(n) {
      const { sunUp, earthUp, start, h } = plan, last = count() - 1;
      await caption("float", n, "Sunrise, then Earth",
        `<p>Near the pole the Sun stays close to the horizon. It circles the sky once a month and spends days at a time behind ridges.</p>
         <p>Earth sits low in one part of the sky and dips in and out of view. The clock now runs forward until both have come up.</p>`);
      let at = start;
      if (sunUp > 0) {
        await panTo(bodyView("sun", at, 50));
        const to = clamp(sunUp + 10 * h, 0, last);
        await runClock(at, to, 6500, "sun", 50); at = to;
      }
      await panTo(bodyView("earth", at, 34), 1300);
      const to = clamp(Math.max(at + 30 * h, earthUp > at ? earthUp + 14 * h : 0), 0, last);
      await runClock(at, to, 5500, "earth", 34);
      // pull back to the whole planner
      await sleep(500);
      const cap = caption("right", n, "The full planner",
        `<p>The same scene is the backdrop for the whole planner. The site and its mission panels are on the left, the camera controls are at the top, and the timeline runs along the bottom.</p>`);
      press("#site-continue");
      doc.documentElement.classList.remove("present-bare");
      await Promise.all([cap, panTo({ ...bodyView("earth", to, 70), pitch: 6 }, 1300)]);
    },
  },
  { // 3
    async run(n) {
      const last = count() - 1;
      await caption("right", n, "Sun and Earth contact over time",
        `<p>Each bar covers the whole stay, and the white line is the current moment.</p>
         <ul class="key">
           <li><i style="background:#f2c94c"></i></li><li>Sun above the terrain</li>
           <li><i style="background:#4f8fe8"></i></li><li>Contact with Earth</li>
           <li><i style="background:linear-gradient(90deg,#2fa36b 50%,#fc3d21 50%)"></i></li><li>Green while the equipment has power, red when the battery is at its reserve</li>
         </ul>
         <p style="margin-top:12px">The camera follows the Sun through the stay, then Earth, so you can match the sky to the bars.</p>`);
      await Promise.all([runClock(demo.index, 0, MOVE), sleep(MOVE)]);
      await panTo(bodyView("sun", 0, 46));
      markRow(0, "#f2c94c");
      await runClock(0, last, 7000, "sun");
      await sleep(400);
      markRow(1, "#4f8fe8");
      await Promise.all([runClock(last, 0, MOVE), panTo(bodyView("earth", 0, 46))]);
      await runClock(0, last, 7000, "earth");
      await sleep(400);
      markRow(2, "#2fa36b");
    },
  },
  { // 4
    async run(n) {
      markRow(null);
      const last = count() - 1;
      await caption("left", n, "360° skyline",
        `<p>This is the horizon as the lander sees it, turned through a full circle and laid flat. The outline is the real terrain around the site.</p>
         <p>The Sun and Earth are drawn at their current bearing and height. When one drops below the outline, a hill is blocking it. The calendar under it shows the same hours as bands.</p>`);
      await scrollToEl(".time-sky-cluster");
      focusOn("#skyline");
      await runClock(demo.index, 0, MOVE);
      await runClock(0, last, 8000);
    },
  },
  { // 5
    async run(n) {
      focusOn(null);
      await caption("right", n, "Compare two sites",
        `<p>Pick a second site and the planner puts both in one table, for the same dates and the same lander.</p>
         <p>The rows are the mission outlook, solar output, power, battery low point, Earth contact and the longest silence. "Visit this site" switches the scene to the other one.</p>`);
      await scrollToY(0);
      press('[data-open="compare"]');
      await sleep(300);
      focusOn("#mission-sheet");
      await waitFor(() => !/Calculating/.test(q("#pane-compare").textContent), 25000);
    },
  },
  { // 6
    async run(n) {
      focusOn(null);
      await caption("left", n, "Find a better location",
        `<p>The search scores a grid of points within 40 km of the current site for the same mission window and lists the best of them.</p>`);
      setField("#search-region", "around"); setField("#search-radius", "40");
      await scrollToEl(".decision-cluster");
      const img = q("#map-img");
      if (img) { $("pmap-img").src = img.src; $("pmap").hidden = false; requestAnimationFrame(() => $("pmap").classList.add("show")); }
      $("pmap-marks").innerHTML = ""; $("pmap-note").textContent = "Scoring candidate points…";
      focusOn("#search-list");
      press("#find-best-location");
      await waitFor(() => doc.querySelectorAll("#search-list .rank-item").length > 0, 40000);
      const hits = [...doc.querySelectorAll("#search-list .rank-item strong")].map((el) => {
        const m = /([\d.]+)°S\s+([\d.]+)°E/.exec(el.textContent);
        return m && demo.mapPoint(-Number(m[1]), Number(m[2]));
      }).filter(Boolean);
      const marks = $("pmap-marks");
      marks.innerHTML = `<circle cx="500" cy="500" r="9" fill="#fff"/><text x="520" y="512">South Pole</text>`;
      for (const [k, [x, y]] of hits.entries()) {
        marks.insertAdjacentHTML("beforeend", `<circle class="hit${k ? "" : " best"}" cx="${x}" cy="${y}" r="${k ? 22 : 30}"/>`);
        await sleep(140);
      }
      $("pmap-note").textContent = hits.length
        ? `${hits.length} best points for this stay. The red one ranks first. Adopt makes any of them the site in view.`
        : "The search returned no ranked points for this stay.";
    },
  },
  { // 7
    async run(n) {
      focusOn(null);
      await caption("right", n, "Find a better date",
        `<p>If the site is fixed, the date helper moves the landing day earlier and later and ranks what it finds for the same stay length and lander.</p>
         <p>Apply moves the whole plan to that date. The buttons above the list shift the launch by a week or two at a time.</p>`);
      focusOn("#date-list");
      press("#suggest-dates");
      await waitFor(() => doc.querySelectorAll("#date-list .rank-item").length > 0, 40000);
    },
  },
  { // 8
    async run(n) {
      focusOn(null);
      await caption("left", n, "Relay path",
        `<p>When terrain blocks the direct line to Earth, a relay satellite can carry the link.</p>
         <p>This tool picks a route between Earth and the Moon at the mission start. It weighs time in sunlight, time in contact with Earth, obstacles and distance, and colours each waypoint by what it can see. It is a first-pass corridor model and does not propagate an orbit.</p>`);
      await scrollToEl(".pathfind-cluster");
      focusOn("#pathfind-panel");
      press("#compute-pathfind");
      await waitFor(() => !q("#pathfind-results").hidden, 30000);
    },
  },
  { // 9
    async run(n) {
      focusOn(null);
      await caption("right", n, "Test mission resilience",
        `<p>Landings slip. This test reruns the stay at each delayed landing time with the same hardware and shows which delays still meet the requirements.</p>
         <p>The optimizer then tries fixed panel orientations at the two study sites, CR1 and SR1, and reports which one serves the equipment best.</p>`);
      await scrollToEl("#mission-planning");
      focusOn("#mission-planning .mission-results");
      const idle = () => q("#cancel-mission-job").disabled;
      setField("#orientation-step", "90");
      press("#test-delays");
      await sleep(400); await waitFor(idle, 45000);
      press("#optimize-mission");
      await sleep(400); await waitFor(idle, 60000);
    },
  },
  { // 10
    async run(n) {
      focusOn(null);
      await caption("right", n, "The mission grade", `<p>Everything above rolls up into one grade for the stay.</p>`);
      await scrollToY(0);
      press('[data-open="results"]');
      await waitFor(() => q("#results .v"), 20000);
      focusOn("#mission-sheet");
      const grade = q("#results .v")?.textContent.trim();
      await sleep(350);
      $("cap-body").innerHTML = `<p>Everything above rolls up into one grade for the stay.${grade ? ` ${siteName()} on these dates comes out <b>${grade}</b>, and the sentence beside the badge gives the reason.` : ""}</p>
        <p>The rows under it are the numbers behind the grade: average solar output, the share of the stay with power, the battery's lowest charge, Earth contact, the longest gap in contact and hours of sunlight.</p>
        <p>Change the dates, the panel or the battery in the lander settings and the grade is worked out again.</p>`;
    },
  },
];
total = steps.length;

// ------------------------------------------------------------------ runner
let at = -1, busy = true, finished = false;
async function advance() {
  if (busy) return;
  if (finished) { location.reload(); return; }
  busy = true; hint("");
  at++;
  if (at >= steps.length) {
    focusOn(null);
    document.body.dataset.side = "none"; $("caption").classList.remove("show");
    $("veil-title").textContent = "That's the walkthrough";
    $("veil-text").textContent = "Open the planner at the site root to try your own landing site and dates.";
    $("veil").classList.remove("gone");
    await sleep(1200);
    finished = true; busy = false;
    hint("<kbd>Space</kbd>run it again");
    return;
  }
  try { await steps[at].run(at + 1); }
  catch (error) { console.error(error); }
  busy = false;
  hint(at === steps.length - 1 ? "<kbd>Space</kbd>finish" : "<kbd>Space</kbd>next");
}
function onKey(e) {
  if (e.code !== "Space" && e.key !== "ArrowRight" && e.key !== "PageDown") return;
  e.preventDefault(); e.stopPropagation();
  if (!e.repeat) advance();
}
window.addEventListener("keydown", onKey, true);
$("hint").addEventListener("click", advance);

frame.addEventListener("load", async () => {
  win = frame.contentWindow; doc = win.document;
  doc.head.append(Object.assign(doc.createElement("style"), { textContent: FRAME_CSS }));
  doc.documentElement.classList.add("present-bare");
  win.addEventListener("keydown", onKey, true);
  $("veil-text").textContent = "Loading terrain and Sun and Earth positions…";
  const ready = await waitFor(() => (demo = win.nocoastDemo) && demo.result && !demo.loading && demo.view, 60000);
  if (!ready) {
    $("veil-text").textContent = "The planner could not load its data. Start the science API (run.ps1) and reload this page.";
    return;
  }
  await sleep(1200);          // let the terrain mesh finish building behind the title
  $("veil-text").textContent = "A planner for landing at the lunar south pole. This walkthrough runs the live app on NASA LOLA terrain and JPL positions for the Sun and Earth.";
  busy = false;
  hint("<kbd>Space</kbd>begin the landing");
});
