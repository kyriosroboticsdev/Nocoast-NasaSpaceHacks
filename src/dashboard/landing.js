// The welcome screen is the app's first impression. Keep the interaction and its
// controls self-contained; the dashboard remains mounted underneath it.
import "./landing.css";

const FEATURES = [
  ["earth", "Real NASA data", "LOLA terrain · JPL Sun &amp; Earth"],
  ["check", "Power and contact estimates", "Power, sunlight &amp; Earth contact"],
  ["relay", "Relay-aware comms", "See where a satellite keeps you online"],
];

function starfield(canvas) {
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, H = 0, stars = [], raf = 0, t0 = performance.now();

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round(W * H / 7000) }, () => ({
      x: Math.random() * W, y: Math.random() * H * 0.82,
      r: Math.random() * 1.1 + 0.3, p: Math.random() * Math.PI * 2, s: Math.random() * 1.5 + 0.4,
    }));
  }

  function frame(now) {
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#05070f"); sky.addColorStop(0.62, "#070d1e"); sky.addColorStop(1, "#0c1836");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    for (const st of stars) {
      const a = reduce ? 0.7 : 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * st.s + st.p));
      ctx.globalAlpha = a; ctx.fillStyle = "#cdd8f0";
      ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    const hy = H * 0.74, dip = H * 0.05;
    const horizon = (x) => hy + dip * Math.sin((x / W) * Math.PI * 1.1 - 0.2) * -1 + dip * 0.4;
    const period = reduce ? 1e9 : 26;
    const u = reduce ? 0.32 : (t % period) / period;
    const sx = u * (W + 240) - 120;
    const sy = horizon(sx) - H * 0.055 - Math.sin(u * Math.PI) * H * 0.02;

    const wash = ctx.createRadialGradient(sx, hy, 0, sx, hy, W * 0.5);
    wash.addColorStop(0, "rgba(242,179,61,0.16)"); wash.addColorStop(1, "rgba(242,179,61,0)");
    ctx.fillStyle = wash; ctx.fillRect(0, hy - 10, W, H - hy + 10);

    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 150);
    glow.addColorStop(0, "rgba(255,240,200,0.95)"); glow.addColorStop(0.25, "rgba(242,201,76,0.55)");
    glow.addColorStop(1, "rgba(242,201,76,0)");
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(sx, sy, 150, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff6df"; ctx.beginPath(); ctx.arc(sx, sy, 15, 0, Math.PI * 2); ctx.fill();

    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, horizon(x));
    ctx.lineTo(W, H); ctx.closePath();
    const ground = ctx.createLinearGradient(0, hy, 0, H);
    ground.addColorStop(0, "#131f3a"); ground.addColorStop(1, "#070c18");
    ctx.fillStyle = ground; ctx.fill();
    ctx.strokeStyle = "rgba(120,150,210,0.45)"; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) (x ? ctx.lineTo(x, horizon(x)) : ctx.moveTo(x, horizon(x)));
    ctx.stroke();

    if (!reduce) raf = requestAnimationFrame(frame);
  }

  resize();
  const onResize = () => resize();
  addEventListener("resize", onResize);
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); removeEventListener("resize", onResize); };
}

const svg = (name) => `<svg aria-hidden="true" class="l-ic"><use href="#i-${name}"/></svg>`;

export function showLanding({ onEnter, onTour } = {}) {
  const root = document.createElement("div");
  root.className = "landing";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Welcome to NoCoast lunar mission planner");
  root.innerHTML = `
    <canvas class="l-canvas" aria-hidden="true"></canvas>
    <div class="l-content">
      <div class="l-brand"><span class="l-mark" aria-hidden="true"></span>NoCoast</div>
      <h1 class="l-title">Will your Moon landing<br><span>survive the dark?</span></h1>
      <p class="l-sub">At the lunar south pole the Sun just skims the horizon and Earth keeps dropping out of
        sight. Pick a site and a date — estimate power, sunlight and staying in touch. Results remain <b>preliminary</b> until terrain validation is supplied.</p>
      <div class="l-cta">
        <button class="l-enter" id="l-enter">Explore landing sites ${svg("down")}</button>
        <button class="l-tour" id="l-tour">Take a quick tour</button>
      </div>
      <p class="l-prompt">Start with a site and date. Compare the sunlight, power, and Earth contact your mission needs.</p>
      <div class="l-features" aria-label="What you can explore">
        ${FEATURES.map(([ic, h, s]) => `<div class="l-feat">${svg(ic)}<div><b>${h}</b><span>${s}</span></div></div>`).join("")}
      </div>
      <p class="l-foot">A planning sandbox built with NASA LOLA terrain and JPL data. Results are estimates, not a landing-site recommendation.</p>
    </div>`;
  document.body.append(root);
  document.body.classList.add("landing-open");
  const stop = starfield(root.querySelector(".l-canvas"));

  function leave(after) {
    root.classList.add("leaving");
    setTimeout(() => { stop(); root.remove(); document.body.classList.remove("landing-open"); after?.(); }, 620);
  }
  root.querySelector("#l-enter").addEventListener("click", () => leave(onEnter));
  root.querySelector("#l-tour").addEventListener("click", () => leave(onTour));
  root.addEventListener("keydown", (e) => { if (e.key === "Escape") leave(onEnter); });
  requestAnimationFrame(() => root.querySelector("#l-enter").focus());
  return { leave };
}
