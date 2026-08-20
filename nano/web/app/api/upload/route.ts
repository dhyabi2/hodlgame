import { NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      const url = typeof body?.url === "string" ? body.url.trim() : "";
      return url
        ? NextResponse.json({ url })
        : NextResponse.json({ error: "url required" }, { status: 400 });
    }

    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "file too large (max 5MB)" }, { status: 400 });
    }
    const ext = EXTS[file.type] ?? "png";
    const name = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
    const dir = path.join(process.cwd(), "public", "uploads");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ url: `/uploads/${name}` });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
}