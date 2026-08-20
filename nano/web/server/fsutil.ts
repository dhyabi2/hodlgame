// Atomic file write: write to a temp file then rename, so a crash mid-write
// never leaves a torn/partial state file (the sweep paid/deposit ledgers).

import * as fs from "node:fs";

export function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}