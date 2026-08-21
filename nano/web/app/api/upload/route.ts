import { NextResponse } from "next/server";
import * as crypto from "node:crypto";
import { safeUrl } from "../../../server/validate";
import { saveBlob } from "../../../server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Images are stored in the durable store (Upstash on prod, filesystem locally) —
// no IPFS/Pinata. Kept small because the blob rides in a single store value.
const MAX_BYTES = 1024 * 1024; // 1 MB
const EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

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
    if (!EXTS[file.type]) {
      return NextResponse.json({ error: "unsupported image type" }, { status: 400 });
    }

    // Store {contentType, base64} in the durable store under a random id; serve
    // it back via /api/image/<id>. Absolute URL so metadata safeUrl keeps it.
    const id = crypto.randomBytes(16).toString("hex");
    const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    await saveBlob(`img:${id}`, JSON.stringify({ ct: file.type, data: b64 }));
    const url = `${new URL(req.url).origin}/api/image/${id}`;
    return NextResponse.json({ url });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
}
