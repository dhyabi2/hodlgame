// BigInt-safe JSON (ops carry bigint amounts). Works in Node and the browser.

export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}

export function parse<T>(text: string): T {
  return JSON.parse(text, (_k, v) =>
    v && typeof v === "object" && typeof v.$bigint === "string" ? BigInt(v.$bigint) : v
  ) as T;
}