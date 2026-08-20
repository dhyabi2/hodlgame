// Multi-token identity. A token is named by the first 16 bytes (128 bits) of its
// launch block hash. The launch block's hash is deterministic on-chain (Nano
// hashes the full signed block), so any indexer can derive the same id from the
// launch block alone — no off-chain registry is required for identity.

export const TOKEN_ID_HEX = 32; // 16 bytes = 32 hex chars
export const TOKEN_ID_BYTES = 16;

/** 32-hex (128-bit) token id — the state-map key everywhere. */
export type TokenId = string;

/** First 16 bytes of a 64-hex Nano block hash. */
export function tokenIdFromLaunchHash(hash: string): TokenId {
  return hash.replace(/^0x/i, "").toLowerCase().slice(0, TOKEN_ID_HEX);
}
