// NoCoast dashboard: one working screen. Settings on the left, the lander's-eye 3D scene in the middle,
// and a results drawer underneath (time strip + every site compared side by side, or a landing-day grid).
// Science: Person 2 backend (/api). Power: Person 3 P0 model + mission/battery model (Alex's defaults).
import { createSkyView } from "./sky3d.js";
import { apiUrl } from "../apiBase.ts";
import { resultCsv, MODEL_ID } from "../power/model.mjs";
import { DEFAULT_MISSION_SETTINGS } from "../power/mission.ts";
import { simulateStay, missionVerdict, assertSolarContext } from "../power/stay.ts";
import { createRequestQueue } from "./requests.mjs";
import { timelineFromWindows } from "../science/assessment.ts";
import { downloadCard } from "./card.js";
import { gameScore, scoreGrade, scoreTip } from "./game.js";
import { findSite, SITE_CATALOG } from "../scenario/catalog.ts";
import {
  applyLandingScenario, bootLandingNavigator, ensureLandingTerrain, isLandingSync, setLandingSun, subscribeLandingAssessment, subscribeLandingScenario,
} from "../app.ts";

const DAY = 86400;
const GRID_DAYS = 35;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } }

// ============================================================ state
const D = DEFAULT_MISSION_SETTINGS;
const NEEDS_DEFAULT = { loadW: 40, ...D.battery, ...D.requirements };   // Person 3 team defaults
const PANEL_DEFAULT = { areaM2: 2, efficiency: 0.28, tiltDeg: 90, face: "auto" };
const state = {
  contract: null, sites: [], focus: null, custom: load("customSitesV3", []), view: "site", pane: "site",
  start: null, end: null, antenna: 0,
  results: new Map(), power: new Map(), mission: new Map(), faceDeg: new Map(),
  tIdx: 0, playing: false, mode: "check", loading: true,
  days: new Map(), dayRun: 0,
  needs: { ...NEEDS_DEFAULT, ...load("needsV2", {}) },
  panel: { ...PANEL_DEFAULT, ...load("panelV2", {}) },
  relay: { on: true, sats: 3, ...load("relayV1", {}) },
};
let advanced = false;

// ============================================================ formatting
const utc = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const toDT = (d) => d.toISOString().slice(0, 16);
const toDate = (d) => d.toISOString().slice(0, 10);
function fmtDur(sec) {
  if (sec == null) return "—";
  if (advanced) { const h = sec / 3600; return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`; }
  const d = Math.floor(sec / DAY), h = Math.floor((sec % DAY) / 3600), m = Math.round((sec % 3600) / 60);
  if (d) return `${d} d${h ? ` ${h} h` : ""}`;
  if (h) return `${h} h${m ? ` ${m} m` : ""}`;
  return `${m} min`;
}
const fmtWhen = (ms) => advanced ? utc(new Date(ms)).replace("T", " ").replace("Z", " UTC")
  : new Date(ms).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";
const pct = (f, dp = 0) => (f == null ? "—" : `${(f * 100).toFixed(advanced ? 1 : dp)}%`);
const fmtW = (w) => (w == null ? "—" : w < 10 ? `${w.toFixed(1)} W` : `${Math.round(w).toLocaleString()} W`);
const fmtWh = (wh) => (wh == null ? "—" : wh >= 1000 ? `${(wh / 1000).toFixed(1)} kWh` : `${Math.round(wh)} Wh`);
const kmFromPole = (s) => ((90 - Math.abs(s.lat)) * Math.PI / 180) * 1737.4;
const where = (s) => advanced ? `${s.lat.toFixed(4)}°, ${s.lon.toFixed(4)}°E` : `${kmFromPole(s).toFixed(1)} km from the pole`;
const dayOf = (ms) => Math.floor((ms - state.start.getTime()) / 1000 / DAY) + 1;

// ============================================================ api
// The hosted backend is one small container shared with the Navigator; a burst of heavy analysis
// calls makes it run out of memory and restart. Keep at most two requests in flight.
const slot = createRequestQueue(2);
async function api(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  return slot(async () => {
    const r = await fetch(apiUrl(`api/${path}${q ? "?" + q : ""}`));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  });
}
const memo = new Map();
function cached(key, fn) {
  const hit = memo.get(key);
  if (hit) { memo.delete(key); memo.set(key, hit); return hit; }
  const pending = fn().catch((error) => { if (memo.get(key) === pending) memo.delete(key); throw error; });
  memo.set(key, pending);
  if (memo.size > 32) memo.delete(memo.keys().next().value);
  return pending;
}
const allSites = () => [...state.sites, ...state.custom, ...(state.mapSpot ? [state.mapSpot] : [])];
const siteById = (id) => allSites().find((s) => s.id === id);
function analyze(s, start, end, cacheResult = true) {
  const query = { latitudeDeg: s.lat, longitudeEastDeg: s.lon, startUtc: utc(start), endUtc: utc(end),
    antennaMinElevationDeg: state.antenna, relay: state.relay.on, relaySats: state.relay.sats };
  const request = () => api("analyze", query).then((r) => ({ ...r, _t: r.series.timesUtc.map(Date.parse) }));
  return cacheResult ? cached(JSON.stringify(query), request) : request();
}
const NO_POWER = "Solar power is unavailable here because matching terrain or Sun data is missing.";

function setStatus(msg, kind = "") { $("status").textContent = msg; $("status").dataset.kind = kind; }

// ============================================================ power + mission (Person 3 models)
function sunAverageBearing(input) {      // circular mean of the Sun's azimuth while it is visible
  let x = 0, y = 0;
  for (const s of input.samples) if (s.solarVisibleFraction && Number.isFinite(s.sun.azimuthDeg)) { x += Math.sin(s.sun.azimuthDeg * Math.PI / 180); y += Math.cos(s.sun.azimuthDeg * Math.PI / 180); }
  if (!x && !y) for (const s of input.samples) if (Number.isFinite(s.sun.azimuthDeg)) { x += Math.sin(s.sun.azimuthDeg * Math.PI / 180); y += Math.cos(s.sun.azimuthDeg * Math.PI / 180); }
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}
function panelFor(input) {
  const p = state.panel, az = p.face === "auto" ? sunAverageBearing(input) : +p.face;
  return { panel: { areaM2: p.areaM2, efficiency: p.efficiency, tiltDeg: p.tiltDeg, azimuthDeg: Math.min(359.999, az), referenceIrradianceWm2: 1361 }, az };
}
function missionSettings() {
  const n = state.needs;
  return {
    battery: { capacityWh: n.capacityWh, initialSocFraction: n.initialSocFraction, reserveSocFraction: n.reserveSocFraction,
      chargeEfficiency: n.chargeEfficiency, dischargeEfficiency: n.dischargeEfficiency, maxChargeW: n.maxChargeW, maxDischargeW: n.maxDischargeW },
    requirements: { minPowerAvailabilityFraction: n.minPowerAvailabilityFraction, minCommsAvailabilityFraction: n.minCommsAvailabilityFraction,
      maxCommsBlackoutHours: n.maxCommsBlackoutHours },
  };
}
// Earth line-of-sight timeline from the backend's exact windows (unknown stays unknown, never assumed).
function commsTimeline(r, start, end) {
  const comm = state.relay.on && r.commsEffective ? r.commsEffective : r.communication;
  return timelineFromWindows(utc(start), (end - start) / 1000, comm.windows, comm.blackouts, comm.unknown);
}

function runMission(input, comms) {
  const { panel, az } = panelFor(input);
  const { power: p, mission: m } = simulateStay(input, panel, state.needs.loadW, missionSettings(), comms ?? []);
  return { p, m, az };
}

// Every view judges the exact shared mission artifact, including terrain qualification.
function verdictFor(id) { return missionVerdict(state.mission.get(id)?.error ? null : state.mission.get(id)); }
const VERDICT = { go: "GO", caution: "CAUTION", nogo: "NO-GO", unknown: "CAN'T TELL", preliminary: "PRELIMINARY" };
const vbadge = (v) => `<span class="v v-${v}">${VERDICT[v]}</span>`;

// ============================================================ refresh
let refreshRun = 0;
async function refresh() {
  if (!state.contract) { renderAll(); return; }
  const run = ++refreshRun;
  state.dayRun++;
  const c = state.contract.time;
  state.results.clear(); state.power.clear(); state.mission.clear(); inputs.clear();
  state.loading = false; state.fresh = new Set();
  const invalid = (message) => { renderAll(); setStatus(message, "err"); };
  if (!(state.start < state.end)) return invalid("The end must be after the start.");
  if (state.start < new Date(c.supportedStartUtc) || state.end > new Date(c.supportedEndUtc)) return invalid("Dates must fall within 2027 (the data range).");
  if ((state.end - state.start) / 1000 > c.maxMissionDurationSeconds) return invalid("A stay can be at most 60 days.");
  state.loading = true; state.fresh = new Set(); setStatus("Calculating…", "busy"); renderAll();
  const start = state.start, end = state.end;
  const stale = () => run !== refreshRun;
  const load = async (s) => {
    const r = await analyze(s, start, end);
    const input = r.solarInput ?? { error: r.solarInputUnavailableReason || NO_POWER };
    if (stale()) return;
    state.results.set(s.id, r);
    computeMission(s.id, input);
    state.fresh.add(s.id);
  };
  const show = () => {
    const r = state.results.get(state.focus);
    if (r) state.tIdx = Math.min(state.tIdx, r._t.length - 1);
    renderAll();
  };
  try {
    // The site in view first, so its verdict appears without waiting for the comparison.
    const focus = allSites().find((s) => s.id === state.focus);
    if (focus) { await load(focus); if (stale()) return; show(); setStatus("Comparing other sites…", "busy"); }
    await Promise.all(allSites().filter((s) => s !== focus).map(load));
    if (stale()) return;
    state.loading = false; setStatus("");
    show();
  } catch (e) { if (stale()) return; state.loading = false; setStatus(`Couldn't calculate: ${e.message}`, "err"); renderResults(); }
  if (state.mode === "days") refreshDays();
}
const inputs = new Map();
function computeMission(id, input) {
  if (input) inputs.set(id, input);
  input = inputs.get(id);
  const r = state.results.get(id);
  if (!input || input.error || !r) {
    state.mission.set(id, { error: input?.error || "Power model unavailable for this site." }); state.power.delete(id); return;
  }
  try {
    const site = siteById(id);
    assertSolarContext(input, { latitudeDeg: site.lat, longitudeEastDeg: site.lon,
      surfaceElevationM: r.site.surfaceElevationM, startUtc: utc(state.start), endUtc: utc(state.end) });
    const { p, m, az } = runMission(input, commsTimeline(r, state.start, state.end));
    p._t = p.samples.map((x) => Date.parse(x.timeUtc));
    state.power.set(id, p); state.mission.set(id, m); state.faceDeg.set(id, az);
  } catch (e) { state.mission.set(id, { error: e.message }); state.power.delete(id); }
}
function recomputeAll() {
  for (const s of allSites()) computeMission(s.id);
  recomputeDays(); renderAll();
}

// ============================================================ landing-day grid
function gridStart() {
  const d = new Date(state.start); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(1);
  return d;
}
async function refreshDays() {
  const run = ++state.dayRun, first = gridStart(), stay = state.end - state.start;
  const last = new Date(state.contract.time.supportedEndUtc).getTime() - stay;
  const dates = [...Array(GRID_DAYS)].map((_, k) => new Date(first.getTime() + k * DAY * 1000)).filter((d) => d.getTime() <= last);
  for (const s of allSites()) {
    const row = { dates, sweep: null, inputs: new Map(), stay };
    state.days.set(s.id, row);
    api("sweep", { latitudeDeg: s.lat, longitudeEastDeg: s.lon, firstDayUtc: utc(first), sweepDays: dates.length,
      missionSeconds: stay / 1000, antennaMinElevationDeg: state.antenna, relay: state.relay.on, relaySats: state.relay.sats })
      .then((sw) => { if (run === state.dayRun) { row.sweep = sw; recomputeDays(); renderResults(); } })
      .catch((e) => { if (run === state.dayRun) { row.error = e.message; renderResults(); } });
  }
  recomputeDays(); renderResults();
  const jobs = dates.flatMap((d) => allSites().map((s) => [s, d]));   // Every catalog site and selected custom point uses its own geometry.
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && run === state.dayRun) {
      const [s, d] = jobs[next++];
      try {
        const result = await analyze(s, d, new Date(d.getTime() + stay), false);
        const input = result.solarInput ?? { error: result.solarInputUnavailableReason || NO_POWER };
        if (run !== state.dayRun) return;
        if (!input.error) assertSolarContext(input, { latitudeDeg: s.lat, longitudeEastDeg: s.lon,
          surfaceElevationM: result.site.surfaceElevationM, startUtc: utc(d), endUtc: utc(new Date(d.getTime() + stay)) });
        state.days.get(s.id).inputs.set(toDate(d), { input, result: { communication: result.communication, commsEffective: result.commsEffective } });
      } catch (e) { if (run === state.dayRun) state.days.get(s.id).inputs.set(toDate(d), { error: e.message }); }
      recomputeDays(s.id, toDate(d)); scheduleRender();
    }
  };
  await Promise.all([...Array(6)].map(worker));
}
let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderResults(); }); } }
function recomputeDays(onlyId, onlyDate) {
  for (const [id, row] of state.days) {
    if (onlyId && id !== onlyId) continue;
    row.cells ??= new Map();
    for (const d of row.dates) {
      const ds = toDate(d);
      if (onlyDate && ds !== onlyDate) continue;
      const sw = row.sweep?.days.find((x) => x.dateUtc.slice(0, 10) === ds);
      const entry = row.inputs.get(ds), input = entry?.input;
      let m = null;
      if (input && !input.error) { try { m = runMission(input, commsTimeline(entry.result, d, new Date(d.getTime() + row.stay))).m; } catch { m = null; } }
      const verdict = m ? missionVerdict(m) : entry ? "unknown" : "pending";
      row.cells.set(ds, { verdict, sw });
    }
  }
}

