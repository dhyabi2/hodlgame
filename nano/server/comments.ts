// Comments store — a durable thread per token (off-chain).

import { loadJson, saveJson } from "./store";

export interface Comment {
  id: string;
  tokenId: string;
  account: string;
  text: string;
  time: number;
}

export function loadComments(): Comment[] {
  return loadJson<Comment[]>("comments.json") ?? [];
}

export function commentsFor(tokenId: string): Comment[] {
  return loadComments()
    .filter((c) => c.tokenId === tokenId)
    .sort((a, b) => a.time - b.time)
    .slice(-200);
}

export function addComment(tokenId: string, account: string, text: string): Comment {
  const all = loadComments();
  const comment: Comment = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    tokenId,
    account,
    text: String(text).slice(0, 280),
    time: Date.now(),
  };
  all.push(comment);
  saveJson("comments.json", all);
  return comment;
}