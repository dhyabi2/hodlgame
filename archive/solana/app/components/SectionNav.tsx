"use client";

import { useEffect, useState } from "react";

export interface NavSection {
  id: string;
  label: string;
  icon: string;
}

/**
 * The page is a ~3000px tower on a phone with no way to jump between its parts.
 * This is a scroll-spy tab strip: a bottom bar on mobile (thumb-reachable) and
 * an inline strip on desktop.
 */
export function SectionNav({ sections }: { sections: NavSection[] }) {
  const [active, setActive] = useState(sections[0]?.id);

  useEffect(() => {
    const nodes = sections
      .map((s) => document.getElementById(s.id))
      .filter((n): n is HTMLElement => !!n);
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      // Bias the "current" band toward the upper middle of the viewport so the
      // section you're reading is the one highlighted.
      { rootMargin: "-25% 0px -55% 0px", threshold: 0 }
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [sections]);

  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  };

  return (
    <>
      <nav
        aria-label="Sections"
        className="hidden md:flex sticky top-[68px] z-30 gap-1 p-1 rounded-xl bg-holder-900/70 backdrop-blur-md border border-holder-700/60 w-fit mx-auto"
      >
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => go(s.id)}
            aria-current={active === s.id ? "true" : undefined}
            className={`px-4 min-h-[36px] rounded-lg text-sm font-medium transition ${
              active === s.id
                ? "bg-holder-accent text-holder-900"
                : "text-ink-300 hover:text-white"
            }`}
          >
            <span aria-hidden className="mr-1.5">
              {s.icon}
            </span>
            {s.label}
          </button>
        ))}
      </nav>

      <nav
        aria-label="Sections"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-holder-950/92 backdrop-blur-md border-t border-holder-700/60 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => go(s.id)}
              aria-current={active === s.id ? "true" : undefined}
              className={`flex-1 min-h-[56px] flex flex-col items-center justify-center gap-0.5 transition ${
                active === s.id ? "text-holder-accent" : "text-ink-400"
              }`}
            >
              <span className="text-lg leading-none" aria-hidden>
                {s.icon}
              </span>
              <span className="text-[11px] font-medium">{s.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
