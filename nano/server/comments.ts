// Comments store — a tiny JSON-file-backed thread per token (off-chain).

import * as fs from "node:fs";
import * as path from "node:path";

export interface Comment {
  id: string;
  tokenId: string;
  account: string;
  text: string;
  time: number;
}

function commentsFile(): string {
  return process.env.COMMENTS_FILE ?? path.join(process.cwd(), ".comments.json");
}

export function loadComments(): Comment[] {
  try {
    const raw = JSON.parse(fs.readFileSync(commentsFile(), "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(comments: Comment[]): void {
  fs.writeFileSync(commentsFile(), JSON.stringify(comments, null, 2));
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
  save(all);
  return comment;
}