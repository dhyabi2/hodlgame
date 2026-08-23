import { ImageResponse } from "next/og";
import { loadMetaRow } from "../../../server/tokens";
import { isTokenId } from "../../../server/validate";
import { loadBlob } from "../../../server/store";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "HodlGame coin";

// The coin avatar is stored as {ct,data(base64)} under img:<id> and normally
// served from /api/image/<id>. For the OG image we must inline it as a data URI
// (the renderer can't fetch a relative path), so pull it straight from the store.
async function avatarDataUri(image?: string): Promise<string | null> {
  const m = /^\/api\/image\/([0-9a-f]{32})$/.exec(image || "");
  if (!m) return null;
  try {
    const raw = await loadBlob(`img:${m[1]}`);
    if (!raw) return null;
    const { ct, data } = JSON.parse(raw) as { ct: string; data: string };
    const type = /^image\/(png|jpeg|gif|webp)$/.test(ct) ? ct : "image/png";
    return `data:${type};base64,${data}`;
  } catch {
    return null;
  }
}

export default async function Image({ params }: { params: { id: string } }) {
  const id = params.id;
  const meta = isTokenId(id) ? await loadMetaRow(id).catch(() => null) : null;
  const name = (meta?.name || "").trim() || "Untitled coin";
  const symbol = (meta?.symbol || "").trim();
  const avatar = await avatarDataUri(meta?.image);
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
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar}
              width={200}
              height={200}
              style={{ objectFit: "cover", border: "3px solid #ffffff" }}
            />
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
            <div style={{ fontSize: 82, fontWeight: 900, lineHeight: 1.02 }}>{name}</div>
            {symbol ? (
              <div style={{ fontSize: 44, opacity: 0.65, marginTop: 14, letterSpacing: 3 }}>
                ${symbol.toUpperCase()}
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ fontSize: 34, opacity: 0.8 }}>
            Zero-custody memecoin on Nano · feeless · instant
          </div>
          <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: 4 }}>HODLGAME</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
