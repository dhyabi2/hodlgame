import type { Metadata } from "next";
import "./globals.css";

// Canonical site URL — the purchased production domain. Used as the base for
// Open Graph / twitter card URLs so shared links always point at the real site
// (never a *.vercel.app deployment alias).
const SITE_URL = "https://nanocrypto.fun";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "HoldFun · Nano L2",
  description: "Token launchpad on Nano (XNO) — creator capped at 5%.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "HoldFun · Nano L2",
    description: "Token launchpad on Nano (XNO) — creator capped at 5%.",
    url: SITE_URL,
    siteName: "HoldFun",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "HoldFun · Nano L2",
    description: "Token launchpad on Nano (XNO) — creator capped at 5%.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
