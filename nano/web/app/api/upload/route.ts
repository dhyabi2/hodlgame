import { NextResponse } from "next/server";
import * as crypto from "node:crypto";
import { safeImageUrl } from "../../../server/validate";
import { saveBlob } from "../../../server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Images are stored in the durable store (Vercel Blob on prod, filesystem
// locally). Kept small because the blob rides in a single store value.
const MAX_BYTES = 1024 * 1024; // 1 MB
const MAX_DIM = 4096; // reject decompression-bomb dimensions (clients resize to 512)

// ── rate limiting (unauthenticated endpoint → storage/cost DoS otherwise) ────
const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || now > e.reset) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
  if (e.n >= max) return false;
  e.n++;
  return true;
}
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return req.headers.get("x-real-ip")?.trim() || (xff && xff.length ? xff[xff.length - 1] : "shared");
}

// Sniff the real format + dimensions from the file's magic bytes — never trust
// the client-supplied MIME type. Returns null for anything that isn't a
// recognized raster image (so SVG/HTML/scripts are rejected outright) or whose
// real dimensions can't be read (a decompression bomb must not slip through as
// "unknown size").
function sniffImage(b: Buffer): { type: string; w: number; h: number } | null {
  // PNG
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "image/png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  // GIF
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { type: "image/gif", w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }
  // JPEG — walk segments to the Start-Of-Frame; require it (no SOF ⇒ reject, so
  // dimensions are always validated).
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { type: "image/jpeg", h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
      }
      const len = b.readUInt16BE(o + 2);
      if (len < 2) return null; // malformed segment length → refuse
      o += 2 + len;
    }
    return null; // valid SOI but no SOF → refuse (can't validate size)
  }
  // WebP — parse the real canvas dimensions from VP8X / VP8L / VP8 .
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const fourcc = b.toString("ascii", 12, 16);
    try {
      if (fourcc === "VP8X") {
        return { type: "image/webp", w: (b.readUIntLE(24, 3) & 0xffffff) + 1, h: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
      }
      if (fourcc === "VP8 ") {
        return { type: "image/webp", w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === "VP8L" && b[20] === 0x2f) {
        const bits = b.readUInt32LE(21);
        return { type: "image/webp", w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
    } catch { return null; }
    return null; // unknown webp variant → can't validate dims → refuse
  }
  return null;
}

/** Accept an image upload (form-data `file`) or a passthrough `{url}`. */
export async function POST(req: Request) {
  try {
    // Reject oversized bodies before buffering them into memory (OOM guard).
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BYTES + 128 * 1024) {
      return NextResponse.json({ error: "file too large (max 1MB)" }, { status: 413 });
    }

    const ip = clientIp(req);
    if (!rateLimit(`up:${ip}`, 20, 60_000) || !rateLimit("up:global", 200, 60_000)) {
      return NextResponse.json({ error: "rate limited — try again shortly" }, { status: 429 });
    }

    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await req.json();
      // Only echo back safe https/ipfs URLs (never http: — mixed content /
      // tracking beacon — and never javascript:/data:).
      const url = safeImageUrl(body?.url);
      return url
        ? NextResponse.json({ url })
        : NextResponse.json({ error: "valid https or ipfs image url required" }, { status: 400 });
    }

    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "file too large (max 1MB)" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const info = sniffImage(buf);
    if (!info) {
      return NextResponse.json({ error: "unsupported or corrupt image (png/jpeg/gif/webp only)" }, { status: 400 });
    }
    if (info.w < 1 || info.h < 1 || info.w > MAX_DIM || info.h > MAX_DIM) {
      return NextResponse.json({ error: `image dimensions out of range (1–${MAX_DIM}px)` }, { status: 400 });
    }

    // Store {contentType, base64} under a random id; serve via /api/image/<id>.
    // Content type is the SNIFFED type, never the client's. The URL is
    // site-relative (safeImageUrl allows exactly this shape) so it survives
    // domain/alias changes and plain-http local dev, where an absolute
    // http://localhost origin would be sanitized away and block the launch.
    const id = crypto.randomBytes(16).toString("hex");
    const b64 = buf.toString("base64");
    // `t` (upload time) lets the orphan-image GC apply a grace period.
    await saveBlob(`img:${id}`, JSON.stringify({ ct: info.type, data: b64, t: Date.now() }));
    return NextResponse.json({ url: `/api/image/${id}` });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
}
