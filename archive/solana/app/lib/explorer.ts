const CLUSTER = process.env.NEXT_PUBLIC_NETWORK ?? "devnet";

/** `?cluster=` is omitted on mainnet — Solana Explorer defaults there. */
function suffix(): string {
  return CLUSTER === "mainnet-beta" || CLUSTER === "mainnet"
    ? ""
    : `?cluster=${CLUSTER}`;
}

export const NETWORK_LABEL =
  CLUSTER === "mainnet-beta" || CLUSTER === "mainnet"
    ? "Mainnet"
    : CLUSTER.charAt(0).toUpperCase() + CLUSTER.slice(1);

export const IS_MAINNET = CLUSTER === "mainnet-beta" || CLUSTER === "mainnet";

export function txUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${suffix()}`;
}

export function addressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}${suffix()}`;
}

export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
