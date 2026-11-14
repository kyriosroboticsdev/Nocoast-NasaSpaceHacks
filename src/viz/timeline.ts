import type { MissionAssessment, TimeWindow } from '../assess/windows';
import { findBestWindow } from '../assess/decision';

export type TimelineHighlight = {
  kind: 'simultaneous' | 'sunlight' | 'earth' | 'none';
  window: TimeWindow | null;
};

/** Gantt-style sunlight / Earth LOS timeline with best-window highlighter. */
export function renderTimeline(
  canvas: HTMLCanvasElement,
  assessment: MissionAssessment,
  scrubUtc: string,
  secondary?: MissionAssessment | null,
  highlight?: TimelineHighlight | null,
) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || (secondary ? 120 : 96);
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

  const rows = secondary
    ? [
        { label: `${assessment.siteLabel} sun`, windows: assessment.sunlightWindows, color: '#e6b84d' },
        { label: `${assessment.siteLabel} Earth`, windows: assessment.earthWindows, color: '#5aa8e6' },
        { label: `${assessment.siteLabel} ∩`, windows: assessment.simultaneousWindows, color: '#7de4d4' },
        { label: `${secondary.siteLabel} sun`, windows: secondary.sunlightWindows, color: '#c49a3c' },
        { label: `${secondary.siteLabel} Earth`, windows: secondary.earthWindows, color: '#3f87c4' },
        { label: `${secondary.siteLabel} ∩`, windows: secondary.simultaneousWindows, color: '#5bb8aa' },
      ]
    : [
        { label: 'Sunlight', windows: assessment.sunlightWindows, color: '#e6b84d' },
        { label: 'Earth LOS', windows: assessment.earthWindows, color: '#5aa8e6' },
        { label: 'Sun ∩ Earth', windows: assessment.simultaneousWindows, color: '#7de4d4' },
      ];

  const t0 = Date.parse(assessment.samples[0]?.utc ?? scrubUtc);
  const t1 = Date.parse(assessment.samples[assessment.samples.length - 1]?.utc ?? scrubUtc);
  const span = Math.max(1, t1 - t0);
  const labelW = secondary ? 128 : 100;
  const trackX = labelW;
  const trackW = w - labelW - 8;
  const rowH = h / rows.length;
  const maxLabel = secondary ? 20 : 16;

  const best = highlight ?? findBestWindow(assessment);
  if (best.window) {
    const x0 = trackX + ((Date.parse(best.window.startUtc) - t0) / span) * trackW;
    const x1 = trackX + ((Date.parse(best.window.endUtc) - t0) / span) * trackW;
    ctx.fillStyle = 'rgba(125, 228, 212, 0.14)';
    ctx.fillRect(x0, 0, Math.max(3, x1 - x0), h);
    ctx.strokeStyle = 'rgba(125, 228, 212, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x0 + 0.5, 1, Math.max(3, x1 - x0) - 1, h - 2);
    ctx.setLineDash([]);
  }

  rows.forEach((row, i) => {
    const y = i * rowH;
    ctx.fillStyle = '#8aa0b8';
    ctx.font = '11px system-ui, sans-serif';
    const label = row.label.length > maxLabel ? `${row.label.slice(0, maxLabel - 1)}…` : row.label;
    ctx.fillText(label, 6, y + rowH * 0.62);
    ctx.fillStyle = '#18293b';
    ctx.fillRect(trackX, y + 8, trackW, rowH - 16);
    for (const win of row.windows) {
      const x0 = trackX + ((Date.parse(win.startUtc) - t0) / span) * trackW;
      const x1 = trackX + ((Date.parse(win.endUtc) - t0) / span) * trackW;
      ctx.fillStyle = row.color;
      ctx.fillRect(x0, y + 8, Math.max(2, x1 - x0), rowH - 16);
    }
  });

  const scrubX = trackX + ((Date.parse(scrubUtc) - t0) / span) * trackW;
  ctx.strokeStyle = '#edf4ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(scrubX, 0);
  ctx.lineTo(scrubX, h);
  ctx.stroke();

  if (best.window) {
    ctx.fillStyle = '#7de4d4';
    ctx.font = '10px system-ui, sans-serif';
    const kindLabel =
      best.kind === 'simultaneous' ? 'Best ∩' :
      best.kind === 'sunlight' ? 'Best sun' :
      best.kind === 'earth' ? 'Best Earth' : '';
    if (kindLabel) {
      const x0 = trackX + ((Date.parse(best.window.startUtc) - t0) / span) * trackW;
      ctx.fillText(`${kindLabel} ${best.window.hours.toFixed(1)}h`, Math.min(x0 + 4, w - 72), 12);
    }
  }
}
