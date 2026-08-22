// Reusable stark-monochrome share-card generator. Renders an off-screen canvas
// (white-on-black, the brand palette) and hands the viewer the image via the
// Web Share API where available, else a download, else a new tab. Everything is
// drawn client-side from data the caller already has — no server, no custody.
//
// Several entertainment features share this: Proof-of-Solvency, Nemesis brag,
// Birth Certificate, auto-roast cards. Keep it dependency-free (2D canvas only).

export interface ShareCardSpec {
  filename: string; // e.g. "hodlgame-solvency.png"
  title: string; // small eyebrow, e.g. "PROOF OF SOLVENCY"
  headline: string; // the big number/line, e.g. "128.5 XNO"
  subline?: string; // secondary line under the headline
  rows?: { label: string; value: string }[]; // small key/value rows
  footer?: string; // bottom hairline text, e.g. "verify at hodlgame.fun"
  qr?: HTMLCanvasElement | HTMLImageElement | null; // optional verify-QR to embed
}

const W = 1080;
const H = 1080;

/** Draw the HODLGAME coin-O mark (the favicon monogram) at (x,y,size). */
function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const s = size / 100;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = "#fff";
  // outer chamfered square with a square hole and a low-resting diamond (evenodd)
  const p = new Path2D("M0,0 H72 L100,14 V100 H0 Z M18,18 V82 H82 V18 Z M50,41 L66,57 L50,73 L34,57 Z");
  ctx.fill(p, "evenodd");
  ctx.restore();
}

/** Render the card to a canvas (also returned for callers that want the blob). */
export function renderShareCard(spec: ShareCardSpec): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  // ground
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  // subtle hairline frame
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 2;
  ctx.strokeRect(48, 48, W - 96, H - 96);

  // brand mark + wordmark eyebrow
  drawMark(ctx, 96, 104, 64);
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 34px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("HODLGAME", 176, 152);

  // eyebrow title
  ctx.fillStyle = "#a3a3a3";
  ctx.font = "900 26px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(spec.title.toUpperCase(), 96, 300);

  // headline (auto-shrink to fit width)
  ctx.fillStyle = "#ffffff";
  let hf = 132;
  ctx.font = `900 ${hf}px ui-sans-serif, system-ui, sans-serif`;
  while (ctx.measureText(spec.headline).width > W - 200 && hf > 40) {
    hf -= 6;
    ctx.font = `900 ${hf}px ui-sans-serif, system-ui, sans-serif`;
  }
  ctx.fillText(spec.headline, 96, 300 + 40 + hf);

  let y = 300 + 40 + hf + 60;
  if (spec.subline) {
    ctx.fillStyle = "#d4d4d4";
    ctx.font = "500 34px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(spec.subline, 96, y);
    y += 60;
  }

  // rows
  if (spec.rows?.length) {
    y += 24;
    for (const r of spec.rows) {
      ctx.fillStyle = "#737373";
      ctx.font = "700 28px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(r.label, 96, y);
      ctx.fillStyle = "#e5e5e5";
      ctx.font = "700 28px ui-monospace, monospace";
      const vw = ctx.measureText(r.value).width;
      ctx.fillText(r.value, W - 96 - vw, y);
      y += 52;
    }
  }

  // QR (bottom-left) on a white quiet-zone tile
  if (spec.qr) {
    const q = 220;
    const qx = 96, qy = H - 96 - q;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(qx - 12, qy - 12, q + 24, q + 24);
    try { ctx.drawImage(spec.qr as any, qx, qy, q, q); } catch {}
  }

  // footer hairline
  ctx.fillStyle = "#737373";
  ctx.font = "700 26px ui-sans-serif, system-ui, sans-serif";
  const foot = spec.footer ?? "hodlgame.fun";
  const fw = ctx.measureText(foot).width;
  ctx.fillText(foot, W - 96 - fw, H - 116);

  return cv;
}

/** Render + deliver the card: Web Share (mobile) → download → new tab. */
export async function shareCard(spec: ShareCardSpec): Promise<void> {
  const cv = renderShareCard(spec);
  const blob: Blob | null = await new Promise((res) => cv.toBlob((b) => res(b), "image/png"));
  if (!blob) return;
  const file = new File([blob], spec.filename, { type: "image/png" });
  const navAny = navigator as any;
  if (navAny.canShare && navAny.canShare({ files: [file] })) {
    try { await navAny.share({ files: [file], title: spec.title }); return; } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = spec.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Convert an on-page SVG QR (qrcode.react QRCodeSVG) to a canvas for embedding. */
export async function svgQrToCanvas(svgEl: SVGElement | null, size = 220): Promise<HTMLCanvasElement | null> {
  if (!svgEl) return null;
  try {
    const xml = new XMLSerializer().serializeToString(svgEl);
    const svg64 = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = svg64; });
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    return cv;
  } catch {
    return null;
  }
}
