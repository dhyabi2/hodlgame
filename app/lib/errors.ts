/** Turns raw wallet/RPC error text into something a player can actually use. */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("user rejected") || lower.includes("rejected the request")) {
    return "You cancelled the transaction in your wallet.";
  }
  if (lower.includes("insufficient") && lower.includes("lamports")) {
    return "Not enough SOL to cover the transaction fee.";
  }
  if (lower.includes("insufficient") || lower.includes("0x1")) {
    return "Not enough balance to complete this — check your wallet.";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "The network is busy right now — wait a few seconds and try again.";
  }
  if (lower.includes("blockhash not found") || lower.includes("expired")) {
    return "That transaction took too long and expired. Try again.";
  }
  if (lower.includes("slippagetolerance") || lower.includes("slippage")) {
    return "Price moved before your swap landed. Try again with the new quote.";
  }
  if (lower.includes("accountnotinitialized") || lower.includes("could not find account")) {
    return "That account doesn't exist on-chain yet. If you've never staked, stake first.";
  }
  if (lower.includes("insufficientliquidity") || lower.includes("poolempty")) {
    return "The swap pool doesn't have enough liquidity for that trade. Try a smaller amount.";
  }
  if (lower.includes("amounttoosmall") || lower.includes("zeroamount")) {
    return "That amount rounds to zero on-chain. Try a larger one.";
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "Couldn't reach the network. Check your connection and try again.";
  }
  if (lower.includes("wallet not connected")) {
    return "Your wallet disconnected. Reconnect and try again.";
  }

  // Fall back to the real message, but keep it short — a raw stack-trace-y
  // string is worse than nothing for a player trying to understand what happened.
  return raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
}
