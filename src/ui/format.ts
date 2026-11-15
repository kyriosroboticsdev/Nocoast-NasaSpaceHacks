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

/** Icon so the grade never relies on color alone (color-blind safety). */
export function viabilityIcon(v: string) {
  if (v === 'GO') return '✓';
  if (v === 'RISKY') return '⚠';
  return '✗';
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
  if (wh > 0 && wh < 0.05) return '<0.1 Wh';
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh.toFixed(1)} Wh`;
}

export function fmtDuration(seconds: number | null | undefined) {
  if (seconds == null) return 'Unknown';
  if (seconds === 0) return 'None';
  if (seconds < 0.1) return `${seconds.toPrecision(2)} s`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(2)} h`;
}

export function fmtAvailability(fraction: number | null | undefined) {
  if (fraction == null || !Number.isFinite(fraction)) return 'Unknown';
  if (fraction === 1) return '100%';
  if (fraction > 0.9995) return '<100%';
  if (fraction === 0) return '0%';
  return `${(fraction * 100).toFixed(1)}%`;
}
