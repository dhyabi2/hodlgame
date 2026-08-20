// Strict RPC config: HoldFun Nano uses rpc.nano.to exclusively.

import * as fs from "node:fs";

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

/** Perform a JSON-RPC call against rpc.nano.to. Throws on error. */
export async function nanoRpc(
  key: string,
  body: Record<string, unknown>
): Promise<any> {
  const payload = { ...body };
  // rpc.nano.to accepts the key in the body and as an Authorization header
  // (no "Bearer" prefix) — per the reference implementation.
  if (key) payload.key = key;
  const res = await fetch(NANO_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: key } : {}),
    },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as any;
  if (json.error) {
    throw new Error(
      typeof json.error === "string" ? json.error : JSON.stringify(json.error)
    );
  }
  return json;
}
