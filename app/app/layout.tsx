import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import { ToastProvider } from "@/lib/toast";

const inter = Inter({ subsets: ["latin"] });
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
});

const title = "Holder — Patience Pays";
const description =
  "Stake HOLD tokens. Diamond hands earn rebates and win the Diamond Raffle. Paper hands pay a 20% exit tax — 5% burned forever. Built on Solana.";

export const viewport = {
  themeColor: "#0f172a",
};

export const metadata: Metadata = {
  title,
  description,
  manifest: "/manifest.json",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title,
    description,
    type: "website",
    siteName: "Holder",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} ${spaceGrotesk.variable}`}>
        <WalletProvider>
          <ToastProvider>{children}</ToastProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
