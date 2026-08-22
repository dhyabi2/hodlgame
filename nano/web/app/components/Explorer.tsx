"use client";

// Explorer tab (docs/EXPLORER-SPEC.md): a rich, real-data blockchain explorer —
// stats overview, universal search, paginated/filterable op feed, op detail
// (state deltas + raw blocks + hexdump + confirmations + value-flow story),
// account and token pages (charts, trades, holders with %, socials, proof of
// reserves), and in-browser verification. No mock data — everything comes from
// the deterministic chain replay via /api/explorer.

import { useEffect, useState } from "react";
import { verifyInBrowser, type VerifyResult } from "../lib/clientIndexer";
import { fmtNum, fmtXno } from "../lib/trade";

type View =
  | { kind: "stats" }
  | { kind: "feed" }
  | { kind: "trust" }
  | { kind: "op"; q: string }
  | { kind: "account"; q: string }
  | { kind: "token"; q: string }
  | { kind: "results"; q: string };

const short = (s: string, n = 8) => (s ? `${s.slice(0, n)}…${s.slice(-4)}` : "");
const ago = (ts?: number) => {
  if (!ts) return "·";
  const t = ts > 1e12 ? ts : ts * 1000;
  const m = Math.floor(Math.max(0, Date.now() - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};
const absTime = (ts?: number) => {
  if (!ts) return "unknown time";
  const t = ts > 1e12 ? ts : ts * 1000;
  return new Date(t).toLocaleString();
};
// Older uploads stored an ABSOLUTE /api/image/<id> URL baked in with
// whatever domain was live at upload time; if that domain later starts
// redirecting itself (an alias, a moved custom domain) the old absolute URL
// breaks forever. Normalize to the CURRENT origin's relative path.
const normalizeImage = (url: string): string => {
  const m = url.match(/^(?:https?:\/\/[^/]+)?\/api\/image\/([0-9a-f]{32})$/);
  return m ? `/api/image/${m[1]}` : url;
};
const tokSym = (t: { symbol?: string; tokenId: string }) => t.symbol || t.tokenId.slice(0, 4).toUpperCase();
const tokName = (t: { name?: string; tokenId: string }) => t.name || `Coin ${t.tokenId.slice(0, 6)}`;
const fmtTok = (raw: string, dec: number) => {
  const neg = raw.startsWith("-");
  const n = BigInt(neg ? raw.slice(1) : raw);
  const d = 10n ** BigInt(dec);
  const whole = (n / d).toLocaleString();
  const frac = (n % d).toString().padStart(dec, "0").replace(/0+$/, "").slice(0, 6);
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
};
const pctStr = (n: number | null | undefined) => (n == null ? "·" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const pctColor = (n: number | null | undefined) => (n == null ? "text-neutral-500" : n >= 0 ? "text-green-700" : "text-red-600");

const KIND_COLOR: Record<string, string> = {
  launch: "bg-purple-900/60 text-purple-300", buy: "bg-neutral-100/60 text-black", sell: "bg-neutral-100/60 text-black",
  transfer: "bg-blue-900/60 text-blue-300", seedLiq: "bg-teal-900/60 text-teal-300", addLiq: "bg-teal-900/60 text-teal-300",
  stake: "bg-neutral-100/60 text-black", unstake: "bg-neutral-100/60 text-black", claim: "bg-neutral-100 text-neutral-700",
};
const ALL_KINDS = ["launch", "buy", "sell", "transfer", "seedLiq", "addLiq", "stake", "unstake", "claim"];
const KIND_LABEL: Record<string, string> = { launch: "launch", buy: "buy", sell: "sell", transfer: "send", seedLiq: "seed liquidity", addLiq: "add liquidity", stake: "stake", unstake: "unstake", claim: "claim" };
const FIELD_XNO = new Set(["poolXno"]);
const FIELD_LABEL: Record<string, string> = { supply: "total coins", creatorShare: "creator's coins", treasury: "treasury", poolXno: "pool XNO", poolTokens: "coins in pool", totalStaked: "staked", rebateVault: "rebate vault", rewardPerShare: "reward per share" };

const card = "rounded-none border border-neutral-300 bg-white p-4";
const th = "text-left text-[10px] uppercase tracking-wider text-neutral-400 pb-1 pr-3";
const td = "py-1 pr-3 text-xs";
const mono = "font-mono text-[11px]";
const linkC = "text-black hover:underline cursor-pointer";

async function api(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`/api/explorer?${qs}`);
  return r.json();
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      title="copy"
      onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1000); }); }}
      className="ml-1 text-[10px] text-neutral-400 hover:text-black align-middle"
    >
      {done ? "✓" : "⧉"}
    </button>
  );
}

