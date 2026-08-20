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

const title = "HoldFun — The fun way to hold";
const description =
  "Launch a token where the creator can only ever own 5%. The community's 95% funds the pool, and a 20% exit tax rewards the people who actually hold. Built on Solana.";

export const viewport = {
  themeColor: "#050505",
  // Let the page paint into the notch/home-indicator area; the shell pads for it.
  viewportFit: "cover" as const,
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title,
  description,
  manifest: "/manifest.json",
  icons: { icon: "/icon.svg" },
  openGraph: { title, description, type: "website", siteName: "HoldFun" },
  twitter: { card: "summary_large_image", title, description },
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
          {/* Balances and stakers are per-token, so those providers live
              inside the /t/[mint] route rather than app-wide. */}
          <ToastProvider>{children}</ToastProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
