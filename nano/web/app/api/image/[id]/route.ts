import { loadBlob } from "../../../../server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serve an uploaded image out of the durable store (Upstash on prod, filesystem
// locally). The id is a 32-hex random token minted at upload time.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!/^[0-9a-f]{32}$/.test(id)) {
    return new Response("bad id", { status: 400 });
  }
  const raw = await loadBlob(`img:${id}`);
  if (!raw) return new Response("not found", { status: 404 });
  try {
    const { ct, data } = JSON.parse(raw) as { ct: string; data: string };
    return new Response(Buffer.from(data, "base64"), {
      headers: {
        "Content-Type": /^image\/(png|jpeg|gif|webp)$/.test(ct) ? ct : "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
        // Defense-in-depth against a polyglot (e.g. GIF/HTML) that slipped the
        // sniffer: forbid MIME-sniffing, sandbox + lock down any script/embed if
        // the URL is opened directly, and serve inline as a plain file.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
        "Content-Disposition": "inline",
      },
    });
  } catch {
    return new Response("corrupt", { status: 500 });
  }
}
