"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { motion } from "framer-motion";
import confetti from "canvas-confetti";
import { Header } from "@/components/Header";
import { AmbientParticles } from "@/components/AmbientParticles";
import { ActionButton, Spinner } from "@/components/ui";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { txUrl } from "@/lib/explorer";
import { usePoll } from "@/lib/usePoll";
import { tokenAvatarSvg } from "@/lib/avatar";
import {
  DEFAULT_CONFIG,
  STEP_RUNNERS,
  activeSteps,
  clearProgress,
  impliedPrice,
  loadProgress,
  saveProgress,
  validateConfig,
  type LaunchConfig,
  type LaunchContext,
  type StepId,
  type StepResult,
} from "@/lib/launch";

type Phase = "form" | "running" | "done";

/** Uploads the deterministic generated avatar so no-image coins still get one. */
async function uploadGeneratedAvatar(
  name: string,
  symbol: string
): Promise<string | null> {
  try {
    const svg = tokenAvatarSvg(name, symbol);
    const res = await fetch(svg);
    const blob = await res.blob();
    const file = new File([blob], "avatar.svg", { type: "image/svg+xml" });
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", name);
    fd.append("symbol", symbol);
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await r.json().catch(() => ({}));
    return r.ok && data.uri ? (data.uri as string) : null;
  } catch {
    return null;
  }
}

