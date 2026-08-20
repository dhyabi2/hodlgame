// Comments store — a durable thread per token (off-chain).

import { loadJson, saveJson } from "./store";

export interface Comment {
  id: string;
  tokenId: string;
  account: string;
  text: string;
  time: number;
}

export async function loadComments(): Promise<Comment[]> {
  return (await loadJson<Comment[]>("comments")) ?? [];
}

export async function commentsFor(tokenId: string): Promise<Comment[]> {
  return (await loadComments())
    .filter((c) => c.tokenId === tokenId)
    .sort((a, b) => a.time - b.time)
    .slice(-200);
}

export async function addComment(tokenId: string, account: string, text: string): Promise<Comment> {
  const all = await loadComments();
  const comment: Comment = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    tokenId,
    account,
    text: String(text).slice(0, 280),
    time: Date.now(),
  };
  all.push(comment);
  // Bound total storage (unauthenticated writes): keep the most recent.
  const MAX_COMMENTS = 20000;
  const trimmed = all.length > MAX_COMMENTS ? all.slice(all.length - MAX_COMMENTS) : all;
  await saveJson("comments", trimmed);
  return comment;
}