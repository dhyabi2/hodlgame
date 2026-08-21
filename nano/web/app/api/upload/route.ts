import { NextResponse } from "next/server";
import * as crypto from "node:crypto";
import { safeUrl } from "../../../server/validate";
import { saveBlob } from "../../../server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Images are stored in the durable store (Upstash on prod, filesystem locally) —
// no IPFS/Pinata. Kept small because the blob rides in a single store value.
const MAX_BYTES = 1024 * 1024; // 1 MB
const MAX_DIM = 4096; // reject decompression-bomb dimensions (clients resize to 512)

// Sniff the real format + dimensions from the file's magic bytes — never trust
// the client-supplied MIME type. Returns null for anything that isn't a
// recognized raster image (so SVG/HTML/scripts are rejected outright).
function sniffImage(b: Buffer): { type: string; w: number; h: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "image/png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { type: "image/gif", w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { type: "image/jpeg", h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
      }
      o += 2 + b.readUInt16BE(o + 2);
    }
    return { type: "image/jpeg", w: 1, h: 1 }; // valid JPEG, no SOF found — allow, unknown dims
  }
  if (b.length >= 16 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    return { type: "image/webp", w: 1, h: 1 }; // magic validated; dims not parsed
  }
  return null;
}

/** Accept an image upload (form-data `file`) or a passthrough `{url}`. */
export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await req.json();
      // Only echo back safe http(s)/ipfs URLs — stored as an image/social URL
      // and rendered in the browser (no javascript:/data:).
      const url = safeUrl(body?.url);
      return url
        ? NextResponse.json({ url })
        : NextResponse.json({ error: "valid http(s) url required" }, { status: 400 });
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
    if (info.w > MAX_DIM || info.h > MAX_DIM) {
      return NextResponse.json({ error: `image dimensions too large (max ${MAX_DIM}px)` }, { status: 400 });
    }

    // Store {contentType, base64} in the durable store under a random id; serve
    // it back via /api/image/<id>. Content type comes from the sniffed magic
    // bytes, never the client. Absolute URL so metadata safeUrl keeps it.
    const id = crypto.randomBytes(16).toString("hex");
    const b64 = buf.toString("base64");
    await saveBlob(`img:${id}`, JSON.stringify({ ct: info.type, data: b64 }));
    const url = `${new URL(req.url).origin}/api/image/${id}`;
    return NextResponse.json({ url });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
}
