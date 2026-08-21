// STRICT RULE: HoldFun Nano uses https://rpc.nano.to EXCLUSIVELY.
// Do NOT add other RPC endpoints, proxies, or work services to this file or
// anywhere else in the codebase. The only permitted fallback is LOCAL CPU
// proof-of-work computation (offline, contacts no one), used when
// work_generate does not answer.
//
// Fetched blocks are still verified locally (indexer/blockSource.ts):
// self-certifying ed25519-blake2b signatures mean the endpoint can omit
// data, never forge it.

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";

export const NANO_RPC = "https://rpc.nano.to";
export const SEND_DIFFICULTY = "fffffff800000000";
export const RECEIVE_DIFFICULTY = "fffffe0000000000";

/** Load the rpc.nano.to API key from env or the local (gitignored) .keys.json. */
export function loadNanoRpcKey(): string {
  if (process.env.NANO_RPC_KEY) return process.env.NANO_RPC_KEY;
  try {
    const keys = JSON.parse(fs.readFileSync(".keys.json", "utf-8"));
    return keys.nanoRpcKey ?? "";
  } catch {
    return "";
  }
}

const TIMEOUT_MS = 30_000;
const WORK_RPC_TIMEOUT_MS = 10_000; // work_generate is known to hang; fail fast to local

