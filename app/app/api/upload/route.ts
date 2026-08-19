import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function ext(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "png";
}

/**
 * Uploads a token image to Vercel Blob, wraps it in Metaplex-compatible
 * metadata JSON, and returns the metadata URI to be written on-chain by the
 * launch flow. Requires `BLOB_READ_WRITE_TOKEN`; otherwise returns 503 and the
 * client falls back to name/symbol-only metadata.
 */
export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Image storage is not configured." },
      { status: 503 }
    );
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    const name = String(form.get("name") ?? "").slice(0, 32);
    const symbol = String(form.get("symbol") ?? "").slice(0, 10);

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "No image provided." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "Image is too large (max 5 MB)." },
        { status: 400 }
      );
    }

    const id = crypto.randomUUID();
    const image = await put(`images/${id}.${ext(file.name)}`, file, {
      access: "public",
      addRandomSuffix: true,
      contentType: file.type || "image/png",
    });

    const metadata = {
      name,
      symbol,
      description: "",
      image: image.url,
    };
    const meta = await put(`meta/${id}.json`, JSON.stringify(metadata), {
      access: "public",
      addRandomSuffix: true,
      contentType: "application/json",
    });

    return NextResponse.json({ uri: meta.url, image: image.url });
  } catch (err) {
    console.error("image upload failed", err);
    return NextResponse.json({ error: "Upload failed." }, { status: 500 });
  }
}