// ============================================================ settings panels
function numberField(id, label, value, { min, max, step = 1, unit = "" } = {}) {
  return `<label class="field">${label}<span class="num"><input id="${id}" type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}" value="${value}">${unit ? `<i>${unit}</i>` : ""}</span></label>`;
}
function renderNeedsBox() {
  const n = state.needs, P = (f) => +(f * 100).toFixed(2);
  const isDefault = Object.keys(NEEDS_DEFAULT).every((k) => n[k] === NEEDS_DEFAULT[k]);
  $("needs-box").innerHTML = `<h2>Lander needs ${isDefault ? `<span class="tag">team defaults</span>` : `<button class="link" id="n-reset">Reset to team defaults</button>`}</h2>
    <div class="pair">
      ${numberField("n-load", advanced ? "Constant load" : "Equipment power", n.loadW, { min: 0, max: 100000, step: 5, unit: "W" })}
      ${numberField("n-cap", advanced ? "Battery capacity" : "Battery size", n.capacityWh, { min: 0, max: 1e7, step: 100, unit: "Wh" })}
      ${numberField("n-comms", advanced ? "Min. DTE availability" : "Earth contact at least", P(n.minCommsAvailabilityFraction), { min: 0, max: 100, step: 5, unit: "%" })}
      ${numberField("n-gap", advanced ? "Max. DTE blackout" : "Longest silence allowed", n.maxCommsBlackoutHours, { min: 0, max: 1440, step: 1, unit: "h" })}
    </div>
    <div class="adv-only pair">
      ${numberField("n-power", "Min. power availability", P(n.minPowerAvailabilityFraction), { min: 0.01, max: 100, step: 1, unit: "%" })}
      ${numberField("n-init", "Initial charge", P(n.initialSocFraction), { min: 0, max: 100, step: 5, unit: "%" })}
      ${numberField("n-res", "Reserve cutoff", P(n.reserveSocFraction), { min: 0, max: 100, step: 5, unit: "%" })}
      ${numberField("n-ceff", "Charge efficiency", P(n.chargeEfficiency), { min: 0.01, max: 100, step: 1, unit: "%" })}
      ${numberField("n-deff", "Discharge efficiency", P(n.dischargeEfficiency), { min: 0.01, max: 100, step: 1, unit: "%" })}
      ${numberField("n-maxc", "Max. charge", n.maxChargeW, { min: 0, max: 1e7, step: 50, unit: "W" })}
      ${numberField("n-maxd", "Max. discharge", n.maxDischargeW, { min: 0, max: 1e7, step: 50, unit: "W" })}
    </div>`;
  const map = { "n-load": ["loadW", 1], "n-cap": ["capacityWh", 1], "n-comms": ["minCommsAvailabilityFraction", 100], "n-gap": ["maxCommsBlackoutHours", 1],
    "n-power": ["minPowerAvailabilityFraction", 100], "n-init": ["initialSocFraction", 100], "n-res": ["reserveSocFraction", 100],
    "n-ceff": ["chargeEfficiency", 100], "n-deff": ["dischargeEfficiency", 100], "n-maxc": ["maxChargeW", 1], "n-maxd": ["maxDischargeW", 1] };
  for (const [id, [key, div]] of Object.entries(map)) {
    $(id).addEventListener("change", () => {
      const el = $(id), v = parseFloat(el.value), lo = +el.min, hi = +el.max;
      const ok = Number.isFinite(v) && v >= lo && v <= hi && (key !== "initialSocFraction" || v / 100 >= state.needs.reserveSocFraction)
        && (key !== "reserveSocFraction" || v / 100 <= state.needs.initialSocFraction);
      el.setAttribute("aria-invalid", String(!ok));
      if (!ok) { setStatus(key === "initialSocFraction" || key === "reserveSocFraction" ? "Initial charge must be at or above the reserve." : `Use a value from ${lo} to ${hi}.`, "err"); return; }
      setStatus("");
      state.needs = { ...state.needs, [key]: v / div }; save("needsV2", state.needs);
      renderNeedsBox(); recomputeAll();
    });
  }
  $("n-reset")?.addEventListener("click", () => { state.needs = { ...NEEDS_DEFAULT }; save("needsV2", state.needs); renderNeedsBox(); recomputeAll(); });
}
const COMPASS8 = [["North", 0], ["North-east", 45], ["East", 90], ["South-east", 135], ["South", 180], ["South-west", 225], ["West", 270], ["North-west", 315]];
function renderPanelBox() {
  const p = state.panel;
  const opt = (list, cur) => list.map(([l, v]) => `<option value="${v}" ${String(v) === String(cur) ? "selected" : ""}>${l}</option>`).join("")
    + (list.some(([, v]) => String(v) === String(cur)) ? "" : `<option value="${cur}" selected>${cur}°</option>`);
  const az = state.faceDeg.get(state.focus);
  $("panel-box").innerHTML = `<h2>Solar panel</h2>
    <div class="pair">
      ${numberField("p-area", "Size", p.areaM2, { min: 0.1, max: 1000, step: 0.1, unit: "m²" })}
      ${numberField("p-eff", "Efficiency", +(p.efficiency * 100).toFixed(1), { min: 1, max: 100, step: 1, unit: "%" })}
      <label class="field">Tilt${advanced ? `<span class="num"><input id="p-tilt" type="number" min="0" max="180" step="1" value="${p.tiltDeg}"><i>°</i></span>`
        : `<select id="p-tilt">${opt([["Lying flat", 0], ["Leaning 45°", 45], ["Standing up", 90]], p.tiltDeg)}</select>`}</label>
      <label class="field">Faces<select id="p-face">${opt([["Fixed mean Sun bearing", "auto"], ...COMPASS8], p.face)}</select></label>
    </div>
    ${p.face === "auto" && az != null ? `<p class="hint">Fixed, pointed at the Sun's average bearing for this stay (${Math.round(az)}°${advanced ? " true" : ""}).</p>` : ""}`;
  const commit = () => {
    const area = parseFloat($("p-area").value), eff = parseFloat($("p-eff").value), tilt = parseFloat($("p-tilt").value), face = $("p-face").value;
    if (!(area >= 0.1 && area <= 1000) || !(eff >= 1 && eff <= 100) || !(tilt >= 0 && tilt <= 180)) { setStatus("Check the panel numbers.", "err"); return; }
    setStatus(""); state.panel = { areaM2: area, efficiency: eff / 100, tiltDeg: tilt, face }; save("panelV2", state.panel);
    recomputeAll(); renderPanelBox();
  };
  for (const id of ["p-area", "p-eff", "p-tilt", "p-face"]) $(id).addEventListener("change", commit);
}
function renderSources() {
  $("sources-line").innerHTML = advanced
    ? `Terrain: NASA LOLA LDEM 80 m/240 m + PGDA 5 m · Ephemeris: JPL DE421, MOON_ME frame · Power: ${MODEL_ID} + dc-bus-linear-pv-constant-load-v1`
    : "Terrain from NASA LOLA · Sun and Earth positions from NASA JPL · Power and battery from the team's model";
}

