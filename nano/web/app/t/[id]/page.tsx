import type { Metadata } from "next";
import { loadMetaRow } from "../../../server/tokens";
import { isTokenId } from "../../../server/validate";
import TokenRedirect from "./TokenRedirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SITE = "https://www.hodlgame.fun";

// Per-coin share page. Its whole job on the server is to emit rich OG/Twitter
// tags (title, description, and — via the co-located opengraph-image.tsx — a
// branded per-coin image) so the link unfurls with the coin's card wherever
// it's pasted. Only the metadata is fast/light (a single store read, no replay);
// the human is redirected client-side into the app.
export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const id = params.id;
  if (!isTokenId(id)) return { title: "Coin · HodlGame" };
  const meta = await loadMetaRow(id).catch(() => null);
  const name = (meta?.name || "").trim() || "Untitled coin";
  const symbol = (meta?.symbol || "").trim();
  const label = symbol ? `${name} ($${symbol})` : name;
  const title = `${label} · HodlGame`;
  const description =
    (meta?.description || "").trim() ||
    `${label} — a zero-custody memecoin on Nano (XNO). Feeless, instant, every balance verifiable. Trade it on HodlGame.`;
  const url = `${SITE}/t/${id}`;
  // opengraph-image.tsx in this folder is auto-attached by Next as the OG +
  // Twitter image, so we deliberately don't set `images` here.
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: "HodlGame", type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default function TokenSharePage({ params }: { params: { id: string } }) {
  return <TokenRedirect id={params.id} />;
}
