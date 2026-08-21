"use client";

// Explorer tab (docs/EXPLORER-SPEC.md): unified search, decoded op feed with
// state deltas, op/account/token drill-downs, and the trust dashboard.

import { useEffect, useState } from "react";
import { verifyInBrowser, type VerifyResult } from "../lib/clientIndexer";

type View =
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
const fmtXno = (raw?: string) => {
  if (!raw || raw === "0") return "0";
  const neg = raw.startsWith("-");
  const n = Number(BigInt(neg ? raw.slice(1) : raw)) / 1e30;
  const s = n < 0.000001 ? n.toExponential(2) : n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return (neg ? "-" : "") + s;
};
const fmtTok = (raw: string, dec: number) => {
  const neg = raw.startsWith("-");
  const n = BigInt(neg ? raw.slice(1) : raw);
  const d = 10n ** BigInt(dec);
  const frac = (n % d).toString().padStart(dec, "0").replace(/0+$/, "").slice(0, 6);
  return `${neg ? "-" : ""}${n / d}${frac ? "." + frac : ""}`;
};

const KIND_COLOR: Record<string, string> = {
  launch: "bg-purple-900/60 text-purple-300",
  buy: "bg-green-900/60 text-green-300",
  sell: "bg-red-900/60 text-red-300",
  transfer: "bg-blue-900/60 text-blue-300",
  seedLiq: "bg-teal-900/60 text-teal-300",
  addLiq: "bg-teal-900/60 text-teal-300",
  stake: "bg-amber-900/60 text-amber-300",
  unstake: "bg-amber-900/60 text-amber-300",
  claim: "bg-zinc-800 text-zinc-300",
};

const card = "rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4";
const th = "text-left text-[10px] uppercase tracking-wider text-zinc-600 pb-1 pr-3";
const td = "py-1 pr-3 text-xs";
const mono = "font-mono text-[11px]";
const linkC = "text-green-400 hover:underline cursor-pointer";

async function api(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`/api/explorer?${qs}`);
  return r.json();
}

