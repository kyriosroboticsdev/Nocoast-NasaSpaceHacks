import type { MissionAssessment, TimeWindow } from '../assess/windows';
import { findBestWindow } from '../assess/decision';

export type TimelineHighlight = {
  kind: 'simultaneous' | 'sunlight' | 'earth' | 'none';
  window: TimeWindow | null;
};

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Fraction of [t0, t1] covered by the given windows (clipped). */
function coverage(windows: TimeWindow[], t0: number, t1: number): number {
  let covered = 0;
  for (const win of windows) {
    const a = Math.max(t0, Date.parse(win.startUtc));
    const b = Math.min(t1, Date.parse(win.endUtc));
    if (b > a) covered += b - a;
  }
  return covered / Math.max(1, t1 - t0);
}

function dayShade(bothFrac: number): string {
  if (bothFrac >= 0.5) return 'rgba(61, 207, 142, 0.14)';   // green — healthy day
  if (bothFrac >= 0.15) return 'rgba(230, 184, 77, 0.12)';  // amber — thin margins
  return 'rgba(224, 112, 112, 0.10)';                       // red — dead day
}

/**
 * Mission-week calendar: one column per Earth day (UTC) with green/amber/red
 * shading from the sun+Earth coverage of that day, and icon-labeled rows for
 * sunlight / Earth contact / both-at-once. Click-to-scrub is wired by the app
 * shell via the t0/t1/trackX/trackW values stored on the canvas dataset.
 */
export function renderTimeline(
  canvas: HTMLCanvasElement,
  assessment: MissionAssessment,
  scrubUtc: string,
  secondary?: MissionAssessment | null,
  highlight?: TimelineHighlight | null,
) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || (secondary ? 190 : 150);
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW;
  const h = cssH;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#101b28';
  ctx.fillRect(0, 0, w, h);

  type Row = { icon: string; label: string; windows: TimeWindow[]; color: string };
  const siteRows = (a: MissionAssessment, dim = false): Row[] => [
    { icon: '☀️', label: 'Sunlight', windows: a.sunlightWindows, color: dim ? '#c49a3c' : '#e6b84d' },
    { icon: '📡', label: 'Earth', windows: a.earthWindows, color: dim ? '#3f87c4' : '#5aa8e6' },
    { icon: '✓', label: 'Both', windows: a.simultaneousWindows, color: dim ? '#5bb8aa' : '#7de4d4' },
  ];
  const blocks: Array<{ title: string; rows: Row[]; a: MissionAssessment }> = [
    { title: assessment.siteLabel, rows: siteRows(assessment), a: assessment },
  ];
  if (secondary) blocks.push({ title: secondary.siteLabel, rows: siteRows(secondary, true), a: secondary });

  const t0 = Date.parse(assessment.samples[0]?.utc ?? scrubUtc);
  const t1 = Date.parse(assessment.samples[assessment.samples.length - 1]?.utc ?? scrubUtc);
  const span = Math.max(1, t1 - t0);
  const labelW = 108;
  const trackX = labelW;
  const trackW = w - labelW - 8;
  const headerH = 18;
  const blockGap = 8;
  const blockH = (h - headerH - blockGap * (blocks.length - 1)) / blocks.length;
  const titleH = blocks.length > 1 ? 13 : 0;
  const rowH = (blockH - titleH) / 3;

  // Expose geometry for click-to-scrub / hover readout in the app shell.
  canvas.dataset.t0 = String(t0);
  canvas.dataset.t1 = String(t1);
  canvas.dataset.trackX = String(trackX);
  canvas.dataset.trackW = String(trackW);

  // Day columns: shading (site A health) + grid + date labels.
  const firstDay = Math.floor(t0 / DAY_MS) * DAY_MS;
  const days: number[] = [];
  for (let d = firstDay; d < t1; d += DAY_MS) days.push(d);
  const labelEvery = Math.max(1, Math.ceil(days.length / 10));
  ctx.font = '10px system-ui, sans-serif';
  days.forEach((dayStart, i) => {
    const a = Math.max(t0, dayStart);
    const b = Math.min(t1, dayStart + DAY_MS);
    const x0 = trackX + ((a - t0) / span) * trackW;
    const x1 = trackX + ((b - t0) / span) * trackW;
    const bothFrac = coverage(assessment.simultaneousWindows, a, b);
    ctx.fillStyle = dayShade(bothFrac);
    ctx.fillRect(x0, headerH, x1 - x0, h - headerH);
    ctx.strokeStyle = 'rgba(164, 182, 204, 0.18)';
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, headerH);
    ctx.lineTo(x0 + 0.5, h);
    ctx.stroke();
    if (i % labelEvery === 0 && x1 - x0 > 26) {
      const date = new Date(dayStart);
      ctx.fillStyle = '#a4b6cc';
      ctx.fillText(`${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`, x0 + 3, 12);
    }
  });

  // Best-window highlight behind the bars.
  const best = highlight ?? findBestWindow(assessment);
  if (best.window) {
    const x0 = trackX + ((Date.parse(best.window.startUtc) - t0) / span) * trackW;
    const x1 = trackX + ((Date.parse(best.window.endUtc) - t0) / span) * trackW;
    ctx.fillStyle = 'rgba(125, 228, 212, 0.12)';
    ctx.fillRect(x0, headerH, Math.max(3, x1 - x0), h - headerH);
    ctx.strokeStyle = 'rgba(125, 228, 212, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x0 + 0.5, headerH + 1, Math.max(3, x1 - x0) - 1, h - headerH - 2);
    ctx.setLineDash([]);
  }

  blocks.forEach((block, bi) => {
    const yBlock = headerH + bi * (blockH + blockGap);
    if (titleH) {
      ctx.fillStyle = '#8aa0b8';
      ctx.font = '600 10px system-ui, sans-serif';
      const title = block.title.length > 24 ? `${block.title.slice(0, 23)}…` : block.title;
      ctx.fillText(title, 6, yBlock + 10);
    }
    block.rows.forEach((row, ri) => {
      const y = yBlock + titleH + ri * rowH;
      ctx.fillStyle = '#8aa0b8';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${row.icon} ${row.label}`, 6, y + rowH * 0.66);
      ctx.fillStyle = 'rgba(24, 41, 59, 0.75)';
      ctx.fillRect(trackX, y + 4, trackW, rowH - 8);
      for (const win of row.windows) {
        const x0 = trackX + ((Date.parse(win.startUtc) - t0) / span) * trackW;
        const x1 = trackX + ((Date.parse(win.endUtc) - t0) / span) * trackW;
        ctx.fillStyle = row.color;
        ctx.fillRect(x0, y + 4, Math.max(2, x1 - x0), rowH - 8);
      }
    });
  });

  // Scrub cursor on top.
  const scrubX = trackX + ((Date.parse(scrubUtc) - t0) / span) * trackW;
  ctx.strokeStyle = '#edf4ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(scrubX, headerH - 4);
  ctx.lineTo(scrubX, h);
  ctx.stroke();

  if (best.window) {
    ctx.fillStyle = '#7de4d4';
    ctx.font = '10px system-ui, sans-serif';
    const kindLabel =
      best.kind === 'simultaneous' ? 'Best both' :
      best.kind === 'sunlight' ? 'Best sun' :
      best.kind === 'earth' ? 'Best Earth' : '';
    if (kindLabel) {
      const x0 = trackX + ((Date.parse(best.window.startUtc) - t0) / span) * trackW;
      ctx.fillText(`${kindLabel} ${best.window.hours.toFixed(1)}h`, Math.min(x0 + 4, w - 84), headerH + 10);
    }
  }
}