// ============================================================ 3D scene + "right now" readout
let sky3d = null;
function drawScene(r) {
  if (!sky3d) {
    try { sky3d = createSkyView($("sky3d")); }
    catch { $("sky3d").innerHTML = `<p class="scene-empty">This browser can't show 3D (WebGL is off). The results below still work.</p>`; sky3d = false; }
  }
  if (!sky3d) return;
  sky3d.setTexts({ sun: "Sun", earth: "Earth", sunHidden: "Sun (behind terrain)", earthHidden: "Earth (behind terrain)", lander: "Lander",
    compass: advanced ? [["0°", 0], ["90°", 90], ["180°", 180], ["270°", 270]] : [["N", 0], ["E", 90], ["S", 180], ["W", 270]] });
  const site = siteById(state.focus);
  if (!site) return;
  sky3d.setSite(site).catch(error => setStatus(`Terrain unavailable: ${error.message}`, "err"));
  sky3d.setResult(r);
  if (r) sky3d.setTime(Math.min(state.tIdx, r._t.length-1));
}
$("find-earth").addEventListener("click", () => { if (sky3d) { setView("site"); sky3d.aim("earth"); } });
$("find-sun").addEventListener("click", () => { if (sky3d) { setView("site"); sky3d.aim("sun"); } });
$("reset-view").addEventListener("click", () => sky3d?.resetView());

