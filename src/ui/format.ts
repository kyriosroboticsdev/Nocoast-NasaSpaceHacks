export function fmtPct(n: number) {
  return `${n.toFixed(0)}%`;
}

export function fmtHours(n: number | null) {
  if (n == null) return '— (through window)';
  if (n === 0) return 'now / already set';
  if (n < 1) return `${Math.round(n * 60)} min`;
  if (n < 48) return `${n.toFixed(1)} h`;
  return `${(n / 24).toFixed(1)} d`;
}

export function fmtDeg(n: number | null | undefined, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}°`;
}

export function fmtPower(w: number | null | undefined) {
  if (w == null || !Number.isFinite(w)) return 'Unknown';
  if (w < 1) return `${(w * 1000).toFixed(0)} mW`;
  return `${w.toFixed(1)} W`;
}

export function viabilityClass(v: string) {
  if (v === 'GO') return 'go';
  if (v === 'RISKY') return 'risky';
  if (v === 'UNKNOWN') return 'unknown';
  return 'nogo';
}

export function localDateInputValue(iso: string) {
  // datetime-local wants local wall without Z; we keep UTC semantics by showing UTC digits.
  return iso.slice(0, 16);
}

export function dateInputToUtcIso(value: string) {
  if (!value) return new Date().toISOString();
  const iso = value.length === 16 ? `${value}:00.000Z` : value.endsWith('Z') ? value : `${value}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}

export function fmtEnergy(wh: number | null | undefined) {
  if (wh == null || !Number.isFinite(wh)) return 'Unknown';
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh.toFixed(1)} Wh`;
}
