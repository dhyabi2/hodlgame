import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const GATEWAY = "https://gateway.pinata.cloud/ipfs";

/**
 * Pins a token image to IPFS (via Pinata's free tier), then wraps it in
 * Metaplex-compatible metadata JSON and pins that too. Returns the metadata
 * URI written on-chain by the launch flow. Requires `PINATA_JWT`; otherwise it
 * returns 503 and the client falls back to name/symbol-only metadata.
 */
export async function POST(req: Request) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json(
      { error: "IPFS storage is not configured." },
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

    // 1. Pin the image.
    const imageForm = new FormData();
    imageForm.append("file", file);
    const imgRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: imageForm,
    });
    if (!imgRes.ok) {
      const t = await imgRes.text().catch(() => "");
      throw new Error(`IPFS pin failed (${imgRes.status}): ${t.slice(0, 200)}`);
    }
    const img = (await imgRes.json()) as { IpfsHash: string };
    const imageUrl = `${GATEWAY}/${img.IpfsHash}`;

    // 2. Pin the metadata JSON pointing at the image.
    const metaRes = await fetch(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          symbol,
          description: "",
          image: imageUrl,
        }),
      }
    );
    if (!metaRes.ok) {
      const t = await metaRes.text().catch(() => "");
      throw new Error(`Metadata pin failed (${metaRes.status}): ${t.slice(0, 200)}`);
    }
    const meta = (await metaRes.json()) as { IpfsHash: string };

    return NextResponse.json({
      uri: `${GATEWAY}/${meta.IpfsHash}`,
      image: imageUrl,
    });
  } catch (err) {
    console.error("IPFS upload failed", err);
    return NextResponse.json({ error: "Upload failed." }, { status: 500 });
  }
}