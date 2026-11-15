// Downloadable share card: a 1200x630 PNG (standard social/OG size) with the verdict, site, date, the
// key numbers, and a mini mission-timeline — the visual twin of "Copy link", for posting or slides.
// Pure renderer: the app assembles a plain data object and this draws + downloads it. No app state here.

const W = 1200, H = 630;
const C = {
  bg: "#060b18", panel: "#0b1429", line: "#1d2c52", text: "#eef2fa", muted: "#b2bdd3", faint: "#8e9bb8",
  blue: "#0b3d91", go: "#2fa36b", caution: "#f2b33d", nogo: "#fc3d21", unknown: "#5b6478",
  sun: "#f2c94c", earth: "#4f8fe8", ok: "#2fa36b", bad: "#fc3d21", none: "#26324a", gap: "#5b6478",
};
const VC = { go: C.go, caution: C.caution, nogo: C.nogo, unknown: C.unknown };
const font = (w, px) => `${w} ${px}px 'Public Sans', system-ui, -apple-system, Segoe UI, sans-serif`;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** Render the card to a canvas and return it. `data` is produced by the app (see buildCardData there). */
export function renderCard(data) {
  const canvas = document.createElement("canvas");
  const scale = 2;                               // crisp on retina / when embedded in slides
  canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  // Background + subtle top band in NASA blue.
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.blue; ctx.fillRect(0, 0, W, 8);

  const pad = 56;
  // Brand row.
  ctx.fillStyle = C.nogo; roundRect(ctx, pad, 44, 14, 14, 3); ctx.fill();
  ctx.fillStyle = C.text; ctx.font = font(700, 26); ctx.textBaseline = "alphabetic";
  ctx.fillText("NoCoast", pad + 26, 60);
  ctx.fillStyle = C.faint; ctx.font = font(500, 16);
  ctx.textAlign = "right"; ctx.fillText("Lunar south-pole landing check", W - pad, 60); ctx.textAlign = "left";

  // Verdict badge.
  const vcol = VC[data.verdict] || C.unknown;
  ctx.font = font(800, 30);
  const vlabel = data.verdictLabel.toUpperCase();
  const vw = ctx.measureText(vlabel).width + 44;
  roundRect(ctx, pad, 104, vw, 56, 8); ctx.fillStyle = vcol; ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textBaseline = "middle";
  ctx.fillText(vlabel, pad + 22, 134);
  ctx.textBaseline = "alphabetic";

  // Site + date.
  ctx.fillStyle = C.text; ctx.font = font(700, 48);
  ctx.fillText(data.site, pad, 230);
  ctx.fillStyle = C.muted; ctx.font = font(500, 22);
  ctx.fillText([data.where, data.dateLabel, data.stayLabel].filter(Boolean).join("  ·  "), pad, 266);

  // Reason sentence (wrapped).
  ctx.fillStyle = C.text; ctx.font = font(400, 22);
  const lines = wrap(ctx, data.reason, W - pad * 2).slice(0, 2);
  lines.forEach((ln, k) => ctx.fillText(ln, pad, 312 + k * 32));

  // Metric chips.
  const metrics = (data.metrics || []).slice(0, 4);
  const chipW = (W - pad * 2 - 18 * (metrics.length - 1)) / Math.max(1, metrics.length);
  const chipY = 372, chipH = 92;
  metrics.forEach((m, k) => {
    const x = pad + k * (chipW + 18);
    roundRect(ctx, x, chipY, chipW, chipH, 8); ctx.fillStyle = C.panel; ctx.fill();
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = C.faint; ctx.font = font(600, 14);
    ctx.fillText(String(m.label).toUpperCase(), x + 16, chipY + 28);
    ctx.fillStyle = m.status === "fail" ? C.nogo : m.status === "pass" ? C.go : C.text;
    ctx.font = font(700, 30); ctx.fillText(m.value, x + 16, chipY + 62);
    if (m.sub) { ctx.fillStyle = C.faint; ctx.font = font(400, 13); ctx.fillText(m.sub, x + 16, chipY + 82); }
  });

  // Mini timeline.
  const tlX = pad, tlW = W - pad * 2, tlY = 496, labelW = 108, barX = tlX + labelW, barW = tlW - labelW, rowH = 12, gap = 8;
  (data.bands || []).forEach((band, k) => {
    const y = tlY + k * (rowH + gap);
    ctx.fillStyle = C.muted; ctx.font = font(500, 14); ctx.textBaseline = "middle";
    ctx.fillText(band.label, tlX, y + rowH / 2);
    ctx.fillStyle = C.none; roundRect(ctx, barX, y, barW, rowH, 3); ctx.fill();
    for (const [a, b, col] of band.spans) {
      const xa = barX + a * barW, xb = barX + b * barW;
      ctx.fillStyle = col; ctx.fillRect(xa, y, Math.max(1, xb - xa), rowH);
    }
    ctx.textBaseline = "alphabetic";
  });

  // Footer.
  ctx.fillStyle = C.faint; ctx.font = font(400, 14);
  ctx.fillText(data.footer || "NASA LOLA terrain · JPL DE421 Sun/Earth · team power & battery model", pad, H - 28);

  return canvas;
}

/** Render and trigger a PNG download. Returns true on success. */
export function downloadCard(data, filename = "nocoast-card.png") {
  try {
    const canvas = renderCard(data);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
    return true;
  } catch {
    return false;
  }
}

export const CARD_COLORS = C;
