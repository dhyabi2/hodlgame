import { ImageResponse } from "next/og";

// next/og runs reliably on Vercel's EDGE runtime (its font/wasm assets are
// bundled there; the node lambda fails to trace them and 500s). Edge can't
// import the node-only durable store, so we pull the coin's display fields over
// HTTP (/api/meta) and let the renderer fetch the avatar from its absolute URL.
export const runtime = "edge";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "HodlGame coin";

const SITE = "https://www.hodlgame.fun";
const TOKEN_ID = /^[0-9a-f]{32}$/;
const IMG_PATH = /^\/api\/image\/[0-9a-f]{32}$/;

export default async function Image({ params }: { params: { id: string } }) {
  const id = params.id;
  let name = "Untitled coin";
  let symbol = "";
  let image = "";
  if (TOKEN_ID.test(id)) {
    try {
      const r = await fetch(`${SITE}/api/meta?token=${id}`, { cache: "no-store" });
      if (r.ok) {
        const m = await r.json();
        name = (m?.name || "").trim() || name;
        symbol = (m?.symbol || "").trim();
        image = (m?.image || "").trim();
      }
    } catch {}
  }
  // satori fetches remote images from an absolute URL; only allow our own path.
  const avatarUrl = IMG_PATH.test(image) ? `${SITE}${image}` : null;
  const initial = (symbol || name || "?").slice(0, 1).toUpperCase();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#000000",
          color: "#ffffff",
          padding: "72px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "40px" }}>
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} width={200} height={200} style={{ objectFit: "cover", border: "3px solid #ffffff" }} />
          ) : (
            <div
              style={{
                width: 200,
                height: 200,
                border: "3px solid #ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 110,
                fontWeight: 900,
              }}
            >
              {initial}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", maxWidth: 780 }}>
            <div style={{ display: "flex", fontSize: 82, fontWeight: 900, lineHeight: 1.02 }}>{name}</div>
            {symbol ? (
              <div style={{ display: "flex", fontSize: 44, opacity: 0.65, marginTop: 14, letterSpacing: 3 }}>${symbol.toUpperCase()}</div>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", fontSize: 34, opacity: 0.8 }}>Zero-custody memecoin on Nano · feeless · instant</div>
          <div style={{ display: "flex", fontSize: 44, fontWeight: 900, letterSpacing: 4 }}>HODLGAME</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
