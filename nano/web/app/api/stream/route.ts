import { feed, detail } from "../../../server/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent events: push feed (or a single token) every 3s. */
export async function GET(req: Request) {
  const tokenId = new URL(req.url).searchParams.get("token");
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        try {
          const payload = tokenId ? { token: await detail(tokenId) } : { tokens: await feed() };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch (e: any) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(e?.message ?? e) })}\n\n`));
        }
      };
      await push();
      const timer = setInterval(push, 3000);
      req.signal.addEventListener("abort", () => {
        clearInterval(timer);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}