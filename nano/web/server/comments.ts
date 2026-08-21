// Comments store — a durable thread per token (off-chain, author-signed).
//
// Every comment carries the author's ed25519-blake2b signature over a
// domain-separated digest (core/commentAuth.ts), verified before storing, so
// authorship survives any store loss/fork: an untrusted mirror can re-serve
// comments and anyone can re-verify them. Ids derive from the signature, so
// re-posting a captured comment is idempotent, never a spoof or a replay.

import { commentSignDigest, commentId, MAX_COMMENT_LEN } from "../core/commentAuth";
import { verifyAccountSignature } from "./metaAuth";
import { loadJson, saveJson } from "./store";

export interface Comment {
  id: string;
  tokenId: string;
  account: string;
  text: string;
  time: number;
  signature: string;
}

/** Max clock skew accepted on a comment's client-supplied timestamp. */
const MAX_SKEW_MS = 10 * 60 * 1000;

export async function loadComments(): Promise<Comment[]> {
  return (await loadJson<Comment[]>("comments")) ?? [];
}

export async function commentsFor(tokenId: string): Promise<Comment[]> {
  return (await loadComments())
    .filter((c) => c.tokenId === tokenId)
    .sort((a, b) => a.time - b.time)
    .slice(-200);
}

export type AddResult = { ok: true; comment: Comment } | { ok: false; error: string };

export async function addComment(
  tokenId: string,
  account: string,
  text: string,
  time: number,
  signature: string
): Promise<AddResult> {
  // Signature covers the EXACT text + time; reject rather than mutate.
  if (typeof text !== "string" || !text.trim() || text.length > MAX_COMMENT_LEN) {
    return { ok: false, error: `text required (max ${MAX_COMMENT_LEN} chars)` };
  }
  if (!Number.isSafeInteger(time) || Math.abs(Date.now() - time) > MAX_SKEW_MS) {
    return { ok: false, error: "time out of range" };
  }
  if (!verifyAccountSignature(account, signature, commentSignDigest(tokenId, time, text))) {
    return { ok: false, error: "invalid author signature" };
  }
  const all = await loadComments();
  const id = commentId(signature);
  if (all.some((c) => c.id === id)) {
    return { ok: true, comment: all.find((c) => c.id === id)! }; // idempotent re-post
  }
  const comment: Comment = { id, tokenId, account, text, time, signature };
  all.push(comment);
  // Bound total storage: keep the most recent.
  const MAX_COMMENTS = 20000;
  const trimmed = all.length > MAX_COMMENTS ? all.slice(all.length - MAX_COMMENTS) : all;
  await saveJson("comments", trimmed);
  return { ok: true, comment };
}
