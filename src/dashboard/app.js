// Lunar Navigator: Sun, Earth & communication. Plain-language by default, with an Advanced mode for specialists.
const SUN = "#ffc83d", EARTH = "#4fb8ff", BOTH = "#3ddc97", BAD = "#ff7a7a";
const SITE_COLORS = ["#8ab4ff", "#ff8fab", "#c792ea", "#5eead4"];
const MAX_COMPARE = 4;
const DAY = 86400;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ============================================================ wording (simple / advanced)
const TEXT = {
  tagline: ["When can a Moon lander get sunlight and talk to Earth?", "Sun/Earth visibility & DTE comm windows · contract v0.1"],
  tabOverview: ["Overview", "Overview"],
  tabCompare: ["Compare places", "Compare sites"],
  tabDates: ["Best landing days", "Landing-date trade"],
  tabTerrain: ["3D terrain", "3D terrain"],
  t3Title: ["Fly around the landing spot", "3D terrain (LOLA 5 m mosaic) with computed Sun/Earth directions"],
  t3Help: ["Drag to look around, scroll to zoom. The yellow arrow points at the Sun and the blue arrow at Earth. A faded arrow means it is hidden behind the hills. Slide the time bar to watch them move.",
    "Person 1 terrain explorer. Arrows = topocentric Sun/Earth unit vectors (ENU → viewer frame) at the scrubbed UTC; faded = obstructed per the numerical horizon. Lighting follows the Sun vector (illustrative, no cast shadows)."],
  modeLabel: ["Advanced", "Advanced"],
  ctlSite: ["Landing spot", "Site"],
  ctlLanding: ["Landing day", "Landing day"],
  ctlLength: ["Mission length", "Mission duration"],
  skyTitle: ["What the lander sees", "Horizon panorama"],
  skyHelp: ["A 360° view around the lander. The grey shapes are hills. Hills are drawn taller than they really are so you can see them.",
    "Terrain horizon (1440 az samples, 0.25°) with Sun/Earth topocentric tracks over the window. Vertical scale exaggerated."],
  legSun: ["Sun's path", "Sun track (visible)"],
  legEarth: ["Earth's path", "Earth track (visible)"],
  legHidden: ["hidden behind hills", "obstructed by terrain"],
  tlTitle: ["Mission timeline", "Visibility timeline"],
  tlHelp: ["Coloured bars show when each thing is happening. Click anywhere to jump to that moment.",
    "Sun visible / DTE line of sight / both, from refined event times. Click to scrub."],
  schedTitle: ["When can we talk to Earth?", "DTE windows & blackouts"],
  cmpTitle: ["Which spot is better?", "Site comparison"],
  cmpHelp: ["Same dates, different places. The green tag marks the best value.",
    "Same window for every site. Best value tagged among contract-quality (rankable) sites only."],
  mapTitle: ["Pick a spot on the map", "South-polar map"],
  mapHelp: ["Click anywhere to try your own landing spot. The top of the map faces Earth.",
    "LOLA 80 m hillshade, ±60 km polar stereographic, 0°E up. Click to add a custom site (fallback terrain outside the 5 m tiles → unranked)."],
  calTitle: ["Which days are best to land?", "Landing-date sweep"],
  calHelp: ["Each square is a possible landing day, rated for the whole mission length. Click a day to look at it.",
    "Each cell = landing at 00:00 UTC on that day, scored over the mission duration at 600 s sampling (no event refinement)."],
  delayTitle: ["What if the launch is delayed?", "Schedule slip impact"],
  delayHelp: ["Rockets often launch late. Slide to see how a delay changes things.",
    "Δ metrics vs. the planned landing day for the same mission duration."],
};
const INFO = {
  comm: ["The lander can only send messages straight to Earth when Earth is above the hills on its horizon.",
    "Direct-to-Earth line-of-sight proxy: Earth center elevation > max(terrain horizon + margin, antenna min elevation). Strict >. No link budget or DSN scheduling."],
  blackout: ["The longest stretch when Earth is hidden and the lander can't call home on its own.",
    "Longest contiguous interval without DTE line of sight in the window (truncated at the window edges)."],
  sun: ["How much of the mission the Sun is above the hills. Sunlight means solar power.",
    "Fraction of the window with the Sun center above the terrain horizon (center-binary-v1). Not irradiance; no partial disc or eclipse modelling."],
  dark: ["The longest night. The lander has to live on batteries and stay warm until sunrise.",
    "Longest contiguous interval with the Sun center below the terrain horizon."],
  both: ["Time when the lander has power AND can talk to Earth, which is the best time to get work done.",
    "Intersection of Sun-visible and DTE windows."],
  height: ["How high the spot is compared to the Moon's average surface. Higher spots see farther and catch more sunlight.",
    "Bilinear height from the PGDA 5 m DEM relative to the 1737.4 km reference sphere."],
};
let advanced = false;
const T = (k) => TEXT[k][advanced ? 1 : 0];
const I = (k) => INFO[k][advanced ? 1 : 0];
const info = (k) => `<span class="info" data-info="${k}">i</span>`;

// ============================================================ state
const state = {
  contract: null, mapMeta: null,
  sites: [], custom: load("customSitesV2", []),
  focus: null, compare: [],
  start: null, end: null, antenna: 0,
  results: new Map(), tIdx: 0, playing: false,
  tab: "overview", sweep: null, delay: 0,
};
function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

const allSites = () => [...state.sites, ...state.custom];
const siteById = (id) => allSites().find((s) => s.id === id);
const colorOf = (id) => SITE_COLORS[allSites().findIndex((s) => s.id === id) % SITE_COLORS.length];

