import type { Metadata } from "next";
import "./globals.css";

// Canonical site URL — the purchased production domain. Used as the base for
// Open Graph / twitter card URLs so shared links always point at the real site
// (never a *.vercel.app deployment alias).
const SITE_URL = "https://hodlgame.fun";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "HodlGame · Nano L2",
  description: "Token launchpad on Nano (XNO) — creator capped at 5%.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "HodlGame · Nano L2",
    description: "Token launchpad on Nano (XNO) — creator capped at 5%.",
    url: SITE_URL,
    siteName: "HodlGame",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "HodlGame · Nano L2",
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
