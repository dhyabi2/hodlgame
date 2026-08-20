import { NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { safeUrl } from "../../../server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const GATEWAY = "https://gateway.pinata.cloud/ipfs";
const EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

async function pinToIpfs(file: File): Promise<string> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("no PINATA_JWT");
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`IPFS pin failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { IpfsHash: string };
  return `${GATEWAY}/${data.IpfsHash}`;
}

async function saveLocal(file: File): Promise<string> {
  const ext = EXTS[file.type] ?? "png";
  const name = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
  const dir = path.join(process.cwd(), "public", "uploads");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.from(await file.arrayBuffer()));
  return `/uploads/${name}`;
}

/** Accept an image upload (form-data `file`) or a passthrough `{url}`. */
export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await req.json();
      // Only echo back safe http(s)/ipfs URLs — the result is stored as an
      // image/social URL and rendered in the browser (no javascript:/data:).
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
      return NextResponse.json({ error: "file too large (max 5MB)" }, { status: 400 });
    }
    if (!EXTS[file.type]) {
      return NextResponse.json({ error: "unsupported image type" }, { status: 400 });
    }

    // Pinata/IPFS → local filesystem.
    let url: string;
    if (process.env.PINATA_JWT) url = await pinToIpfs(file);
    else url = await saveLocal(file);

    return NextResponse.json({ url, ipfs: Boolean(process.env.PINATA_JWT) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
}