// ============================================================ formatting
const utc = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const toDT = (d) => d.toISOString().slice(0, 16);
const toDate = (d) => d.toISOString().slice(0, 10);
function fmtDur(sec) {
  if (sec == null) return "—";
  if (advanced) {
    const h = sec / 3600;
    return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
  }
  const d = Math.floor(sec / DAY), h = Math.floor((sec % DAY) / 3600), m = Math.round((sec % 3600) / 60);
  if (d) return `${d} day${d > 1 ? "s" : ""}${h ? ` ${h} hr` : ""}`;
  if (h) return `${h} hr${m ? ` ${m} min` : ""}`;
  return `${m} min`;
}
function fmtWhen(iso) {
  if (advanced) return iso;
  const d = new Date(iso);
  return d.toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";
}
const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const pctAdv = (v) => (v == null ? "—" : advanced ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);
function where(s) {
  if (advanced) return `${s.lat.toFixed(4)}°, ${s.lon.toFixed(4)}°E`;
  const km = ((90 - Math.abs(s.lat)) * Math.PI / 180) * 1737.4;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km from the ${s.lat < 0 ? "South" : "North"} Pole`;
}

// ============================================================ api
async function api(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  const r = await fetch(`/api/${path}${q ? "?" + q : ""}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
const cache = new Map();
function analyze(site) {
  const p = { latitudeDeg: site.lat, longitudeEastDeg: site.lon, startUtc: utc(state.start), endUtc: utc(state.end),
    antennaMinElevationDeg: state.antenna };
  const key = JSON.stringify(p);
  if (!cache.has(key)) {
    cache.set(key, api("analyze", p).then((r) => ({ ...r, _t: r.series.timesUtc.map(Date.parse) }))
      .catch((e) => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}
function setStatus(msg, err = false) { $("status").textContent = msg; $("status").classList.toggle("err", err); }

function windowError() {
  const c = state.contract.time;
  if (!(state.start < state.end)) return "The end must be after the start.";
  if (state.start < new Date(c.supportedStartUtc) || state.end > new Date(c.supportedEndUtc)) return "Dates must be within 2027.";
  if ((state.end - state.start) / 1000 > c.maxMissionDurationSeconds) return "Missions can be at most 60 days.";
  return null;
}

async function refresh() {
  const err = windowError();
  if (err) { setStatus(err, true); return; }
  const ids = [...new Set([state.focus, ...state.compare])].filter((id) => siteById(id));
  setStatus("Working it out…");
  try {
    const res = await Promise.all(ids.map((id) => analyze(siteById(id))));
    state.results = new Map(ids.map((id, i) => [id, res[i]]));
    const r = state.results.get(state.focus);
    state.tIdx = Math.min(state.tIdx, r._t.length - 1);
    $("t").max = r._t.length - 1; $("t").value = state.tIdx;
    setStatus("");
    renderAll();
  } catch (e) { setStatus(e.message, true); }
  refreshSweep();
}

async function refreshSweep() {
  const s = siteById(state.focus);
  const c = state.contract.time;
  const land = new Date(state.start); land.setUTCHours(0, 0, 0, 0);
  const first = new Date(Date.UTC(land.getUTCFullYear(), land.getUTCMonth(), 1));
  try {
    state.sweep = await api("sweep", { latitudeDeg: s.lat, longitudeEastDeg: s.lon, firstDayUtc: utc(first),
      sweepDays: Math.round((Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 3, 1) - first) / 1000 / DAY), missionSeconds: (state.end - state.start) / 1000, antennaMinElevationDeg: state.antenna });
  } catch (e) {
    state.sweep = { days: [], error: e.message };
  }
  if (c && state.tab === "dates") renderDates();
}

// ============================================================ static text + mode
function applyText() {
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = T(el.dataset.t); });
  const opts = [["sunAndCommPercent", "Sun + Earth together", "Sun + DTE (%)"],
    ["commPercent", "Can talk to Earth", "DTE availability (%)"],
    ["sunlitPercent", "Sunlight", "Sun visible (%)"],
    ["longestBlackoutHours", "Longest time without contact", "Longest DTE blackout (h)"],
    ["longestDarkHours", "Longest darkness", "Longest darkness (h)"]];
  const cur = $("cal-metric").value || "sunAndCommPercent";
  $("cal-metric").innerHTML = opts.map(([v, s, a]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${advanced ? a : s}</option>`).join("");
}
$("advanced").addEventListener("change", () => {
  advanced = $("advanced").checked;
  document.body.classList.toggle("advanced", advanced);
  save("advancedMode", advanced);
  applyText(); renderAll();
});
function showTab(tab) {
  state.tab = ["overview", "compare", "dates", "terrain"].includes(tab) ? tab : "overview";
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === state.tab));
  document.querySelectorAll(".tab-page").forEach((p) => { p.hidden = p.id !== `tab-${state.tab}`; });
  if (location.hash.slice(1) !== state.tab) history.replaceState(null, "", `${location.search}#${state.tab}`);
  renderAll();
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ============================================================ controls
function renderSiteSelect() {
  $("site").innerHTML = allSites().map((s) => `<option value="${esc(s.id)}" ${s.id === state.focus ? "selected" : ""}>${esc(s.name)}</option>`).join("");
}
function syncDateInputs() {
  $("land-date").value = toDate(state.start);
  $("start").value = toDT(state.start); $("end").value = toDT(state.end);
  const days = Math.round((state.end - state.start) / 1000 / DAY);
  if ([...$("length").options].some((o) => +o.value === days)) $("length").value = String(days);
}
$("site").addEventListener("change", () => { state.focus = $("site").value; state.tIdx = 0; refresh(); });
$("land-date").addEventListener("change", () => {
  if (!$("land-date").value) return;
  const len = state.end - state.start;
  state.start = new Date($("land-date").value + "T00:00:00Z");
  state.end = new Date(state.start.getTime() + len);
  state.tIdx = 0; syncDateInputs(); refresh();
});
$("length").addEventListener("change", () => {
  state.end = new Date(state.start.getTime() + +$("length").value * DAY * 1000);
  const max = new Date(state.contract.time.supportedEndUtc);
  if (state.end > max) state.end = max;
  state.tIdx = 0; syncDateInputs(); refresh();
});
$("start").addEventListener("change", () => { if ($("start").value) { state.start = new Date($("start").value + ":00Z"); state.tIdx = 0; refresh(); } });
$("end").addEventListener("change", () => { if ($("end").value) { state.end = new Date($("end").value + ":00Z"); state.tIdx = 0; refresh(); } });
$("antenna").addEventListener("change", () => {
  const v = parseFloat($("antenna").value);
  state.antenna = Number.isFinite(v) ? v : state.contract.visibility.antennaMinElevationDeg;
  refresh();
});

// ============================================================ time player
$("t").addEventListener("input", () => { state.tIdx = +$("t").value; renderMoment(); });
$("play").addEventListener("click", () => {
  state.playing = !state.playing;
  $("play").textContent = $("play3").textContent = state.playing ? "❚❚" : "▶";
  if (state.playing) requestAnimationFrame(tick);
});
let last = 0, acc = 0;
function tick(ts) {
  if (!state.playing) { last = 0; return; }
  const r = state.results.get(state.focus);
  if (last && r) {
    acc += ((ts - last) / 1000) * 3 * (DAY / state.contract.time.baseStepSeconds);   // 3 days per second
    const adv = Math.floor(acc); acc -= adv;
    if (adv) { state.tIdx = (state.tIdx + adv) % r._t.length; $("t").value = state.tIdx; renderMoment(); }
  }
  last = ts;
  requestAnimationFrame(tick);
}

// ============================================================ render: overview
function renderAll() {
  if (!state.contract) return;
  if (state.tab === "terrain") renderTerrainTab();
  if (state.tab === "overview") renderOverview();
  if (state.tab === "compare") renderCompare();
  if (state.tab === "dates") renderDates();
}

function renderOverview() {
  const r = state.results.get(state.focus);
  if (!r) return;
  renderNumbers(r);
  renderSchedule(r);
  renderMoment();
}

function untilNext(r, body) {
  const t = r._t[state.tIdx];
  const ev = r.events.find((e) => e.body === body && Date.parse(e.timeUtc) > t);
  return ev ? (Date.parse(ev.timeUtc) - t) / 1000 : null;
}

function renderMoment() {
  const r = state.results.get(state.focus);
  if (r && state.tab === "terrain") { renderTerrainTab(); return; }
  if (!r || state.tab !== "overview") return;
  const i = state.tIdx, s = r.series;
  $("t-label").textContent = `${fmtWhen(s.timesUtc[i])} · ${advanced ? "T+" : "day "}${advanced ? fmtDur((r._t[i] - r._t[0]) / 1000) : Math.floor((r._t[i] - r._t[0]) / 1000 / DAY) + 1}`;

  const sunUp = s.sunVisible[i], earthUp = s.earthVisible[i];
  const tSun = untilNext(r, "sun"), tEarth = untilNext(r, "earth");
  const later = (sec, word) => (sec == null ? `No change before the mission ends.` : `${word} in ${fmtDur(sec)}.`);
  const clearance = (b) => {
    const el = s[`${b}ElevationDeg`][i], hz = s[`${b}HorizonDeg`][i];
    return hz == null ? `el ${el.toFixed(2)}°` : `el ${el.toFixed(2)}° · horizon ${hz.toFixed(2)}° · clearance ${(el - hz >= 0 ? "+" : "") + (el - hz).toFixed(2)}°`;
  };
  $("now-sun").innerHTML = `<span class="big-icon sun ${sunUp ? "" : "off"}"></span><div>
    <div class="headline">${advanced ? `Sun: <span class="${sunUp ? "yes" : "no"}">${sunUp ? "visible" : "obstructed"}</span>` :
      sunUp ? `<span class="yes">The Sun is up</span>, so the solar panels make power` : `<span class="no">The Sun is hidden</span>, so the lander runs on batteries`}</div>
    <div class="sub">${advanced ? `${clearance("sun")} · ${sunUp ? "set" : "rise"} in ${fmtDur(tSun)}` : later(tSun, sunUp ? "Sunset" : "Sunrise")}</div></div>`;
  $("now-earth").innerHTML = `<span class="big-icon earth ${earthUp ? "" : "off"}"></span><div>
    <div class="headline">${advanced ? `DTE: <span class="${earthUp ? "yes" : "no"}">${earthUp ? "line of sight" : "blocked"}</span>` :
      earthUp ? `<span class="yes">Earth is in view</span>, so we can talk to mission control` : `<span class="no">Earth is hidden</span>, so there's no direct contact`}</div>
    <div class="sub">${advanced ? `${clearance("earth")} · ${earthUp ? "set" : "rise"} in ${fmtDur(tEarth)}` : later(tEarth, earthUp ? "Earth sets" : "Earth comes back")}</div></div>`;

  drawSky($("sky"), r);
  drawTimeline($("timeline"), [{ r, name: null }]);
}

function metric(label, value, { infoKey, bar, color, unit } = {}) {
  return `<div class="metric"><div class="label">${label}${infoKey ? info(infoKey) : ""}</div>
    <div class="value">${value}${unit ? ` <small>${unit}</small>` : ""}</div>
    ${bar != null ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, bar))}%;background:${color}"></i></div>` : ""}</div>`;
}
const compact = (label, value) => `<div class="metric compact"><div class="label">${label}</div><div class="value">${value}</div></div>`;

function renderNumbers(r) {
  const c = r.communication.summary, su = r.sun.summary, b = r.sunAndCommunication.summary, site = siteById(state.focus);
  let h = `<h2>${advanced ? "Metrics" : "The numbers"}</h2><p class="help">${esc(site.name)} · ${fmtDur((state.end - state.start) / 1000)} mission</p>`;
  h += `<div class="group-label">${advanced ? "Communication (DTE)" : "Talking to Earth"}</div>`;
  h += metric(advanced ? "DTE availability" : "Can talk to Earth", pctAdv(c.percentOfMission), { infoKey: "comm", bar: c.percentOfMission, color: EARTH, unit: advanced ? "" : "of the mission" });
  h += metric(advanced ? "Longest blackout" : "Longest time without contact", fmtDur(c.longestGapSeconds), { infoKey: "blackout" });
  h += `<div class="group-label">${advanced ? "Illumination" : "Sunlight"}</div>`;
  h += metric(advanced ? "Sun visible" : "Sunlight", pctAdv(su.percentOfMission), { infoKey: "sun", bar: su.percentOfMission, color: SUN, unit: advanced ? "" : "of the mission" });
  h += metric(advanced ? "Longest darkness" : "Longest night", fmtDur(su.longestGapSeconds), { infoKey: "dark" });
  h += `<div class="group-label">${advanced ? "Combined" : "Best working time"}</div>`;
  h += metric(advanced ? "Sun ∩ DTE" : "Sun and Earth together", pctAdv(b.percentOfMission), { infoKey: "both", bar: b.percentOfMission, color: BOTH, unit: advanced ? "" : "of the mission" });
  h += `<div class="group-label">${advanced ? "Site" : "The landing spot"}</div>`;
  h += metric(advanced ? "Surface elevation" : "Height", r.site.surfaceElevationM == null ? "—" : `${Math.round(r.site.surfaceElevationM).toLocaleString()} m`, { infoKey: "height" });
  h += compact(advanced ? "Coordinates" : "Where", where(site));
  if (advanced) {
    h += compact("DTE windows", c.windowCount);
    h += compact("Longest DTE window", fmtDur(c.longestWindowSeconds));
    h += compact("Longest Sun ∩ DTE window", fmtDur(b.longestWindowSeconds));
    h += compact("Rise/set events", `${r.events.length} (±${r.eventRefinementStepSeconds} s)`);
    h += compact("Antenna min. elevation", `${r.visibility.antennaMinElevationDeg}°`);
    h += compact("Terrain quality", `${r.site.terrainQuality}${r.site.rankable ? "" : " (unranked)"}`);
    h += compact("Elevation source", r.site.surfaceElevationMethod ?? "—");
    h += compact("Frame / step", `${r.frameId} · ${r.baseStepSeconds} s`);
    h += compact("Models", `${r.visibility.sunModel} / ${r.visibility.earthModel}`);
  }
  $("numbers").innerHTML = h;
}

function renderSchedule(r) {
  const c = r.communication;
  const spans = [...c.windows.map((w) => ({ ...w, up: true })), ...c.blackouts.map((w) => ({ ...w, up: false }))]
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  if (advanced) {
    $("schedule").innerHTML = `<table class="adv"><thead><tr><th>Period</th><th>Start (UTC)</th><th>End (UTC, excl.)</th><th>Duration</th><th>Note</th></tr></thead><tbody>
      ${spans.map((w) => `<tr><td class="${w.up ? "up" : "down"}">${w.up ? "DTE window" : "Blackout"}</td><td>${w.startUtc}</td><td>${w.endUtc}</td>
      <td>${fmtDur(w.durationSeconds)} (${w.durationSeconds} s)</td><td>${[w.truncatedAtMissionStart && "from window start", w.truncatedAtMissionEnd && "to window end"].filter(Boolean).join(", ")}</td></tr>`).join("")}
      </tbody></table>
      <p class="help">Events bracketed to ${r.eventRefinementStepSeconds} s (time = first sample in the new state). No physical timing-accuracy claim.</p>`;
    return;
  }
  $("schedule").innerHTML = `<div class="sched">${spans.map((w) => `
    <div class="sched-item"><i class="dot" style="background:${w.up ? EARTH : "#3a4152"}"></i>
      <div><div class="when">${w.up ? "Can talk to Earth" : "No contact"} · ${fmtWhen(w.startUtc)} → ${fmtWhen(w.endUtc)}</div>
      ${w.truncatedAtMissionStart ? `<div class="note">already happening when the mission starts</div>` : ""}
      ${w.truncatedAtMissionEnd ? `<div class="note">still going when the mission ends</div>` : ""}</div>
      <div class="dur">${fmtDur(w.durationSeconds)}</div></div>`).join("")}</div>`;
}

// ============================================================ sky view
function drawSky(canvas, r) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const s = r.series, i = state.tIdx, mask = r.horizon.elevationDeg, step = r.horizon.azimuthStepDeg;
  const padL = advanced ? 36 : 0, padB = 22, pw = W - padL, ph = H - padB;
  const known = mask.filter((v) => v != null);
  const lo = Math.max(-12, Math.min(-2, Math.min(...known) - 1));
  const above = (a) => a.filter((v) => v >= lo);
  const hi = Math.min(90, Math.max(2, ...above(s.sunElevationDeg), ...above(s.earthElevationDeg), ...known) + 2.5);
  const X = (az) => padL + (az / 360) * pw, Y = (el) => ((hi - el) / (hi - lo)) * ph;
  const sunUp = s.sunVisible[i];

  // black sky: the Moon has no air, so the sky is black even in daylight
  ctx.fillStyle = "#03050a"; ctx.fillRect(padL, 0, pw, ph);
  for (let k = 0; k < 70; k++) {             // a few fixed stars
    const x = padL + ((k * 9301 + 49297) % 233280) / 233280 * pw, y = ((k * 4253 + 1931) % 1000) / 1000 * ph * 0.7;
    ctx.fillStyle = `rgba(255,255,255,${0.15 + (k % 5) * 0.08})`; ctx.fillRect(x, y, 1.2, 1.2);
  }
  if (advanced) {
    ctx.font = "10px system-ui"; ctx.fillStyle = "#8d98aa"; ctx.textAlign = "right"; ctx.strokeStyle = "#151c29";
    const es = [0.5, 1, 2, 5, 10, 15, 30].find((v) => (hi - lo) / v <= 7) || 30;
    for (let e = Math.ceil(lo / es) * es; e <= hi; e += es) {
      ctx.beginPath(); ctx.moveTo(padL, Y(e)); ctx.lineTo(W, Y(e)); ctx.stroke();
      ctx.fillText(`${+e.toFixed(1)}°`, padL - 4, Y(e) + 3);
    }
  }

  const path = (az, el, vis, color, hidden) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.globalAlpha = hidden ? 0.35 : 0.85;
    ctx.setLineDash(hidden ? [3, 4] : []);
    for (let k = 1; k < az.length; k++) {
      if (Math.abs(az[k] - az[k - 1]) > 180 || vis[k] == null || vis[k] === hidden) continue;
      ctx.beginPath(); ctx.moveTo(X(az[k - 1]), Y(el[k - 1])); ctx.lineTo(X(az[k]), Y(el[k])); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.setLineDash([]);
  };
  const body = (az, el, color, label) => {
    const x = X(az), y = Y(el);
    ctx.shadowColor = color; ctx.shadowBlur = 18; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    if (!advanced) {
      ctx.font = "600 12px system-ui"; ctx.textAlign = "center"; ctx.fillStyle = color;
      ctx.fillText(label, x, Math.max(14, y - 14));
    }
  };

  ctx.save(); ctx.beginPath(); ctx.rect(padL, 0, pw, ph); ctx.clip();
  path(s.sunAzimuthDeg, s.sunElevationDeg, s.sunVisible, SUN, false);
  path(s.earthAzimuthDeg, s.earthElevationDeg, s.earthVisible, EARTH, false);
  body(s.sunAzimuthDeg[i], s.sunElevationDeg[i], SUN, "Sun");
  body(s.earthAzimuthDeg[i], s.earthElevationDeg[i], EARTH, "Earth");

  // hills drawn on top, so they hide the Sun/Earth when in front of them; lit grey when the Sun is up
  const g = ctx.createLinearGradient(0, 0, 0, ph);
  g.addColorStop(0, sunUp ? "#6b7385" : "#2d3340"); g.addColorStop(1, sunUp ? "#2b303b" : "#14171e");
  ctx.beginPath(); ctx.moveTo(padL, ph);
  for (let k = 0; k <= mask.length; k++) {
    const v = mask[k % mask.length];
    ctx.lineTo(X(k * step), Y(v == null ? lo : v));
  }
  ctx.lineTo(W, ph); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = sunUp ? "#aab3c3" : "#4a5263"; ctx.lineWidth = 1; ctx.stroke();
  path(s.sunAzimuthDeg, s.sunElevationDeg, s.sunVisible, SUN, true);
  path(s.earthAzimuthDeg, s.earthElevationDeg, s.earthVisible, EARTH, true);
  // "ghost" markers so hidden bodies are still findable
  const ghost = (az, el, color, label, vis) => {
    if (vis) return;
    const x = X(az), y = Math.min(ph - 10, Y(el));
    ctx.setLineDash([3, 3]); ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = "600 12px system-ui"; ctx.textAlign = "center"; ctx.fillStyle = color;
    ctx.fillText(advanced ? `${label} (obstructed)` : `${label} (behind hills)`, x, y - 14);
  };
  ghost(s.sunAzimuthDeg[i], s.sunElevationDeg[i], SUN, "Sun", s.sunVisible[i]);
  ghost(s.earthAzimuthDeg[i], s.earthElevationDeg[i], EARTH, "Earth", s.earthVisible[i]);
  ctx.restore();

  ctx.font = "600 11px system-ui"; ctx.fillStyle = "#8d98aa"; ctx.textAlign = "center";
  const names = advanced ? [["0°", 0], ["90°", 90], ["180°", 180], ["270°", 270], ["360°", 360]]
    : [["North", 0], ["East", 90], ["South", 180], ["West", 270], ["North", 360]];
  names.forEach(([l, az]) => ctx.fillText(l, Math.min(W - 18, Math.max(padL + 18, X(az))), H - 6));
}

// ============================================================ timeline
function drawTimeline(canvas, items) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth;
  const labelW = 150, rowH = 14, gap = 6, groupGap = items.length > 1 ? 18 : 0, top = 22;
  const groupH = (items.length > 1 ? 18 : 0) + 3 * (rowH + gap);
  const H = top + items.length * (groupH + groupGap);
  canvas.style.height = H + "px"; canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const t0 = state.start.getTime(), t1 = state.end.getTime(), pw = W - labelW - 4;
  const X = (ms) => labelW + ((ms - t0) / (t1 - t0)) * pw;
  const days = (t1 - t0) / 1000 / DAY, every = days <= 16 ? 2 : days <= 35 ? 5 : 10;
  ctx.font = "11px system-ui"; ctx.textAlign = "center";
  for (let d = 0; d <= days; d += every) {
    const x = X(t0 + d * DAY * 1000);
    ctx.fillStyle = "#8d98aa";
    ctx.textAlign = x > W - 30 ? "right" : "center";
    ctx.fillText(advanced ? new Date(t0 + d * DAY * 1000).toISOString().slice(5, 10) : `Day ${d + 1}`, x, 12);
    ctx.strokeStyle = "#1a2130"; ctx.beginPath(); ctx.moveTo(x, top - 4); ctx.lineTo(x, H); ctx.stroke();
  }
  const rowNames = advanced ? ["Sun visible", "DTE line of sight", "Sun ∩ DTE"] : ["Sunlight", "Can talk to Earth", "Both"];
  let y = top;
  for (const { r, name, color } of items) {
    if (name) {
      ctx.textAlign = "left"; ctx.font = "600 13px system-ui"; ctx.fillStyle = color || "#eef2f8";
      ctx.fillText(name, 0, y + 12); y += 18;
    }
    [[r.sun.sunlitWindows, SUN], [r.communication.windows, EARTH], [r.sunAndCommunication.windows, BOTH]].forEach(([wins, col], k) => {
      ctx.textAlign = "left"; ctx.font = "12px system-ui"; ctx.fillStyle = "#8d98aa";
      ctx.fillText(rowNames[k], 0, y + 11);
      ctx.fillStyle = "#1a2130"; roundRect(ctx, labelW, y, pw, rowH, 4);
      ctx.fillStyle = col;
      for (const w of wins) {
        const a = X(Date.parse(w.startUtc)), b = X(Date.parse(w.endUtc));
        roundRect(ctx, a, y, Math.max(2, b - a), rowH, 4);
      }
      y += rowH + gap;
    });
    y += groupGap;
  }
  const r0 = state.results.get(state.focus);
  if (r0) {
    const x = X(r0._t[state.tIdx]);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, top - 6); ctx.lineTo(x, H); ctx.stroke();
  }
  canvas._scrub = { labelW, pw, t0, t1 };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, Math.min(r, w / 2)) : ctx.rect(x, y, w, h); ctx.fill();
}
function scrubFrom(canvas, ev) {
  const g = canvas._scrub, r = state.results.get(state.focus);
  if (!g || !r) return;
  const rect = canvas.getBoundingClientRect();
  const f = (ev.clientX - rect.left - g.labelW) / g.pw;
  if (f < 0 || f > 1) return;
  const ms = g.t0 + f * (g.t1 - g.t0);
  state.tIdx = Math.max(0, Math.min(r._t.length - 1, Math.round((ms - r._t[0]) / 1000 / state.contract.time.baseStepSeconds)));
  $("t").value = state.tIdx;
  if (state.tab === "overview") renderMoment(); else renderCompare();
}
let dragging = null;
for (const id of ["timeline", "cmp-timeline"]) {
  $(id).addEventListener("mousedown", (e) => { dragging = $(id); scrubFrom(dragging, e); });
}
window.addEventListener("mousemove", (e) => { if (dragging) scrubFrom(dragging, e); });
window.addEventListener("mouseup", () => { dragging = null; });

