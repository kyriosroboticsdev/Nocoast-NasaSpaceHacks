import { apiUrl } from '../apiBase';
import { resolveSiteCoords } from '../scenario/catalog';
import type { ScenarioSlot, ScenarioState } from '../scenario/types';
import { formatSlopeArea } from '../terrain/slopes.mjs';
import { createSlopeView, type SlopeSite } from './slopes';

/** Adapt the shared Planner's A/B scenario into the slope screen without changing its assessment engine. */
export function wireSlopeIntegration(): (state: ScenarioState) => void {
  const details = document.getElementById('terrain-slope-details') as HTMLDetailsElement;
  const picker = document.getElementById('slope-slot') as HTMLSelectElement;
  const host = document.getElementById('slope-view')!;
  let sites: SlopeSite[] = [], selected = 'A', view: ReturnType<typeof createSlopeView> | undefined;
  const siteFrom = (slot: ScenarioSlot): SlopeSite => {
    const c = resolveSiteCoords(slot.siteId, slot.customLatDeg, slot.customLonEastDeg);
    return { id: slot.id, name: `Site ${slot.id} · ${c.label}`, lat: c.latitudeDeg, lon: c.longitudeEastDeg };
  };
  const paintBadges = () => {
    for (const slot of ['A', 'B']) {
      const node = document.getElementById(`slope-area-${slot.toLowerCase()}`)!;
      const site = sites.find(s => s.id === slot), area = site && view?.areaFor(site);
      node.hidden = !site || !view;
      node.textContent = !area ? 'Terrain area unknown — open Terrain slopes and area comparison.'
        : `Area within slope limit: ${formatSlopeArea(area.withinAreaM2)} · ≤${area.limitDeg}° · ${formatSlopeArea(area.unknownAreaM2)} unknown in the same 1.24 × 1.24 km window.`;
    }
  };
  const show = () => {
    if (!details.open) { view?.setActive(false); paintBadges(); return; }
    if (!view) view = createSlopeView(host, paintBadges, path => apiUrl(path, import.meta.env.BASE_URL));
    view.setSites(sites);
    view.setSite(sites.find(s => s.id === selected) ?? sites[0]);
    view.setActive(true);
    paintBadges();
  };
  details.addEventListener('toggle', show);
  picker.addEventListener('change', () => { selected = picker.value; show(); });
  let signature = '';
  return state => {
    const next = [siteFrom(state.primary), ...(state.compareEnabled ? [siteFrom(state.secondary)] : [])];
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return; // scrub, date and panel changes do not change terrain
    signature = nextSignature; sites = next;
    if (!sites.some(s => s.id === selected)) selected = 'A';
    picker.replaceChildren(...sites.map(site => {
      const option = document.createElement('option'); option.value = site.id; option.textContent = site.name; return option;
    }));
    picker.value = selected;
    show();
  };
}