// Both viewpoints use the same scene and the same site/time data.
function setView(v) {
  state.view = v === "terrain" ? "terrain" : "site";
  document.querySelectorAll("#view-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  document.querySelector(".scene-hint").textContent = state.view === "terrain"
    ? "Drag to orbit · Middle-drag to pan · Scroll to zoom"
    : "Drag to look around · Scroll to zoom";
  if (sky3d) sky3d.setMode(state.view === "terrain" ? "bird" : "lander");
}
document.querySelectorAll("#view-seg button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
function paintLandingSun(r) {
  if (!r) return;
  const s = r.series, i = state.tIdx;
  const az = s.sunAzimuthDeg?.[i], el = s.sunElevationDeg?.[i];
  setLandingSun(Number.isFinite(az) ? az : null, Number.isFinite(el) ? el : 0);
}

// ============================================================ map + custom spots
const MAX_CUSTOM = 4;
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
  if (!state.mapMeta || $("map-panel").hidden) return;
  const marks = allSites().map((s) => {
    const [x, y] = latLonToMap(s.lat, s.lon);
    if (x < 0 || x > 1000 || y < 0 || y > 1000) return "";
    const on = s.id === state.focus;
    return `<g class="mk${on ? " on" : ""}"><circle cx="${x}" cy="${y}" r="${on ? 16 : 12}"/>
      <text x="${x + 24}" y="${y + 13}">${esc(s.name)}</text></g>`;
  }).join("");
  $("map-overlay").innerHTML = `<text class="north" x="500" y="50" text-anchor="middle">${advanced ? "↑ 0°E" : "↑ toward Earth"}</text>
    <circle cx="500" cy="500" r="7" class="pole"/><text class="north" x="515" y="550">${advanced ? "90°S" : "South Pole"}</text>${marks}`;
  $("map-count").textContent = `${state.custom.length} of ${MAX_CUSTOM} custom spots`;
}
function addSpot(lat, lon, saveSpot = true) {
  if (!(lat >= -90 && lat <= -75) || !(lon >= -360 && lon <= 360)) { setStatus("Use a latitude from -90 to -75 (the terrain data covers the south polar region).", "err"); return; }
  if (saveSpot && state.custom.length >= MAX_CUSTOM) { setStatus(`You can keep ${MAX_CUSTOM} custom spots. Remove one from the table first.`, "err"); return; }
  const n = state.custom.length ? Math.max(...state.custom.map((s) => +s.name.replace(/\D+/g, "") || 0)) + 1 : 1;
  const s = { id: saveSpot ? `c-${Date.now()}` : "map-spot", name: saveSpot ? `Spot ${n}` : "Map selection",
    lat: +lat.toFixed(4), lon: +(((lon % 360) + 360) % 360).toFixed(4), custom: true };
  if (saveSpot) { state.custom.push(s); save("customSitesV3", state.custom); }
  else {
    state.mapSpot = s;
    for (const cache of [state.results,state.power,state.mission,inputs]) cache.delete(s.id);
  }
  state.focus = s.id; state.days.clear(); state.dayRun++;
  syncInputs(); renderMap(); drawScene(null); refresh();
  setStatus("Working out the hills around your spot (a few seconds the first time)…", "busy");
}
function removeSpot(id) {
  state.custom = state.custom.filter((s) => s.id !== id); save("customSitesV3", state.custom);
  for (const m of [state.results, state.power, state.mission, state.days]) m.delete(id);
  if (state.focus === id) state.focus = state.sites[0].id;
  syncInputs(); renderMap(); renderAll();
}
$("map-toggle").addEventListener("click", () => {
  const open = $("map-panel").hidden;
  $("map-panel").hidden = !open; $("map-toggle").setAttribute("aria-expanded", String(open));
  if (open) renderMap();
});
$("map-close").addEventListener("click", () => $("map-toggle").click());
const mapView = { scale: 1, x: 0, y: 0 };
const mapWrap = $("map-wrap");
function updateMapTransform() {
  const limit = 1-mapView.scale;
  mapView.x = Math.min(0, Math.max(limit, mapView.x));
  mapView.y = Math.min(0, Math.max(limit, mapView.y));
  $("map-content").style.transform = `translate(${mapView.x*100}%, ${mapView.y*100}%) scale(${mapView.scale})`;
  $("map-out").disabled = mapView.scale === 1;
  $("map-in").disabled = mapView.scale === 8;
}
function zoomMap(factor, x = .5, y = .5) {
  const next = Math.min(8, Math.max(1, mapView.scale*factor));
  const ratio = next/mapView.scale;
  mapView.x = x-(x-mapView.x)*ratio;
  mapView.y = y-(y-mapView.y)*ratio;
  mapView.scale = next;
  updateMapTransform();
}
$("map-out").onclick = () => zoomMap(1/1.5);
$("map-in").onclick = () => zoomMap(1.5);
$("map-reset").onclick = () => { Object.assign(mapView,{scale:1,x:0,y:0}); updateMapTransform(); };
updateMapTransform();
mapWrap.addEventListener("wheel", event => {
  event.preventDefault();
  const bounds = mapWrap.getBoundingClientRect();
  zoomMap(Math.exp(-event.deltaY*.002),(event.clientX-bounds.left)/bounds.width,(event.clientY-bounds.top)/bounds.height);
}, {passive:false});
let mapDrag;
mapWrap.addEventListener("pointerdown", event => {
  if (event.button !== 0 || !event.isPrimary) return;
  mapDrag = {id:event.pointerId,x:event.clientX,y:event.clientY,offsetX:mapView.x,offsetY:mapView.y,moved:false};
  mapWrap.setPointerCapture(event.pointerId);
});
mapWrap.addEventListener("pointermove", event => {
  if (mapDrag?.id !== event.pointerId) return;
  const dx = event.clientX-mapDrag.x, dy = event.clientY-mapDrag.y;
  mapDrag.moved ||= Math.hypot(dx,dy)>5;
  if (!mapDrag.moved) return;
  const bounds = mapWrap.getBoundingClientRect();
  mapView.x = mapDrag.offsetX+dx/bounds.width;
  mapView.y = mapDrag.offsetY+dy/bounds.height;
  updateMapTransform();
});
mapWrap.addEventListener("pointercancel", () => {mapDrag = undefined;});
mapWrap.addEventListener("pointerup", event => {
  if (mapDrag?.id !== event.pointerId) return;
  const moved = mapDrag.moved;
  mapDrag = undefined;
  if (moved || !state.mapMeta) return;
  const bounds = $("map-content").getBoundingClientRect();
  const x = (event.clientX-bounds.left)/bounds.width, y = (event.clientY-bounds.top)/bounds.height;
  const nearest = allSites().map(site => {
    const [sx,sy] = latLonToMap(site.lat,site.lon);
    return {site, distance:Math.hypot((sx/1000-x)*bounds.width,(sy/1000-y)*bounds.height)};
  }).sort((a,b)=>a.distance-b.distance)[0];
  if (nearest?.distance < 14) selectSite(nearest.site.id);
  else addSpot(...mapToLatLon(x,y),false);
});
$("coord-form").addEventListener("submit", (e) => {
  e.preventDefault();
  addSpot(parseFloat($("c-lat").value), parseFloat($("c-lon").value));
});

function untilNext(r, body) {
  const t = r._t[state.tIdx];
  const ev = r.events.find((e) => e.body === body && Date.parse(e.timeUtc) > t);
  return ev ? (Date.parse(ev.timeUtc) - t) / 1000 : null;
}
function batteryAt(m, ms) {
  if (!m?.segments || state.needs.capacityWh === 0) return null;
  const off = (ms - state.start.getTime()) / 1000;
  const seg = m.segments.find((s) => s.startOffsetSeconds <= off && off < s.endOffsetSeconds) ?? m.segments.at(-1);
  if (seg?.batteryStartWh == null || seg.batteryEndWh == null) return null;
  const f = (off - seg.startOffsetSeconds) / (seg.endOffsetSeconds - seg.startOffsetSeconds);
  return (seg.batteryStartWh + (seg.batteryEndWh - seg.batteryStartWh) * Math.max(0, Math.min(1, f))) / state.needs.capacityWh;
}
function powerAt(p, ms) {
  if (!p?._t || ms < p._t[0]) return null;
  let lo = 0, hi = p._t.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (p._t[mid] <= ms) lo = mid; else hi = mid - 1; }
  return p.samples[lo];
}
function renderNow() {
  const r = state.results.get(state.focus);
  if (r) state.tIdx = Math.min(state.tIdx, r._t.length - 1);
  if (!r) {
    drawScene(null);
    $("scene-now").textContent = state.loading ? "Calculating…" : "No current result.";
    $("t-label").textContent = "";
    const strip = $("strip"); strip.getContext("2d").clearRect(0, 0, strip.width, strip.height);
    pushLanding();
    return;
  }
  const i = state.tIdx, s = r.series, ms = r._t[i];
  $("t-label").innerHTML = `<b>Day ${dayOf(ms)}</b> ${fmtWhen(ms)}`;
  const line = (body, up, name) => {
    const el = s[`${body}ElevationDeg`][i], hz = s[`${body}HorizonDeg`][i], next = untilNext(r, body);
    const state_ = up == null ? "unknown" : up ? (body === "sun" ? "up" : "in view") : "behind terrain";
    const when = next == null ? "no change before the stay ends" : `${up ? (body === "sun" ? "sets" : "sets") : "back"} in ${fmtDur(next)}`;
    const extra = advanced ? ` · el ${el.toFixed(2)}°${hz == null ? "" : ` · horizon ${hz.toFixed(2)}°`} · az ${s[`${body}AzimuthDeg`][i].toFixed(1)}°`
      : up ? ` · ${el.toFixed(1)}° above level` : "";
    return `<div class="now ${up ? "on" : "off"}">${icon(body)}<b>${name} ${state_}</b><span>${extra} · ${when}</span></div>`;
  };
  const p = state.power.get(state.focus), s0 = powerAt(p, ms), bat = batteryAt(state.mission.get(state.focus), ms);
  const pw = s0?.powerW == null ? `<div class="now pw"><b>Panel output unknown</b></div>` : `<div class="now pw"><b>Panel ${fmtW(s0.powerW)}</b><span>${bat == null ? "" : `battery ${Math.round(bat * 100)}%`}${
    s0.solarVisibleFraction && s0.powerW === 0 ? " · Sun is behind the panel" : ""}</span></div>`;
  $("scene-now").innerHTML = line("sun", s.sunVisible[i], "Sun") + line("earth", s.earthVisible[i], "Earth") + pw;
  drawScene(r);
  drawStrip();
  pushLanding();
}

// ============================================================ time strip (sunlight / Earth contact / power) + playback
const BAND = { sun: "#f2c94c", earth: "#4f8fe8", ok: "#2fa36b", bad: "#fc3d21", none: "#26324a", unknown: "#5b6478" };
function drawStrip() {
  const canvas = $("strip"), r = state.results.get(state.focus);
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !r) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const labelW = 96, top = 4, rowH = 10, gap = 6, t0 = state.start.getTime(), t1 = state.end.getTime(), pw = W - labelW;
  const X = (ms) => labelW + ((ms - t0) / (t1 - t0)) * pw;
  ctx.font = "500 11px 'Public Sans', system-ui, sans-serif"; ctx.textBaseline = "middle";
  const m = state.mission.get(state.focus);
  const rows = [
    [advanced ? "Sun visible" : "Sunlight", r.sun.sunlitWindows.map((w) => [w.startUtc, w.endUtc, BAND.sun])],
    [state.relay.on && r.commsEffective ? "Earth + relay" : advanced ? "DTE line of sight" : "Earth contact", (state.relay.on && r.commsEffective ? r.commsEffective : r.communication).windows.map((w) => [w.startUtc, w.endUtc, BAND.earth])],
    [advanced ? "Load served" : "Power OK", m?.segments ? m.segments.map((g) => [t0 + g.startOffsetSeconds * 1000, t0 + g.endOffsetSeconds * 1000,
      g.available == null ? BAND.unknown : g.available ? BAND.ok : BAND.bad]) : []],
  ];
  rows.forEach(([name, spans], k) => {
    const y = top + k * (rowH + gap);
    ctx.fillStyle = "#b9c3d6"; ctx.textAlign = "left"; ctx.fillText(name, 0, y + rowH / 2);
    ctx.fillStyle = BAND.none; ctx.fillRect(labelW, y, pw, rowH);
    for (const [a, b, col] of spans) {
      const xa = X(typeof a === "string" ? Date.parse(a) : a), xb = X(typeof b === "string" ? Date.parse(b) : b);
      ctx.fillStyle = col; ctx.fillRect(xa, y, Math.max(1, xb - xa), rowH);
    }
  });
  const days = (t1 - t0) / 1000 / DAY, every = days <= 8 ? 1 : days <= 16 ? 2 : days <= 32 ? 4 : 10;
  ctx.fillStyle = "#b9c3d6"; ctx.font = "11px 'Public Sans', system-ui, sans-serif";
  const ty = top + 3 * (rowH + gap) + 6;
  for (let d = 0; d < days; d += every) {
    const x = X(t0 + d * DAY * 1000);
    ctx.textAlign = d === 0 ? "left" : "center"; ctx.fillText(`Day ${d + 1}`, x, ty);
  }
  const x = X(r._t[state.tIdx]);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(x - 1, 0, 2, top + 3 * (rowH + gap) - gap + 4);
  canvas._g = { labelW, pw, t0, t1 };
}
function scrub(ev) {
  const g = $("strip")._g, r = state.results.get(state.focus);
  if (!g || !r) return;
  const rect = $("strip").getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (ev.clientX - rect.left - g.labelW) / g.pw));
  state.tIdx = Math.max(0, Math.min(r._t.length - 1, Math.round(f * (g.t1 - g.t0) / 1000 / state.contract.time.baseStepSeconds)));
  renderNow();
}
$("strip").addEventListener("pointerdown", (e) => { $("strip").setPointerCapture(e.pointerId); scrub(e); });
$("strip").addEventListener("pointermove", (e) => { if (e.buttons) scrub(e); });
$("strip").tabIndex = 0;
$("strip").addEventListener("keydown", (e) => {
  const r = state.results.get(state.focus); if (!r) return;
  const step = e.shiftKey ? 144 : 6;
  if (e.key === "ArrowRight") state.tIdx = Math.min(r._t.length - 1, state.tIdx + step);
  else if (e.key === "ArrowLeft") state.tIdx = Math.max(0, state.tIdx - step);
  else return;
  e.preventDefault(); renderNow();
});
$("play").addEventListener("click", () => {
  state.playing = !state.playing;
  $("play").innerHTML = icon(state.playing ? "pause" : "play");
  $("play").setAttribute("aria-label", state.playing ? "Pause" : "Play");
  if (state.playing) requestAnimationFrame(tick);
});
let last = 0, acc = 0;
function tick(ts) {
  if (!state.playing) { last = 0; return; }
  const r = state.results.get(state.focus);
  if (last && r) {
    acc += ((ts - last) / 1000) * 2 * (DAY / state.contract.time.baseStepSeconds);   // 2 days per second
    const adv = Math.floor(acc); acc -= adv;
    if (adv) { state.tIdx = (state.tIdx + adv) % r._t.length; renderNow(); }
  }
  last = ts; requestAnimationFrame(tick);
}