// ============================================================ compare
function renderCompare() {
  const ids = state.compare.filter((id) => state.results.has(id));
  const rs = ids.map((id) => state.results.get(id));
  const best = (get, dir) => {
    const v = rs.filter((r) => r.site.rankable).map(get).filter((x) => x != null);
    if (v.length < 2 || new Set(v).size < 2) return null;
    return dir === "max" ? Math.max(...v) : Math.min(...v);
  };
  const rows = [
    [advanced ? "DTE availability" : "Can talk to Earth", (r) => r.communication.summary.percentOfMission, pctAdv, "max", EARTH, "comm"],
    [advanced ? "Longest blackout" : "Longest time without contact", (r) => r.communication.summary.longestGapSeconds, fmtDur, "min", null, "blackout"],
    [advanced ? "Sun visible" : "Sunlight", (r) => r.sun.summary.percentOfMission, pctAdv, "max", SUN, "sun"],
    [advanced ? "Longest darkness" : "Longest night", (r) => r.sun.summary.longestGapSeconds, fmtDur, "min", null, "dark"],
    [advanced ? "Sun ∩ DTE" : "Sun and Earth together", (r) => r.sunAndCommunication.summary.percentOfMission, pctAdv, "max", BOTH, "both"],
  ];
  const bests = rows.map(([, get, , dir]) => best(get, dir));
  $("compare-grid").innerHTML = ids.map((id, k) => {
    const r = rs[k], s = siteById(id);
    const tag = r.site.rankable ? "" : `<span class="warn-tag">${advanced ? `${r.site.terrainQuality} · unranked` : "rough map data"}</span>`;
    return `<div class="site-card"><h3><span class="swatch" style="background:${colorOf(id)}"></span>${esc(s.name)} ${tag}</h3>
      <div class="where">${where(s)}${r.site.surfaceElevationM != null ? ` · ${Math.round(r.site.surfaceElevationM).toLocaleString()} m high` : ""}</div>
      ${rows.map(([label, get, fmt, , color, infoKey], j) => {
        const v = get(r), isBest = r.site.rankable && v != null && v === bests[j];
        return `<div class="metric"><div class="label">${label}${info(infoKey)}</div>
          <div class="value">${fmt(v)}${isBest ? `<span class="best-tag">best</span>` : ""}</div>
          ${color ? `<div class="bar"><i style="width:${v ?? 0}%;background:${color}"></i></div>` : ""}</div>`;
      }).join("")}</div>`;
  }).join("");
  drawTimeline($("cmp-timeline"), ids.map((id) => ({ r: state.results.get(id), name: siteById(id).name, color: colorOf(id) })));
  renderMap();
  renderCustomList();
}

