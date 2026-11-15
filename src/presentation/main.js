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
const NIGHT_LIGHT = 3.4;    // fill light while the Sun is behind terrain (the planner's own value is 0.8)
const PLANNER = "./";

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
  .present-sky {
    position: absolute; z-index: 3; top: 112px; left: 50%; width: min(720px, calc(100% - 44px));
    padding: 10px 12px 12px; border: 1px solid #ffffff36; border-radius: 14px; background: rgba(14,20,29,.84);
    backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); pointer-events: none;
    opacity: 0; translate: -50% -18px; scale: .96;
    transition: opacity .8s cubic-bezier(.45,0,.2,1), translate .8s cubic-bezier(.45,0,.2,1), scale .8s cubic-bezier(.45,0,.2,1);
  }
  .present-sky.show { opacity: 1; translate: -50% 0; scale: 1; }
  .present-sky h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: #b9c3d6; }
  .present-sky canvas { display: block; width: 100%; border-radius: 8px; }
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
/** Wait for the planner to finish recalculating after a site or date change. */
async function settled(timeout = 45000) {
  await sleep(700);
  return waitFor(() => demo.result && !demo.loading, timeout);
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

// ------------------------------------------------------------------ text column, hint, full-screen slides
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
const items = (list, from = 0) => list.map((t, k) => `<li class="rise" style="--i:${from + k}">${t}</li>`).join("");

/** A full-screen text slide over the planner. */
async function slide(html) {
  const veil = $("veil"), box = $("veil-content");
  focusOn(null);
  $("caption").classList.remove("show");
  document.body.dataset.side = "none";
  if (veil.classList.contains("gone")) { box.innerHTML = html; veil.classList.remove("gone"); startSky(); await sleep(1200); return; }
  box.classList.add("swap"); await sleep(360);
  box.innerHTML = html; veil.scrollTop = 0; box.classList.remove("swap");
  await sleep(900);
}

// Backdrop for the slides: stars, and a Sun that circles low along the horizon as it does at the pole.
let skyOn = false;
function startSky() {
  if (skyOn) return;
  skyOn = true;
  const cv = $("veil-sky"), ctx = cv.getContext("2d");
  let W = 0, H = 0, stars = [];
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round(W * H / 5200) }, () => ({ x: Math.random() * W, y: Math.random() * H * .9, r: Math.random() * 1.1 + .25, p: Math.random() * 6.28, s: Math.random() * 1.4 + .4 }));
  };
  size(); addEventListener("resize", size);
  const t0 = performance.now();
  (function draw(now) {
    if ($("veil").classList.contains("gone")) { skyOn = false; removeEventListener("resize", size); return; }
    const t = (now - t0) / 1000, hy = H * .9;
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      ctx.globalAlpha = .25 + .45 * (.5 + .5 * Math.sin(t * s.s + s.p));
      ctx.fillStyle = "#cdd8f0"; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const u = (t / 40) % 1, sx = u * (W + 400) - 200, sy = hy - 6 - Math.sin(u * Math.PI) * H * .035;
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 230);
    glow.addColorStop(0, "rgba(255,238,200,.85)"); glow.addColorStop(.18, "rgba(242,201,76,.32)"); glow.addColorStop(1, "rgba(242,201,76,0)");
    ctx.fillStyle = glow; ctx.fillRect(sx - 230, sy - 230, 460, 460);
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) ctx.lineTo(x, hy + Math.sin(x / 190) * 7 + Math.sin(x / 61 + 1) * 3);
    ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = "#0a111c"; ctx.fill();
    requestAnimationFrame(draw);
  })(t0);
}

const WELCOME = `<div class="welcome">
  <img src="/branding/nocoast-icon.png" alt="" width="60" height="52">
  <h1 style="--i:1">NoCoast</h1>
  <p class="lead" style="--i:2">A planner for choosing where and when to land at the Moon's south pole.</p>
  <div class="cards" style="--i:3">
    <div class="card rise" style="--i:4"><h2>The problem</h2><p>At the pole the Sun skims the horizon and Earth drops behind ridges. A lander can lose power and contact for days.</p></div>
    <div class="card rise" style="--i:5"><h2>What it works out</h2><p>Sunlight, solar power, battery charge and Earth contact for every hour of the stay, then a grade for the mission.</p></div>
    <div class="card rise" style="--i:6"><h2>The data</h2><p>NASA LOLA elevation maps for the terrain. JPL's DE421 ephemeris for where the Sun and Earth are.</p></div>
    <div class="card rise" style="--i:7"><h2>This walkthrough</h2><p>Twelve short stops on the live app, starting with a landing. Press space to move on from each.</p></div>
  </div>
  <p class="team" style="--i:9">Built for NASA Space Apps by <span>Alex</span><span>Randy</span><span>Sonit</span><span>Abhi</span></p>
  <p class="loading" id="loading" style="--i:10">Loading terrain and Sun and Earth positions…</p>
</div>`;

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
// The 360° skyline lives further down the planner page; this mirrors it into a panel over the scene.
let skyPanel = null;
function showSkyline(on) {
  if (!skyPanel) {
    skyPanel = doc.createElement("div"); skyPanel.className = "present-sky";
    skyPanel.innerHTML = `<h3>360° skyline: the horizon around the lander, with the Sun and Earth</h3><canvas></canvas>`;
    q("main").append(skyPanel);
    const out = skyPanel.querySelector("canvas"), ctx = out.getContext("2d");
    (function mirror() {
      const src = q("#skyline");
      if (src && src.width && skyPanel.classList.contains("show")) {
        if (out.width !== src.width || out.height !== src.height) { out.width = src.width; out.height = src.height; }
        ctx.drawImage(src, 0, 0);
      }
      win.requestAnimationFrame(mirror);
    })();
  }
  requestAnimationFrame(() => skyPanel.classList.toggle("show", on));
}