function KindBadge({ kind, valid }: { kind: string; valid?: boolean }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${KIND_COLOR[kind] ?? "bg-zinc-800 text-zinc-300"}`}>
      {kind}
      {valid === false ? " ✕" : ""}
    </span>
  );
}

function OpRow({ it, go }: { it: any; go: (v: View) => void }) {
  const sum =
    it.fields?.poolXno && (it.kind === "buy" || it.kind === "sell" || it.kind === "seedLiq")
      ? `${fmtXno((BigInt(it.fields.poolXno.after) - BigInt(it.fields.poolXno.before)).toString())} XNO`
      : it.balances?.length
      ? `${it.balances.length} balance change${it.balances.length > 1 ? "s" : ""}`
      : "";
  return (
    <tr className="border-t border-zinc-900 hover:bg-zinc-900/40">
      <td className={td}>
        <KindBadge kind={it.kind} valid={it.valid} />
      </td>
      <td className={td}>
        <span className={linkC} onClick={() => go({ kind: "token", q: it.tokenId })}>
          {it.symbol || short(it.tokenId, 6)}
        </span>
      </td>
      <td className={`${td} ${mono}`}>
        <span className={linkC} onClick={() => go({ kind: "account", q: it.sender })}>
          {short(it.sender, 10)}
        </span>
      </td>
      <td className={`${td} text-zinc-400`}>{it.valid === false ? <span className="text-red-400">{it.reason}</span> : sum}</td>
      <td className={`${td} ${mono}`}>
        <span className={linkC} onClick={() => go({ kind: "op", q: it.hash })}>
          {short(it.hash, 8)}
        </span>
      </td>
      <td className={`${td} text-zinc-500`}>{ago(it.timestamp)}</td>
    </tr>
  );
}

function OpsTable({ items, go }: { items: any[]; go: (v: View) => void }) {
  if (!items?.length) return <p className="text-xs text-zinc-600">no ops</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className={th}>op</th>
            <th className={th}>token</th>
            <th className={th}>account</th>
            <th className={th}>effect</th>
            <th className={th}>hash</th>
            <th className={th}>age</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <OpRow key={it.hash} it={it} go={go} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ k, children }: { k: string; children: any }) {
  return (
    <div className="flex gap-3 py-1 border-t border-zinc-900/60 text-xs">
      <span className="w-36 shrink-0 text-zinc-500">{k}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

export default function Explorer() {
  const [view, setView] = useState<View>({ kind: "feed" });
  const [q, setQ] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr("");
    const params: Record<string, string> =
      view.kind === "feed" || view.kind === "trust"
        ? { view: view.kind }
        : view.kind === "results"
        ? { view: "search", q: view.q }
        : { view: view.kind, q: view.q };
    const load = (first: boolean) =>
      api(params)
        .then((j) => {
          if (!live) return;
          if (j.error) {
            if (first) setErr(j.error);
          } else {
            setData(j);
            setErr("");
          }
        })
        .catch((e) => live && first && setErr(e.message))
        .finally(() => live && first && setLoading(false));
    load(true);
    // Live refresh on the always-changing views (feed + trust dashboard).
    const t =
      view.kind === "feed" || view.kind === "trust" ? setInterval(() => load(false), 5000) : null;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [JSON.stringify(view)]);

  const go = (v: View) => {
    setData(null);
    setView(v);
  };
  const submit = () => q.trim() && go({ kind: "results", q: q.trim() });

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-green-500 font-mono"
          placeholder="search: token name / tokenId / nano_ address / block hash"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="shrink-0 rounded-xl bg-green-500 px-4 py-3 text-sm font-bold text-black hover:bg-green-400" onClick={submit}>
          Search
        </button>
      </div>
      <div className="flex gap-2 text-xs">
        {(["feed", "trust"] as const).map((k) => (
          <button
            key={k}
            onClick={() => go({ kind: k })}
            className={`px-3 py-1.5 rounded-full font-bold ${view.kind === k ? "bg-green-500 text-black" : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"}`}
          >
            {k === "feed" ? "ops feed" : "trust"}
          </button>
        ))}
        {view.kind !== "feed" && view.kind !== "trust" && (
          <span className="px-3 py-1.5 rounded-full bg-zinc-800 text-zinc-300 font-mono">{view.kind}: {short((view as any).q ?? "", 10)}</span>
        )}
      </div>

      {loading && <p className="text-xs text-zinc-600">loading…</p>}
      {err && <p className="text-xs text-red-400">{err}</p>}
      {!loading && !err && data && (
        <>
          {view.kind === "feed" && (
            <div className={card}>
              <p className="text-[11px] text-zinc-600 mb-2">{data.total} ops replayed · newest first</p>
              <OpsTable items={data.items} go={go} />
            </div>
          )}

          {view.kind === "results" &&
            (data.type === "op" ? (
              <OpDetail d={data.data} go={go} />
            ) : data.type === "account" ? (
              <AccountDetail d={data.data} go={go} />
            ) : data.type === "token" ? (
              <TokenDetailX d={data.data} go={go} />
            ) : data.type === "tokens" ? (
              <div className={card}>
                {data.data.length === 0 && <p className="text-xs text-zinc-600">no matches</p>}
                {data.data.map((t: any) => (
                  <p key={t.tokenId} className="text-sm py-1">
                    <span className={linkC} onClick={() => go({ kind: "token", q: t.tokenId })}>
                      {t.name || short(t.tokenId, 8)} ({t.symbol})
                    </span>
                  </p>
                ))}
              </div>
            ) : data.type === "block" ? (
              <div className={card}>
                <h3 className="font-black mb-2">Nano block (not a HoldFun op)</h3>
                <Row k="hash"><span className={mono}>{data.data.hash}</span></Row>
                <Row k="account"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: data.data.account })}>{data.data.account}</span></Row>
                <Row k="amount">{fmtXno(data.data.amount)} XNO</Row>
                <Row k="classified as">{data.data.classification?.kind}{data.data.classification?.tokenId ? ` · token ${short(data.data.classification.tokenId, 8)}` : ""}</Row>
              </div>
            ) : (
              <p className="text-xs text-zinc-600">nothing found</p>
            ))}

          {view.kind === "op" && <OpDetail d={data} go={go} />}
          {view.kind === "account" && <AccountDetail d={data} go={go} />}
          {view.kind === "token" && <TokenDetailX d={data} go={go} />}
          {view.kind === "trust" && <TrustPanel d={data} go={go} />}
        </>
      )}
    </div>
  );
}

