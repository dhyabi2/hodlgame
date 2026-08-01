"use client";

const MUTE_KEY = "holder:muted";

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

export function isMuted(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(MUTE_KEY) === "1";
}

export function setMuted(muted: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
}

function tone(
  freq: number,
  startTime: number,
  duration: number,
  type: OscillatorType,
  gainPeak: number,
  audioCtx: AudioContext
) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

function play(fn: (audioCtx: AudioContext, now: number) => void) {
  if (isMuted()) return;
  const audioCtx = getContext();
  if (!audioCtx) return;
  fn(audioCtx, audioCtx.currentTime);
}

/** Short upward chime — staking / diamond hands. */
export function playStake() {
  play((audioCtx, now) => {
    tone(660, now, 0.12, "triangle", 0.15, audioCtx);
    tone(880, now + 0.08, 0.16, "triangle", 0.15, audioCtx);
  });
}

/** Descending "rip" — unstake tax hit. */
export function playTax() {
  play((audioCtx, now) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.35);
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.45);
  });
}

/** Sparkle arpeggio — claiming a rebate. */
export function playClaim() {
  play((audioCtx, now) => {
    [523, 659, 784, 1047].forEach((freq, i) => {
      tone(freq, now + i * 0.07, 0.18, "sine", 0.12, audioCtx);
    });
  });
}

/** Quick whoosh — swap executed. */
export function playSwap() {
  play((audioCtx, now) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(700, now + 0.2);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  });
}

/** Neutral click for buttons/toggles. */
export function playClick() {
  play((audioCtx, now) => {
    tone(320, now, 0.05, "square", 0.06, audioCtx);
  });
}