// ============================================================ results drawer
function sunStats(r) {        // Sun elevation above a level horizon while it is visible
  const el = r.series.sunElevationDeg, v = r.series.sunVisible;
  let n = 0, sum = 0, lo = Infinity, hi = -Infinity;
  for (let k = 0; k < el.length; k++) if (v[k]) { n++; sum += el[k]; lo = Math.min(lo, el[k]); hi = Math.max(hi, el[k]); }
  return n ? { mean: sum / n, min: lo, max: hi } : null;
}
// One site's checks, shared by the compare cards (side panel) and the drawer summary.
function siteChecks(s) {
  if (pending(s.id)) return null;
  const n = state.needs, r = state.results.get(s.id), m = state.mission.get(s.id), su = m?.summary;
  if (!r) return null;
  const p = state.power.get(s.id);
  const out = [{ k: "pv", label: "Solar output", status: p?.summary.meanPowerW == null ? "unknown" : "info",
    value: fmtW(p?.summary.meanPowerW), sub: "average over stay",
    tip: "Calculated from this location's Sun direction, distance, terrain shadows and your panel settings. Missing data stays unknown." }];
  if (!su) out.push({ k: "power", label: advanced ? "Power availability" : "Power", status: "unknown", value: "—", sub: "source data unavailable", tip: m?.error });
  else {
    const ok = n.minPowerAvailabilityFraction >= 1 ? m.powerOutages.length === 0 : su.powerAvailabilityFraction + 1e-12 >= n.minPowerAvailabilityFraction;
    const lossDay = su.firstKnownPowerLossOffsetSeconds == null ? null : Math.floor(su.firstKnownPowerLossOffsetSeconds / DAY) + 1;
    out.push(su.powerAvailabilityFraction == null ? { k: "power", label: "Power", status: "unknown", value: "—", sub: "data gap" }
      : { k: "power", label: advanced ? "Power availability" : "Power", status: ok ? "pass" : "fail", value: pct(su.powerAvailabilityFraction),
        sub: ok ? `needs ${pct(n.minPowerAvailabilityFraction)}` : lossDay == null ? "equipment power shortfall" : `runs out day ${lossDay}`,
        tip: "Share of the stay the equipment gets all the power it needs, from the panel or the battery." });
    const minSoc = su.minimumBatteryWh == null || n.capacityWh === 0 ? null : su.minimumBatteryWh / n.capacityWh;
    out.push({ k: "soc", label: advanced ? "Min. SOC" : "Battery low point", status: minSoc != null && minSoc <= n.reserveSocFraction + 1e-6 ? "warn" : "info",
      value: pct(minSoc), sub: `reserve ${pct(n.reserveSocFraction)}`, tip: "The lowest the battery gets. It never drains below the reserve cutoff." });
  }
  const comm = state.relay.on && r.commsEffective ? r.commsEffective : r.communication;
  const c = su ? su.commsAvailabilityFraction : comm.summary.percentOfMission == null ? null : comm.summary.percentOfMission / 100;
  const gapS = su ? su.longestCommsBlackoutSeconds : comm.summary.longestGapSeconds;
  out.push({ k: "comms", label: advanced ? "DTE availability" : "Earth contact", status: c == null ? "unknown" : c + 1e-12 >= n.minCommsAvailabilityFraction ? "pass" : "fail",
    value: pct(c), sub: `needs ${pct(n.minCommsAvailabilityFraction)}`, tip: state.relay.on ? "Share of the stay with direct Earth contact or a modeled relay link." : "Share of the stay Earth clears the terrain and antenna elevation threshold." });
  out.push({ k: "gap", label: advanced ? "Max. DTE blackout" : "Longest silence", status: gapS == null ? "unknown" : gapS / 3600 <= n.maxCommsBlackoutHours + 1e-9 ? "pass" : "fail",
    value: fmtDur(gapS), sub: `limit ${fmtDur(n.maxCommsBlackoutHours * 3600)}`, tip: "The longest stretch with Earth hidden behind terrain." });
  out.push({ k: "sun", label: advanced ? "Sun visible" : "Sunlight", status: "info", value: pct(r.sun.summary.percentOfMission == null ? null : r.sun.summary.percentOfMission / 100), sub: "of the stay",
    tip: "Share of the stay the Sun is above the terrain." });
  const ss = sunStats(r);
  out.push({ k: "el", label: advanced ? "Solar elevation" : "Sun height", status: "info", value: ss ? `${ss.mean.toFixed(1)}°` : "—",
    sub: ss ? `${ss.min.toFixed(1)}° to ${ss.max.toFixed(1)}°` : "never visible",
    tip: "How high the Sun stands above a level horizon while visible. At the pole it skims the horizon, so shadows are kilometres long and panels must stand upright." });
  if (advanced && su) {
    out.push({ k: "score", label: "Viability score", status: "info", value: m.viability.score == null ? "—" : m.viability.score.toFixed(1), sub: "not a probability",
      tip: "Person 3 score: 100 × power × comms × blackout factors." });
    out.push({ k: "energy", label: "Solar energy", status: "info", value: fmtWh(su.solarEnergyWh), sub: `${fmtW(su.solarEnergyWh == null ? null : su.solarEnergyWh * 3600 / su.durationSeconds)} avg` });
  }
  return out;
}
const ICON = { pass: "check", fail: "cross", unknown: "q" };
function metricRow(c) {
  return `<div class="m m-${c.status}"${c.tip ? ` data-tip="${esc(c.tip)}"` : ""}><span class="ml">${c.label}</span>
    <span class="mv">${ICON[c.status] ? icon(ICON[c.status]) : ""}<b>${c.value}</b></span><span class="ms">${c.sub ?? ""}</span></div>`;
}
function renderCompare() {
  const primary = siteById(state.focus);
  const choices = allSites().filter(site=>site.id !== state.focus);
  const secondary = choices.find(site=>site.id === state.compareSite) ?? choices[0];
  if (!primary || !secondary) { $("pane-compare").textContent = "Choose two different sites to compare."; return; }
  state.compareSite = secondary.id;
  const options = choices.map(site=>`<option value="${esc(site.id)}" ${site.id===secondary.id?"selected":""}>${esc(site.name)}</option>`).join("");
  const a = pending(primary.id) ? [] : siteChecks(primary) ?? [];
  const b = pending(secondary.id) ? [] : siteChecks(secondary) ?? [];
  const ids = new Set([...a,...b].map(metric=>metric.k));
  const entries = [...ids].map(id=>{
    const x = a.find(metric=>metric.k===id), y = b.find(metric=>metric.k===id);
    return `<tr><th scope="row">${esc(x?.label ?? y.label)}</th><td>${esc(x?.value ?? "—")}</td><td>${esc(y?.value ?? "—")}</td></tr>`;
  }).join("");
  const verdict = site => pending(site.id) ? "Calculating…" : vbadge(verdictFor(site.id));
  $("pane-compare").innerHTML = `<label class="field">Compare with<select id="compare-site">${options}</select></label>
    <table class="compare-table"><thead><tr><th scope="col">Measure</th><th scope="col">${esc(primary.name)}</th><th scope="col">${esc(secondary.name)}</th></tr></thead>
    <tbody><tr><th scope="row">Mission outlook</th><td>${verdict(primary)}</td><td>${verdict(secondary)}</td></tr>${entries}</tbody></table>
    <div class="actions"><button class="link" data-visit="${esc(secondary.id)}">Visit this site</button>
    ${secondary.custom && secondary !== state.mapSpot ? `<button class="link" data-del="${esc(secondary.id)}">Remove saved spot</button>` : ""}
    ${primary.custom && primary !== state.mapSpot ? `<button class="link" data-del="${esc(primary.id)}">Remove current spot</button>` : ""}</div>`;
}
const pending = (id) => state.loading && !state.fresh?.has(id);
function gameBlock() {
  const mission = state.mission.get(state.focus);
  const verdict = verdictFor(state.focus);
  const scored = gameScore({ mission, verdict, capacityWh: state.needs.capacityWh });
  const grade = scoreGrade(scored.total);
  if (scored.total == null) return "";
  return `<section class="game"><div class="game-head"><div><p class="game-kicker">Mission designer</p><h3 class="game-title">${esc(grade.label)}</h3></div>
    <div class="game-score t-${grade.tier}"><b>${scored.total}</b><small>/ 100</small><span class="game-grade">${grade.grade}</span></div></div>
    <p class="game-tip">${esc(scoreTip(scored, { capacityWh: state.needs.capacityWh }))}</p></section>`;
}
function renderSummary() {        // drawer, check mode: the site in view's verdict + one-line reason
  const v = verdictFor(state.focus);
  const checks = pending(state.focus) ? [] : siteChecks(siteById(state.focus)) ?? [];
  const relayNote = state.relay.on && state.results.get(state.focus)?.relay
    ? `<p class="why">Earth contact includes a ${state.relay.sats}-satellite polar relay when the direct link is blocked.</p>` : "";
  return `<div class="summary">${pending(state.focus) ? "" : vbadge(v)}<p class="why">${esc(reason(state.focus, v))}</p></div><div class="metric-readout">${checks.map(metricRow).join("")}</div>${relayNote}
    ${advanced ? gameBlock() : ""}<div class="summary-actions">
    ${state.pane !== "compare" ? `<button class="link" id="open-compare">Compare with another site</button>` : ""}</div>`;
}
function reason(id, v) {
  const m = state.mission.get(id), s = siteById(id)?.name ?? "";
  if (pending(id)) return "Calculating…";
  if (!m || m.error) {
    const r = state.results.get(id), n = state.needs;
    const comm = state.relay.on && r?.commsEffective ? r.commsEffective : r?.communication;
    const comms = comm?.summary.percentOfMission == null || comm.summary.longestGapSeconds == null ? null
      : comm.summary.percentOfMission / 100 + 1e-12 >= n.minCommsAvailabilityFraction
      && comm.summary.longestGapSeconds / 3600 <= n.maxCommsBlackoutHours + 1e-9;
    return `${s}: can't tell. ${m?.error ?? "Power data unavailable."}${comms == null ? "" : comms ? " Earth contact meets the limits." : " Earth contact already misses the limits."}`;
  }
  const su = m.summary, n = state.needs;
  if (v === "go") return `${s} works for this stay: power never runs out and Earth contact meets the limits.`;
  if (v === "preliminary") return `${s}: the modeled requirements are ${m.viability.requirementsMet ? "met" : "not met"}. These estimates use an illustrative horizon rather than measured terrain.`;
  if (v === "unknown") return `${s}: can't tell. Part of the stay has no data, so it isn't judged.`;
  const parts = [];
  if (m.powerOutages.length) parts.push(`the battery reaches its reserve on day ${Math.floor(su.firstKnownPowerLossOffsetSeconds / DAY) + 1}, so equipment loses power for ${fmtDur(m.powerOutages.reduce((t, w) => t + w.durationSeconds, 0))} in total`);
  if (su.commsAvailabilityFraction + 1e-12 < n.minCommsAvailabilityFraction) parts.push(`Earth is in view only ${pct(su.commsAvailabilityFraction)} of the time (needs ${pct(n.minCommsAvailabilityFraction)})`);
  if (su.longestCommsBlackoutSeconds / 3600 > n.maxCommsBlackoutHours) parts.push(`the longest silence is ${fmtDur(su.longestCommsBlackoutSeconds)} (limit ${fmtDur(n.maxCommsBlackoutHours * 3600)})`);
  return `${s} is ${VERDICT[v]}: ${parts.join("; ")}.`;
}
function renderDays() {
  const first = gridStart(), planned = toDate(state.start);
  const head = [...Array(GRID_DAYS)].map((_, k) => new Date(first.getTime() + k * DAY * 1000));
  const rows = allSites().map((s) => {
    const row = state.days.get(s.id);
    const cells = head.map((d) => {
      const ds = toDate(d), c = row?.cells?.get(ds), inRange = row?.dates.some((x) => toDate(x) === ds);
      if (!inRange) return `<td class="d-out"></td>`;
      const v = c?.verdict ?? "pending";
      return `<td><button class="day d-${v}${ds === planned ? " planned" : ""}" data-day="${ds}" data-site="${esc(s.id)}"
        aria-label="${esc(s.name)} ${ds}: ${v === "pending" ? "calculating" : VERDICT[v]}">${+ds.slice(8)}</button></td>`;
    }).join("");
    return `<tr><th scope="row">${esc(s.name)}<small>${row?.error ? esc(row.error) : where(s)}</small></th>${cells}</tr>`;
  }).join("");
  const months = [];
  head.forEach((d, k) => { const lab = d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short" }); if (!k || d.getUTCDate() === 1) months.push([k, lab]); });
  const monthRow = `<tr><th></th>${head.map((d, k) => { const mk = months.find(([j]) => j === k); return `<td class="mon">${mk ? mk[1] : ""}</td>`; }).join("")}</tr>`;
  const done = [...state.days.values()].reduce((a, r) => a + [...(r.cells?.values() ?? [])].filter((c) => c.verdict !== "pending").length, 0);
  const total = [...state.days.values()].reduce((a, r) => a + r.dates.length, 0);
  return `<div class="opt-bar"><button class="btn primary" id="optimize-btn" type="button">Best site and day for sun + contact</button>
    <span class="hint">Searches the catalog for sunlight and Earth contact${state.relay.on ? " with the relay on" : ""}.</span></div>
    <p class="why">Each square is a landing on that day (00:00 UTC) for a ${Math.round((state.end - state.start) / 1000 / DAY)}-day stay. Click one to load it.
    ${done < total ? `<span class="prog">Checked ${done} of ${total}…</span>` : ""}</p>
    <div class="tbl-wrap"><table class="days">${monthRow}${rows}</table></div>
    <div class="legend">${["go", "caution", "nogo", "preliminary", "unknown"].map((v) => `<span><i class="d-${v}"></i>${VERDICT[v]}</span>`).join("")}<span><i class="planned-key"></i>Current landing day</span></div>`;
}
function renderResults() {
  $("results").innerHTML = state.mode === "days" ? renderDays() : renderSummary();
  renderCompare();
}
$("results").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.day) {
    const len = state.end - state.start;
    state.start = new Date(b.dataset.day + "T00:00:00Z"); state.end = new Date(state.start.getTime() + len);
    state.focus = b.dataset.site; state.tIdx = 0; syncInputs(); setMode("check"); refresh();
  } else if (b.id === "open-compare") setPane("compare");
  else if (b.id === "optimize-btn") void runOptimize();
  else if (b.id === "share-card") shareCard();
});
function selectSite(id) {
  if (!id || id === state.focus) return;
  state.focus = id;
  syncInputs();
  renderAll();
}
$("pane-compare").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]"); if (del) { removeSpot(del.dataset.del); return; }
  if (e.target.closest("#add-spot")) { if ($("map-panel").hidden) $("map-toggle").click(); $("c-lat").focus(); return; }
  selectSite(e.target.closest("[data-visit]")?.dataset.visit);
});
$("pane-compare").addEventListener("change", event => {
  if (event.target.id !== "compare-site") return;
  state.compareSite = event.target.value;
  renderCompare();
  $("compare-site")?.focus();
});
function setPane(p, focusHeading = true) {
  state.pane = p;
  document.body.dataset.panel = p;
  const name = p === "dates" || p === "equipment" ? "settings" : p;
  const panels = [...document.querySelectorAll("[data-screen]")];
  for (const panel of panels) panel.hidden = panel.dataset.screen !== name;
  $("settings-heading").textContent = p === "dates" ? "Mission dates" : "Lander settings";
  $("sheet-nav").hidden = p === "site";
  $("sheet-back").hidden = p === "menu";
  $("sheet-reopen").hidden = true;
  $("mission-sheet").hidden = false;
  $("mission-sheet").scrollTop = 0;
  $("mission-dock").hidden = p === "site";
  if (focusHeading) panels.find(panel=>!panel.hidden)?.querySelector("h1")?.focus({preventScroll:true});
  if (state.contract) { renderResults(); drawStrip(); }
}
document.querySelectorAll("[data-open]").forEach(button=>button.onclick = () => {
  if (button.dataset.open === "results") setMode("check");
  setPane(button.dataset.open);
});
$("site-continue").onclick = () => setPane("menu");
$("sheet-back").onclick = () => setPane("menu");
$("sheet-hide").onclick = () => {
  $("mission-sheet").hidden = true;
  $("sheet-reopen").hidden = false;
  $("sheet-reopen").focus();
};
$("sheet-reopen").onclick = () => setPane(state.pane);

