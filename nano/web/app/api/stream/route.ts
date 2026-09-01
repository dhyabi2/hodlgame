import { feed, detail } from "../../../server/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent events: push feed (or a single token) periodically.
 *
 * The interval was 3s, which is a FULL market fold every three seconds for as
 * long as a connection is held open — and nothing in the app subscribes to
 * this, so any stray client was pure invisible load. 30s matches the polling
 * the UI actually uses. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const tokenId = u.searchParams.get("token");
  const account = u.searchParams.get("account") ?? "";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        try {
          const payload = tokenId ? { token: await detail(tokenId, account) } : { tokens: await feed(account) };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch (e: any) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(e?.message ?? e) })}\n\n`));
        }
      };
      await push();
      const timer = setInterval(push, 30000);
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