export default function CreatePage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();

  const [config, setConfig] = useState<LaunchConfig>(DEFAULT_CONFIG);
  const [phase, setPhase] = useState<Phase>("form");
  const [mintKeypair, setMintKeypair] = useState<Keypair | null>(null);
  const [mint, setMint] = useState<PublicKey | null>(null);
  const [completed, setCompleted] = useState<StepResult[]>([]);
  const [current, setCurrent] = useState<StepId | null>(null);
  const [failure, setFailure] = useState<{ step: StepId; message: string } | null>(null);
  const [resumable, setResumable] = useState(false);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: solBalance } = usePoll(
    async () => {
      if (!wallet.publicKey) return null;
      return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
    },
    { intervalMs: 20000, enabled: !!wallet.publicKey },
    [connection, wallet.publicKey?.toBase58()]
  );

  useEffect(() => {
    const saved = loadProgress();
    if (saved && saved.completed.length > 0) setResumable(true);
  }, []);

  const problems = useMemo(
    () => validateConfig(config, solBalance ?? null),
    [config, solBalance]
  );
  const problemFor = (field: string) =>
    touched.has(field) || attempted
      ? problems.find((p) => p.field === field)?.message
      : undefined;
  const markTouched = (field: string) =>
    setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));

  const steps = useMemo(() => activeSteps(config), [config]);
  const price = impliedPrice(config);
  const set = <K extends keyof LaunchConfig>(key: K, value: LaunchConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const run = useCallback(
    async (startFrom: StepResult[], mintKp: Keypair | null, mintKey: PublicKey) => {
      const done = [...startFrom];

      // If no custom image was uploaded, upload the generated avatar so the
      // coin still gets a real on-chain image. Best-effort — if storage isn't
      // configured the launch proceeds with name/symbol only.
      let cfg = config;
      if (!cfg.uri.trim()) {
        try {
          const uri = await uploadGeneratedAvatar(cfg.name, cfg.symbol);
          if (uri) cfg = { ...cfg, uri };
        } catch {
          /* ignore */
        }
      }

      const ctx: LaunchContext = {
        connection,
        wallet,
        config: cfg,
        mintKeypair: mintKp,
        mint: mintKey,
      };

      for (const step of activeSteps(cfg)) {
        if (done.some((d) => d.id === step.id)) continue;
        setCurrent(step.id);
        setFailure(null);
        try {
          const signature = await STEP_RUNNERS[step.id](ctx);
          done.push({ id: step.id, signature });
          setCompleted([...done]);
          saveProgress({ mint: mintKey.toBase58(), completed: done });
        } catch (err) {
          console.error(`launch step ${step.id} failed`, err);
          setCurrent(null);
          setFailure({ step: step.id, message: friendlyError(err) });
          return;
        }
      }

      setCurrent(null);
      setPhase("done");
      clearProgress();
      confetti({
        particleCount: 160,
        spread: 100,
        startVelocity: 45,
        origin: { y: 0.5 },
        colors: ["#8b7bf7", "#22d3ee", "#f6c34a"],
      });
    },
    [connection, wallet, config]
  );

  const start = async () => {
    setAttempted(true);
    if (!wallet.publicKey || problems.length > 0) return;
    const kp = Keypair.generate();
    setMintKeypair(kp);
    setMint(kp.publicKey);
    setCompleted([]);
    setPhase("running");
    await run([], kp, kp.publicKey);
  };

  const retry = async () => {
    if (!mint) return;
    await run(completed, mintKeypair, mint);
  };

  const abandon = () => {
    clearProgress();
    setResumable(false);
    toast.push("info", "Cleared", "That unfinished launch was discarded.");
  };

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", config.name);
      fd.append("symbol", config.symbol);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.uri) throw new Error(data.error || "Upload failed.");
      set("uri", data.uri);
      toast.push("success", "Image added", "It shows in wallets after launch.");
    } catch (err) {
      setPreview(null);
      set("uri", "");
      toast.push("danger", "Upload failed", friendlyError(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <AmbientParticles />
      <main className="min-h-screen px-4 sm:px-6 pb-16 relative">
        <Header />

        <div className="max-w-2xl mx-auto pt-4 space-y-6 relative z-10">
          {phase === "form" && (
            <>
              <div className="text-center space-y-1">
                <h1 className="font-display text-3xl sm:text-4xl font-bold metallic-text">
                  Launch your coin
                </h1>
                <p className="text-sm text-ink-400">You keep 5%. The rest is for everyone else.</p>
              </div>

              {resumable && (
                <div className="panel p-4 border-holder-jackpot/40 flex items-center gap-3">
                  <span aria-hidden>⏸️</span>
                  <span className="text-sm text-ink-200 flex-1">Unfinished launch</span>
                  <button onClick={abandon} className="text-sm font-bold text-holder-accent hover:underline">
                    Discard
                  </button>
                </div>
              )}

              <section className="panel p-5 sm:p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="relative w-14 h-14 rounded-2xl shrink-0 border border-holder-700 shadow-panel overflow-hidden group"
                    aria-label="Add an image"
                  >
                    <span
                      className="absolute inset-0"
                      style={{
                        backgroundImage: `url("${preview ?? tokenAvatarSvg(config.name, config.symbol)}")`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                      }}
                      aria-hidden
                    />
                    <span className="absolute inset-0 bg-holder-950/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-[10px] font-bold">
                      {uploading ? "…" : "Change"}
                    </span>
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={onPickImage}
                  />
                  <div className="min-w-0">
                    <p className="font-display font-bold text-ink-100 truncate">
                      {config.name.trim() || config.symbol.trim() || "Your coin"}
                    </p>
                    <p className="text-xs text-ink-400">
                      {config.uri ? "Image ready ✓" : "Tap the picture to add your own"}
                    </p>
                  </div>
                </div>

                <Field
                  label="Name"
                  hint=""
                  error={problemFor("name")}
                  onBlur={() => markTouched("name")}
                  value={config.name}
                  onChange={(v) => set("name", v)}
                  placeholder="Moon Doge"
                />
                <Field
                  label="Ticker"
                  hint=""
                  error={problemFor("symbol")}
                  onBlur={() => markTouched("symbol")}
                  value={config.symbol}
                  onChange={(v) => set("symbol", v.toUpperCase())}
                  placeholder="DOGE"
                />
                <Field
                  label="Supply"
                  hint="How many coins exist."
                  error={problemFor("totalSupply")}
                  onBlur={() => markTouched("totalSupply")}
                  value={config.totalSupply}
                  onChange={(v) => set("totalSupply", v.replace(/[^\d.]/g, ""))}
                  inputMode="decimal"
                />
                <Field
                  label="SOL to start"
                  hint="Funds the pool so people can buy."
                  error={problemFor("poolSol")}
                  onBlur={() => markTouched("poolSol")}
                  value={config.poolSol}
                  onChange={(v) => set("poolSol", v.replace(/[^\d.]/g, ""))}
                  inputMode="decimal"
                />

                {price !== null && (
                  <p className="text-xs text-ink-400 text-center">
                    Starts at{" "}
                    <span className="text-ink-100 font-semibold">
                      {price < 0.000001 ? price.toExponential(2) : price.toFixed(6)} SOL
                    </span>{" "}
                    per {config.symbol || "coin"}
                  </p>
                )}

                {!wallet.publicKey ? (
                  <div className="flex justify-center">
                    <WalletMultiButton className="!h-12 !rounded-xl !bg-holder-accent !text-holder-900 !font-bold hover:!bg-holder-accentBright" />
                  </div>
                ) : (
                  <ActionButton
                    onClick={start}
                    disabled={problems.length > 0}
                    disabledReason={
                      attempted && problems.length > 0
                        ? "Check the fields above."
                        : problems.length > 0
                        ? "Fill in the details."
                        : null
                    }
                  >
                    Launch
                  </ActionButton>
                )}
              </section>
            </>
          )}

          {(phase === "running" || phase === "done") && (
            <StepList
              steps={steps}
              completed={completed}
              current={current}
              failure={failure}
              onRetry={retry}
              phase={phase}
              mint={mint}
              config={config}
            />
          )}
        </div>
      </main>
    </>
  );
}

function StepList({
  steps,
  completed,
  current,
  failure,
  onRetry,
  phase,
  mint,
  config,
}: {
  steps: { id: StepId; title: string; detail: string }[];
  completed: StepResult[];
  current: StepId | null;
  failure: { step: StepId; message: string } | null;
  onRetry: () => void;
  phase: Phase;
  mint: PublicKey | null;
  config: LaunchConfig;
}) {
  const doneIds = new Set(completed.map((c) => c.id));

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="font-display text-2xl sm:text-3xl font-bold text-ink-100">
          {phase === "done" ? "🎉 Your coin is live" : "Launching…"}
        </h1>
        <p className="text-sm text-ink-300">
          {phase === "done"
            ? `${config.name} (${config.symbol}) is ready.`
            : "Approve in your wallet."}
        </p>
      </div>

      <ol className="panel p-5 sm:p-6 space-y-3">
        {steps.map((step) => {
          const done = doneIds.has(step.id);
          const active = current === step.id;
          const failed = failure?.step === step.id;
          const result = completed.find((c) => c.id === step.id);

          return (
            <li
              key={step.id}
              className={`flex items-start gap-3 rounded-xl p-3 border transition ${
                failed
                  ? "border-holder-danger/50 bg-holder-danger/5"
                  : done
                  ? "border-holder-success/40 bg-holder-success/5"
                  : active
                  ? "border-holder-accent/50 bg-holder-accent/5"
                  : "border-holder-700 bg-holder-900/40"
              }`}
            >
              <span className="shrink-0 mt-0.5 w-6 h-6 flex items-center justify-center">
                {done ? (
                  <span className="text-holder-success" aria-hidden>
                    ✓
                  </span>
                ) : active ? (
                  <Spinner className="w-4 h-4 text-holder-accent" />
                ) : failed ? (
                  <span className="text-holder-dangerBright" aria-hidden>
                    ✕
                  </span>
                ) : (
                  <span className="w-2 h-2 rounded-full bg-holder-700" aria-hidden />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm font-semibold ${
                    done
                      ? "text-holder-success"
                      : failed
                      ? "text-holder-dangerBright"
                      : "text-ink-100"
                  }`}
                >
                  {step.title}
                  <span className="sr-only">
                    {done ? " — complete" : active ? " — in progress" : failed ? " — failed" : " — pending"}
                  </span>
                </p>
                {step.detail ? (
                  <p className="text-xs text-ink-300 mt-0.5">{step.detail}</p>
                ) : null}
                {failed && (
                  <p className="text-xs text-holder-dangerBright mt-1">{failure!.message}</p>
                )}
                {result && (
                  <a
                    href={txUrl(result.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-ink-400 hover:text-holder-accent underline underline-offset-2 mt-1 inline-block"
                  >
                    View transaction ↗
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {failure && (
        <div className="panel p-5 space-y-3 text-center">
          <p className="text-sm text-ink-200">Nothing was lost — pick up where it stopped.</p>
          <ActionButton onClick={onRetry}>Retry</ActionButton>
        </div>
      )}

      {phase === "done" && mint && (
        <div className="panel p-5 sm:p-6 space-y-4 text-center">
          <motion.a
            href={`/t/${mint.toBase58()}`}
            initial={{ scale: 0.98 }}
            animate={{ scale: 1 }}
            className="block w-full min-h-[52px] flex items-center justify-center rounded-xl font-bold bg-holder-accent text-holder-900 hover:bg-holder-accentBright shadow-glow-accent transition"
          >
            Open your coin →
          </motion.a>
          <button
            onClick={() => {
              navigator.clipboard
                ?.writeText(`${window.location.origin}/t/${mint.toBase58()}`)
                .catch(() => {});
            }}
            className="w-full min-h-[44px] rounded-xl text-sm font-medium border border-holder-700 text-ink-200 hover:border-holder-accent hover:text-holder-accent transition"
          >
            Copy share link
          </button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  value,
  onChange,
  onBlur,
  placeholder,
  inputMode,
  optional,
}: {
  label: string;
  hint: string;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  inputMode?: "decimal" | "numeric";
  optional?: boolean;
}) {
  const id = `field-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-200 flex gap-2">
        {label}
        {optional && <span className="text-ink-500 font-normal">optional</span>}
      </label>
      <input
        id={id}
        type="text"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={!!error}
        aria-describedby={`${id}-hint`}
        autoComplete="off"
        className={`w-full min-h-[48px] rounded-xl bg-holder-900 border px-4 text-white placeholder-ink-500 focus:outline-none focus:border-holder-accent ${
          error ? "border-holder-danger" : "border-holder-700"
        }`}
      />
      <p
        id={`${id}-hint`}
        className={`text-xs ${error ? "text-holder-dangerBright" : "text-ink-400"}`}
      >
        {error ?? hint}
      </p>
    </div>
  );
}
