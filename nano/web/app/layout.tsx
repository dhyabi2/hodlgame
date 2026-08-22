import type { Metadata, Viewport } from "next";
import "./globals.css";
import InstallPrompt from "./components/InstallPrompt";

const SITE_URL = "https://hodlgame.fun";
const TITLE = "HodlGame — Hold to Win";
const DESC =
  "The trustless memecoin game on Nano (XNO). Launch and trade coins with zero custody — nobody ever holds your money, every balance is verifiable, and the creator is capped at 5%. Feeless, instant, and the game where holding wins.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: "HodlGame",
  title: { default: TITLE, template: "%s · HodlGame" },
  description: DESC,
  keywords: [
    "HodlGame", "memecoin", "Nano", "XNO", "zero custody", "trustless",
    "launchpad", "crypto game", "hold to win", "feeless", "DeFi",
  ],
  authors: [{ name: "HodlGame" }],
  creator: "HodlGame",
  alternates: { canonical: "/" },
  manifest: "/manifest.webmanifest",
  robots: { index: true, follow: true, googleBot: { index: true, follow: true } },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icon-192.png", sizes: "192x192" }],
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "HodlGame" },
  openGraph: {
    title: TITLE,
    description: DESC,
    url: SITE_URL,
    siteName: "HodlGame",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "HodlGame — Hold to Win" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESC,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <InstallPrompt />
      </body>
    </html>
  );
}
