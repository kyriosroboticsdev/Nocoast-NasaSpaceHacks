// NoCoast dashboard: one working screen. Settings on the left, the lander's-eye 3D scene in the middle,
// and a results drawer underneath (time strip + every site compared side by side, or a landing-day grid).
// Science: Person 2 backend (/api). Power: Person 3 P0 model + mission/battery model (Alex's defaults).
import { createSkyView } from "./sky3d.js";
import { simulate, resultCsv, MODEL_ID } from "../power/model.mjs";
import { simulateMission, DEFAULT_MISSION_SETTINGS } from "../power/mission.ts";
import { initTour } from "./tour.js";
import { showLanding } from "./landing.js";
import { downloadCard, CARD_COLORS } from "./card.js";
import { gameScore, scoreGrade, scoreTip, GAME } from "./game.js";

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
  contract: null, sites: [], focus: null, custom: load("customSitesV3", []), view: "site", pane: load("paneV1", "settings"),
  start: null, end: null, antenna: 0,
  results: new Map(), power: new Map(), mission: new Map(), faceDeg: new Map(),
  tIdx: 0, playing: false, mode: "check", loading: true,
  days: new Map(), dayRun: 0,
  needs: { ...NEEDS_DEFAULT, ...load("needsV2", {}) },
  panel: { ...PANEL_DEFAULT, ...load("panelV2", {}) },
  relay: { on: true, sats: 3, ...load("relayV1", {}) },   // polar comms relay (direct-to-Earth + relay)
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
async function api(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  const r = await fetch(`/api/${path}${q ? "?" + q : ""}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
const memo = new Map();
function cached(key, fn) {
  if (!memo.has(key)) memo.set(key, fn().catch((e) => { memo.delete(key); throw e; }));
  return memo.get(key);
}
const allSites = () => [...state.sites, ...state.custom];
const siteById = (id) => allSites().find((s) => s.id === id);
const analyze = (s, start, end) => cached(`a|${s.id}|${utc(start)}|${utc(end)}|${state.antenna}|${state.relay.on}|${state.relay.sats}`, () =>
  api("analyze", { latitudeDeg: s.lat, longitudeEastDeg: s.lon, startUtc: utc(start), endUtc: utc(end),
    antennaMinElevationDeg: state.antenna, relay: state.relay.on, relaySats: state.relay.sats })
    .then((r) => ({ ...r, _t: r.series.timesUtc.map(Date.parse) })));
// Effective contact = direct-to-Earth OR relay (when the relay is on and the backend returned it).
const commsBlock = (r) => (state.relay.on && r.commsEffective) ? r.commsEffective : r.communication;
const NO_POWER = "The power model covers CR1 and SR1 only so far, so power can't be judged here.";
const solarInput = (s, start, end) => s.custom ? Promise.resolve({ error: NO_POWER }) : cached(`s|${s.id}|${utc(start)}|${utc(end)}`, () =>
  api(`solar_input/${encodeURIComponent(s.id)}`, { startUtc: utc(start), endUtc: utc(end) }));

function setStatus(msg, kind = "") { $("status").textContent = msg; $("status").dataset.kind = kind; }

// ============================================================ power + mission (Person 3 models)
function sunAverageBearing(input) {      // circular mean of the Sun's azimuth while it is visible
  let x = 0, y = 0;
  for (const s of input.samples) if (s.solarVisibleFraction) { x += Math.sin(s.sun.azimuthDeg * Math.PI / 180); y += Math.cos(s.sun.azimuthDeg * Math.PI / 180); }
  if (!x && !y) for (const s of input.samples) { x += Math.sin(s.sun.azimuthDeg * Math.PI / 180); y += Math.cos(s.sun.azimuthDeg * Math.PI / 180); }
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
  const t0 = start.getTime(), dur = (end - start) / 1000;
  const comm = commsBlock(r);
  const spans = [...comm.windows.map((w) => [w, true]), ...comm.blackouts.map((w) => [w, false]),
    ...comm.unknown.map((w) => [w, null])]
    .map(([w, v]) => [(Date.parse(w.startUtc) - t0) / 1000, (Date.parse(w.endUtc) - t0) / 1000, v])
    .sort((a, b) => a[0] - b[0]);
  const out = []; let at = 0;
  for (const [a, b, v] of spans) {
    if (a > at + 1e-6) out.push({ startOffsetSeconds: at, endOffsetSeconds: a, available: null });
    if (b > Math.max(a, at)) out.push({ startOffsetSeconds: Math.max(a, at), endOffsetSeconds: Math.min(b, dur), available: v });
    at = Math.max(at, Math.min(b, dur));
  }
  if (at < dur - 1e-6) out.push({ startOffsetSeconds: at, endOffsetSeconds: dur, available: null });
  return out;
}
const allComms = (dur) => [{ startOffsetSeconds: 0, endOffsetSeconds: dur, available: true }];

function runMission(input, comms) {
  const { panel, az } = panelFor(input);
  const p = simulate(input, panel);
  const m = simulateMission(p, state.needs.loadW, missionSettings(), comms ?? allComms(p.summary.durationSeconds));
  return { p, m, az };
}

// Verdict from the mission model's requirement check. Power shortfall = NO-GO; an Earth-contact-only
// shortfall = CAUTION (the lander survives but is out of touch too long); anything unmeasured = CAN'T TELL.
function judge({ powerFrac, powerOutages, commsFrac, blackoutH, complete }) {
  const n = state.needs;
  if (!complete || powerFrac == null || commsFrac == null || blackoutH == null) return "unknown";
  const powerOk = n.minPowerAvailabilityFraction >= 1 ? powerOutages === 0 : powerFrac + 1e-12 >= n.minPowerAvailabilityFraction;
  const commsOk = commsFrac + 1e-12 >= n.minCommsAvailabilityFraction && blackoutH <= n.maxCommsBlackoutHours + 1e-9;
  return !powerOk ? "nogo" : !commsOk ? "caution" : "go";
}
function verdictFor(id) {
  const m = state.mission.get(id);
  if (!m || m.error) return "unknown";
  const s = m.summary;
  return judge({ powerFrac: s.powerAvailabilityFraction, powerOutages: m.powerOutages.length, commsFrac: s.commsAvailabilityFraction,
    blackoutH: s.longestCommsBlackoutSeconds == null ? null : s.longestCommsBlackoutSeconds / 3600, complete: s.complete });
}
const VERDICT = { go: "GO", caution: "CAUTION", nogo: "NO-GO", unknown: "CAN'T TELL" };
const vbadge = (v) => `<span class="v v-${v}">${VERDICT[v]}</span>`;

// ============================================================ refresh
async function refresh() {
  const c = state.contract.time;
  if (!(state.start < state.end)) return setStatus("The end must be after the start.", "err");
  if (state.start < new Date(c.supportedStartUtc) || state.end > new Date(c.supportedEndUtc)) return setStatus("Dates must fall within 2027 (the data range).", "err");
  if ((state.end - state.start) / 1000 > c.maxMissionDurationSeconds) return setStatus("A stay can be at most 60 days.", "err");
  state.loading = true; setStatus("Calculating…", "busy"); renderResults();
  const start = state.start, end = state.end;
  try {
    await Promise.all(allSites().map(async (s) => {
      const [r, input] = await Promise.all([analyze(s, start, end), solarInput(s, start, end).catch((e) => ({ error: e.message }))]);
      if (start !== state.start || end !== state.end) return;
      state.results.set(s.id, r);
      computeMission(s.id, input);
    }));
    if (start !== state.start || end !== state.end) return;
    const r = state.results.get(state.focus);
    state.tIdx = Math.min(state.tIdx, r._t.length - 1);
    state.loading = false; setStatus("");
    renderAll();
  } catch (e) { state.loading = false; setStatus(`Couldn't calculate: ${e.message}`, "err"); renderResults(); }
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
    const row = { dates, sweep: null, inputs: new Map(), stay, noPower: !!s.custom };
    state.days.set(s.id, row);
    api("sweep", { latitudeDeg: s.lat, longitudeEastDeg: s.lon, firstDayUtc: utc(first), sweepDays: dates.length,
      missionSeconds: stay / 1000, antennaMinElevationDeg: state.antenna, relay: state.relay.on, relaySats: state.relay.sats })
      .then((sw) => { if (run === state.dayRun) { row.sweep = sw; recomputeDays(); renderResults(); } })
      .catch((e) => { if (run === state.dayRun) { row.error = e.message; renderResults(); } });
  }
  renderResults();
  const jobs = dates.flatMap((d) => state.sites.map((s) => [s, d]));   // power model: contract sites only
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && run === state.dayRun) {
      const [s, d] = jobs[next++];
      try {
        const input = await solarInput(s, d, new Date(d.getTime() + stay));
        if (run !== state.dayRun) return;
        state.days.get(s.id).inputs.set(toDate(d), input);
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
      const input = row.inputs.get(ds);
      let m = null;
      if (input && !input.error) { try { m = runMission(input).m; } catch { m = null; } }
      const commFrac = (state.relay.on && sw?.commWithRelayPercent != null ? sw.commWithRelayPercent : sw?.commPercent) / 100;
      const blackoutH = state.relay.on && sw?.longestBlackoutWithRelayHours != null ? sw.longestBlackoutWithRelayHours : sw?.longestBlackoutHours;
      const verdict = !sw || sw.missing || !m ? (sw && (input || row.noPower) ? "unknown" : "pending") : judge({
        powerFrac: m.summary.powerAvailabilityFraction, powerOutages: m.powerOutages.length,
        commsFrac: commFrac, blackoutH: blackoutH, complete: m.summary.complete });
      row.cells.set(ds, { verdict, sw, m });
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
      <label class="field">Faces<select id="p-face">${opt([["Toward the Sun", "auto"], ...COMPASS8], p.face)}</select></label>
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
function renderRelayBox() {
  const on = state.relay.on;
  $("relay-box").innerHTML = `<h2>Comms relay <span class="tag">${on ? "on" : "off"}</span></h2>
    <label class="relay-row"><input type="checkbox" id="relay-on" ${on ? "checked" : ""}>Use a polar relay satellite</label>
    <p class="hint">When Earth drops behind the terrain, an orbiting relay carries the signal — so the lander stays in contact far more of the time.${advanced ? " Simplified polar constellation (see backend/relay.py)." : ""}</p>
    ${on ? `<div class="adv-only pair">${numberField("relay-sats", "Relay satellites", state.relay.sats, { min: 1, max: 8, step: 1 })}</div>` : ""}`;
  $("relay-on").addEventListener("change", () => {
    state.relay = { ...state.relay, on: $("relay-on").checked }; save("relayV1", state.relay);
    state.days.clear(); state.dayRun++; refresh();
  });
  $("relay-sats")?.addEventListener("change", () => {
    const v = parseInt($("relay-sats").value, 10);
    if (v >= 1 && v <= 8) { state.relay = { ...state.relay, sats: v }; save("relayV1", state.relay); state.days.clear(); state.dayRun++; refresh(); }
    else setStatus("Relay satellites must be 1 to 8.", "err");
  });
}
function renderSources() {
  $("sources-line").innerHTML = advanced
    ? `Terrain: NASA LOLA LDEM 80 m/240 m + PGDA 5 m · Ephemeris: JPL DE421, MOON_ME frame · Power: ${MODEL_ID} + dc-bus-linear-pv-constant-load-v1`
    : "Terrain from NASA LOLA · Sun and Earth positions from NASA JPL · Power and battery from the team's model";
}

// ============================================================ 3D scene + "right now" readout
let sky3d = null;
function drawScene(r) {
  if (state.view === "terrain") { postSky(); return; }
  if (!sky3d) {
    try { sky3d = createSkyView($("sky3d")); }
    catch { $("sky3d").innerHTML = `<p class="scene-empty">This browser can't show 3D (WebGL is off). The results below still work.</p>`; sky3d = false; }
  }
  if (!sky3d) return;
  sky3d.setTexts({ sun: "Sun", earth: "Earth", sunHidden: "Sun (behind terrain)", earthHidden: "Earth (behind terrain)", lander: "Lander",
    compass: advanced ? [["0°", 0], ["90°", 90], ["180°", 180], ["270°", 270]] : [["N", 0], ["E", 90], ["S", 180], ["W", 270]] });
  sky3d.setSite(siteById(state.focus));
  sky3d.setResult(r);
  sky3d.setTime(state.tIdx);
}
$("find-earth").addEventListener("click", () => sky3d?.aim("earth"));
$("find-sun").addEventListener("click", () => sky3d?.aim("sun"));
$("reset-view").addEventListener("click", () => sky3d?.resetView());

// Scene view: standing at the site (our 3D sky) or Person 1's polar terrain explorer, fed the same Sun/Earth.
function setView(v) {
  state.view = v === "terrain" ? "terrain" : "site";
  document.querySelectorAll("#view-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  $("scene").classList.toggle("terrain-view", state.view === "terrain");
  if (state.view === "terrain" && !$("terrain-frame").src) $("terrain-frame").src = "/terrain.html?embed=1";
  renderNow();
}
document.querySelectorAll("#view-seg button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
function postSky() {
  const frame = $("terrain-frame"), r = state.results.get(state.focus), site = siteById(state.focus);
  if (!frame.contentWindow || !r || !site) return;
  const i = state.tIdx, s = r.series;
  frame.contentWindow.postMessage({ type: "lunar-sky", siteId: site.id, timeUtc: s.timesUtc[i],
    sunEnu: s.sunEnu[i], earthEnu: s.earthEnu[i], sunVisible: s.sunVisible[i], earthVisible: s.earthVisible[i] }, location.origin);
}
$("terrain-frame").addEventListener("load", () => setTimeout(postSky, 300));
window.addEventListener("message", (e) => { if (e.origin === location.origin && e.data?.type === "lunar-sky-ready") postSky(); });

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
function addSpot(lat, lon) {
  if (!(lat >= -90 && lat <= -75) || !(lon >= -360 && lon <= 360)) { setStatus("Use a latitude from -90 to -75 (the terrain data covers the south polar region).", "err"); return; }
  if (state.custom.length >= MAX_CUSTOM) { setStatus(`You can keep ${MAX_CUSTOM} custom spots. Remove one from the table first.`, "err"); return; }
  const n = state.custom.length ? Math.max(...state.custom.map((s) => +s.name.replace(/\D+/g, "") || 0)) + 1 : 1;
  const s = { id: `c-${Date.now()}`, name: `Spot ${n}`, lat: +lat.toFixed(4), lon: +(((lon % 360) + 360) % 360).toFixed(4), custom: true };
  state.custom.push(s); save("customSitesV3", state.custom);
  state.focus = s.id; state.days.clear(); state.dayRun++;
  syncInputs(); renderMap(); refresh();
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
$("map-wrap").addEventListener("mousemove", (e) => {
  const b = $("map-wrap").getBoundingClientRect(), [lat, lon] = mapToLatLon((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height);
  tooltip(`${advanced ? `${lat.toFixed(4)}°, ${lon.toFixed(4)}°E` : `${(((90 + lat) * Math.PI) / 180 * 1737.4).toFixed(1)} km from the pole`}<br>Click to add this spot`, e);
});
$("map-wrap").addEventListener("mouseleave", () => tooltip(null));
$("map-wrap").addEventListener("click", (e) => {
  const b = $("map-wrap").getBoundingClientRect();
  addSpot(...mapToLatLon((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height));
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
  if (!m?.segments) return null;
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
  if (!r) return;
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
  const pw = s0?.powerW == null ? "" : `<div class="now pw"><b>Panel ${fmtW(s0.powerW)}</b><span>${bat == null ? "" : `battery ${Math.round(bat * 100)}%`}${
    s0.solarVisibleFraction && s0.powerW === 0 ? " · Sun is behind the panel" : ""}</span></div>`;
  $("scene-now").innerHTML = line("sun", s.sunVisible[i], "Sun") + line("earth", s.earthVisible[i], "Earth") + pw;
  drawScene(r);
  drawStrip();
}

// ============================================================ time strip (sunlight / Earth contact / power) + playback
const BAND = { sun: "#f2c94c", earth: "#4f8fe8", relay: "#b07cf0", ok: "#2fa36b", bad: "#fc3d21", none: "#26324a", unknown: "#5b6478" };
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
  const relayOn = state.relay.on && r.relay;
  const rows = [
    [advanced ? "Sun visible" : "Sunlight", r.sun.sunlitWindows.map((w) => [w.startUtc, w.endUtc, BAND.sun])],
    [advanced ? "Contact (any)" : "Earth contact", commsBlock(r).windows.map((w) => [w.startUtc, w.endUtc, BAND.earth])],
    ...(relayOn ? [["via relay", r.relay.windows.map((w) => [w.startUtc, w.endUtc, BAND.relay])]] : []),
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
  const ty = top + rows.length * (rowH + gap) + 6;
  for (let d = 0; d < days; d += every) {
    const x = X(t0 + d * DAY * 1000);
    ctx.textAlign = d === 0 ? "left" : "center"; ctx.fillText(`Day ${d + 1}`, x, ty);
  }
  const x = X(r._t[state.tIdx]);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(x - 1, 0, 2, top + rows.length * (rowH + gap) - gap + 4);
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
  const n = state.needs, r = state.results.get(s.id), m = state.mission.get(s.id), su = m?.summary;
  if (!r) return null;
  const out = [];
  if (!su) out.push({ k: "power", label: advanced ? "Power availability" : "Power", status: "unknown", value: "—", sub: "CR1 and SR1 only so far", tip: m?.error });
  else {
    const ok = n.minPowerAvailabilityFraction >= 1 ? m.powerOutages.length === 0 : su.powerAvailabilityFraction + 1e-12 >= n.minPowerAvailabilityFraction;
    const lossDay = su.firstKnownPowerLossOffsetSeconds == null ? null : Math.floor(su.firstKnownPowerLossOffsetSeconds / DAY) + 1;
    out.push(su.powerAvailabilityFraction == null ? { k: "power", label: "Power", status: "unknown", value: "—", sub: "data gap" }
      : { k: "power", label: advanced ? "Power availability" : "Power", status: ok ? "pass" : "fail", value: pct(su.powerAvailabilityFraction),
        sub: ok ? `needs ${pct(n.minPowerAvailabilityFraction)}` : `runs out day ${lossDay}`,
        tip: "Share of the stay the equipment gets all the power it needs, from the panel or the battery." });
    const minSoc = su.minimumBatteryWh == null ? null : su.minimumBatteryWh / n.capacityWh;
    out.push({ k: "soc", label: advanced ? "Min. SOC" : "Battery low point", status: minSoc != null && minSoc <= n.reserveSocFraction + 1e-6 ? "warn" : "info",
      value: pct(minSoc), sub: `reserve ${pct(n.reserveSocFraction)}`, tip: "The lowest the battery gets. It never drains below the reserve cutoff." });
  }
  const eff = commsBlock(r).summary;
  const c = su?.commsAvailabilityFraction ?? eff.percentOfMission / 100;
  const gapS = su?.longestCommsBlackoutSeconds ?? eff.longestGapSeconds;
  const relayOn = state.relay.on && r.relay;
  const dtePct = r.communication.summary.percentOfMission;
  const relaySub = relayOn && eff.percentOfMission != null && dtePct != null && eff.percentOfMission > dtePct + 0.05
    ? `direct ${pct(dtePct / 100)} + relay` : `needs ${pct(n.minCommsAvailabilityFraction)}`;
  out.push({ k: "comms", label: advanced ? "Contact availability" : "Earth contact", status: c + 1e-12 >= n.minCommsAvailabilityFraction ? "pass" : "fail",
    value: pct(c), sub: relaySub, tip: relayOn ? "Share of the stay the lander can reach Earth directly OR through the relay satellite." : "Share of the stay Earth is above the terrain, so the lander can radio home directly." });
  out.push({ k: "gap", label: advanced ? "Max. blackout" : "Longest silence", status: gapS / 3600 <= n.maxCommsBlackoutHours + 1e-9 ? "pass" : "fail",
    value: fmtDur(gapS), sub: `limit ${fmtDur(n.maxCommsBlackoutHours * 3600)}`, tip: "The longest stretch with no way to reach Earth." });
  if (relayOn && r.relay.summary.percentOfMission != null) {
    out.push({ k: "relay", label: advanced ? "Relay coverage" : "Relay link", status: "info",
      value: pct(r.relay.summary.percentOfMission / 100), sub: `${state.relay.sats} sat${state.relay.sats > 1 ? "s" : ""}, polar orbit`,
      tip: "Share of the stay an orbiting relay satellite can carry the signal when Earth is hidden behind terrain. Simplified polar constellation model." });
  }
  out.push({ k: "sun", label: advanced ? "Sun visible" : "Sunlight", status: "info", value: pct(r.sun.summary.percentOfMission / 100), sub: "of the stay",
    tip: "Share of the stay the Sun is above the terrain." });
  const ss = sunStats(r);
  out.push({ k: "el", label: advanced ? "Solar elevation" : "Sun height", status: "info", value: ss ? `${ss.mean.toFixed(1)}°` : "—",
    sub: ss ? `${ss.min.toFixed(1)}° to ${ss.max.toFixed(1)}°` : "never visible",
    tip: "How high the Sun stands above a level horizon while visible. At the pole it skims the horizon, so shadows are kilometres long and panels must stand upright." });
  if (advanced && su) {
    out.push({ k: "score", label: "Viability score", status: "info", value: m.viability.score == null ? "—" : m.viability.score.toFixed(1), sub: "not a probability",
      tip: "Person 3 score: 100 × power × comms × blackout factors." });
    out.push({ k: "energy", label: "Solar energy", status: "info", value: fmtWh(su.solarEnergyWh), sub: `${fmtW(su.solarEnergyWh * 3600 / su.durationSeconds)} avg` });
  }
  return out;
}
const ICON = { pass: "check", fail: "cross", unknown: "q" };
function metricRow(c) {
  return `<div class="m m-${c.status}"${c.tip ? ` data-tip="${esc(c.tip)}"` : ""}><span class="ml">${c.label}</span>
    <span class="mv">${ICON[c.status] ? icon(ICON[c.status]) : ""}<b>${c.value}</b></span><span class="ms">${c.sub ?? ""}</span></div>`;
}
function renderCompare() {
  const cards = allSites().map((s) => {
    const sel = s.id === state.focus, checks = siteChecks(s);
    const del = s.custom ? `<button class="del" data-del="${esc(s.id)}" aria-label="Remove ${esc(s.name)}" title="Remove">${icon("cross")}</button>` : "";
    const body = checks ? checks.map(metricRow).join("")
      : state.loading ? `<div class="skel"><span class="bar"></span><span class="bar"></span></div>` : `<p class="hint">No data.</p>`;
    return `<article class="card${sel ? " sel" : ""}" data-site="${esc(s.id)}" tabindex="0" role="button" aria-pressed="${sel}"
        aria-label="${esc(s.name)}: ${checks ? VERDICT[verdictFor(s.id)] : "calculating"}. Show in the 3D view.">
      <header><div><h3>${esc(s.name)}</h3><small>${where(s)}${s.custom ? " · your spot" : ""}</small></div>
        ${checks ? vbadge(verdictFor(s.id)) : ""}${del}</header>
      ${sel ? `<p class="in-view">${icon("check")}Showing in the 3D view</p>` : ""}
      <div class="metrics">${body}</div></article>`;
  }).join("");
  $("pane-compare").innerHTML = `<div class="cmp-head"><p class="hint">Click a site to show it in the 3D view.</p>
      <button class="btn ghost" id="add-spot" ${state.custom.length >= MAX_CUSTOM ? "disabled" : ""}>${icon("pin")}Add a spot</button></div>
    ${cards}`;
}
let lastSummaryVerdict = null;    // so the reveal animation fires on real verdict changes, not every re-render
function headlineStats(id) {       // the three numbers that make the verdict land, at a glance
  const checks = siteChecks(siteById(id)) || [];
  const pick = (k) => checks.find((c) => c.k === k);
  return ["power", "comms", "gap"].map(pick).filter(Boolean);
}
function renderSummary() {        // drawer, check mode: the site in view's verdict + the key numbers
  const v = verdictFor(state.focus);
  const changed = !state.loading && v !== lastSummaryVerdict;
  lastSummaryVerdict = state.loading ? lastSummaryVerdict : v;
  const stats = state.loading ? [] : headlineStats(state.focus);
  return `<div class="summary v-wrap-${v}${changed ? " reveal" : ""}">
    <div class="verdict-head">${state.loading ? `<span class="v v-unknown">…</span>` : vbadge(v)}
      <p class="why">${esc(reason(state.focus, v))}</p></div>
    ${stats.length ? `<div class="verdict-stats">${stats.map((c, i) => `<div class="vstat vstat-${c.status}" style="--i:${i}">
      <span class="vstat-l">${esc(c.label)}</span><b>${esc(String(c.value))}</b><span class="vstat-s">${esc(c.sub ?? "")}</span></div>`).join("")}</div>` : ""}
    ${state.pane !== "compare" ? `<button class="link" id="open-compare">Compare all ${allSites().length} sites</button>` : ""}
  </div>`;
}
function reason(id, v) {
  const m = state.mission.get(id), s = siteById(id)?.name ?? "";
  if (state.loading) return "Calculating…";
  if (!m || m.error) {
    const r = state.results.get(id), n = state.needs, cs = r && commsBlock(r).summary;
    const comms = r ? cs.percentOfMission / 100 + 1e-12 >= n.minCommsAvailabilityFraction
      && cs.longestGapSeconds / 3600 <= n.maxCommsBlackoutHours + 1e-9 : null;
    return `${s}: can't tell. ${m?.error ?? "Power data unavailable."}${comms == null ? "" : comms ? " Earth contact meets the limits." : " Earth contact already misses the limits."}`;
  }
  const su = m.summary, n = state.needs;
  if (v === "go") return `${s} works for this stay: power never runs out and Earth contact meets the limits.`;
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
  return `<div class="opt-bar"><button class="btn primary" id="optimize-btn">${icon("check")}Best site &amp; day for sun + contact</button>
      <span class="hint">Searches every site and landing day for the most sunlight and communication${state.relay.on ? " (with the relay)" : ""}.</span></div>
    <p class="why">Each square is a landing on that day (00:00 UTC) for a ${Math.round((state.end - state.start) / 1000 / DAY)}-day stay. Click one to load it.
    ${done < total ? `<span class="prog">Checked ${done} of ${total}…</span>` : ""}</p>
    <div class="tbl-wrap"><table class="days">${monthRow}${rows}</table></div>
    <div class="legend">${["go", "caution", "nogo", "unknown"].map((v) => `<span><i class="d-${v}"></i>${VERDICT[v]}</span>`).join("")}<span><i class="planned-key"></i>Current landing day</span></div>`;
}
function renderResults() {
  $("results").innerHTML = state.mode === "days" ? renderDays() : state.mode === "game" ? renderGame() : renderSummary();
  renderCompare();
}
// ---- Mission Designer game mode: score the current site/date/battery pick 0-100 and show how to raise it.
function scoreBar(label, value, max, tier) {
  return `<div class="gb"><span class="gb-l">${label}</span>
    <span class="gb-track"><span class="gb-fill t-${tier}" style="width:${Math.round(100 * value / max)}%"></span></span>
    <span class="gb-v">${value}<i>/${max}</i></span></div>`;
}
function renderGame() {
  const id = state.focus, s = siteById(id), v = verdictFor(id);
  if (!s) return `<p class="hint">${state.loading ? "Loading sites…" : "Pick a site to start a mission."}</p>`;
  const result = gameScore({ mission: state.mission.get(id), verdict: v, capacityWh: state.needs.capacityWh });
  const g = scoreGrade(result.total), tip = scoreTip(result, { capacityWh: state.needs.capacityWh });
  const dateLabel = `${state.start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · ${Math.round((state.end - state.start) / 1000 / DAY)}-day stay`;
  return `<div class="game">
    <div class="game-head">
      <div><p class="game-kicker">Mission Designer · battery budget ${GAME.batteryBudgetWh.toLocaleString()} Wh</p>
        <h2 class="game-title">${esc(s.name)}</h2><p class="game-date">${dateLabel}</p></div>
      <div class="game-score t-${g.tier}"><b>${result.total ?? "—"}</b><small>/ 100</small>
        <span class="game-grade">${g.grade} · ${g.label}</span></div>
    </div>
    ${state.loading ? `<p class="hint">Scoring…</p>` : `
      <div class="game-bars">
        ${scoreBar(advanced ? "Reliability (power · comms · blackout)" : "Does it survive?", result.reliability ?? 0, GAME.reliabilityMax, result.verdict === "nogo" ? "nogo" : result.verdict === "caution" ? "caution" : "go")}
        ${scoreBar(advanced ? "Efficiency (battery under budget)" : "Does it do it cheaply?", result.efficiency ?? 0, GAME.efficiencyMax, "go")}
      </div>
      <p class="game-tip">${icon("warn")}${esc(tip)}</p>
      <div class="game-actions">
        <button class="btn primary" id="game-card">${icon("down")}Download result card</button>
        <span class="hint">Change the site, date, panel and battery on the left — the score updates live.</span>
      </div>`}
  </div>`;
}
$("results").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.day) {
    const len = state.end - state.start;
    state.start = new Date(b.dataset.day + "T00:00:00Z"); state.end = new Date(state.start.getTime() + len);
    state.focus = b.dataset.site; state.tIdx = 0; syncInputs(); setMode("check"); refresh();
  } else if (b.id === "open-compare") setPane("compare");
  else if (b.id === "game-card") shareCard({ withScore: true });
  else if (b.id === "optimize-btn") runOptimize();
});
// Joint optimiser: ask the backend for the (site, landing day) with the most sun + contact, then load it.
async function runOptimize() {
  const btn = $("optimize-btn"); if (btn) { btn.disabled = true; }
  setStatus("Searching every site and landing day for the most sun + contact…", "busy");
  const stayDays = Math.round((state.end - state.start) / 1000 / DAY);
  const qs = new URLSearchParams({
    firstDayUtc: utc(new Date(state.contract.time.supportedStartUtc)), sweepDays: "30",
    missionSeconds: String((state.end - state.start) / 1000), antennaMinElevationDeg: String(state.antenna),
    relay: String(state.relay.on), relaySats: String(state.relay.sats),
  });
  for (const s of state.custom) qs.append("extraSites", `${s.lat},${s.lon}`);
  try {
    const r = await fetch(`/api/optimize?${qs}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const o = await r.json(), b = o.best;
    if (!b) { setStatus("No site could be scored over this range.", "err"); return; }
    const site = allSites().find((s) => s.id === b.id)
      || allSites().find((s) => Math.abs(s.lat - b.latitudeDeg) < 1e-3 && Math.abs(((s.lon - b.longitudeEastDeg) % 360 + 360) % 360) < 1e-3);
    const name = site?.name || b.name || where({ lat: b.latitudeDeg, lon: b.longitudeEastDeg });
    setStatus(`Best: ${name}, land ${b.bestDateUtc.slice(0, 10)} — score ${b.objectiveScore}, contact ${Math.round(b.commWithRelayPercent ?? b.commPercent)}%, sun ${Math.round(b.sunlitPercent)}%.`, "");
    if (site) {
      state.focus = site.id;
      state.start = new Date(b.bestDateUtc);
      state.end = new Date(state.start.getTime() + stayDays * DAY * 1000);
      const max = new Date(state.contract.time.supportedEndUtc); if (state.end > max) state.end = max;
      setMode("check"); newWindow();
    }
  } catch (e) {
    setStatus(`Couldn't optimize: ${e.message}`, "err");
  } finally { if ($("optimize-btn")) $("optimize-btn").disabled = false; }
}
function selectSite(id) { if (id && id !== state.focus) { state.focus = id; syncInputs(); renderAll(); } }
$("pane-compare").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]"); if (del) { removeSpot(del.dataset.del); return; }
  if (e.target.closest("#add-spot")) { if ($("map-panel").hidden) $("map-toggle").click(); $("c-lat").focus(); return; }
  selectSite(e.target.closest(".card")?.dataset.site);
});
$("pane-compare").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) { e.preventDefault(); selectSite(e.target.dataset.site); }
});
function setPane(p) {
  state.pane = p === "compare" ? "compare" : "settings"; save("paneV1", state.pane);
  document.querySelectorAll(".pane-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.pane === state.pane)));
  $("pane-settings").hidden = state.pane !== "settings"; $("pane-compare").hidden = state.pane !== "compare";
  renderResults();
}
document.querySelectorAll(".pane-tabs button").forEach((b) => b.addEventListener("click", () => setPane(b.dataset.pane)));

// ============================================================ render + modes
function renderAll() {
  if (!state.contract) return;
  renderResults(); renderNow(); renderPanelBox(); renderRelayBox(); renderMap();
}
function setMode(mode) {
  state.mode = mode === "days" || mode === "game" ? mode : "check";
  document.querySelectorAll(".modes button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === state.mode)));
  if (location.hash.slice(1) !== state.mode) history.replaceState(null, "", `${location.search}#${state.mode}`);
  if (state.mode === "days" && !state.days.size) refreshDays();
  renderResults();
}
document.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("advanced").addEventListener("change", () => {
  advanced = $("advanced").checked; document.body.classList.toggle("advanced", advanced); save("advancedMode", advanced);
  renderNeedsBox(); renderSources(); renderAll();
});

// ============================================================ mission inputs
function syncInputs() {
  $("site").innerHTML = allSites().map((s) => `<option value="${esc(s.id)}" ${s.id === state.focus ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  $("land-date").value = toDate(state.start); $("start").value = toDT(state.start); $("end").value = toDT(state.end);
  const days = Math.round((state.end - state.start) / 1000 / DAY);
  if ([...$("length").options].some((o) => +o.value === days)) $("length").value = String(days);
}
const newWindow = () => { state.tIdx = 0; state.days.clear(); state.dayRun++; syncInputs(); refresh(); };
$("site").addEventListener("change", () => { state.focus = $("site").value; renderAll(); });
$("land-date").addEventListener("change", () => {
  if (!$("land-date").value) return;
  const len = state.end - state.start;
  state.start = new Date($("land-date").value + "T00:00:00Z"); state.end = new Date(state.start.getTime() + len);
  const max = new Date(state.contract.time.supportedEndUtc); if (state.end > max) state.end = max;
  newWindow();
});
$("length").addEventListener("change", () => {
  state.end = new Date(state.start.getTime() + +$("length").value * DAY * 1000);
  const max = new Date(state.contract.time.supportedEndUtc); if (state.end > max) state.end = max;
  newWindow();
});
$("start").addEventListener("change", () => { if ($("start").value) { state.start = new Date($("start").value + ":00Z"); newWindow(); } });
$("end").addEventListener("change", () => { if ($("end").value) { state.end = new Date($("end").value + ":00Z"); newWindow(); } });
$("antenna").addEventListener("change", () => {
  const v = parseFloat($("antenna").value);
  state.antenna = Number.isFinite(v) ? v : state.contract.visibility.antennaMinElevationDeg; newWindow();
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
  window.location.href = `/api/export/${encodeURIComponent(state.focus)}?${q}`;
});
$("p-csv").addEventListener("click", () => {
  const p = state.power.get(state.focus); if (!p) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([resultCsv(p)], { type: "text/csv" }));
  a.download = `${state.focus}_power_${toDate(state.start)}_${toDate(state.end)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
// ============================================================ hero "day at the pole" + share card + tour
// One press: show the lander's-eye sky, face the Sun, and start playback so the Sun visibly circles the
// horizon. Reuses the existing play loop (sky3d.setTime moves the Sun marker every frame).
function watchDayAtThePole() {
  if (state.mode === "days") setMode("check");
  setView("site");
  if (!state.playing) $("play").click();
  // Let the scene build/draw a frame, then frame the Sun.
  setTimeout(() => sky3d?.aim?.("sun"), 120);
  setStatus("Watch the Sun crawl around the horizon — that's a day at the pole.", "");
  setTimeout(() => { if ($("status").textContent.startsWith("Watch the Sun")) setStatus(""); }, 6000);
}

// Spans (start,end) in ms -> [frac,frac] of the mission window, for the card's mini-timeline.
function cardBands(id) {
  const r = state.results.get(id), m = state.mission.get(id);
  if (!r) return [];
  const t0 = state.start.getTime(), t1 = state.end.getTime(), span = Math.max(1, t1 - t0);
  const fr = (ms) => Math.max(0, Math.min(1, (ms - t0) / span));
  const C = CARD_COLORS;
  const win = (list, col) => list.map((w) => [fr(Date.parse(w.startUtc)), fr(Date.parse(w.endUtc)), col]);
  const bands = [
    { label: "Sunlight", spans: win(r.sun.sunlitWindows, C.sun) },
    { label: "Earth contact", spans: win(r.communication.windows, C.earth) },
  ];
  if (m?.segments) bands.push({ label: "Power OK", spans: m.segments.map((g) =>
    [fr(t0 + g.startOffsetSeconds * 1000), fr(t0 + g.endOffsetSeconds * 1000), g.available == null ? C.gap : g.available ? C.ok : C.bad]) });
  return bands;
}
function buildCardData(id, opts = {}) {
  const s = siteById(id), v = verdictFor(id);
  const checks = siteChecks(s) || [];
  const pick = (k) => checks.find((c) => c.k === k);
  const LABELS = { power: "Power", comms: "Earth contact", gap: "Longest silence", sun: "Sunlight" };
  const metrics = ["power", "comms", "gap", "sun"].map((k) => pick(k)).filter(Boolean)
    .map((c) => ({ label: LABELS[c.k], value: c.value, sub: c.sub, status: c.status }));
  if (opts.withScore) {
    const result = gameScore({ mission: state.mission.get(id), verdict: v, capacityWh: state.needs.capacityWh });
    const g = scoreGrade(result.total);
    metrics.unshift({ label: "Mission score", value: result.total == null ? "—" : String(result.total),
      sub: `${g.grade} · ${g.label}`, status: g.tier === "nogo" ? "fail" : g.tier === "go" ? "pass" : "info" });
  }
  const months = { month: "short", day: "numeric", timeZone: "UTC" };
  const dateLabel = `${state.start.toLocaleDateString("en-US", months)} – ${state.end.toLocaleDateString("en-US", { ...months, year: "numeric" })}`;
  return {
    site: s.name, where: where(s), dateLabel, stayLabel: `${Math.round((state.end - state.start) / 1000 / DAY)}-day stay`,
    verdict: v, verdictLabel: VERDICT[v], reason: reason(id, v), metrics, bands: cardBands(id),
    footer: "NASA LOLA terrain · JPL DE421 Sun/Earth · team power & battery model · nocoast",
  };
}
function shareCard(opts = {}) {
  const id = state.focus, s = siteById(id);
  if (!s || state.loading) { setStatus("Give it a moment to finish calculating, then try the share card again.", "busy"); return; }
  const ok = downloadCard(buildCardData(id, opts), `nocoast_${s.id}_${toDate(state.start)}.png`);
  setStatus(ok ? "Saved a share card (PNG) to your downloads." : "Couldn't make the card in this browser.", ok ? "" : "err");
  if (ok) setTimeout(() => { if ($("status").textContent.startsWith("Saved a share")) setStatus(""); }, 5000);
}
$("watch-day").addEventListener("click", watchDayAtThePole);
$("share-card").addEventListener("click", shareCard);
const tour = initTour({ onWatchDay: watchDayAtThePole });
$("help-btn").addEventListener("click", () => tour.open(0));

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

(async function init() {
  renderSources(); renderNeedsBox();
  // Cinematic landing screen on every load (skip with ?land=0 for shared/deep links). "Enter" drops
  // straight into the app; "Take the tour" runs the step-by-step tutorial (also on the header "?").
  if (new URLSearchParams(location.search).get("land") !== "0") {
    document.body.classList.add("pre-enter");
    showLanding({
      onEnter: () => document.body.classList.remove("pre-enter"),
      onTour: () => { document.body.classList.remove("pre-enter"); tour.open(0); },
    });
  }
  try { [state.contract, state.mapMeta] = await Promise.all([api("contract"), api("polar_map/meta").catch(() => null)]); }
  catch (e) { setStatus(`Can't reach the science server (${e.message}). Start it with ./run.ps1.`, "err"); $("results").innerHTML = ""; return; }
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
  syncInputs(); renderNeedsBox(); renderPanelBox(); renderRelayBox(); renderSources();
  setPane(state.pane); setMode(location.hash.slice(1));
  refresh();
})();