function OpDetail({ d, go }: { d: any; go: (v: View) => void }) {
  return (
    <div className="space-y-3">
      <div className={card}>
        <div className="flex items-center gap-2 mb-2">
          <KindBadge kind={d.kind} valid={d.valid} />
          <span className={linkC} onClick={() => go({ kind: "token", q: d.tokenId })}>{d.symbol || short(d.tokenId, 8)}</span>
          <span className="text-zinc-600 text-xs">{ago(d.timestamp)}</span>
        </div>
        <Row k="hash"><span className={mono}>{d.hash}</span></Row>
        {d.carriers && (
          <Row k="carrier blocks">
            <span className={mono}>{d.carriers.map((c: string) => short(c, 10)).join(" + ")} (fragment pair)</span>
          </Row>
        )}
        <Row k="signer"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.sender })}>{d.sender}</span></Row>
        {!d.valid && <Row k="rejected"><span className="text-red-400">{d.reason}</span></Row>}
        {d.depositEdge && (
          <Row k="funded by deposit">
            <span className={mono}>{short(d.depositEdge.deposit, 12)}</span> · {fmtXno(d.depositEdge.amountRaw)} XNO
          </Row>
        )}
        <Row k="on Nano L1">
          <a className={linkC} href={`https://nanexplorer.com/nano/block/${d.hash}`} target="_blank" rel="noreferrer">nanexplorer ↗</a>
        </Row>
      </div>

      {Object.keys(d.fields ?? {}).length > 0 && (
        <div className={card}>
          <h3 className="font-black text-sm mb-2">State changes</h3>
          {Object.entries(d.fields).map(([f, v]: any) => (
            <Row key={f} k={f}>
              <span className={mono}>{v.before} → {v.after}</span>
            </Row>
          ))}
        </div>
      )}
      {d.balances?.length > 0 && (
        <div className={card}>
          <h3 className="font-black text-sm mb-2">Balance movements</h3>
          {d.balances.map((b: any) => (
            <Row key={b.account} k={short(b.account, 10)}>
              <span className={b.delta.startsWith("-") ? "text-red-400" : "text-green-400"}>{b.delta}</span> raw tokens
            </Row>
          ))}
        </div>
      )}
      {d.payoutCoverage?.length > 0 && (
        <div className={card}>
          <h3 className="font-black text-sm mb-2">Payout story</h3>
          {d.payoutCoverage.map((c: any) => (
            <div key={c.sendHash} className="text-xs py-1 border-t border-zinc-900/60">
              pool send <span className={mono}>{short(c.sendHash, 10)}</span> → {fmtXno(c.amountRaw)} XNO to {short(c.recipient, 10)}, covering{" "}
              {c.covers.map((x: any, i: number) => (
                <span key={i}>
                  {x.kind} {x.hash ? short(x.hash, 8) : ""} ({fmtXno(x.amountRaw)} XNO){i < c.covers.length - 1 ? " + " : ""}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountDetail({ d, go }: { d: any; go: (v: View) => void }) {
  return (
    <div className="space-y-3">
      <div className={card}>
        <h3 className="font-black mb-1 break-all font-mono text-sm">{d.address}</h3>
        {d.labels?.map((l: string) => (
          <span key={l} className="inline-block mr-1 px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 text-[10px] font-bold">{l}</span>
        ))}
        <Row k="XNO balance">{fmtXno(d.xnoBalanceRaw)} XNO {d.opened ? "" : "(unopened)"}</Row>
        {d.createdTokens?.length > 0 && (
          <Row k="created tokens">
            {d.createdTokens.map((t: string) => (
              <span key={t} className={`${linkC} mr-2`} onClick={() => go({ kind: "token", q: t })}>{short(t, 8)}</span>
            ))}
          </Row>
        )}
        {d.authorityOf?.length > 0 && (
          <Row k="metadata authority of">
            {d.authorityOf.map((t: string) => (
              <span key={t} className={`${linkC} mr-2`} onClick={() => go({ kind: "token", q: t })}>{short(t, 8)}</span>
            ))}
          </Row>
        )}
      </div>
      {d.holdings?.length > 0 && (
        <div className={card}>
          <h3 className="font-black text-sm mb-2">Token holdings</h3>
          {d.holdings.map((h: any) => (
            <Row key={h.tokenId} k={h.symbol || short(h.tokenId, 8)}>
              {fmtTok(h.balance, h.decimals)} {h.staked !== "0" ? `· staked ${fmtTok(h.staked, h.decimals)}` : ""}
            </Row>
          ))}
        </div>
      )}
      <div className={card}>
        <h3 className="font-black text-sm mb-2">Ops</h3>
        <OpsTable items={d.ops} go={go} />
      </div>
    </div>
  );
}

function TokenDetailX({ d, go }: { d: any; go: (v: View) => void }) {
  const reservesMatch = d.reserves && BigInt(d.reserves.onchainBalance) >= BigInt(d.reserves.indexedPoolXno);
  return (
    <div className="space-y-3">
      <div className={card}>
        <h3 className="font-black mb-2">
          {d.name || short(d.tokenId, 8)} <span className="text-zinc-500">({d.symbol})</span>{" "}
          {d.authority?.immutable && <span className="px-2 py-0.5 rounded-full bg-purple-900/60 text-purple-300 text-[10px] font-bold">immutable</span>}
        </h3>
        <Row k="tokenId"><span className={mono}>{d.tokenId}</span></Row>
        <Row k="creator"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.creator })}>{short(d.creator, 12)}</span></Row>
        {d.authority && <Row k="metadata authority"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.authority.authority })}>{short(d.authority.authority, 12)}</span></Row>}
        {d.launchHash && <Row k="launch block"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "op", q: d.launchHash })}>{short(d.launchHash, 12)}</span></Row>}
        <Row k="supply">{fmtTok(d.supply, d.decimals)}</Row>
        <Row k="treasury">{fmtTok(d.treasury, d.decimals)}</Row>
        <Row k="pool tokens">{fmtTok(d.poolTokens, d.decimals)}</Row>
        <Row k="staked">{fmtTok(d.totalStaked, d.decimals)}</Row>
        <Row k="burned">{fmtTok(d.burned, d.decimals)}</Row>
      </div>
      {d.reserves && (
        <div className={card}>
          <h3 className="font-black text-sm mb-2">
            Proof of reserves{" "}
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${reservesMatch ? "bg-green-900/60 text-green-300" : "bg-red-900/60 text-red-300"}`}>
              {reservesMatch ? "backed" : "check"}
            </span>
          </h3>
          <Row k="pool account"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.reserves.poolAddress })}>{short(d.reserves.poolAddress, 12)}</span></Row>
          <Row k="indexed pool XNO">{fmtXno(d.reserves.indexedPoolXno)} XNO</Row>
          <Row k="on-chain balance">{fmtXno(d.reserves.onchainBalance)} XNO</Row>
          {d.reserves.pendingCount > 0 && <Row k="pending receives">{d.reserves.pendingCount}</Row>}
        </div>
      )}
      <div className={card}>
        <h3 className="font-black text-sm mb-2">Holders ({d.holders.length})</h3>
        {d.holders.slice(0, 50).map((h: any) => (
          <Row key={h.account} k={short(h.account, 10)}>{fmtTok(h.balance, d.decimals)}</Row>
        ))}
      </div>
      <div className={card}>
        <h3 className="font-black text-sm mb-2">History</h3>
        <OpsTable items={d.ops} go={go} />
      </div>
    </div>
  );
}

function VerifyButton({ serverRoot }: { serverRoot: string }) {
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [res, setRes] = useState<VerifyResult | null>(null);
  async function run() {
    setState("running");
    try {
      setRes(await verifyInBrowser());
    } catch (e: any) {
      setRes({ ok: false, localRoot: "", serverRoot, tokens: 0, ops: 0, accounts: 0, error: e.message });
    }
    setState("done");
  }
  return (
    <div className="mt-2">
      <button
        onClick={run}
        disabled={state === "running"}
        className="rounded-xl bg-green-500 px-4 py-2 text-xs font-bold text-black hover:bg-green-400 disabled:opacity-40"
      >
        {state === "running" ? "recomputing in your browser…" : "Verify in your browser"}
      </button>
      {res && (
        <div className="mt-2 text-xs">
          {res.error ? (
            <p className="text-amber-400">verify error: {res.error}</p>
          ) : (
            <>
              <p className={res.ok ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                {res.ok ? "✓ VERIFIED — your browser reproduced the server's root" : "✗ MISMATCH — server root differs from your recomputation"}
              </p>
              <Row k="your root"><span className={mono}>{res.localRoot || "—"}</span></Row>
              <Row k="server root"><span className={mono}>{res.serverRoot || "—"}</span></Row>
              <Row k="replayed">{res.accounts} accounts · {res.tokens} tokens · {res.ops} ops (no secrets)</Row>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TrustPanel({ d, go }: { d: any; go: (v: View) => void }) {
  return (
    <div className="space-y-3">
      <div className={card}>
        <h3 className="font-black text-sm mb-2">Consensus</h3>
        <Row k="state root"><span className={mono}>{d.stateRoot}</span></Row>
        <Row k="tokens / ops">{d.tokens} / {d.events}</Row>
        <Row k="anchor account"><span className={`${mono} ${linkC}`} onClick={() => go({ kind: "account", q: d.anchor })}>{short(d.anchor, 12)}</span></Row>
        <Row k="verify yourself"><span className={mono}>npx tsx scripts/verify.ts</span> recomputes this root with zero secrets</Row>
        <VerifyButton serverRoot={d.stateRoot} />
      </div>
      <div className={card}>
        <h3 className="font-black text-sm mb-2">Proof of reserves — all pools</h3>
        {d.pools.length === 0 && <p className="text-xs text-zinc-600">no pools yet</p>}
        {d.pools.map((p: any) => (
          <div key={p.tokenId} className="text-xs py-1.5 border-t border-zinc-900/60">
            <span className={linkC} onClick={() => go({ kind: "token", q: p.tokenId })}>{p.symbol || short(p.tokenId, 8)}</span>{" "}
            · indexed {fmtXno(p.indexedPoolXno)} · on-chain {fmtXno(p.onchainBalance)} · owed {p.outstandingObligations === "rpc-error" ? "?" : fmtXno(p.outstandingObligations)} XNO
          </div>
        ))}
      </div>
      <div className={card}>
        <h3 className="font-black text-sm mb-2">Off-chain snapshot</h3>
        <Row k="hash"><span className={mono}>{d.snapshot.hash}</span></Row>
        <Row k="size">{d.snapshot.bytes} bytes</Row>
        <Row k="anchored on-chain">{d.snapshot.anchored ? "yes" : "not yet"}</Row>
      </div>
    </div>
  );
}