// ============================================================ render + modes
function renderRelayBox() {
  let box = $("relay-box");
  if (!box) {
    box = document.createElement("section");
    box.className = "group";
    box.id = "relay-box";
    $("needs-box")?.after(box);
  }
  const on = state.relay.on;
  box.innerHTML = `<h2>Comms relay <span class="tag">${on ? "on" : "off"}</span></h2>
    <label class="relay-row"><input type="checkbox" id="relay-on" ${on ? "checked" : ""}>Use a polar relay satellite</label>
    <p class="hint">When Earth drops behind the terrain, an orbiting relay carries the signal.</p>
    ${on ? `<div class="pair">${numberField("relay-sats", "Relay satellites", state.relay.sats, { min: 1, max: 8, step: 1 })}</div>` : ""}`;
  $("relay-on").addEventListener("change", () => {
    state.relay = { ...state.relay, on: $("relay-on").checked };
    save("relayV1", state.relay);
    state.results.clear(); state.days.clear(); state.dayRun++;
    renderRelayBox(); refresh();
  });
  $("relay-sats")?.addEventListener("change", () => {
    const v = parseInt($("relay-sats").value, 10);
    if (v >= 1 && v <= 8) {
      state.relay = { ...state.relay, sats: v };
      save("relayV1", state.relay);
      state.results.clear(); state.days.clear(); state.dayRun++;
      refresh();
    }
  });
}
async function runOptimize() {
  const btn = $("optimize-btn");
  if (btn) btn.disabled = true;
  setStatus("Searching sites and landing days…", "busy");
  try {
    const out = await api("optimize", {
      firstDayUtc: utc(state.start), sweepDays: 14, missionSeconds: (state.end - state.start) / 1000,
      antennaMinElevationDeg: state.antenna, relay: state.relay.on, relaySats: state.relay.sats,
    });
    const best = out.best;
    if (!best?.bestDateUtc) { setStatus("No ranked landing day in this window.", "err"); return; }
    const len = state.end - state.start;
    if (siteById(best.id)) state.focus = best.id;
    state.start = new Date(best.bestDateUtc);
    state.end = new Date(state.start.getTime() + len);
    state.tIdx = 0;
    syncInputs();
    setMode("check");
    setStatus(`Best pick: ${best.name || best.id} on ${best.bestDateUtc.slice(0, 10)}.`);
    refresh();
  } catch (e) {
    setStatus(`Couldn't optimize: ${e.message}`, "err");
  } finally { if ($("optimize-btn")) $("optimize-btn").disabled = false; }
}
function shareCard() {
  const site = siteById(state.focus);
  const v = verdictFor(state.focus);
  const mission = state.mission.get(state.focus);
  downloadCard({
    verdict: v, verdictLabel: VERDICT[v] || "CAN'T TELL",
    site: site?.name || "Site", where: site ? where(site) : "",
    dateLabel: state.start ? toDate(state.start) : "",
    stayLabel: state.start && state.end ? `${Math.round((state.end - state.start) / DAY / 1000)}-day stay` : "",
    reason: reason(state.focus, v),
    metrics: mission?.summary ? [
      { label: "Power", value: pct(mission.summary.powerAvailabilityFraction), status: v === "go" ? "pass" : "fail" },
      { label: "Earth", value: pct(mission.summary.commsAvailabilityFraction), status: "pass" },
    ] : [],
  }, `nocoast-${site?.id || "site"}.png`);
}
function renderAll() {
  renderResults(); renderNow(); renderPanelBox(); renderMap();
}
function setMode(mode) {
  state.mode = mode === "days" ? "days" : "check";
  document.querySelectorAll(".modes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
  if (location.hash.slice(1) !== state.mode) history.replaceState(null, "", `${location.search}#${state.mode}`);
  document.body.dataset.dateGrid = String(state.mode === "days");
  if (state.mode === "days" && !state.days.size) refreshDays();
  renderResults();
}
document.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
  setMode(b.dataset.mode);
  setPane("results");
}));
$("advanced").addEventListener("change", () => {
  advanced = $("advanced").checked; document.body.classList.toggle("advanced", advanced); save("advancedMode", advanced);
  renderNeedsBox(); renderSources(); renderAll();
});