function KindBadge({ kind, valid }: { kind: string; valid?: boolean }) {
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${KIND_COLOR[kind] ?? "bg-neutral-100 text-neutral-700"}`}>{KIND_LABEL[kind] ?? kind}{valid === false ? " ✕" : ""}</span>;
}

/** Inline SVG price line chart from a real analytics series. */
function MiniChart({ series }: { series: { time: number; priceRaw: string }[] }) {
  if (!series || series.length < 2) return <p className="text-xs text-neutral-400">not enough price points yet</p>;
  const pts = series.map((p) => Number(BigInt(p.priceRaw)) / 1e30);
  const min = Math.min(...pts), max = Math.max(...pts), range = max - min || 1;
  const W = 560, H = 120;
  const path = pts.map((v, i) => `${(i / (pts.length - 1)) * W},${H - ((v - min) / range) * (H - 8) - 4}`).join(" ");
  const up = pts[pts.length - 1] >= pts[0];
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" preserveAspectRatio="none">
        <polyline points={path} fill="none" stroke={up ? "#000000" : "#666666"} strokeWidth="1.5" />
        <polyline points={`0,${H} ${path} ${W},${H}`} fill={up ? "#00000018" : "#66666618"} stroke="none" />
      </svg>
    </div>
  );
}

function OpsTable({ items, go }: { items: any[]; go: (v: View) => void }) {
  if (!items?.length) return <p className="text-xs text-neutral-400">no ops</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead><tr><th className={th}>action</th><th className={th}>coin</th><th className={th}>who</th><th className={th}>result</th><th className={th}>details</th><th className={th}>when</th></tr></thead>
        <tbody>
          {items.map((it) => {
            const sum = it.fields?.poolXno && (it.kind === "buy" || it.kind === "sell" || it.kind === "seedLiq")
              ? `${fmtXno((BigInt(it.fields.poolXno.after) - BigInt(it.fields.poolXno.before)).toString())} XNO`
              : it.balances?.length ? `${it.balances.length} balance change${it.balances.length > 1 ? "s" : ""}` : "";
            return (
              <tr key={it.hash} className="border-t border-neutral-300 hover:bg-neutral-50">
                <td className={td}><KindBadge kind={it.kind} valid={it.valid} /></td>
                <td className={td}><span className={linkC} onClick={() => go({ kind: "token", q: it.tokenId })}>{tokSym(it)}</span></td>
                <td className={`${td} ${mono}`}><span className={linkC} onClick={() => go({ kind: "account", q: it.sender })}>{short(it.sender, 10)}</span></td>
                <td className={`${td} text-neutral-600`}>{it.valid === false ? <span className="text-black">{it.reason}</span> : sum}</td>
                <td className={td}><span className={linkC} onClick={() => go({ kind: "op", q: it.hash })}>view →</span></td>
                <td className={`${td} text-neutral-500`} title={absTime(it.timestamp)}>{ago(it.timestamp)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Row({ k, children }: { k: any; children: any }) {
  return <div className="flex gap-3 py-1 border-t border-neutral-300/60 text-xs"><span className="w-36 shrink-0 text-neutral-500">{k}</span><span className="min-w-0 break-all">{children}</span></div>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: any }) {
  return <div className="rounded-none border border-neutral-300 bg-white p-3"><p className="text-[10px] uppercase tracking-wider text-neutral-400">{label}</p><p className="text-lg font-black">{value}</p>{sub && <p className="text-[11px] text-neutral-500">{sub}</p>}</div>;
}

export default function Explorer() {
  const [view, setView] = useState<View>({ kind: "stats" });
  const [q, setQ] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  // feed controls
  const [feedItems, setFeedItems] = useState<any[]>([]);
  const [feedCursor, setFeedCursor] = useState(0);
  const [feedNext, setFeedNext] = useState<number | null>(null);
  const [kindFilter, setKindFilter] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr("");
    if (view.kind === "feed") { setFeedItems([]); setFeedCursor(0); }
    const params: Record<string, string> =
      view.kind === "stats" || view.kind === "trust" ? { view: view.kind }
      : view.kind === "feed" ? { view: "feed", limit: "50", ...(kindFilter ? { kind: kindFilter } : {}) }
      : view.kind === "results" ? { view: "search", q: view.q }
      : { view: view.kind, q: view.q };
    const load = (first: boolean) => api(params).then((j) => {
      if (!live) return;
      if (j.error) { if (first) setErr(j.error); }
      else { setData(j); setErr(""); if (view.kind === "feed") { setFeedItems(j.items); setFeedNext(j.nextCursor); } }
    }).catch((e) => live && first && setErr(e.message)).finally(() => live && first && setLoading(false));
    load(true);
    const t = view.kind === "stats" || view.kind === "trust" || (view.kind === "feed" && !kindFilter) ? setInterval(() => load(false), 5000) : null;
    return () => { live = false; if (t) clearInterval(t); };
  }, [JSON.stringify(view), kindFilter]);

  const go = (v: View) => { setData(null); setView(v); };
  const submit = () => q.trim() && go({ kind: "results", q: q.trim() });
  const loadMoreFeed = async () => {
    if (feedNext == null) return;
    const j = await api({ view: "feed", cursor: String(feedNext), limit: "50", ...(kindFilter ? { kind: kindFilter } : {}) });
    setFeedItems((p) => [...p, ...(j.items ?? [])]); setFeedNext(j.nextCursor);
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input className="w-full rounded-none border border-neutral-300 bg-white px-4 py-3 text-sm text-black placeholder-neutral-400 focus:outline-none focus:border-black"
          placeholder="Search a coin name, address, or transaction" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <button className="shrink-0 rounded-none bg-black px-4 py-3 text-sm font-bold text-white hover:bg-neutral-800" onClick={submit}>Search</button>
      </div>
      <div className="flex gap-2 text-xs flex-wrap">
        {(["stats", "feed", "trust"] as const).map((k) => (
          <button key={k} onClick={() => go({ kind: k })} className={`px-3 py-1.5 rounded-full font-bold ${view.kind === k ? "bg-black text-white" : "bg-white text-neutral-600 hover:text-neutral-800"}`}>
            {k === "stats" ? "Overview" : k === "feed" ? "Activity" : "Verify"}
          </button>
        ))}
        {!["stats", "feed", "trust"].includes(view.kind) && <span className="px-3 py-1.5 rounded-full bg-neutral-100 text-neutral-700 font-mono">{view.kind}: {short((view as any).q ?? "", 10)}</span>}
      </div>

      {loading && <p className="text-xs text-neutral-400">loading…</p>}
      {err && <p className="text-xs text-black">{err}</p>}
      {!loading && !err && data && (
        <>
          {view.kind === "stats" && <StatsPanel d={data} go={go} />}
          {view.kind === "feed" && (
            <div className={card}>
              <div className="flex gap-1.5 flex-wrap mb-3">
                <button onClick={() => setKindFilter("")} className={`px-2 py-1 rounded-full text-[10px] font-bold ${!kindFilter ? "bg-black text-white" : "bg-white text-neutral-600"}`}>all</button>
                {ALL_KINDS.map((k) => <button key={k} onClick={() => setKindFilter(k)} className={`px-2 py-1 rounded-full text-[10px] font-bold ${kindFilter === k ? "bg-black text-white" : "bg-white text-neutral-600"}`}>{KIND_LABEL[k] ?? k}</button>)}
              </div>
              <p className="text-[11px] text-neutral-400 mb-2">{data.total} actions · newest first{kindFilter ? ` · ${kindFilter}` : " · live"}</p>
              <OpsTable items={feedItems} go={go} />
              {feedNext != null && <button onClick={loadMoreFeed} className="mt-3 w-full rounded-none bg-white py-2 text-xs font-bold text-neutral-700 hover:bg-neutral-100">Load more</button>}
            </div>
          )}
          {view.kind === "results" && <Results data={data} go={go} />}
          {view.kind === "op" && <OpDetail d={data} go={go} />}
          {view.kind === "account" && <AccountDetail d={data} go={go} />}
          {view.kind === "token" && <TokenDetailX d={data} go={go} />}
          {view.kind === "trust" && <TrustPanel d={data} go={go} />}
        </>
      )}
    </div>
  );
}

function StatsPanel({ d, go }: { d: any; go: (v: View) => void }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Stat label="tokens" value={d.totalTokens} />
        <Stat label="actions" value={d.totalOps} sub={`${d.invalidOps} rejected`} />
        <Stat label="holders" value={d.totalHolders} />
        <Stat label="total value locked" value={`${fmtXno(d.tvlRaw)} XNO`} />
        <Stat label="24h volume" value={`${fmtXno(d.volume24hRaw)} XNO`} />
        <Stat label="fees" value="0 (feeless)" sub="Nano" />
      </div>
      <div className={card}>
        <h3 className="font-black text-sm mb-2">Top tokens by market cap</h3>
        {d.topByMcap.length === 0 && <p className="text-xs text-neutral-400">no tokens yet</p>}
        {d.topByMcap.map((t: any) => (
          <div key={t.tokenId} className="flex items-center justify-between text-xs py-1.5 border-t border-neutral-300/60">
            <span className={linkC} onClick={() => go({ kind: "token", q: t.tokenId })}>{t.image ? <img src={normalizeImage(t.image)} alt="" className="w-5 h-5 rounded-full object-cover inline-block mr-1.5 align-middle" /> : null}{tokName(t)} <span className="text-neutral-400">{tokSym(t)}</span></span>
            <span className="flex gap-3"><span>{fmtXno(t.marketCapRaw)} mcap</span><span className={pctColor(t.change24h)}>{pctStr(t.change24h)}</span><span className="text-neutral-500">{t.holders} holders</span></span>
          </div>
        ))}
      </div>
      <div className={card}>
        <h3 className="font-black text-sm mb-2">Latest launches</h3>
        {d.latest.map((t: any) => (
          <div key={t.tokenId} className="flex items-center justify-between text-xs py-1.5 border-t border-neutral-300/60">
            <span className={linkC} onClick={() => go({ kind: "token", q: t.tokenId })}>{t.image ? <img src={normalizeImage(t.image)} alt="" className="w-5 h-5 rounded-full object-cover inline-block mr-1.5 align-middle" /> : null}{tokName(t)} <span className="text-neutral-400">{tokSym(t)}</span></span>
            <span className="text-neutral-500" title={absTime(t.createdAt)}>{ago(t.createdAt)}</span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-neutral-400" title="A fingerprint of the entire ledger state — anyone can recompute it to verify this site">integrity fingerprint <span className={mono}>{short(d.stateRoot, 12)}</span><Copy text={d.stateRoot} /></p>
    </div>
  );
}

function Results({ data, go }: { data: any; go: (v: View) => void }) {
  if (data.type === "op") return <OpDetail d={data.data} go={go} />;
  if (data.type === "account") return <AccountDetail d={data.data} go={go} />;
  if (data.type === "token") return <TokenDetailX d={data.data} go={go} />;
  if (data.type === "tokens")
    return <div className={card}>{data.data.length === 0 ? <p className="text-xs text-neutral-400">no matches</p> : data.data.map((t: any) => (
      <div key={t.tokenId} className="flex items-center justify-between text-sm py-1 border-t border-neutral-300/60">
        <span className={linkC} onClick={() => go({ kind: "token", q: t.tokenId })}>{tokName(t)} ({tokSym(t)})</span>
        <span className="text-xs text-neutral-500">{fmtXno(t.marketCapRaw)} mcap · {t.holders}h</span>
      </div>))}</div>;
  if (data.type === "block")
    return <div className={card}>
      <h3 className="font-black mb-2">Plain Nano transaction (not a coin action)</h3>
      <Row k="hash"><span className={mono}>{data.data.hash}</span><Copy text={data.data.hash} /></Row>
      <Row k="account"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: data.data.account })}>{data.data.account}</span></Row>
      <Row k="amount">{fmtXno(data.data.amount)} XNO</Row>
      <Row k="confirmed">{data.data.confirmed ? "yes ✓" : "pending"}</Row>
      <Row k="looks like">{data.data.classification?.kind}{data.data.classification?.tokenId ? ` · token ${short(data.data.classification.tokenId, 8)}` : ""}</Row>
      <details><summary className="text-[11px] text-neutral-500 cursor-pointer">byte-level decode</summary><Hexdump ann={data.data.annotation} /></details>
    </div>;
  return <p className="text-xs text-neutral-400">nothing found</p>;
}

function Hexdump({ ann }: { ann: any }) {
  if (!ann?.segments) return null;
  return (
    <div className="mt-2">
      <p className="text-[10px] uppercase tracking-wider text-neutral-400 mb-1">link decode ({ann.kind})</p>
      <div className="space-y-0.5">
        {ann.segments.map((s: any, i: number) => (
          <div key={i} className="flex gap-2 text-[11px]">
            <span className={`${mono} text-black break-all w-1/2`}>{s.bytes}</span>
            <span className="text-neutral-500">{s.label}{s.value ? `: ${s.value}` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OpDetail({ d, go }: { d: any; go: (v: View) => void }) {
  return (
    <div className="space-y-3">
      <div className={card}>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <KindBadge kind={d.kind} valid={d.valid} />
          <span className={linkC} onClick={() => go({ kind: "token", q: d.tokenId })}>{tokSym(d)}</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${d.confirmed ? "bg-neutral-100/60 text-black" : "bg-neutral-100/60 text-black"}`}>{d.confirmed ? "confirmed" : "pending"}</span>
          <span className="text-neutral-400 text-xs" title={absTime(d.timestamp)}>{ago(d.timestamp)}</span>
        </div>
        <Row k="hash"><span className={mono}>{d.hash}</span><Copy text={d.hash} /></Row>
        {d.carriers && <Row k="sent as"><span title={d.carriers.join(" + ")}>two linked blocks</span></Row>}
        <Row k="sent by"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.sender })}>{d.sender}</span><Copy text={d.sender} /></Row>
        {!d.valid && <Row k="rejected"><span className="text-black">{d.reason}</span></Row>}
        {d.depositEdge && <Row k="funded by deposit"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "op", q: d.depositEdge.deposit })}>{short(d.depositEdge.deposit, 12)}</span> · {fmtXno(d.depositEdge.amountRaw)} XNO</Row>}
        <Row k="on Nano L1"><a className={linkC} href={`https://nanexplorer.com/nano/block/${d.hash}`} target="_blank" rel="noreferrer">nanexplorer ↗</a></Row>
      </div>

      {Object.keys(d.fields ?? {}).length > 0 && (
        <div className={card}><h3 className="font-black text-sm mb-2">State changes</h3>
          {Object.entries(d.fields).map(([f, v]: any) => <Row key={f} k={FIELD_LABEL[f] ?? f}>{FIELD_XNO.has(f) ? `${fmtXno(v.before)} → ${fmtXno(v.after)} XNO` : `${fmtNum(Number(v.before))} → ${fmtNum(Number(v.after))}`}</Row>)}
        </div>
      )}
      {d.balances?.length > 0 && (
        <div className={card}><h3 className="font-black text-sm mb-2">Who gained / lost coins</h3>
          {d.balances.map((b: any) => <Row key={b.account} k={short(b.account, 10)}><span className={b.delta.startsWith("-") ? "text-red-600" : "text-green-700"}>{b.delta.startsWith("-") ? "" : "+"}{fmtNum(Number(b.delta))}</span> coins</Row>)}
        </div>
      )}
      {d.payoutCoverage?.length > 0 && (
        <div className={card}><h3 className="font-black text-sm mb-2">Payout story</h3>
          {d.payoutCoverage.map((c: any) => (
            <div key={c.sendHash} className="text-xs py-1 border-t border-neutral-300/60">pool send <span className={mono}>{short(c.sendHash, 10)}</span> → {fmtXno(c.amountRaw)} XNO to {short(c.recipient, 10)}, covering {c.covers.map((x: any, i: number) => <span key={i}>{x.kind} {x.hash ? short(x.hash, 8) : ""} ({fmtXno(x.amountRaw)} XNO){i < c.covers.length - 1 ? " + " : ""}</span>)}</div>
          ))}
        </div>
      )}
      {d.blocks?.length > 0 && (
        <details className={card}><summary className="font-black text-sm mb-2 cursor-pointer">Raw block data (advanced)</summary>
          {d.blocks.map((b: any) => (
            <div key={b.hash} className="mb-3 last:mb-0">
              <Row k="block"><span className={mono}>{short(b.hash, 12)}</span><Copy text={b.hash} /></Row>
              <Row k="link"><span className={mono}>{short(b.link, 12)}</span></Row>
              <Row k="representative"><span className={mono}>{short(b.representative, 12)}</span></Row>
              <Row k="balance"><span className={mono}>{b.balance}</span></Row>
              <Hexdump ann={b.annotation} />
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function AccountDetail({ d, go }: { d: any; go: (v: View) => void }) {
  const [ops, setOps] = useState<any[]>(d.ops);
  const [next, setNext] = useState<number | null>(d.nextCursor);
  useEffect(() => { setOps(d.ops); setNext(d.nextCursor); }, [d.address]);
  const more = async () => {
    if (next == null) return;
    const j = await api({ view: "account", q: d.address, cursor: String(next), limit: "50" });
    setOps((p) => [...p, ...(j.ops ?? [])]); setNext(j.nextCursor);
  };
  return (
    <div className="space-y-3">
      <div className={card}>
        <h3 className="font-black mb-1 text-sm">Wallet <span className={`${mono} break-all`}>{short(d.address, 12)}</span><Copy text={d.address} /></h3>
        {d.labels?.map((l: string) => <span key={l} className="inline-block mr-1 px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 text-[10px] font-bold">{l}</span>)}
        <Row k="XNO balance">{fmtXno(d.xnoBalanceRaw)} XNO {d.opened ? "" : "(never used)"}</Row>
        {d.createdTokens?.length > 0 && <Row k="created coins">{d.createdTokens.map((t: any) => <span key={t.tokenId} className={`${linkC} mr-2`} onClick={() => go({ kind: "token", q: t.tokenId })}>{tokSym(t)}</span>)}</Row>}
        {d.authorityOf?.length > 0 && <Row k="can edit info for">{d.authorityOf.map((t: any) => <span key={t.tokenId} className={`${linkC} mr-2`} onClick={() => go({ kind: "token", q: t.tokenId })}>{tokSym(t)}</span>)}</Row>}
      </div>
      {d.holdings?.length > 0 && (
        <div className={card}><h3 className="font-black text-sm mb-2">Coin holdings</h3>
          {d.holdings.map((h: any) => <Row key={h.tokenId} k={<span className={linkC} onClick={() => go({ kind: "token", q: h.tokenId })}>{tokSym(h)}</span>}>{fmtTok(h.balance, h.decimals)}{h.staked !== "0" ? ` · staked ${fmtTok(h.staked, h.decimals)}` : ""}{h.banked !== "0" ? ` · banked ${fmtXno(h.banked)} XNO` : ""}</Row>)}
        </div>
      )}
      <div className={card}><h3 className="font-black text-sm mb-2">Actions ({d.opsTotal})</h3>
        <OpsTable items={ops} go={go} />
        {next != null && <button onClick={more} className="mt-3 w-full rounded-none bg-white py-2 text-xs font-bold text-neutral-700 hover:bg-neutral-100">Load more</button>}
      </div>
    </div>
  );
}

function TokenDetailX({ d, go }: { d: any; go: (v: View) => void }) {
  const [holders, setHolders] = useState<any[]>(d.holders);
  const [hnext, setHnext] = useState<number | null>(d.holderNextCursor);
  useEffect(() => { setHolders(d.holders); setHnext(d.holderNextCursor); }, [d.tokenId]);
  const moreHolders = async () => {
    if (hnext == null) return;
    const j = await api({ view: "token", q: d.tokenId, holderCursor: String(hnext) });
    setHolders((p) => [...p, ...(j.holders ?? [])]); setHnext(j.holderNextCursor);
  };
  const reservesMatch = d.reserves && BigInt(d.reserves.onchainBalance) >= BigInt(d.reserves.indexedPoolXno);
  return (
    <div className="space-y-3">
      <div className={card}>
        <div className="flex items-center gap-3">
          {d.image ? <img src={normalizeImage(d.image)} alt="" className="w-12 h-12 rounded-full object-cover" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} /> : null}
          <div className="min-w-0">
            <h3 className="font-black">{tokName(d)} <span className="text-neutral-500">({tokSym(d)})</span> {d.authority?.immutable && <span className="px-2 py-0.5 rounded-full bg-purple-900/60 text-purple-300 text-[10px] font-bold">immutable</span>}</h3>
            <p className="text-sm">{fmtXno(d.priceRaw)} XNO <span className={pctColor(d.change24h)}>{pctStr(d.change24h)} 24h</span> · mcap {fmtXno(d.marketCapRaw)}</p>
          </div>
        </div>
        {d.description && <p className="text-xs text-neutral-600 mt-2">{d.description}</p>}
        <div className="flex gap-3 mt-2 text-xs">
          {d.website && <a className={linkC} href={d.website} target="_blank" rel="noreferrer">website ↗</a>}
          {d.twitter && <a className={linkC} href={d.twitter} target="_blank" rel="noreferrer">twitter ↗</a>}
          {d.telegram && <a className={linkC} href={d.telegram} target="_blank" rel="noreferrer">telegram ↗</a>}
        </div>
      </div>

      <div className={card}><h3 className="font-black text-sm mb-2">Price</h3><MiniChart series={d.series} /></div>

      <details className={card}>
        <summary className="font-black text-sm cursor-pointer">Technical details</summary>
        <Row k="coin ID"><span className={mono}>{d.tokenId}</span><Copy text={d.tokenId} /></Row>
        <Row k="created by"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.creator })}>{short(d.creator, 12)}</span></Row>
        {d.authority && <Row k="who can edit its info"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.authority.authority })}>{short(d.authority.authority, 12)}</span></Row>}
        {d.launchHash && <Row k="launch transaction"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "op", q: d.launchHash })}>{short(d.launchHash, 12)}</span></Row>}
        <Row k="created on">{absTime(d.createdAt)}</Row>
        <Row k="decimals"><span title="consensus-bound, immutable">{d.decimals}</span></Row>
        <Row k="supply">{fmtTok(d.supply, d.decimals)}</Row>
        <Row k="treasury">{fmtTok(d.treasury, d.decimals)}</Row>
        <Row k="coins in the pool">{fmtTok(d.poolTokens, d.decimals)}</Row>
        <Row k="staked">{fmtTok(d.totalStaked, d.decimals)}</Row>
        <Row k="burned">{fmtTok(d.burned, d.decimals)}</Row>
        <Row k="bought / sold (24h)">{fmtXno(d.buyVolumeRaw)} / {fmtXno(d.sellVolumeRaw)} XNO</Row>
      </details>

      {d.reserves && (
        <div className={card}>
          <h3 className="font-black text-sm mb-2">Proof of reserves <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${reservesMatch ? "bg-neutral-100/60 text-black" : "bg-neutral-100/60 text-black"}`}>{reservesMatch ? "backed" : "check"}</span></h3>
          <Row k="pool account"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.reserves.poolAddress })}>{short(d.reserves.poolAddress, 12)}</span><Copy text={d.reserves.poolAddress} /></Row>
          <Row k="indexed pool XNO">{fmtXno(d.reserves.indexedPoolXno)} XNO</Row>
          <Row k="on-chain balance">{fmtXno(d.reserves.onchainBalance)} XNO</Row>
          {d.reserves.pendingCount > 0 && <Row k="pending receives">{d.reserves.pendingCount}</Row>}
        </div>
      )}

      {d.trades?.length > 0 && (
        <div className={card}><h3 className="font-black text-sm mb-2">Recent trades</h3>
          <div className="overflow-x-auto"><table className="w-full"><thead><tr><th className={th}></th><th className={th}>account</th><th className={th}>amount</th><th className={th}>price</th><th className={th}>age</th></tr></thead>
            <tbody>{d.trades.map((t: any, i: number) => (
              <tr key={i} className="border-t border-neutral-300"><td className={td}><KindBadge kind={t.kind} /></td>
                <td className={`${td} ${mono}`}><span className={linkC} onClick={() => go({ kind: "account", q: t.account })}>{short(t.account, 10)}</span></td>
                <td className={td}>{fmtTok(t.amountRaw, d.decimals)}</td><td className={td}>{fmtXno(t.priceRaw)}</td>
                <td className={`${td} text-neutral-500`} title={absTime(t.time)}>{ago(t.time)}</td></tr>))}</tbody></table></div>
        </div>
      )}

      <div className={card}>
        <h3 className="font-black text-sm mb-2">Holders ({d.holdersTotal}) <span className="text-[11px] font-normal text-neutral-500">top-10 hold {d.concentration.top10Pct.toFixed(1)}%</span></h3>
        {holders.map((h: any) => (
          <div key={h.account} className="flex items-center justify-between text-xs py-1 border-t border-neutral-300/60">
            <span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: h.account })}>{short(h.account, 12)}</span>
            <span>{fmtTok(h.balance, d.decimals)} <span className="text-neutral-400">({h.pct.toFixed(2)}%)</span></span>
          </div>
        ))}
        {hnext != null && <button onClick={moreHolders} className="mt-3 w-full rounded-none bg-white py-2 text-xs font-bold text-neutral-700 hover:bg-neutral-100">Load more</button>}
      </div>

      <div className={card}><h3 className="font-black text-sm mb-2">History</h3><OpsTable items={d.ops} go={go} /></div>
    </div>
  );
}

function VerifyButton({ serverRoot }: { serverRoot: string }) {
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [res, setRes] = useState<VerifyResult | null>(null);
  async function run() {
    setState("running");
    try { setRes(await verifyInBrowser()); }
    catch (e: any) { setRes({ ok: false, localRoot: "", serverRoot, tokens: 0, ops: 0, accounts: 0, error: e.message }); }
    setState("done");
  }
  return (
    <div className="mt-2">
      <button onClick={run} disabled={state === "running"} className="rounded-none bg-black px-4 py-2 text-xs font-bold text-white hover:bg-neutral-800 disabled:opacity-40">
        {state === "running" ? "recomputing in your browser…" : "Verify in your browser"}
      </button>
      {res && <div className="mt-2 text-xs">
        {res.error ? <p className="text-black">verify error: {res.error}</p> : <>
          <p className={res.ok ? "text-black font-bold" : "text-black font-bold"}>{res.ok ? "✓ VERIFIED — your browser reproduced the server's root" : "✗ MISMATCH — server root differs from your recomputation"}</p>
          <Row k="your root"><span className={mono}>{res.localRoot || "—"}</span></Row>
          <Row k="server root"><span className={mono}>{res.serverRoot || "—"}</span></Row>
          <Row k="replayed">{res.accounts} accounts · {res.tokens} tokens · {res.ops} ops (no secrets)</Row>
        </>}
      </div>}
    </div>
  );
}

function TrustPanel({ d, go }: { d: any; go: (v: View) => void }) {
  return (
    <div className="space-y-3">
      <div className={card}><h3 className="font-black text-sm mb-2">Don't trust — verify</h3>
        <Row k="integrity fingerprint"><span className={mono}>{d.stateRoot}</span><Copy text={d.stateRoot} /></Row>
        <Row k="coins / actions replayed">{d.tokens} / {d.events}</Row>
        <Row k="protocol anchor wallet"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.anchor })}>{short(d.anchor, 12)}</span></Row>
        <Row k="verify yourself">your browser re-checks every action and must arrive at the same fingerprint</Row>
        <VerifyButton serverRoot={d.stateRoot} />
      </div>
      <div className={card}><h3 className="font-black text-sm mb-2">Proof of reserves — all pools</h3>
        <p className="text-[11px] text-neutral-500 mb-1">For each coin: the XNO this site says is in the pool vs what the Nano blockchain actually holds.</p>
        {d.pools.length === 0 && <p className="text-xs text-neutral-400">no pools yet</p>}
        {d.pools.map((p: any) => {
          const backed = BigInt(p.onchainBalance) >= BigInt(p.indexedPoolXno);
          return (
            <div key={p.tokenId} className="text-xs py-1.5 border-t border-neutral-300/60">
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold mr-1.5 ${backed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>{backed ? "✓ backed" : "! check"}</span>
              <span className={linkC} onClick={() => go({ kind: "token", q: p.tokenId })}>{tokSym(p)}</span> · site says {fmtXno(p.indexedPoolXno)} · blockchain holds {fmtXno(p.onchainBalance)} · still owed {p.outstandingObligations === "rpc-error" ? "?" : fmtXno(p.outstandingObligations)} XNO
            </div>
          );
        })}
      </div>
      <div className={card}><h3 className="font-black text-sm mb-2">Metadata snapshot</h3>
        <Row k="fingerprint"><span className={mono}>{d.snapshot.hash}</span><Copy text={d.snapshot.hash} /></Row>
        <Row k="size">{d.snapshot.bytes} bytes</Row>
        <Row k="published to the blockchain">{d.snapshot.anchored ? "yes" : "not yet"}</Row>
      </div>
    </div>
  );
}