const steps = [
  { // 1
    async run(n) {
      plan = makePlan();
      const s = series(), aimAt = plan.sunUp > 0 ? plan.sunUp : plan.start;
      const yaw0 = s.sunAzimuthDeg[aimAt];
      doc.documentElement.classList.add("present-bare");
      demo.setNightLight(NIGHT_LIGHT);
      demo.setTime(plan.start);
      demo.look({ yaw: yaw0 - 70, pitch: -62, fov: 78, lift: 460 });
      await caption("float", n, `Landing at ${siteName()}`,
        `<p>This is the view from the lander's camera on the way down. The ground and the ridges are built from NASA's LOLA elevation data for this spot.</p>
         <p>The Sun is still behind the terrain here. The scene is brightened so you can see the surface.</p>`);
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
      await caption("right", n, "Sun, Earth and the skyline over time",
        `<p>Each bar covers the whole stay, and the white line is the current moment.</p>
         <ul class="key">
           <li><i style="background:#f2c94c"></i></li><li>Sun above the terrain</li>
           <li><i style="background:#4f8fe8"></i></li><li>Contact with Earth</li>
           <li><i style="background:linear-gradient(90deg,#2fa36b 50%,#fc3d21 50%)"></i></li><li>Green while the equipment has power, red when the battery is at its reserve</li>
         </ul>
         <p style="margin-top:12px">The panel at the top is the horizon turned through a full circle and laid flat. When the Sun or Earth drops below its outline, a hill is blocking it and the bar goes dark.</p>
         <p>The camera follows the Sun through the stay, then Earth.</p>`);
      await Promise.all([runClock(demo.index, 0, MOVE), sleep(MOVE)]);
      showSkyline(true);
      await panTo(bodyView("sun", 0, 46));
      markRow(0, "#f2c94c");
      await runClock(0, last, 7500, "sun");
      await sleep(400);
      markRow(1, "#4f8fe8");
      await Promise.all([runClock(last, 0, MOVE), panTo(bodyView("earth", 0, 46))]);
      await runClock(0, last, 7500, "earth");
      await sleep(400);
      markRow(2, "#2fa36b");
    },
  },
  { // 4
    async run(n) {
      markRow(null); showSkyline(false);
      await caption("right", n, "Compare two sites",
        `<p>Pick a second site and the planner puts both in one table, for the same dates and the same lander.</p>
         <p>The rows are the mission outlook, solar output, power, battery low point, Earth contact and the longest silence. "Visit this site" switches the scene to the other one.</p>`);
      press('[data-open="compare"]');
      await sleep(300);
      focusOn("#mission-sheet");
      await waitFor(() => !/Calculating/.test(q("#pane-compare").textContent), 25000);
    },
  },
  { // 5
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
      const rows = [...doc.querySelectorAll("#search-list .rank-item")];
      const hits = rows.map((el) => {
        const m = /([\d.]+)°S\s+([\d.]+)°E/.exec(el.textContent);
        return m && demo.mapPoint(-Number(m[1]), Number(m[2]));
      }).filter(Boolean);
      const marks = $("pmap-marks");
      marks.innerHTML = `<circle cx="500" cy="500" r="9" fill="#fff"/><text x="520" y="512">South Pole</text>`;
      for (const [k, [x, y]] of hits.entries()) {
        marks.insertAdjacentHTML("beforeend", `<circle class="hit${k ? "" : " best"}" cx="${x}" cy="${y}" r="${k ? 22 : 30}"/>`);
        await sleep(140);
      }
      if (!rows.length) { $("pmap-note").textContent = "The search returned no ranked points for this stay."; return; }
      $("pmap-note").textContent = `${hits.length} best points for this stay. The red one ranks first.`;
      await sleep(1400);
      // adopt the top result: it becomes the landing site for the rest of the walkthrough
      rows[0].classList.add("present-target"); focusOn(null); rows[0].classList.add("present-focus");
      await sleep(500);
      rows[0].click();
      if (hits[0]) marks.insertAdjacentHTML("beforeend", `<circle class="here" cx="${hits[0][0]}" cy="${hits[0][1]}" r="52"/>`);
      $("pmap-note").textContent = "Adopting the top point. The planner is working out the hills around it…";
      await settled();
      $("pmap-note").innerHTML = `The top point is now the landing site, listed as <b>${siteName()}</b>. Everything after this uses it.`;
    },
  },
  { // 6
    async run(n) {
      focusOn(null);
      await caption("right", n, "Find a better date",
        `<p>With the site chosen, the date helper moves the landing day earlier and later and ranks what it finds for the same stay length and lander.</p>
         <p>The buttons above the list shift the launch by a week or two at a time.</p>`);
      focusOn("#date-list");
      press("#suggest-dates");
      await waitFor(() => doc.querySelectorAll("#date-list .rank-item").length > 0, 45000);
      const best = q("#date-list .rank-item");
      if (!best) { $("cap-body").insertAdjacentHTML("beforeend", `<p>No better date turned up for this site, so the plan keeps its dates.</p>`); return; }
      const label = best.querySelector("strong")?.textContent.trim();
      await sleep(1400);
      best.classList.add("present-target"); focusOn(null); best.classList.add("present-focus");
      await sleep(500);
      best.click();
      await settled();
      $("cap-body").insertAdjacentHTML("beforeend", `<p>The top date is now applied${label ? `: <b>${label}</b>` : ""}. The site, timeline and grade have all moved to it.</p>`);
    },
  },
  { // 7
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
  { // 8
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
  { // 9
    async run(n) {
      focusOn(null);
      await caption("right", n, "The mission grade", `<p>Everything above rolls up into one grade for the stay.</p>`);
      await scrollToY(0);
      press('[data-open="results"]');
      await waitFor(() => q("#results .v"), 20000);
      focusOn("#mission-sheet");
      const grade = q("#results .v")?.textContent.trim();
      await sleep(350);
      $("cap-body").innerHTML = `<p>Everything above rolls up into one grade for the stay.${grade ? ` ${siteName()}, the point and date picked a moment ago, comes out <b>${grade}</b>. The sentence beside the badge gives the reason.` : ""}</p>
        <p>The rows under it are the numbers behind the grade: average solar output, the share of the stay with power, the battery's lowest charge, Earth contact, the longest gap in contact and hours of sunlight.</p>
        <p>Change the dates, the panel or the battery in the lander settings and the grade is worked out again.</p>`;
    },
  },
  { // 10
    run: (n) => slide(`<p class="kicker">${n} of ${total}</p><h1 style="--i:1">Everything in the planner</h1>
      <div class="cols" style="--i:2">
        <div><h2>Mission workspace</h2><ul>${items([
          "<b>At the site:</b> the lander's view of the sky and terrain",
          "<b>Above the site:</b> orbit the ground around the lander",
          "<b>South pole map:</b> click a point or type coordinates",
          "<b>Custom spots:</b> save up to four of your own",
          "<b>Timeline:</b> sunlight, Earth contact and power by hour",
          "<b>Mission outlook:</b> the grade and the numbers behind it",
          "<b>Mission dates:</b> landing day and length of stay",
          "<b>Find a landing day:</b> a calendar of grades by date",
          "<b>Compare sites:</b> two sites in one table",
          "<b>Lander settings:</b> panel, battery, load and requirements",
          "<b>Polar relay:</b> satellites that fill gaps in Earth contact",
          "<b>Exports:</b> quest JSON, power CSV and a share card",
        ], 3)}</ul></div>
        <div><h2>Analysis tools</h2><ul>${items([
          "<b>Terrain explorer:</b> whole-Moon terrain with layers and markers",
          "<b>Sunlight overlay:</b> sampled illumination on the terrain",
          "<b>Slope screening:</b> area under a slope limit near each site",
          "<b>Find best location:</b> ranks a grid of nearby points",
          "<b>Rank known sites:</b> scores every catalog site",
          "<b>Suggest better dates:</b> ranks earlier and later landings",
          "<b>Jump to best stretch:</b> the longest run of Sun and Earth together",
          "<b>Relay path:</b> a route for a relay between Earth and the Moon",
          "<b>Site A and B:</b> grade for the stay and status right now",
          "<b>Antenna pointing:</b> fixed boresight and beamwidth",
          "<b>Mission resilience:</b> landing delays and panel orientation",
          "<b>Skyline and calendar:</b> the horizon and the hours it blocks",
        ], 9)}</ul></div>
      </div>`),
  },
  { // 11
    run: (n) => slide(`<p class="kicker">${n} of ${total}</p><h1 style="--i:1">The maths and science underneath</h1>
      <ul class="wide">${items([
        "<b>Horizon.</b> For every compass bearing the planner finds the highest terrain angle seen from the site, and subtracts the drop from the Moon's curvature, <code>d² / 2R</code> with <code>R = 1737.4 km</code>.",
        "<b>Sun and Earth.</b> Positions come from JPL's DE421 ephemeris through Skyfield, in the Moon-fixed frame, and are turned into a bearing and a height above level ground at the site.",
        "<b>Visibility.</b> A body is up when its height is above the horizon at its bearing. The Sun is about 0.53° wide and Earth about 1.9°, so both are treated as discs.",
        "<b>Solar power.</b> <code>P = 1361 W/m² ÷ r² × area × efficiency × cos θ × visible fraction</code>, where <code>r</code> is the Sun's distance in AU and <code>θ</code> is the angle between the Sun and the panel.",
        "<b>Battery.</b> Charge and discharge are added up across the stay with efficiency losses and a reserve floor. Hours at the floor count as outages, and the grade checks them against the requirements.",
        "<b>Location search.</b> A coarse grid of candidate points is scored with 320 m LOLA horizons for the same mission window, then ranked.",
        "<b>Relay path.</b> Waypoints between Earth and the Moon form a graph. Each edge costs its length plus penalties for darkness, lost Earth contact and obstacles. Dijkstra's algorithm finds the cheapest route. A* finds the same route while visiting fewer nodes, using straight-line distance to the goal as a lower bound.",
      ], 2)}</ul>`),
  },
  { // 12
    run: (n) => slide(`<p class="kicker">${n} of ${total}</p><h1 style="--i:1">How it runs on Azure</h1>
      <div class="flow" style="--i:2">
        <div class="rise" style="--i:3"><b>Browser</b>3D scene and power model</div><i class="rise" style="--i:3">→</i>
        <div class="rise" style="--i:4"><b>Static Web Apps</b>serves the built site</div><i class="rise" style="--i:4">→</i>
        <div class="rise" style="--i:5"><b>Container Apps</b>Python science API</div><i class="rise" style="--i:5">→</i>
        <div class="rise" style="--i:6"><b>Blob Storage</b>terrain and kernel cache</div>
      </div>
      <ul class="wide">${items([
        "<b>Static Web Apps</b> hosts the site that Vite builds from this repository.",
        "<b>Container Apps</b> runs the FastAPI backend from a Docker image. It does the heavy work: terrain horizons, Sun and Earth analysis, and the relay path search.",
        "<b>Blob Storage</b> keeps about 240 MB of LOLA elevation files and SPICE kernels, so a cold start does not download them from NASA again.",
        "<b>Managed identity</b> gives the API its access to storage, so no storage key is kept in the repository or the app.",
        "<b>Bicep and GitHub Actions</b> define the resources and deploy the site and the API on each push to main.",
        "<b>Log Analytics and Application Insights</b> collect the API's logs and metrics.",
      ], 7)}</ul>`),
  },
];
total = steps.length;

// ------------------------------------------------------------------ runner
let at = -1, busy = true;
async function advance() {
  if (busy) return;
  busy = true; hint("");
  at++;
  if (at >= steps.length) { location.href = PLANNER; return; }      // done: hand over to the real planner
  try { await steps[at].run(at + 1); }
  catch (error) { console.error(error); }
  busy = false;
  hint(at === steps.length - 1 ? "<kbd>Space</kbd>open the planner" : "<kbd>Space</kbd>next");
}
function onKey(e) {
  if (e.code !== "Space" && e.key !== "ArrowRight" && e.key !== "PageDown") return;
  e.preventDefault(); e.stopPropagation();
  if (!e.repeat) advance();
}
window.addEventListener("keydown", onKey, true);
$("hint").addEventListener("click", advance);

$("veil-content").innerHTML = WELCOME;
startSky();
frame.addEventListener("load", async () => {
  win = frame.contentWindow; doc = win.document;
  doc.head.append(Object.assign(doc.createElement("style"), { textContent: FRAME_CSS }));
  doc.documentElement.classList.add("present-bare");
  win.addEventListener("keydown", onKey, true);
  const ready = await waitFor(() => (demo = win.nocoastDemo) && demo.result && !demo.loading && demo.view, 60000);
  if (!ready) {
    $("loading").textContent = "The planner could not load its data. Start the science API (run.ps1) and reload this page.";
    return;
  }
  demo.setNightLight(NIGHT_LIGHT);
  await sleep(1200);          // let the terrain mesh finish building behind the title
  $("loading").textContent = "Ready.";
  busy = false;
  hint("<kbd>Space</kbd>begin the landing");
});
