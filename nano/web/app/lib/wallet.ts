// 100% in-browser Nano wallet. The 64-hex seed is encrypted with a user
// passphrase (PBKDF2-SHA256 → AES-GCM-256) and stored only in localStorage.
// The seed (and passphrase) never leave the browser.

const ALGO = "AES-GCM";
const ITER = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface WalletCipher {
  v: number;
  salt: string;
  iv: string;
  ct: string;
  iter: number;
}

export function walletSupported(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    material,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptSeed(seed: string, password: string): Promise<WalletCipher> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, ITER);
  const ct = await crypto.subtle.encrypt({ name: ALGO, iv }, key, new TextEncoder().encode(seed));
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)), iter: ITER };
}

export async function decryptSeed(c: WalletCipher, password: string): Promise<string> {
  const key = await deriveKey(password, unb64(c.salt), c.iter);
  const pt = await crypto.subtle.decrypt({ name: ALGO, iv: unb64(c.iv) }, key, unb64(c.ct));
  return new TextDecoder().decode(pt);
}

const KEY = "holdfun_wallet";

export function loadWallet(): WalletCipher | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as WalletCipher) : null;
  } catch {
    return null;
  }
}

export function saveWallet(c: WalletCipher): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}

export function removeWallet(): void {
  localStorage.removeItem(KEY);
}

// Session unlock: after the password decrypts the seed once, the derived keys
// are held in sessionStorage so page reloads within the same browser session
// don't demand the password again. sessionStorage is same-origin and is wiped
// automatically when the tab/browser closes — so the unlock lasts exactly one
// session and never persists to disk. The at-rest secret is still ONLY the
// PBKDF2/AES-encrypted seed in localStorage; this holds the already-decrypted
// keys for the life of the tab, the same exposure the in-memory React state
// had, just surviving a refresh.
const SESSION_KEY = "holdfun_session";

export function saveSessionKeys(json: string): void {
  try { sessionStorage.setItem(SESSION_KEY, json); } catch {}
}

export function loadSessionKeys(): string | null {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}

export function clearSessionKeys(): void {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}