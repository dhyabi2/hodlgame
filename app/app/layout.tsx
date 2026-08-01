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

export const metadata: Metadata = {
  title: "Holder — Patience Pays",
  description: "Stake tokens, tax paper hands, earn rebates on Solana.",
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
