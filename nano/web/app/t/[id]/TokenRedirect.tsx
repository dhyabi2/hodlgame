"use client";

import { useEffect } from "react";

// Humans who open /t/<id> get bounced into the SPA at /#t=<id> (the full app,
// coin preselected). Crawlers never run this — they read the per-coin OG tags
// from generateMetadata in the server-rendered <head> before any JS. The
// redirect is client-side ON PURPOSE: a server redirect would send crawlers to
// "/" and they'd read the generic site card instead of this coin's.
export default function TokenRedirect({ id }: { id: string }) {
  const safe = /^[0-9a-f]{32}$/.test(id) ? id : "";
  useEffect(() => {
    window.location.replace(safe ? `/#t=${safe}` : "/");
  }, [safe]);
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000",
        color: "#fff",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <a href={safe ? `/#t=${safe}` : "/"} style={{ color: "#fff", fontWeight: 900, letterSpacing: 1 }}>
        Opening coin…
      </a>
    </main>
  );
}
