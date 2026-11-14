import type { StateSegment } from '../power/mission';

/** Export the visibility owner's midpoint transition convention for mission policy.
 * No celestial positioning or terrain obstruction is recalculated here.
 */
export function communicationTimeline(samples: Array<{ utc: string; earthLos: boolean | null }>): StateSegment[] {
  if (samples.length < 2) throw new Error('Communication needs both mission boundaries.');
  const origin = Date.parse(samples[0].utc), out: StateSegment[] = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    const start = (Date.parse(a.utc) - origin) / 1000, end = (Date.parse(b.utc) - origin) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid communication timestamps.');
    if (a.earthLos === b.earthLos) out.push({ startOffsetSeconds: start, endOffsetSeconds: end, available: a.earthLos });
    else {
      const mid = (start + end) / 2;
      out.push({ startOffsetSeconds: start, endOffsetSeconds: mid, available: a.earthLos },
        { startOffsetSeconds: mid, endOffsetSeconds: end, available: b.earthLos });
    }
  }
  return out;
}
