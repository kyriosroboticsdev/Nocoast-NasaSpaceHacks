import type { HorizonProfile } from '../horizon/types';

export type SkylineMarkers = {
  sunAz: number;
  sunEl: number;
  sunClear: boolean | null;
  earthAz: number;
  earthEl: number;
  earthClear: boolean | null;
};

/** Draw 360° skyline ribbon into a canvas. */
export function renderSkyline(
  canvas: HTMLCanvasElement,
  profile: HorizonProfile,
  markers?: SkylineMarkers,
) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 140;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW;
  const h = cssH;
  ctx.clearRect(0, 0, w, h);

  // Background sky → ground
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0b1a2c');
  grad.addColorStop(0.55, '#142536');
  grad.addColorStop(0.55, '#1a140e');
  grad.addColorStop(1, '#0e0a07');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const elevs = profile.bins.map(b => b.elevationDeg).filter((v): v is number => v != null);
  if (markers) {
    elevs.push(markers.sunEl, markers.earthEl);
  }
  const dataMin = elevs.length ? Math.min(...elevs) : -10;
  const dataMax = elevs.length ? Math.max(...elevs) : 20;
  const elMin = Math.min(-15, Math.floor(dataMin - 5));
  const elMax = Math.max(25, Math.ceil(dataMax + 5));
  const yOf = (el: number) => h * (1 - (el - elMin) / (elMax - elMin));
  const xOf = (az: number) => (az / 360) * w;

  // Zero horizon reference
  ctx.strokeStyle = '#3d5268';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, yOf(0));
  ctx.lineTo(w, yOf(0));
  ctx.stroke();
  ctx.setLineDash([]);

  // Terrain skyline
  ctx.beginPath();
  let started = false;
  for (const bin of profile.bins) {
    if (bin.elevationDeg == null || bin.status === 'gap') {
      if (started) {
        ctx.stroke();
        started = false;
      }
      continue;
    }
    const x = xOf(bin.azimuthDeg);
    const y = yOf(bin.elevationDeg);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = profile.model === 'sphere_optimistic' ? '#c4a35a' : '#7de4d4';
  ctx.lineWidth = 2;
  if (started) ctx.stroke();

  // Fill under skyline (terrain)
  ctx.beginPath();
  let fillStarted = false;
  let firstX = 0;
  for (const bin of profile.bins) {
    if (bin.elevationDeg == null || bin.status === 'gap') {
      if (fillStarted) {
        ctx.lineTo(xOf(bin.azimuthDeg), h);
        ctx.lineTo(firstX, h);
        ctx.closePath();
        ctx.fillStyle = 'rgba(30, 48, 64, 0.85)';
        ctx.fill();
        fillStarted = false;
      }
      continue;
    }
    const x = xOf(bin.azimuthDeg);
    const y = yOf(bin.elevationDeg);
    if (!fillStarted) {
      firstX = x;
      ctx.moveTo(x, y);
      fillStarted = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  if (fillStarted) {
    ctx.lineTo(w, h);
    ctx.lineTo(firstX, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(30, 48, 64, 0.85)';
    ctx.fill();
  }

  if (markers) {
    drawMarker(ctx, xOf(markers.sunAz), yOf(markers.sunEl), '#ffcc66', '☉', markers.sunClear);
    drawMarker(ctx, xOf(markers.earthAz), yOf(markers.earthEl), '#6eb6ff', '♁', markers.earthClear);
  }

  // Azimuth ticks
  ctx.fillStyle = '#8aa0b8';
  ctx.font = '10px ui-monospace, monospace';
  for (const [az, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']] as const) {
    const x = xOf(az);
    ctx.fillText(label, x + 3, h - 4);
    ctx.strokeStyle = '#2b3c50';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  if (profile.model === 'sphere_optimistic') {
    ctx.fillStyle = '#c4a35a';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('Sphere horizon · optimistic / terrain unknown', 8, 14);
  } else if (profile.model === 'lola_overview_coarse') {
    ctx.fillStyle = '#7de4d4';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('LOLA overview · true-north az · coarse search grade', 8, 14);
  }
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  glyph: string,
  clear: boolean | null,
) {
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = clear === false ? 0.35 : 1;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#0a111a';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#0a111a';
  ctx.font = '10px system-ui';
  ctx.fillText(glyph, x - 4, y + 3);
  if (clear === false) {
    ctx.strokeStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.moveTo(x - 9, y - 9);
    ctx.lineTo(x + 9, y + 9);
    ctx.stroke();
  }
}