// ============================================================ map + custom sites
function latLonToMap(lat, lon) {
  const m = state.mapMeta, R = m.moon_r_m, la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  const rho = 2 * R * Math.tan(Math.PI / 4 + la / 2);
  return [((rho * Math.sin(lo) + m.half_extent_m) / (2 * m.half_extent_m)) * 1000, ((m.half_extent_m - rho * Math.cos(lo)) / (2 * m.half_extent_m)) * 1000];
}
function mapToLatLon(fx, fy) {
  const m = state.mapMeta, R = m.moon_r_m;
  const x = (fx - 0.5) * 2 * m.half_extent_m, y = (0.5 - fy) * 2 * m.half_extent_m;
  return [((2 * Math.atan(Math.hypot(x, y) / (2 * R)) - Math.PI / 2) * 180) / Math.PI, ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360];
}
function renderMap() {
  if (!state.mapMeta) return;
  const placed = [];
  const marks = allSites().filter((s) => s.lat < -80).map((s) => {
    const [x, y] = latLonToMap(s.lat, s.lon);
    if (x < 0 || x > 1000 || y < 0 || y > 1000) return "";
    let ly = y + 6;
    while (placed.some(([px, py]) => Math.abs(px - x) < 230 && Math.abs(py - ly) < 26)) ly += 26;
    placed.push([x, ly]);
    const on = state.compare.includes(s.id);
    return `<circle cx="${x}" cy="${y}" r="${on ? 10 : 7}" fill="${on ? colorOf(s.id) : "#fff"}" stroke="#000" stroke-width="2"/>
      ${ly !== y + 6 ? `<line x1="${x}" y1="${y}" x2="${x + 13}" y2="${ly - 6}" stroke="#fff" stroke-width="1.5"/>` : ""}
      <text x="${x + 15}" y="${ly}" fill="#fff" font-size="22" font-weight="600" stroke="#000" stroke-width="5" paint-order="stroke">${esc(s.name)}</text>`;
  }).join("");
  $("map-overlay").setAttribute("viewBox", "0 0 1000 1000");
  $("map-overlay").innerHTML = `<text x="500" y="34" fill="${EARTH}" font-size="24" font-weight="600" text-anchor="middle" stroke="#000" stroke-width="5" paint-order="stroke">${advanced ? "↑ 0°E" : "↑ toward Earth"}</text>
    <circle cx="500" cy="500" r="5" fill="none" stroke="#fff" stroke-width="2"/>
    <text x="490" y="520" text-anchor="end" fill="#fff" font-size="18" stroke="#000" stroke-width="4" paint-order="stroke">${advanced ? "90°S" : "South Pole"}</text>${marks}`;
}
function renderCustomList() {
  const rows = allSites().map((s) => `<div class="custom-item">
      <label><input type="checkbox" data-cmp="${esc(s.id)}" ${state.compare.includes(s.id) ? "checked" : ""}>
        <span><span class="swatch" style="background:${colorOf(s.id)}"></span> ${esc(s.name)}<br><span class="muted">${where(s)}</span></span></label>
      ${s.contract ? "" : `<button data-del="${esc(s.id)}" title="Remove">✕</button>`}</div>`).join("");
  $("custom-list").innerHTML = `<p class="help">${advanced ? `Compare up to ${MAX_COMPARE} sites.` : `Tick up to ${MAX_COMPARE} places to compare.`}</p>${rows}`;
}
$("custom-list").addEventListener("change", (e) => {
  const id = e.target.dataset.cmp; if (!id) return;
  if (e.target.checked) { if (state.compare.length >= MAX_COMPARE) state.compare.shift(); state.compare.push(id); }
  else state.compare = state.compare.filter((x) => x !== id);
  refresh();
});
$("custom-list").addEventListener("click", (e) => {
  const id = e.target.dataset?.del; if (!id) return;
  state.custom = state.custom.filter((s) => s.id !== id); save("customSitesV2", state.custom);
  state.compare = state.compare.filter((x) => x !== id);
  if (state.focus === id) state.focus = state.sites[0].id;
  renderSiteSelect(); refresh();
});
$("map-wrap").addEventListener("mousemove", (e) => {
  const r = $("map-wrap").getBoundingClientRect();
  const [lat, lon] = mapToLatLon((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  tooltip(advanced ? `${lat.toFixed(4)}°, ${lon.toFixed(4)}°E` : `${where({ lat, lon })}<br><span class="help">click to try this spot</span>`, e);
});
$("map-wrap").addEventListener("mouseleave", () => tooltip(null));
$("map-wrap").addEventListener("click", (e) => {
  const r = $("map-wrap").getBoundingClientRect();
  const [lat, lon] = mapToLatLon((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  const s = { id: `c-${Date.now()}`, name: `My spot ${state.custom.length + 1}`, lat: +lat.toFixed(4), lon: +lon.toFixed(4), contract: false };
  state.custom.push(s); save("customSitesV2", state.custom);
  if (state.compare.length >= MAX_COMPARE) state.compare.shift();
  state.compare.push(s.id);
  renderSiteSelect(); refresh();
  setStatus("Working out the hills around your spot (a few seconds the first time)…");
});

// ============================================================ best landing days + delay
function dayRow(dateStr) { return state.sweep?.days.find((d) => d.dateUtc.slice(0, 10) === dateStr && !d.missing); }

function renderDates() {
  const sw = state.sweep;
  if (!sw) return;
  if (sw.error) { $("calendar").innerHTML = `<p class="help">${esc(sw.error)}</p>`; return; }
  const metric = $("cal-metric").value, lower = metric.startsWith("longest");
  const vals = sw.days.filter((d) => !d.missing).map((d) => d[metric]).sort((a, b) => a - b);
  const q1 = vals[Math.floor(vals.length / 3)], q2 = vals[Math.floor((2 * vals.length) / 3)];
  const lo = vals[0], hi = vals[vals.length - 1];
  const levels = [["Great", BOTH], ["OK", "#e6c35c"], ["Poor", "#d9706b"]];
  const colorFor = (v) => {
    if (advanced) {
      const t = hi === lo ? 1 : (v - lo) / (hi - lo), g = lower ? 1 - t : t;
      return `hsl(${Math.round(8 + g * 140)}, 62%, ${38 + g * 14}%)`;
    }
    const rank = lower ? (v <= q1 ? 0 : v <= q2 ? 1 : 2) : (v >= q2 ? 0 : v >= q1 ? 1 : 2);
    return levels[rank][1];
  };
  const planned = toDate(state.start);
  const delayed = toDate(new Date(state.start.getTime() + state.delay * DAY * 1000));
  const byMonth = {};
  sw.days.forEach((d) => (byMonth[d.dateUtc.slice(0, 7)] ??= []).push(d));
  $("calendar").innerHTML = Object.entries(byMonth).map(([m, days]) => {
    const first = new Date(m + "-01T00:00:00Z"), lead = first.getUTCDay();
    const cells = Array(lead).fill(`<div class="cal-day empty"></div>`).concat(days.map((d) => {
      const ds = d.dateUtc.slice(0, 10), n = +ds.slice(8);
      const cls = `${ds === planned ? "sel" : ""} ${state.delay && ds === delayed ? "delayed" : ""}`;
      return d.missing ? `<div class="cal-day none">${n}</div>`
        : `<div class="cal-day ${cls}" data-d="${ds}" style="background:${colorFor(d[metric])}">${n}</div>`;
    }));
    return `<div class="cal-month"><h4>${first.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" })}</h4>
      <div class="cal-grid">${["S", "M", "T", "W", "T", "F", "S"].map((x) => `<div class="cal-dow">${x}</div>`).join("")}${cells.join("")}</div></div>`;
  }).join("");
  $("cal-legend").innerHTML = advanced
    ? `<span>${lower ? "low (better)" : "low"} <i style="background:hsl(${lower ? 148 : 8},62%,45%)"></i></span><span><i style="background:hsl(${lower ? 8 : 148},62%,45%)"></i> ${lower ? "high" : "high (better)"}</span><span>Range ${lo?.toFixed(1)} – ${hi?.toFixed(1)}</span><span>White outline = planned · dashed = delayed</span>`
    : `${levels.map(([l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")}<span>White outline = your landing day</span>`;
  renderDelay();
}

function renderDelay() {
  const max = 30;
  $("delay").max = max; $("delay").value = state.delay;
  const planned = dayRow(toDate(state.start));
  const dDate = new Date(state.start.getTime() + state.delay * DAY * 1000);
  const delayed = dayRow(toDate(dDate));
  $("delay-label").textContent = state.delay === 0 ? (advanced ? "Slip: 0 d (planned)" : "No delay (the plan)")
    : advanced ? `Slip: +${state.delay} d → land ${toDate(dDate)}` : `Delayed ${state.delay} day${state.delay > 1 ? "s" : ""} → land ${dDate.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric" })}`;
  if (!planned || !delayed) {
    $("delay-result").innerHTML = `<p class="help">${advanced ? "Slipped window falls outside the supported range." : "That delay goes past the dates this tool covers."}</p>`;
    return;
  }
  const items = [
    [advanced ? "DTE availability" : "Can talk to Earth", "commPercent", "max", "%"],
    [advanced ? "Longest blackout" : "Longest time without contact", "longestBlackoutHours", "min", "h"],
    [advanced ? "Sun visible" : "Sunlight", "sunlitPercent", "max", "%"],
    [advanced ? "Longest darkness" : "Longest night", "longestDarkHours", "min", "h"],
    [advanced ? "Sun ∩ DTE" : "Sun and Earth together", "sunAndCommPercent", "max", "%"],
  ];
  const show = (v, unit) => (unit === "%" ? pctAdv(v) : fmtDur(v * 3600));
  $("delay-result").innerHTML = items.map(([label, key, dir, unit]) => {
    const a = planned[key], b = delayed[key], diff = b - a;
    const better = dir === "max" ? diff > 0.05 : diff < -0.05, worse = dir === "max" ? diff < -0.05 : diff > 0.05;
    const cls = better ? "better" : worse ? "worse" : "same";
    const word = state.delay === 0 ? "" : better ? (advanced ? "▲" : "better") : worse ? (advanced ? "▼" : "worse") : (advanced ? "=" : "same");
    return `<div class="metric"><div class="label">${label}</div>
      <div class="value">${show(b, unit)}<span class="delta ${cls}">${state.delay ? `${word}${advanced ? ` (${diff > 0 ? "+" : ""}${unit === "%" ? diff.toFixed(1) + " pp" : diff.toFixed(1) + " h"})` : ` (was ${show(a, unit)})`}` : ""}</span></div></div>`;
  }).join("") + `<p class="help">${advanced ? `Sampled at ${state.contract.time.baseStepSeconds} s, landing 00:00 UTC.` : "Based on landing at midnight (UTC) on each day."}</p>`;
}
$("delay").addEventListener("input", () => { state.delay = +$("delay").value; renderDates(); });
$("cal-metric").addEventListener("change", renderDates);
$("calendar").addEventListener("click", (e) => {
  const d = e.target.closest("[data-d]")?.dataset.d; if (!d) return;
  const len = state.end - state.start;
  state.start = new Date(d + "T00:00:00Z"); state.end = new Date(state.start.getTime() + len);
  const max = new Date(state.contract.time.supportedEndUtc);
  if (state.end > max) state.end = max;
  state.delay = 0; state.tIdx = 0; syncDateInputs(); refresh();
});
$("calendar").addEventListener("mousemove", (e) => {
  const d = e.target.closest("[data-d]")?.dataset.d;
  const row = d && dayRow(d);
  if (!row) return tooltip(null);
  tooltip(`<b>${advanced ? d : new Date(d).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "long", day: "numeric" })}</b><br>
    ${advanced ? "DTE" : "Talk to Earth"} ${pctAdv(row.commPercent)} · ${advanced ? "Sun" : "Sunlight"} ${pctAdv(row.sunlitPercent)} · ${advanced ? "both" : "together"} ${pctAdv(row.sunAndCommPercent)}<br>
    ${advanced ? "Longest blackout" : "Longest no-contact"} ${fmtDur(row.longestBlackoutHours * 3600)}`, e);
});
$("calendar").addEventListener("mouseleave", () => tooltip(null));

// ============================================================ 3D terrain tab (Person 1 explorer)
function renderTerrainTab() {
  const frame = $("terrain-frame");
  if (!frame.src) frame.src = "/terrain.html?embed=1";
  const r = state.results.get(state.focus);
  if (!r) return;
  const i = state.tIdx, s = r.series;
  $("t3").max = r._t.length - 1; $("t3").value = i;
  $("t3-label").textContent = fmtWhen(s.timesUtc[i]);
  const word = (v, on, off) => (v == null ? "unknown" : v ? on : off);
  $("t3-status").innerHTML = `<span><i class="dot sun"></i>${advanced ? `Sun ${word(s.sunVisible[i], "visible", "obstructed")} · az ${s.sunAzimuthDeg[i].toFixed(2)}° el ${s.sunElevationDeg[i].toFixed(2)}°`
      : `Sun: ${word(s.sunVisible[i], "shining on the lander", "hidden behind hills")}`}</span>
    <span><i class="dot earth"></i>${advanced ? `Earth ${word(s.earthVisible[i], "line of sight", "blocked")} · az ${s.earthAzimuthDeg[i].toFixed(2)}° el ${s.earthElevationDeg[i].toFixed(2)}°`
      : `Earth: ${word(s.earthVisible[i], "in view, can talk", "hidden, no contact")}`}</span>`;
  postSky();
}
function postSky() {
  const frame = $("terrain-frame"), r = state.results.get(state.focus), site = siteById(state.focus);
  if (!frame.contentWindow || !r || !site?.contract) return;
  const i = state.tIdx, s = r.series;
  frame.contentWindow.postMessage({ type: "lunar-sky", siteId: site.id, timeUtc: s.timesUtc[i],
    sunEnu: s.sunEnu[i], earthEnu: s.earthEnu[i], sunVisible: s.sunVisible[i], earthVisible: s.earthVisible[i] }, location.origin);
}
$("terrain-frame").addEventListener("load", () => setTimeout(postSky, 300));
// the explorer asks for data once its scene is ready
window.addEventListener("message", (e) => { if (e.origin === location.origin && e.data?.type === "lunar-sky-ready") postSky(); });
$("t3").addEventListener("input", () => { state.tIdx = +$("t3").value; $("t").value = state.tIdx; renderTerrainTab(); });
$("play3").addEventListener("click", () => $("play").click());

// ============================================================ export, tooltips, boot
$("export").addEventListener("click", () => {
  const s = siteById(state.focus);
  const q = new URLSearchParams({ startUtc: utc(state.start), endUtc: utc(state.end), antennaMinElevationDeg: state.antenna });
  if (s.contract) { window.location.href = `/api/export/${encodeURIComponent(s.id)}?${q}`; return; }
  const { _t, ...clean } = state.results.get(s.id);
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([JSON.stringify(clean)], { type: "application/json" })),
    download: `custom_${s.lat}_${s.lon}_${toDate(state.start)}.json` });
  a.click();
});

function tooltip(html, ev) {
  const t = $("tooltip");
  if (!html) { t.style.display = "none"; return; }
  t.innerHTML = html; t.style.display = "block";
  t.style.left = Math.min(window.innerWidth - t.offsetWidth - 10, ev.clientX + 14) + "px";
  t.style.top = ev.clientY + 16 + "px";
}
document.addEventListener("mouseover", (e) => {
  const k = e.target.closest?.("[data-info]")?.dataset.info;
  if (k) tooltip(esc(I(k)), e);
});
document.addEventListener("mouseout", (e) => { if (e.target.closest?.("[data-info]")) tooltip(null); });
window.addEventListener("resize", renderAll);

(async function init() {
  try {
    [state.contract, state.mapMeta] = await Promise.all([api("contract"), api("polar_map/meta")]);
  } catch (e) { setStatus(`Can't reach the server: ${e.message}`, true); return; }
  const c = state.contract;
  const qp = new URLSearchParams(location.search).get("advanced");
  advanced = qp != null ? qp === "1" : !!load("advancedMode", false);
  $("advanced").checked = advanced; document.body.classList.toggle("advanced", advanced);
  state.sites = c.sites.map((s) => ({ id: s.siteId, name: s.displayName, lat: s.latitudeDeg, lon: s.longitudeEastDeg, contract: true }));
  state.focus = state.sites[0].id;
  state.compare = state.sites.map((s) => s.id).slice(0, MAX_COMPARE);
  state.start = new Date(c.time.defaultStartUtc); state.end = new Date(c.time.defaultEndUtc);
  state.antenna = c.visibility.antennaMinElevationDeg;
  for (const id of ["start", "end"]) { $(id).min = toDT(new Date(c.time.supportedStartUtc)); $(id).max = toDT(new Date(c.time.supportedEndUtc)); }
  $("land-date").min = toDate(new Date(c.time.supportedStartUtc));
  $("land-date").max = toDate(new Date(new Date(c.time.supportedEndUtc).getTime() - DAY * 1000));
  $("antenna").value = state.antenna;
  applyText(); renderSiteSelect(); syncDateInputs();
  showTab(location.hash.slice(1));
  refresh();
})();
