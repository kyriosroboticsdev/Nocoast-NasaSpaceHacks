import { slopeArea, formatSlopeArea, slopeBand, slopeCell, slopeRaster, slopeSummary, validSlopeLimit, validateSlopeGrid } from '../terrain/slopes.mjs';

/** Local map, intentionally independent of the mission's time and GO/NO-GO policy. */
export function createSlopeView(host, onChange = () => {}, requestUrl = path => `/${path}`) {
  host.innerHTML = `
    <header class="slope-heading"><div><h2>Terrain slopes</h2><p id="slope-site">Select a site</p></div><span class="slope-tag">Preliminary</span></header>
    <div class="slope-layout">
      <div class="slope-figure">
        <div class="slope-map-wrap" hidden>
          <canvas id="slope-canvas" tabindex="0" role="img" aria-label="Terrain slope map, north up and east right" aria-describedby="slope-map-help slope-inspection"></canvas>
          <svg class="slope-marks" viewBox="0 0 100 100" aria-hidden="true"><path class="slope-center" d="M47 50h6M50 47v6"/><circle class="slope-cursor" cx="50" cy="50" r="1.3"/></svg>
          <span class="slope-north">N ↑</span><span class="slope-east">E →</span>
        </div>
        <p id="slope-status" role="status" aria-live="polite">Open this view to load terrain slopes.</p>
        <button id="slope-retry" class="btn ghost" type="button" hidden>Retry terrain slopes</button>
        <p id="slope-map-help" class="hint">North up · east right · center cross marks the selected site. Click, tap or use arrow keys on the map to inspect a sample.</p>
        <section class="slope-comparison" aria-label="Terrain area comparison">
          <h3>Compare terrain area</h3>
          <p id="slope-comparison-note" class="hint"></p>
          <div class="slope-table-wrap" tabindex="0" role="region" aria-label="Terrain area comparison table"><table><thead><tr><th scope="col">Site</th><th scope="col">Within slope limit</th><th scope="col">Unknown area</th></tr></thead><tbody id="slope-comparison-rows"></tbody></table></div>
          <button id="slope-comparison-retry" class="btn ghost" type="button" hidden>Retry area comparison</button>
          <p class="hint">Estimated map area across all qualifying patches; it may be scattered, not one continuous landing zone.</p>
        </section>
      </div>
      <aside class="slope-info" aria-label="Slope screening settings">
        <div class="slope-area-summary"><span>Area within slope limit</span><strong id="slope-area-value">Unknown</strong><p id="slope-area-detail" class="hint">Select a site to estimate terrain area.</p></div>
        <label class="field" for="slope-limit">Screening limit (°)<input id="slope-limit" type="number" min="1" max="45" step="any" value="10" required aria-describedby="slope-limit-help slope-limit-error"></label>
        <p id="slope-limit-help" class="hint">10° is an example, not a NASA or lander safety limit.</p>
        <p id="slope-limit-error" class="slope-error" role="alert"></p>
        <div id="slope-legend" class="slope-legend" aria-label="Slope color legend"></div>
        <p id="slope-inspection" class="slope-readout" aria-live="polite">No sample loaded.</p>
        <button id="slope-center" class="btn ghost" type="button" disabled>Inspect site center</button>
        <p id="slope-stats" class="slope-stats"></p>
        <p id="slope-resolution" class="hint"></p>
        <p class="slope-warning">Steepness only; landing safety is unverified. Small rocks and hazards may be unresolved. Slope uncertainty is not modeled. Mission grades are unchanged.</p>
      </aside>
    </div>`;
  const el = id => host.querySelector(`#${id}`), canvas = el('slope-canvas');
  const map = host.querySelector('.slope-map-wrap'), cursor = host.querySelector('.slope-cursor');
  const cache = new Map();
  let current = null, grid = null, active = false, controller = null, key = '', limit = 10, cell = null;
  let sites = [], sitesKey = '', comparisonController = null;
  const comparisonState = new Map();
  const siteKey = site => `${site.lat}:${site.lon}`;
  const inCoverageRegion = site => Number.isFinite(site.lat) && site.lat >= -90 && site.lat <= -60;
  function areaFor(site) {
    if (!site) return null;
    const data = cache.get(siteKey(site));
    return data ? { ...slopeArea(data, limit), limitDeg: limit, widthM: 2 * data.halfExtentM } : null;
  }
  function renderAreas() {
    const area = grid ? slopeArea(grid, limit) : null;
    el('slope-area-value').textContent = formatSlopeArea(area?.withinAreaM2 ?? null);
    el('slope-area-detail').textContent = area
      ? `${area.withinPatchFraction == null ? 'Within-limit area unknown' : `${(100 * area.withinPatchFraction).toFixed(1)}% of the full window mapped at ≤${limit}°`}. ${formatSlopeArea(area.unknownAreaM2)} unknown out of ${formatSlopeArea(area.totalAreaM2)}.`
      : current && !inCoverageRegion(current) ? 'No 5 m terrain coverage outside the south polar region. Choose a polar study site.' : 'Waiting for the selected site’s terrain.';
    el('slope-comparison-note').textContent = `Same 1.24 × 1.24 km window at each site · limit ≤${limit}° · estimated planimetric area.`;
    const rows = el('slope-comparison-rows'); rows.replaceChildren();
    for (const site of sites) {
      const row = document.createElement('tr'), name = document.createElement('th');
      name.scope = 'row'; name.textContent = site.name;
      const area = areaFor(site), status = comparisonState.get(siteKey(site));
      const value = document.createElement('td'), unknown = document.createElement('td');
      value.textContent = area ? formatSlopeArea(area.withinAreaM2) : status === 'unsupported' ? 'Unknown' : status === 'error' ? 'Unavailable' : 'Loading…';
      unknown.textContent = area ? formatSlopeArea(area.unknownAreaM2) : '—';
      if (area) value.title = `${area.withinAreaM2 == null ? 'Unknown' : area.withinAreaM2.toLocaleString('en-US')} m² within limit. ${formatSlopeArea(area.totalAreaM2)} window.`;
      if (current && siteKey(current) === siteKey(site)) row.className = 'selected';
      row.append(name, value, unknown); rows.append(row);
    }
    el('slope-comparison-retry').hidden = !sites.some(s => comparisonState.get(siteKey(s)) === 'error');
    onChange();
  }
  async function compareSites(force = false) {
    comparisonController?.abort();
    const request = new AbortController(); comparisonController = request;
    for (const site of sites) {
      if (request.signal.aborted) return;
      const k = siteKey(site);
      if (!inCoverageRegion(site)) { comparisonState.set(k, 'unsupported'); renderAreas(); continue; }
      if (cache.has(k) && !force) continue;
      comparisonState.set(k, 'loading'); renderAreas();
      const timeout = setTimeout(() => request.abort('timeout'), 30000);
      try {
        const params = new URLSearchParams({ latitudeDeg: String(site.lat), longitudeEastDeg: String(site.lon) });
        const response = await fetch(requestUrl(`api/terrain_slopes?${params}`), { signal: request.signal });
        if (!response.ok) throw new Error('Area request failed.');
        const data = validateSlopeGrid(await response.json(), site);
        if (request.signal.aborted || comparisonController !== request) return;
        if (cache.size >= 8 && !cache.has(k)) cache.delete(cache.keys().next().value);
        cache.set(k, data); comparisonState.set(k, 'ready');
      } catch {
        if (comparisonController !== request) return;
        comparisonState.set(k, 'error');
        // A timed-out batch cannot process its remaining sites with the aborted signal.
        if (request.signal.aborted) {
          for (const remaining of sites) if (!cache.has(siteKey(remaining))) comparisonState.set(siteKey(remaining), 'error');
          renderAreas(); return;
        }
      } finally { clearTimeout(timeout); }
      renderAreas();
    }
    if (comparisonController === request) { comparisonController = null; renderAreas(); }
  }
  function legend() {
    const half = +(limit / 2).toFixed(3);
    el('slope-legend').innerHTML = `<span><i class="lower"></i>0–${half}° · lower</span><span><i class="near"></i>&gt;${half}–${limit}° · near limit</span><span><i class="above"></i>&gt;${limit}° · above limit</span><span><i class="unknown"></i>Unknown / grid edge</span>`;
  }
  function inspect() {
    if (!grid || !cell) return;
    const v = grid.slopeDeg[cell.row * grid.n + cell.col];
    const east = (cell.col - (grid.n - 1) / 2) * grid.gridSpacingM;
    const north = (cell.row - (grid.n - 1) / 2) * grid.gridSpacingM;
    const text = v == null ? 'Unknown slope' : `${v.toFixed(1)}° · ${slopeBand(v, limit) === 'above' ? 'above limit' : 'within limit'}`;
    el('slope-inspection').textContent = `${text} · ${east.toFixed(0)} m east, ${north.toFixed(0)} m north of site`;
    // Centered on raster sample pixels; API samples are node registered.
    cursor.setAttribute('cx', String(100 * (cell.col + 0.5) / grid.n));
    cursor.setAttribute('cy', String(100 * (grid.n - cell.row - 0.5) / grid.n));
  }
  function paint() {
    legend();
    renderAreas();
    if (!grid) return;
    canvas.width = canvas.height = grid.n;
    canvas.getContext('2d').putImageData(new ImageData(slopeRaster(grid, limit), grid.n, grid.n), 0, 0);
    const s = slopeSummary(grid, limit);
    el('slope-stats').textContent = `${(100 * grid.knownFraction).toFixed(1)}% of samples known. ${s.withinFraction == null ? 'Within-limit fraction unknown.' : `${(100 * s.withinFraction).toFixed(1)}% of known samples at or below ${limit}°.`}`;
    el('slope-resolution').textContent = `${(2 * grid.halfExtentM / 1000).toFixed(2)} km square · ${grid.gridSpacingM} m grid · ${grid.demPixelSpacingM} m DEM pixels · ${grid.gradientBaselineM} m difference baseline. Gray: missing data, grid edge or tile seam.`;
    inspect();
  }
  async function load(force = false) {
    if (!active || !current) return;
    const site = { ...current }, nextKey = `${site.lat}:${site.lon}`;
    if (!force && nextKey === key && (grid || controller)) return;
    controller?.abort(); const request = new AbortController(); controller = request;
    key = nextKey; grid = null; cell = null; map.hidden = true;
    el('slope-site').textContent = `${site.name} · ${site.lat.toFixed(4)}°, ${site.lon.toFixed(4)}°E`;
    el('slope-stats').textContent = ''; el('slope-resolution').textContent = '';
    renderAreas();
    el('slope-inspection').textContent = 'No sample loaded.'; el('slope-center').disabled = true;
    el('slope-retry').hidden = true; host.setAttribute('aria-busy', 'true');
    el('slope-status').textContent = 'Loading 5 m terrain slopes…';
    if (!inCoverageRegion(site)) {
      el('slope-status').textContent = 'No 5 m terrain coverage outside the south polar region. Choose a polar study site.';
      controller = null; host.setAttribute('aria-busy', 'false'); return;
    }
    const timeout = setTimeout(() => request.abort('timeout'), 30000);
    try {
      let data = cache.get(nextKey);
      if (!data || force) {
        const params = new URLSearchParams({ latitudeDeg: String(site.lat), longitudeEastDeg: String(site.lon) });
        const r = await fetch(requestUrl(`api/terrain_slopes?${params}`), { signal: request.signal });
        if (!r.ok) throw new Error(r.status === 503 ? 'Terrain files are unavailable on the science server.' : `Slope request failed (${r.status}).`);
        data = validateSlopeGrid(await r.json(), site);
        if (request.signal.aborted || controller !== request) return;
        if (cache.size >= 8) cache.delete(cache.keys().next().value);
        cache.set(nextKey, data);
      }
      if (request.signal.aborted || controller !== request) return;
      grid = data; cell = { row: (grid.n - 1) / 2, col: (grid.n - 1) / 2 };
      const known = grid.slopeDeg.some(v => v !== null);
      map.hidden = false; el('slope-center').disabled = false;
      el('slope-status').textContent = known ? '5 m DEM slope screen. Independent of sunlight and panel settings.' : 'No 5 m slope coverage here. Gray means unknown; try CR1 or SR1.';
      paint();
    } catch (e) {
      if (controller !== request || (request.signal.aborted && request.signal.reason !== 'timeout')) return;
      el('slope-status').textContent = request.signal.reason === 'timeout' ? 'Slope request timed out. Check the science server and retry.' : `${e.message} Check the science server and retry.`;
      el('slope-retry').hidden = false;
    } finally {
      clearTimeout(timeout);
      if (controller === request) { controller = null; host.setAttribute('aria-busy', 'false'); }
    }
  }
  el('slope-limit').addEventListener('input', () => {
    const value = el('slope-limit').valueAsNumber;
    if (!validSlopeLimit(value)) { el('slope-limit-error').textContent = 'Use a number from 1° to 45°. The last valid limit is still shown.'; return; }
    el('slope-limit-error').textContent = ''; limit = value; paint();
  });
  el('slope-center').addEventListener('click', () => { if (grid) { cell = { row: (grid.n - 1) / 2, col: (grid.n - 1) / 2 }; inspect(); } });
  el('slope-retry').addEventListener('click', () => { void load(true); });
  el('slope-comparison-retry').addEventListener('click', () => { void compareSites(); });
  canvas.addEventListener('pointerdown', e => {
    if (!grid) return;
    const box = canvas.getBoundingClientRect();
    cell = slopeCell((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height, grid.n);
    canvas.focus(); inspect();
  });
  canvas.addEventListener('keydown', e => {
    if (!grid || !cell) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (!moves[e.key]) return;
    e.preventDefault(); const [dx, dy] = moves[e.key];
    cell = { col: Math.max(0, Math.min(grid.n - 1, cell.col + dx)), row: Math.max(0, Math.min(grid.n - 1, cell.row + dy)) }; inspect();
  });
  legend();
  return {
    setSite(site) { current = site; if (active) void load(); },
    setSites(value) {
      const nextKey = JSON.stringify(value.map(s => [s.id, s.name, s.lat, s.lon]));
      if (nextKey === sitesKey) return;
      sitesKey = nextKey; sites = value.map(s => ({ ...s }));
      void compareSites();
    },
    areaFor,
    setActive(value) {
      active = value;
      if (active) void load();
      else { controller?.abort(); controller = null; host.setAttribute('aria-busy', 'false'); }
    },
  };
}