// ============================================================ mission inputs
function syncInputs() {
  $("active-site").textContent = siteById(state.focus)?.name ?? "Mission planner";
  $("site").innerHTML = allSites().map((s) => `<option value="${esc(s.id)}" ${s.id === state.focus ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  $("land-date").value = toDate(state.start); $("start").value = toDT(state.start); $("end").value = toDT(state.end);
  const days = Math.round((state.end - state.start) / 1000 / DAY);
  if ([...$("length").options].some((o) => +o.value === days)) $("length").value = String(days);
}
function clampStay() {
  const endUtc = state.contract?.time?.supportedEndUtc;
  if (!endUtc || !state.end) return;
  const max = new Date(endUtc);
  if (state.end > max) state.end = max;
}
const newWindow = () => { state.tIdx = 0; state.days.clear(); state.dayRun++; syncInputs(); refresh(); };
$("site").addEventListener("change", () => selectSite($("site").value));
$("land-date").addEventListener("change", () => {
  if (!$("land-date").value || !state.start) return;
  const len = state.end - state.start;
  state.start = new Date($("land-date").value + "T00:00:00Z"); state.end = new Date(state.start.getTime() + len);
  clampStay();
  newWindow();
});
$("length").addEventListener("change", () => {
  if (!state.start) return;
  state.end = new Date(state.start.getTime() + +$("length").value * DAY * 1000);
  clampStay();
  newWindow();
});
$("start").addEventListener("change", () => { if ($("start").value) { state.start = new Date($("start").value + ":00Z"); newWindow(); } });
$("end").addEventListener("change", () => { if ($("end").value) { state.end = new Date($("end").value + ":00Z"); newWindow(); } });
$("antenna").addEventListener("change", () => {
  const v = parseFloat($("antenna").value);
  state.antenna = Number.isFinite(v) ? v : (state.contract?.visibility?.antennaMinElevationDeg ?? state.antenna); newWindow();
});

// ============================================================ exports, tooltips, boot
$("export").addEventListener("click", () => {
  const q = new URLSearchParams({ startUtc: utc(state.start), endUtc: utc(state.end), antennaMinElevationDeg: state.antenna });
  const site = siteById(state.focus);
  if (site.custom) {
    const { _t, ...clean } = state.results.get(site.id) ?? {};
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([JSON.stringify(clean)], { type: "application/json" })),
      download: `spot_${site.lat}_${site.lon}_${toDate(state.start)}.json` });
    a.click(); return;
  }
  window.location.href = apiUrl(`api/export/${encodeURIComponent(state.focus)}?${q}`);
});
$("p-csv").addEventListener("click", () => {
  const p = state.power.get(state.focus); if (!p) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([resultCsv(p)], { type: "text/csv" }));
  a.download = `${state.focus}_power_${toDate(state.start)}_${toDate(state.end)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
function tooltip(html, ev) {
  const t = $("tooltip");
  if (!html) { t.style.display = "none"; return; }
  t.innerHTML = html; t.style.display = "block";
  t.style.left = Math.max(8, Math.min(window.innerWidth - t.offsetWidth - 8, ev.clientX + 12)) + "px";
  t.style.top = Math.min(window.innerHeight - t.offsetHeight - 8, ev.clientY + 16) + "px";
}
document.addEventListener("mouseover", (e) => { const k = e.target.closest?.("[data-tip]")?.dataset.tip; if (k) tooltip(esc(k), e); });
document.addEventListener("mouseout", (e) => { if (e.target.closest?.("[data-tip]")) tooltip(null); });
window.addEventListener("resize", () => drawStrip());

function angDiff(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}
function meanSunAzimuth(samples) {
  let x = 0, y = 0, n = 0;
  for (const s of samples ?? []) {
    if (s.sunlit === false || !Number.isFinite(s.sunAz)) continue;
    const r = s.sunAz * Math.PI / 180;
    x += Math.sin(r); y += Math.cos(r); n++;
  }
  if (!n) return null;
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}
function panelAzimuth() {
  const p = state.panel;
  if (p.face !== "auto") return +p.face || 0;
  const az = state.faceDeg.get(state.focus);
  return Number.isFinite(az) ? az : 0;
}
function missionFromNeeds(n) {
  const battery = {}, requirements = {};
  for (const k of Object.keys(D.battery)) battery[k] = n[k];
  for (const k of Object.keys(D.requirements)) requirements[k] = n[k];
  return { battery, requirements };
}
function lonNear(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180) < 0.002;
}
function pushLanding() {
  if (!state.start || !state.end || state.end <= state.start) return;
  const site = siteById(state.focus);
  if (!site) return;
  const r = state.results.get(state.focus);
  const scrub = r?._t?.[state.tIdx] != null ? new Date(r._t[state.tIdx]).toISOString() : state.start.toISOString();
  applyLandingScenario({
    siteId: site.custom ? "custom" : site.id,
    latitudeDeg: site.lat,
    longitudeEastDeg: site.lon,
    custom: !!site.custom,
    startUtc: state.start.toISOString(),
    durationHours: (state.end - state.start) / 3600000,
    scrubUtc: scrub,
    minEarthElevationDeg: state.antenna,
    panelAreaM2: state.panel.areaM2,
    panelEfficiency: state.panel.efficiency,
    panelTiltDeg: state.panel.tiltDeg,
    panelAzimuthDeg: Math.min(359.999, Math.max(0, panelAzimuth())),
    loadW: state.needs.loadW,
    missionSettings: missionFromNeeds(state.needs),
    showTechnicalDetails: advanced,
  });
  paintLandingSun(r);
}
function onNavigatorScenario(s) {
  if (isLandingSync()) return;
  const th = s.thresholds;
  if (s.primary.siteId === "custom" && s.primary.customLatDeg != null && s.primary.customLonEastDeg != null) {
    const lat = s.primary.customLatDeg, lon = s.primary.customLonEastDeg;
    const match = allSites().find((x) => Math.abs(x.lat - lat) < 0.002 && lonNear(x.lon, lon));
    if (match) { if (state.focus !== match.id) { state.focus = match.id; syncInputs(); renderAll(); } }
    else { addSpot(lat, lon); return; }
  } else {
    const known = findSite(s.primary.siteId);
    if (known && !siteById(known.siteId)) {
      state.sites.push({ id: known.siteId, name: known.name, lat: known.latitudeDeg, lon: known.longitudeEastDeg });
    }
    if (siteById(s.primary.siteId) && state.focus !== s.primary.siteId) {
      state.focus = s.primary.siteId; syncInputs(); renderAll();
    }
  }
  const start = new Date(s.startUtc);
  const end = new Date(start.getTime() + s.durationHours * 3600000);
  if (state.start && (state.start.getTime() !== start.getTime() || Math.abs(state.end - end) > 1000)) {
    state.start = start; state.end = end; state.tIdx = 0; syncInputs(); refresh(); return;
  }
  const currentAz = panelAzimuth();
  const trackSun = state.panel.face === "auto";
  const panelDirty = Math.abs(state.panel.areaM2 - th.panelAreaM2) > 1e-6
    || Math.abs(state.panel.efficiency - th.panelEfficiency) > 1e-6
    || Math.abs(state.panel.tiltDeg - th.panelTiltDeg) > 1e-6
    || (!trackSun && angDiff(currentAz, th.panelAzimuthDeg) > 0.75);
  if (panelDirty) {
    state.panel = {
      areaM2: th.panelAreaM2, efficiency: th.panelEfficiency, tiltDeg: th.panelTiltDeg,
      face: trackSun ? "auto" : String(Math.round(th.panelAzimuthDeg)),
    };
    save("panelV2", state.panel); renderPanelBox(); recomputeAll();
  }
  const needsDirty = state.needs.loadW !== th.batteryFloorW || JSON.stringify(missionFromNeeds(state.needs)) !== JSON.stringify(s.missionSettings);
  if (needsDirty) {
    state.needs = { loadW: th.batteryFloorW, ...s.missionSettings.battery, ...s.missionSettings.requirements };
    save("needsV2", state.needs); renderNeedsBox(); recomputeAll();
  }
  if (Math.abs(state.antenna - th.minEarthElevationDeg) > 1e-6) {
    state.antenna = th.minEarthElevationDeg; $("antenna").value = state.antenna; newWindow(); return;
  }
  const r = state.results.get(state.focus);
  if (!r?._t?.length) return;
  const t = Date.parse(s.scrubUtc);
  let best = 0, bestD = Infinity;
  r._t.forEach((ms, i) => { const d = Math.abs(ms - t); if (d < bestD) { bestD = d; best = i; } });
  if (best !== state.tIdx) { state.tIdx = best; renderNow(); }
}
// presentation.html drives this page in a frame; it gets a small handle on the scene and the clock.
if (new URLSearchParams(location.search).has("present")) {
  window.nocoastDemo = {
    get result() { return state.results.get(state.focus) ?? null; },
    get loading() { return state.loading; },
    get index() { return state.tIdx; },
    setTime(i) { const r = state.results.get(state.focus); if (r) { state.tIdx = Math.max(0, Math.min(r._t.length - 1, Math.round(i))); renderNow(); } },
    look(view) { if (sky3d) sky3d.look(view); },
    get view() { return sky3d ? sky3d.view : null; },
    mapPoint: (lat, lon) => state.mapMeta ? latLonToMap(lat, lon) : null,
  };
}
(async function init() {
  bootLandingNavigator();
  subscribeLandingScenario(onNavigatorScenario);
  subscribeLandingAssessment((assessment) => {
    if (state.panel.face !== "auto") return;
    const az = meanSunAzimuth(assessment.samples);
    if (az == null) return;
    const prev = state.faceDeg.get(state.focus);
    if (prev != null && angDiff(prev, az) < 0.75) return;
    state.faceDeg.set(state.focus, az);
    pushLanding();
  });
  // The Navigator's terrain explorer sits below the workspace; start it when it first scrolls into view.
  const terrainHost = $("terrain-host");
  new IntersectionObserver((entries, observer) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    observer.disconnect();
    ensureLandingTerrain().then(() => pushLanding()).catch(() => {});
  }, { rootMargin: "200px" }).observe(terrainHost);
  const share = document.createElement("button");
  share.className = "btn ghost share-btn";
  share.id = "share-card";
  share.type = "button";
  share.textContent = "Share card";
  $("export")?.after(share);
  share.addEventListener("click", shareCard);
  renderSources(); renderNeedsBox(); renderRelayBox();
  // Built here, not in the HTML: the map comes from the API, whose origin is only known at runtime.
  const mapImg = Object.assign(document.createElement("img"), {
    id: "map-img", src: apiUrl("api/polar_map.png"),
    alt: "Shaded LOLA terrain map of the lunar south pole, about 120 km across" });
  $("map-content").prepend(mapImg);
  try { [state.contract, state.mapMeta] = await Promise.all([api("contract"), api("polar_map/meta").catch(() => null)]); }
  catch (e) {
    setStatus(`Can't reach the science server (${e.message}). Onboard sunlight, power, and Earth grades still follow the settings on this page.`, "err");
    state.loading = false;
    if (!state.start) {
      state.sites = SITE_CATALOG.map((s) => ({ id: s.siteId, name: s.name, lat: s.latitudeDeg, lon: s.longitudeEastDeg }));
      state.focus = state.sites[0].id;
      state.start = new Date("2027-01-15T00:00:00Z");
      state.end = new Date(state.start.getTime() + 14 * DAY * 1000);
      state.antenna = 5;
      syncInputs();
      renderNeedsBox();
      renderPanelBox();
      renderAll();
    }
    return;
  }
  const c = state.contract, qs = new URLSearchParams(location.search);
  advanced = qs.has("advanced") ? qs.get("advanced") === "1" : !!load("advancedMode", false);
  $("advanced").checked = advanced; document.body.classList.toggle("advanced", advanced);
  state.sites = c.sites.map((s) => ({ id: s.siteId, name: s.displayName, lat: s.latitudeDeg, lon: s.longitudeEastDeg }));
  state.focus = siteById(qs.get("site")) ? qs.get("site") : state.sites[0].id;
  state.start = new Date(c.time.defaultStartUtc); state.end = new Date(state.start.getTime() + 14 * DAY * 1000);
  state.antenna = c.visibility.antennaMinElevationDeg;
  for (const id of ["start", "end"]) { $(id).min = toDT(new Date(c.time.supportedStartUtc)); $(id).max = toDT(new Date(c.time.supportedEndUtc)); }
  $("land-date").min = toDate(new Date(c.time.supportedStartUtc));
  $("land-date").max = toDate(new Date(new Date(c.time.supportedEndUtc).getTime() - DAY * 1000));
  $("antenna").value = state.antenna;
  if (qs.get("t")) state.tIdx = Math.max(0, parseInt(qs.get("t"), 10) || 0);
  syncInputs(); renderNeedsBox(); renderPanelBox(); renderSources();
  $("site").disabled = $("site-continue").disabled = false;
  setPane("site", false);
  setMode("check");
  drawScene(null);
  refresh();
})();
