import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "HoldFun · Nano L2",
  description: "Token launchpad on Nano (XNO) — creator capped at 5%.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#000" }}>{children}</body>
    </html>
  );
}
