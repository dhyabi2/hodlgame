"use client";

const MUTE_KEY = "holder:muted";
const VOLUME_KEY = "holder:volume";
const DEFAULT_VOLUME = 0.7;

let ctx: AudioContext | null = null;
/** Every sound routes through this, so the volume slider is truly global. */
let masterGain: GainNode | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = getVolume();
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

function destination(audioCtx: AudioContext): AudioNode {
  return masterGain ?? audioCtx.destination;
}

export function isMuted(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(MUTE_KEY) === "1";
}

export function setMuted(muted: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
}

export function getVolume(): number {
  if (typeof window === "undefined") return DEFAULT_VOLUME;
  const raw = window.localStorage.getItem(VOLUME_KEY);
  const parsed = raw === null ? NaN : parseFloat(raw);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : DEFAULT_VOLUME;
}

export function setVolume(v: number) {
  if (typeof window === "undefined") return;
  const clamped = Math.min(1, Math.max(0, v));
  window.localStorage.setItem(VOLUME_KEY, String(clamped));
  if (masterGain) masterGain.gain.value = clamped;
}

/** Short vibration on supporting devices — silent no-op elsewhere. */
export function haptic(pattern: number | number[] = 15) {
  if (typeof navigator === "undefined" || isMuted()) return;
  if (typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* some browsers throw on unsupported patterns — not worth surfacing */
    }
  }
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
  gain.connect(destination(audioCtx));
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
    gain.connect(destination(audioCtx));
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
    gain.connect(destination(audioCtx));
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

/** Low ominous horn — a whale-sized move just hit the feed. */
export function playWhaleAlert() {
  play((audioCtx, now) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(70, now);
    osc.frequency.linearRampToValueAtTime(110, now + 0.5);
    osc.frequency.linearRampToValueAtTime(65, now + 1.0);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.12);
    gain.gain.setValueAtTime(0.16, now + 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    osc.connect(gain);
    gain.connect(destination(audioCtx));
    osc.start(now);
    osc.stop(now + 1.15);
  });
  haptic([25, 40, 25]);
}

// ---------------------------------------------------------------------------
// Ambient bed — a quiet synthesized vault hum. Off by default (ambient audio
// uninvited is hostile); preference persisted; routed through the master gain
// so the volume slider governs it too.
// ---------------------------------------------------------------------------

const AMBIENT_KEY = "holder:ambient";

let ambientNodes: { stop: () => void } | null = null;

export function isAmbientOn(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(AMBIENT_KEY) === "1";
}

export function setAmbientPref(on: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AMBIENT_KEY, on ? "1" : "0");
}

export function startAmbient() {
  if (ambientNodes || isMuted()) return;
  const audioCtx = getContext();
  if (!audioCtx) return;

  const bedGain = audioCtx.createGain();
  bedGain.gain.value = 0;
  bedGain.connect(destination(audioCtx));

  // Two slightly detuned low sines beat gently against each other; a slow LFO
  // breathes the level so it never reads as a flat test tone.
  const oscA = audioCtx.createOscillator();
  oscA.type = "sine";
  oscA.frequency.value = 55;
  const oscB = audioCtx.createOscillator();
  oscB.type = "sine";
  oscB.frequency.value = 55.7;

  const lfo = audioCtx.createOscillator();
  lfo.frequency.value = 0.07;
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.012;
  lfo.connect(lfoGain);
  lfoGain.connect(bedGain.gain);

  oscA.connect(bedGain);
  oscB.connect(bedGain);

  const now = audioCtx.currentTime;
  bedGain.gain.linearRampToValueAtTime(0.035, now + 3);

  oscA.start(now);
  oscB.start(now);
  lfo.start(now);

  ambientNodes = {
    stop: () => {
      const t = audioCtx.currentTime;
      bedGain.gain.cancelScheduledValues(t);
      bedGain.gain.setValueAtTime(bedGain.gain.value, t);
      bedGain.gain.linearRampToValueAtTime(0.0001, t + 1);
      oscA.stop(t + 1.2);
      oscB.stop(t + 1.2);
      lfo.stop(t + 1.2);
    },
  };
}

export function stopAmbient() {
  if (!ambientNodes) return;
  ambientNodes.stop();
  ambientNodes = null;
}
