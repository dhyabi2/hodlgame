"use client";

const STEPS = [
  { icon: "💎", title: "Stake HOLD", body: "Deposit tokens, no entry tax." },
  {
    icon: "⏳",
    title: "Hold it",
    body: "Exit early and pay a 20% tax — some burned, some funds the vault.",
  },
  {
    icon: "🎉",
    title: "Earn or win",
    body: "Collect rebates from the vault, or win the Diamond Raffle.",
  },
];

export function HowItWorks() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {STEPS.map((step, i) => (
        <div
          key={step.title}
          className="rounded-xl border border-holder-700 bg-holder-800/40 p-3 flex items-start gap-3"
        >
          <span className="text-2xl leading-none">{step.icon}</span>
          <div>
            <p className="text-sm font-bold text-slate-200">
              {i + 1}. {step.title}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">{step.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
