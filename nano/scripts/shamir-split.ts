// Offline k-of-n splitting for custody seeds (roadmap W1 layer 0).
// RUN THIS ON AN AIR-GAPPED MACHINE for real seeds. Nothing in the deployed
// app imports this — it is pure tooling.
//
//   npx tsx scripts/shamir-split.ts split <64-hex-seed> [k] [n]     (default 2-of-3)
//   npx tsx scripts/shamir-split.ts combine <share> <share> [...]
//
// Every split SELF-VERIFIES before printing: each k-combination is
// reconstructed and compared byte-for-byte against the input; if any
// combination disagrees, nothing is printed.

import { splitSecret, combineShares, shareToString, shareFromString, type Share } from "../lib/shamir";

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [head, ...rest] = arr;
  return [...combinations(rest, k - 1).map((c) => [head, ...c]), ...combinations(rest, k)];
}

function main() {
  const [mode, ...args] = process.argv.slice(2);

  if (mode === "split") {
    const seedHex = (args[0] ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(seedHex)) {
      console.error("usage: shamir-split.ts split <64-hex-seed> [k] [n]");
      process.exit(2);
    }
    const k = Number(args[1] ?? 2);
    const n = Number(args[2] ?? 3);
    const secret = Uint8Array.from(Buffer.from(seedHex, "hex"));
    const shares = splitSecret(secret, k, n);

    // Self-verify every k-combination before printing anything.
    for (const combo of combinations(shares, k)) {
      const back = Buffer.from(combineShares(combo)).toString("hex");
      if (back !== seedHex) {
        console.error("SELF-VERIFY FAILED — no shares printed. Do not use this run.");
        process.exit(1);
      }
    }

    console.log(`# ${k}-of-${n} shares (self-verified: every ${k}-combination reconstructs the seed)`);
    console.log(`# Give ONE line to each steward. Any ${k} lines reconstruct; ${k - 1} reveal nothing.`);
    console.log(`# Store nothing here — this output exists only on this screen.`);
    for (const s of shares) console.log(`share ${s.index}/${n}: ${shareToString(s)}`);
    return;
  }

  if (mode === "combine") {
    if (args.length < 2) {
      console.error("usage: shamir-split.ts combine <share> <share> [...]");
      process.exit(2);
    }
    const shares: Share[] = args.map(shareFromString);
    console.log(Buffer.from(combineShares(shares)).toString("hex"));
    return;
  }

  console.error("usage: shamir-split.ts split|combine ...");
  process.exit(2);
}

main();
