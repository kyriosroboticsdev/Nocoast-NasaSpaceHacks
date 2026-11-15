// "Find the best landing site" tool. The user gives a mission window (start/end dates, with optional
// landing/leaving times); we score every built-in south-pole site for that exact window using the app's
// overall viability score and recommend the top one. This module is the dialog UI only — the analysis and
// ranking live in app.js (passed in as `onFind`), so this file stays free of science/state concerns.

const VLABEL = { go: "GO", caution: "CAUTION", nogo: "NO-GO", unknown: "CAN'T TELL", preliminary: "PRELIMINARY" };

export function initBestSite({ supported, getCurrent, onFind, onUse }) {
  const root = document.createElement("div");
  root.className = "bestsite";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "bestsite-title");
  const maxDays = Math.round(supported.maxSeconds / 86400);
  root.innerHTML = `
    <div class="bestsite-scrim" data-close></div>
    <div class="bestsite-card" role="document">
      <button class="bestsite-x" data-close aria-label="Close">&#10005;</button>
      <h2 id="bestsite-title">Find the best landing site</h2>
      <p class="bestsite-sub">Set the days you need to be on the surface. We'll score every south-pole site for
        that exact window and recommend the one with the best overall viability.</p>
      <form class="bestsite-form" id="bestsite-form" novalidate>
        <div class="bestsite-row">
          <label>Start date<input type="date" id="bs-start" required></label>
          <label>End date<input type="date" id="bs-end" required></label>
        </div>
        <div class="bestsite-row">
          <label>Landing time <span class="opt">optional &middot; UTC</span><input type="time" id="bs-land"></label>
          <label>Leaving time <span class="opt">optional &middot; UTC</span><input type="time" id="bs-leave"></label>
        </div>
        <p class="bestsite-note">Times default to 00:00 UTC. Data covers 2027; a stay can be at most ${maxDays} days.</p>
        <p class="bestsite-err" id="bs-err" hidden></p>
        <div class="bestsite-actions">
          <button type="submit" class="btn primary" id="bs-go">Find best site</button>
        </div>
      </form>
      <div class="bestsite-results" id="bs-results" hidden></div>
    </div>`;
  document.body.append(root);
  const q = (s) => root.querySelector(s);

  const minDate = supported.start.slice(0, 10);
  const maxDate = supported.end.slice(0, 10);
  for (const id of ["#bs-start", "#bs-end"]) { q(id).min = minDate; q(id).max = maxDate; }

  function close() { root.hidden = true; }
  root.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  document.addEventListener("keydown", (e) => { if (!root.hidden && e.key === "Escape") close(); });

  function err(msg) { const el = q("#bs-err"); el.textContent = msg || ""; el.hidden = !msg; }

  q("#bestsite-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    err("");
    const sd = q("#bs-start").value;
    const ed = q("#bs-end").value;
    if (!sd || !ed) return err("Pick a start and end date.");
    const lt = q("#bs-land").value || "00:00";
    const vt = q("#bs-leave").value || "00:00";
    const start = new Date(`${sd}T${lt}:00Z`);
    const end = new Date(`${ed}T${vt}:00Z`);
    if (Number.isNaN(+start) || Number.isNaN(+end)) return err("That date or time isn't valid.");
    if (!(start < end)) return err("The end must be after the start.");
    if (start < new Date(supported.start) || end > new Date(supported.end)) return err("Dates must fall within 2027 (the data range).");
    if ((end - start) / 1000 > supported.maxSeconds) return err(`A stay can be at most ${maxDays} days.`);

    const go = q("#bs-go");
    go.disabled = true;
    go.textContent = "Scoring sites…";
    const res = q("#bs-results");
    res.hidden = false;
    res.innerHTML = `<p class="bestsite-busy">Scoring every site for ${sd} &rarr; ${ed}…</p>`;
    try {
      const ranked = await onFind(start, end);
      renderResults(ranked);
    } catch (e2) {
      res.innerHTML = `<p class="bestsite-err" aria-live="polite">Couldn't score sites: ${e2.message}</p>`;
    } finally {
      go.disabled = false;
      go.textContent = "Find best site";
    }
  });

  function renderResults(ranked) {
    const res = q("#bs-results");
    const scored = ranked.filter((r) => r.total != null);
    if (!scored.length) {
      res.innerHTML = `<p class="bestsite-err">No site could be scored for that window — try a different date range.</p>`;
      return;
    }
    const best = ranked[0];
    const chip = (label, val) => (val == null ? "" : `<span class="bestsite-chip">${label} ${val}</span>`);
    res.innerHTML = `
      <div class="bestsite-best">
        <div class="bestsite-best-tag">Recommended</div>
        <div class="bestsite-best-name">${best.name}</div>
        <div class="bestsite-best-meta">
          <span class="v v-${best.verdict}">${VLABEL[best.verdict] || best.verdict}</span>
          ${chip("Score", best.total)}${chip("Sun", best.sunPct != null ? best.sunPct + "%" : null)}${chip("Earth", best.commPct != null ? best.commPct + "%" : null)}
        </div>
        <button class="btn primary" data-use="${best.id}">Use this site</button>
      </div>
      <ol class="bestsite-list" aria-label="All sites ranked">
        ${ranked.map((r, i) => `<li class="${i === 0 ? "is-best" : ""}">
          <span class="bestsite-rank">${i + 1}</span>
          <span class="bestsite-li-name">${r.name}</span>
          <span class="v v-${r.verdict}">${VLABEL[r.verdict] || r.verdict}</span>
          <span class="bestsite-li-score">${r.total == null ? "—" : r.total}</span>
          <button class="link" data-use="${r.id}">Use</button>
        </li>`).join("")}
      </ol>`;
    res.querySelectorAll("[data-use]").forEach((b) =>
      b.addEventListener("click", () => { onUse(b.dataset.use); close(); }));
  }

  function open() {
    err("");
    q("#bs-results").hidden = true;
    q("#bs-results").innerHTML = "";
    const cur = getCurrent?.();
    if (cur) { q("#bs-start").value = cur.start.slice(0, 10); q("#bs-end").value = cur.end.slice(0, 10); }
    q("#bs-land").value = "";
    q("#bs-leave").value = "";
    root.hidden = false;
    q("#bs-start").focus();
  }

  return { open };
}