async function rawCall(key: string, body: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const payload = { ...body };
  // rpc.nano.to accepts the key in the body and as an Authorization header
  // (no "Bearer" prefix) — per the reference implementation.
  if (key) (payload as any).key = key;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(NANO_RPC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: key } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const json = (await res.json()) as any;
    if (json.error) {
      throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ── Proof-of-work service (pattern learned from verifyXNOPrivacyProtocol) ───
//
// Layered: cache → rpc.nano.to (validated — the endpoint has served invalid
// nonces and currently hangs, so a short timeout + local validation are
// mandatory) → compiled C generator raced across CPU cores (bin/workgen,
// `npm run build-workgen`) → WASM computeWork as the last resort. Work is
// tied to a root, so a per-process cache keyed (root, difficulty) makes
// repeats free, and send-difficulty work also satisfies receive.

import { blake2b } from "blakejs";

/** Nano PoW check: blake2b-8(work_le ‖ root) as LE u64 >= threshold. */
export function validateWork(workHex: string, rootHex: string, difficultyHex: string): boolean {
  if (!/^[0-9a-fA-F]{16}$/.test(workHex) || !/^[0-9a-fA-F]{64}$/.test(rootHex)) return false;
  const workLe = Buffer.from(workHex, "hex").reverse();
  const root = Buffer.from(rootHex, "hex");
  const digest = blake2b(Buffer.concat([workLe, root]), undefined, 8);
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(digest[i]);
  return v >= BigInt("0x" + difficultyHex);
}

const workCache = new Map<string, string>(); // `${root}|${difficulty}` → work
const WORK_CACHE_MAX = 2000;

function cacheGet(root: string, difficulty: string): string | undefined {
  const r = root.toLowerCase();
  return (
    workCache.get(`${r}|${difficulty.toLowerCase()}`) ??
    // send-difficulty work always satisfies receive difficulty
    (difficulty.toLowerCase() === RECEIVE_DIFFICULTY ? workCache.get(`${r}|${SEND_DIFFICULTY}`) : undefined)
  );
}
function cachePut(root: string, difficulty: string, work: string) {
  if (workCache.size >= WORK_CACHE_MAX) workCache.delete(workCache.keys().next().value!);
  workCache.set(`${root.toLowerCase()}|${difficulty.toLowerCase()}`, work);
}

/** Race N copies of the compiled generator (random start nonces); first valid
 * nonce wins, losers are killed. `promise` resolves null if the binary is
 * missing or the race is cancelled. */
function workgenRace(root: string, difficulty: string): { promise: Promise<string | null>; cancel: () => void } {
  let cancelFn = () => {};
  const promise = (async () => {
    try {
      const [{ spawn }, os, path, fsm] = await Promise.all([
        import("node:child_process"),
        import("node:os"),
        import("node:path"),
        import("node:fs"),
      ]);
      const bin = process.env.WORKGEN_BIN ?? path.join(process.cwd(), "bin", "workgen");
      if (!fsm.existsSync(bin)) return null;
      const n = Math.max(1, os.cpus().length - 1);
      return await new Promise<string | null>((resolve) => {
        const procs = Array.from({ length: n }, () => spawn(bin, [root, difficulty]));
        let done = false;
        const finish = (work: string | null) => {
          if (done) return;
          done = true;
          for (const p of procs) p.kill("SIGKILL");
          resolve(work);
        };
        cancelFn = () => finish(null);
        let exited = 0;
        for (const p of procs) {
          let out = "";
          p.stdout.on("data", (d: Buffer) => {
            out += d.toString();
            const w = out.trim().slice(0, 16);
            if (w.length === 16 && validateWork(w, root, difficulty)) finish(w);
          });
          p.on("exit", () => {
            exited++;
            if (exited === n) finish(null); // all died without a valid nonce
          });
          p.on("error", () => finish(null));
        }
      });
    } catch {
      return null;
    }
  })();
  return { promise, cancel: () => cancelFn() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function generateWork(key: string, root: string, difficulty: string): Promise<any> {
  const cached = cacheGet(root, difficulty);
  if (cached) return { work: cached, difficulty, source: "cache" };

  // rpc.nano.to first (GPU: 0.1–0.6s when healthy) — but it is known to hang,
  // so after a short grace the local race starts CONCURRENTLY and whichever
  // produces a valid nonce first wins. Every nonce is validated locally.
  const rpcAttempt: Promise<string | null> = rawCall(
    key,
    { action: "work_generate", hash: root, difficulty },
    WORK_RPC_TIMEOUT_MS
  )
    .then((json) => {
      const w = String(json?.work ?? "").trim();
      return w && validateWork(w, root, difficulty) ? w : null;
    })
    .catch(() => null);

  const graced = await Promise.race([rpcAttempt, sleep(1500).then(() => "grace" as const)]);
  if (graced && graced !== "grace") {
    cachePut(root, difficulty, graced);
    return { work: graced, difficulty, source: "rpc" };
  }

  const race = workgenRace(root, difficulty);
  const winner = await new Promise<{ work: string; source: string } | null>((resolve) => {
    let pendingSources = 2;
    const settle = (work: string | null, source: string) => {
      if (work) return resolve({ work, source });
      if (--pendingSources === 0) resolve(null);
    };
    rpcAttempt.then((w) => settle(w, "rpc"));
    race.promise.then((w) => settle(w, "workgen"));
  });
  race.cancel();
  if (winner) {
    cachePut(root, difficulty, winner.work);
    return { work: winner.work, difficulty, source: winner.source };
  }

  // WASM last resort (no compiled binary and RPC dead).
  const work = await nanocurrency.computeWork(root, { workThreshold: difficulty });
  if (work) {
    cachePut(root, difficulty, work);
    return { work, difficulty, source: "wasm" };
  }
  throw new Error("work generation failed");
}

/** Fire-and-forget pre-warm for a root whose work will be needed soon (e.g.
 * the hash of a block just broadcast — it is the next frontier). */
export function warmWork(key: string, root: string, difficulty: string = SEND_DIFFICULTY): void {
  if (cacheGet(root, difficulty)) return;
  void generateWork(key, root, difficulty).catch(() => {});
}

/** Perform a JSON-RPC call against rpc.nano.to. Throws on error.
 * work_generate is served by the layered work service above. */
export async function nanoRpc(key: string, body: Record<string, unknown>): Promise<any> {
  if (body.action === "work_generate" && typeof body.hash === "string") {
    const difficulty = typeof body.difficulty === "string" ? body.difficulty : SEND_DIFFICULTY;
    return generateWork(key, body.hash, difficulty);
  }
  return rawCall(key, body, TIMEOUT_MS);
}
