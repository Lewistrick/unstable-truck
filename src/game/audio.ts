import type { ThemeId } from "../level/themes.js";
import type { Medal } from "./medals.js";
import type { SoundPrefs } from "./storage.js";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** Mobile browsers (iOS Safari especially) only let an AudioContext start from
 * inside a real user gesture, and one created outside a gesture stays
 * suspended - resume() called later from ordinary code is ignored. So this has
 * to run from a genuine pointer/key handler, before any sound is wanted. iOS
 * additionally wants a buffer actually played from within that gesture before
 * it treats the context as unlocked, hence the one-sample silent source. */
export function unlockAudio(): void {
  const c = getCtx();
  void c.resume();
  try {
    const silent = c.createBufferSource();
    silent.buffer = c.createBuffer(1, 1, c.sampleRate);
    silent.connect(c.destination);
    silent.start();
  } catch {
    // Some engines reject the one-sample buffer; the resume() above is the
    // part that matters, so a failure here is not worth aborting for.
  }
}

/** The context's own view of itself: "not created" before anything has needed
 * sound, then "suspended" / "running" / "closed". Surfaced in the sound
 * settings, because a device where audio silently fails is otherwise
 * indistinguishable from one where every volume is set to zero. */
export function audioState(): string {
  return ctx ? ctx.state : "not created";
}

/** Re-resumes the context after the browser suspends it, which mobile does
 * whenever the page goes to the background. Safe to call when there is no
 * context yet. */
export function resumeAudio(): void {
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

function makeNoiseBuffer(c: AudioContext, seconds: number, brownCoeff: number, amp: number): AudioBuffer {
  // Floor the length: sampleRate * seconds is not always a whole number, and a
  // fractional frame count is tolerated by some engines but rejected outright
  // by others (Firefox throws), which would take out every sound at once.
  const len = Math.max(1, Math.floor(c.sampleRate * seconds));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + brownCoeff * w) / (1 + brownCoeff);
    data[i] = last * amp;
  }
  return buf;
}

/** A slow random control signal, roughly in [-1, 1] and seamless at the loop
 * point, for modulating a gain. Unlike a sine LFO it never settles into an
 * audible throb, so what it drives reads as happening at random. `smoothing`
 * is the one-pole coefficient: smaller wanders slower (~0.0004 ≈ 3Hz). */
function makeControlNoiseBuffer(c: AudioContext, seconds: number, smoothing: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    last += (Math.random() * 2 - 1 - last) * smoothing;
    data[i] = last;
  }
  // De-trend so the last sample meets the first: looping across a step change
  // in gain would click.
  const drift = (data[len - 1]! - data[0]!) / (len - 1);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const v = data[i]! - drift * i;
    data[i] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  // Normalise, so changing `smoothing` doesn't silently change the depth too.
  if (peak > 0) for (let i = 0; i < len; i++) data[i] = data[i]! / peak;
  return buf;
}

// ── Volume scaling ─────────────────────────────────────
// Base gains at 100% preference (the synthesis already scales internally)
const ENGINE_BASE = 0.3;
const WOBBLE_BASE = 0.18;
const AMBIENCE_BASE = 0.25;
const EFFECTS_BASE = 0.2;

let prefs: SoundPrefs = {
  ambient: 15, game: 50, effects: 80,
  gameMuted: false, ambientMuted: false, effectsMuted: false,
};

export function setSoundPrefs(p: SoundPrefs): void {
  prefs = p;
  if (engineNodes) {
    engineNodes.master.gain.setTargetAtTime(gameVol() * ENGINE_BASE, getCtx().currentTime, 0.04);
  }
  if (wobbleNodes) updateWobble(lastStability);
  if (ambienceNodes) {
    ambienceNodes.master.gain.setTargetAtTime(ambientVol() * AMBIENCE_BASE, getCtx().currentTime, 0.04);
  }
}

function gameVol(): number { return prefs.gameMuted ? 0 : prefs.game / 100; }
function ambientVol(): number { return prefs.ambientMuted ? 0 : prefs.ambient / 100; }
function effectsVol(): number { return prefs.effectsMuted ? 0 : prefs.effects / 100; }

// ── Engine ─────────────────────────────────────────────

interface EngineNodes {
  master: GainNode;
  rumbleLp: BiquadFilterNode;
  rumbleGain: GainNode;
  chugDepth: GainNode;
  exhBp: BiquadFilterNode;
  exhGain: GainNode;
  all: (OscillatorNode | AudioBufferSourceNode)[];
}

let engineNodes: EngineNodes | null = null;
let prevSpeed = 0;
let engineAccel = 0;

export function startEngine(): void {
  if (engineNodes) return;
  const c = getCtx();
  const bufLen = c.sampleRate * 2;

  const master = c.createGain();
  master.gain.value = gameVol() * ENGINE_BASE;
  master.connect(c.destination);

  const rumble = c.createBufferSource();
  rumble.buffer = makeNoiseBuffer(c, 2, 0.03, 4);
  rumble.loop = true;
  rumble.start();

  const rumbleLp = c.createBiquadFilter();
  rumbleLp.type = "lowpass";
  rumbleLp.frequency.value = 90;
  rumbleLp.Q.value = 2.5;

  const rumbleGain = c.createGain();
  rumbleGain.gain.value = 0.7;
  rumble.connect(rumbleLp).connect(rumbleGain).connect(master);

  const chugLfo = c.createOscillator();
  chugLfo.type = "sine";
  chugLfo.frequency.value = 6;
  const chugDepth = c.createGain();
  chugDepth.gain.value = 0.14;
  chugLfo.connect(chugDepth).connect(rumbleGain.gain);
  chugLfo.start();

  const chug2 = c.createOscillator();
  chug2.type = "sine";
  chug2.frequency.value = 4.3;
  const chug2Depth = c.createGain();
  chug2Depth.gain.value = 0.07;
  chug2.connect(chug2Depth).connect(rumbleGain.gain);
  chug2.start();

  const sub = c.createOscillator();
  sub.type = "sine";
  sub.frequency.value = 25;
  const subGain = c.createGain();
  subGain.gain.value = 0.08;
  sub.connect(subGain).connect(master);
  sub.start();

  const exhNoise = c.createBufferSource();
  exhNoise.buffer = makeNoiseBuffer(c, 2, 0.5, 1); // white-ish
  exhNoise.loop = true;
  exhNoise.start();

  const exhBp = c.createBiquadFilter();
  exhBp.type = "bandpass";
  exhBp.frequency.value = 120;
  exhBp.Q.value = 3;

  const exhGain = c.createGain();
  exhGain.gain.value = 0;
  exhNoise.connect(exhBp).connect(exhGain).connect(master);

  prevSpeed = 0;
  engineAccel = 0;

  engineNodes = {
    master,
    rumbleLp,
    rumbleGain,
    chugDepth,
    exhBp,
    exhGain,
    all: [rumble, chugLfo, chug2, sub, exhNoise],
  };
}

/** Update engine sound each frame. speed is 0..1 (fraction of max speed). */
export function updateEngine(speed: number): void {
  if (!engineNodes) return;
  const c = getCtx();
  const t = c.currentTime;

  // Compute acceleration from speed change
  const rawAccel = Math.abs(speed - prevSpeed) * 60; // scale by ~fps
  engineAccel += (Math.min(rawAccel, 1) - engineAccel) * 0.15;
  prevSpeed = speed;

  engineNodes.master.gain.setTargetAtTime(gameVol() * ENGINE_BASE, t, 0.04);
  engineNodes.rumbleLp.frequency.setTargetAtTime(90 + speed * 160, t, 0.04);
  (engineNodes.all[1] as OscillatorNode).frequency.setTargetAtTime(6 + speed * 14, t, 0.04);
  (engineNodes.all[2] as OscillatorNode).frequency.setTargetAtTime(4.3 + speed * 9.7, t, 0.04);
  engineNodes.chugDepth.gain.setTargetAtTime(0.14 + engineAccel * 0.12, t, 0.04);
  (engineNodes.all[3] as OscillatorNode).frequency.setTargetAtTime(25 + speed * 15, t, 0.04);
  engineNodes.exhBp.frequency.setTargetAtTime(120 + engineAccel * 300, t, 0.04);
  engineNodes.exhGain.gain.setTargetAtTime(engineAccel * 0.15, t, 0.04);
}

export function stopEngine(): void {
  if (!engineNodes) return;
  engineNodes.all.forEach((s) => { try { s.stop(); } catch (_) { /* */ } });
  engineNodes = null;
}

// ── Cargo wobble ───────────────────────────────────────

interface WobbleNodes {
  master: GainNode;
  bp: BiquadFilterNode;
  wahLfo: OscillatorNode;
  wahDepth: GainNode;
  all: (OscillatorNode | AudioBufferSourceNode)[];
}

let wobbleNodes: WobbleNodes | null = null;
let lastStability = 100;

export function startWobble(): void {
  if (wobbleNodes) return;
  const c = getCtx();

  const master = c.createGain();
  master.gain.value = 0;
  master.connect(c.destination);

  // Wind-like noise base
  const noise = c.createBufferSource();
  noise.buffer = makeNoiseBuffer(c, 3, 0.04, 5);
  noise.loop = true;
  noise.start();

  // Bandpass filter sweeps up and down for the wah-wah effect
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 400;
  bp.Q.value = 3;

  // LFO sweeps the bandpass center frequency — this IS the wah-wah
  const wahLfo = c.createOscillator();
  wahLfo.type = "sine";
  wahLfo.frequency.value = 2;
  const wahDepth = c.createGain();
  wahDepth.gain.value = 0;
  wahLfo.connect(wahDepth).connect(bp.frequency);
  wahLfo.start();

  noise.connect(bp).connect(master);

  wobbleNodes = { master, bp, wahLfo, wahDepth, all: [noise, wahLfo] };
}

/** Update wobble sound. stability is 0..100. */
export function updateWobble(stability: number): void {
  lastStability = stability;
  if (!wobbleNodes) return;
  const c = getCtx();
  const t = c.currentTime;
  const vol = gameVol();
  const raw = 1 - stability / 100;
  const intensity = Math.max(0, (raw - 0.4) / 0.6);

  // Quiet overall — just a hint of windy wah
  wobbleNodes.master.gain.setTargetAtTime(vol * WOBBLE_BASE * intensity, t, 0.05);
  // Center frequency rises with danger
  wobbleNodes.bp.frequency.setTargetAtTime(300 + intensity * 500, t, 0.05);
  // Q tightens at high intensity for a more pronounced wah
  wobbleNodes.bp.Q.setTargetAtTime(2 + intensity * 6, t, 0.05);
  // Wah speed increases with instability
  wobbleNodes.wahLfo.frequency.setTargetAtTime(1.5 + intensity * 4, t, 0.05);
  // Sweep range widens with intensity
  wobbleNodes.wahDepth.gain.setTargetAtTime(200 + intensity * 500, t, 0.05);
}

export function stopWobble(): void {
  if (!wobbleNodes) return;
  wobbleNodes.all.forEach((s) => { try { s.stop(); } catch (_) { /* */ } });
  wobbleNodes = null;
}

// ── Medal fanfare ──────────────────────────────────────

const MEDAL_CHORDS: Record<string, number[]> = {
  bronze: [261.6, 329.6, 392.0],
  silver: [329.6, 415.3, 493.9, 659.3],
  gold: [392.0, 493.9, 587.3, 784.0],
  champion: [523.3, 659.3, 784.0, 987.8, 1047],
};

export function playMedalFanfare(medal: Medal): void {
  const vol = effectsVol();
  if (vol <= 0) return;
  const c = getCtx();
  const now = c.currentTime;
  const notes = MEDAL_CHORDS[medal] ?? MEDAL_CHORDS.bronze;
  const duration = medal === "champion" ? 1.8 : medal === "gold" ? 1.4 : 1.0;

  const master = c.createGain();
  master.gain.value = vol * EFFECTS_BASE;
  master.connect(c.destination);

  const delay = c.createDelay();
  delay.delayTime.value = 0.08;
  const delayGain = c.createGain();
  delayGain.gain.value = 0.15;
  delay.connect(delayGain).connect(master);

  for (let i = 0; i < notes!.length; i++) {
    const freq = notes![i]!;
    const startTime = now + i * 0.08;
    const osc = c.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;

    const env = c.createGain();
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(0.3, startTime + 0.03);
    env.gain.exponentialRampToValueAtTime(0.15, startTime + 0.15);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(env).connect(master);
    osc.connect(env).connect(delay);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.1);

    if (medal === "gold" || medal === "champion") {
      const shimmer = c.createOscillator();
      shimmer.type = "sine";
      shimmer.frequency.value = freq * 2.005;
      const sEnv = c.createGain();
      sEnv.gain.setValueAtTime(0, startTime);
      sEnv.gain.linearRampToValueAtTime(0.06, startTime + 0.05);
      sEnv.gain.exponentialRampToValueAtTime(0.001, startTime + duration * 0.7);
      shimmer.connect(sEnv).connect(master);
      shimmer.start(startTime);
      shimmer.stop(startTime + duration + 0.1);
    }
  }

  if (medal === "champion") {
    for (let i = 0; i < 4; i++) {
      const t = now + 0.5 + i * 0.12;
      const sparkle = c.createOscillator();
      sparkle.type = "sine";
      sparkle.frequency.value = 1800 + i * 400;
      const sEnv = c.createGain();
      sEnv.gain.setValueAtTime(0, t);
      sEnv.gain.linearRampToValueAtTime(0.05, t + 0.01);
      sEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      sparkle.connect(sEnv).connect(master);
      sparkle.start(t);
      sparkle.stop(t + 0.4);
    }
  }
}

// ── Countdown tones ────────────────────────────────────

export function playCountdownTone(isGo: boolean): void {
  const vol = effectsVol();
  if (vol <= 0) return;
  const c = getCtx();
  const now = c.currentTime;
  const freq = isGo ? 880 : 440;
  const duration = isGo ? 0.4 : 0.15;

  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;

  const env = c.createGain();
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(vol * EFFECTS_BASE * 0.8, now + 0.01);
  env.gain.exponentialRampToValueAtTime(0.001, now + duration);

  osc.connect(env).connect(c.destination);
  osc.start(now);
  osc.stop(now + duration + 0.05);

  if (isGo) {
    const osc2 = c.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = freq * 1.5;
    const env2 = c.createGain();
    env2.gain.setValueAtTime(0, now);
    env2.gain.linearRampToValueAtTime(vol * EFFECTS_BASE * 0.4, now + 0.01);
    env2.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc2.connect(env2).connect(c.destination);
    osc2.start(now);
    osc2.stop(now + duration + 0.05);
  }
}

// ── Biome ambience ─────────────────────────────────────

interface AmbienceNodes {
  master: GainNode;
  interval: ReturnType<typeof setInterval> | null;
  all: (OscillatorNode | AudioBufferSourceNode)[];
}

let ambienceNodes: AmbienceNodes | null = null;

type AmbienceType = "beach" | "forest" | "desert" | "generic";

const THEME_AMBIENCE: Partial<Record<ThemeId, AmbienceType>> = {
  beach: "beach",
  forest: "forest",
  desert: "desert",
  savanna: "desert",
  volcanic: "desert",
  swamp: "forest",
  autumn: "forest",
  farmland: "generic",
  grassland: "generic",
  town: "generic",
  city: "generic",
  moon: "generic",
  snow: "generic",
  candy: "generic",
};

function startBeach(c: AudioContext, master: GainNode): AmbienceNodes {
  const noise = c.createBufferSource();
  noise.buffer = makeNoiseBuffer(c, 4, 0.02, 3.5);
  noise.loop = true;
  noise.start();

  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 600;
  lp.Q.value = 0.7;

  const waveLfo = c.createOscillator();
  waveLfo.frequency.value = 0.12;
  const waveLfoGain = c.createGain();
  waveLfoGain.gain.value = 400;
  waveLfo.connect(waveLfoGain).connect(lp.frequency);
  waveLfo.start();

  const volLfo = c.createOscillator();
  volLfo.frequency.value = 0.12;
  const volLfoGain = c.createGain();
  volLfoGain.gain.value = master.gain.value * 0.4;
  volLfo.connect(volLfoGain).connect(master.gain);
  volLfo.start();

  noise.connect(lp).connect(master);

  const interval = setInterval(() => {
    if (Math.random() < 0.4) {
      const now = c.currentTime;
      const osc = c.createOscillator();
      osc.type = "sine";
      const env = c.createGain();
      env.gain.setValueAtTime(0, now);
      const baseFreq = 1800 + Math.random() * 600;
      osc.frequency.setValueAtTime(baseFreq * 0.7, now);
      osc.frequency.linearRampToValueAtTime(baseFreq, now + 0.1);
      osc.frequency.linearRampToValueAtTime(baseFreq * 0.6, now + 0.35);
      env.gain.linearRampToValueAtTime(0.04, now + 0.05);
      env.gain.setValueAtTime(0.04, now + 0.15);
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      const vib = c.createOscillator();
      vib.frequency.value = 25;
      const vibGain = c.createGain();
      vibGain.gain.value = 60;
      vib.connect(vibGain).connect(osc.frequency);
      vib.start(now);
      vib.stop(now + 0.5);
      osc.connect(env).connect(master);
      osc.start(now);
      osc.stop(now + 0.5);
    }
  }, 2500);

  return { master, interval, all: [noise, waveLfo, volLfo] };
}

function startForest(c: AudioContext, master: GainNode): AmbienceNodes {
  const bufLen = c.sampleRate * 3;
  const noise = c.createBufferSource();
  noise.buffer = makeNoiseBuffer(c, 3, 0.04, 5);
  noise.loop = true;
  noise.start();

  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 400;
  bp.Q.value = 0.5;

  const windLfo = c.createOscillator();
  windLfo.frequency.value = 0.2;
  const windLfoGain = c.createGain();
  windLfoGain.gain.value = 200;
  windLfo.connect(windLfoGain).connect(bp.frequency);
  windLfo.start();

  const leaves = c.createBufferSource();
  const leafBuf = c.createBuffer(1, bufLen, c.sampleRate);
  const leafData = leafBuf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) leafData[i] = Math.random() * 2 - 1;
  leaves.buffer = leafBuf;
  leaves.loop = true;
  leaves.start();
  const leafBp = c.createBiquadFilter();
  leafBp.type = "highpass";
  leafBp.frequency.value = 3000;
  const leafGain = c.createGain();
  leafGain.gain.value = 0.03;
  leaves.connect(leafBp).connect(leafGain).connect(master);

  noise.connect(bp).connect(master);

  const interval = setInterval(() => {
    if (Math.random() < 0.35) {
      const now = c.currentTime;
      const noteCount = 2 + Math.floor(Math.random() * 3);
      const baseFreq = 2200 + Math.random() * 1500;
      for (let n = 0; n < noteCount; n++) {
        const t = now + n * (0.08 + Math.random() * 0.06);
        const osc = c.createOscillator();
        osc.type = "sine";
        const freq = baseFreq + (Math.random() - 0.5) * 800;
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.linearRampToValueAtTime(freq * (0.85 + Math.random() * 0.3), t + 0.06);
        const env = c.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.03, t + 0.01);
        env.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.connect(env).connect(master);
        osc.start(t);
        osc.stop(t + 0.1);
      }
    }
  }, 2000);

  return { master, interval, all: [noise, leaves, windLfo] };
}

function startDesert(c: AudioContext, master: GainNode): AmbienceNodes {
  const noise = c.createBufferSource();
  noise.buffer = makeNoiseBuffer(c, 3, 0.015, 4);
  noise.loop = true;
  noise.start();

  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 250;
  bp.Q.value = 1.2;

  const windLfo = c.createOscillator();
  windLfo.frequency.value = 0.07;
  const windLfoGain = c.createGain();
  windLfoGain.gain.value = 100;
  windLfo.connect(windLfoGain).connect(bp.frequency);
  windLfo.start();

  noise.connect(bp).connect(master);

  const interval = setInterval(() => {
    if (Math.random() < 0.3) {
      const now = c.currentTime;
      const freq = [880, 1046.5, 1318.5, 1568, 1760][Math.floor(Math.random() * 5)]!;
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const env = c.createGain();
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(0.025, now + 0.02);
      env.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
      const osc2 = c.createOscillator();
      osc2.type = "sine";
      osc2.frequency.value = freq * 1.003;
      const env2 = c.createGain();
      env2.gain.setValueAtTime(0, now);
      env2.gain.linearRampToValueAtTime(0.015, now + 0.02);
      env2.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
      osc.connect(env).connect(master);
      osc2.connect(env2).connect(master);
      osc.start(now);
      osc.stop(now + 1.6);
      osc2.start(now);
      osc2.stop(now + 1.3);
    }
  }, 3500);

  return { master, interval, all: [noise, windLfo] };
}

function startGenericAmbience(c: AudioContext, master: GainNode): AmbienceNodes {
  // Light wind — unobtrusive background
  const noise = c.createBufferSource();
  noise.buffer = makeNoiseBuffer(c, 3, 0.03, 3);
  noise.loop = true;
  noise.start();

  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 350;
  lp.Q.value = 0.5;

  const windLfo = c.createOscillator();
  windLfo.frequency.value = 0.15;
  const windLfoGain = c.createGain();
  windLfoGain.gain.value = 150;
  windLfo.connect(windLfoGain).connect(lp.frequency);
  windLfo.start();

  noise.connect(lp).connect(master);

  return { master, interval: null, all: [noise, windLfo] };
}

export function startAmbience(theme: ThemeId): void {
  stopAmbience();
  const c = getCtx();
  const master = c.createGain();
  master.gain.value = ambientVol() * AMBIENCE_BASE;
  master.connect(c.destination);

  const type = THEME_AMBIENCE[theme] ?? "generic";
  switch (type) {
    case "beach":
      ambienceNodes = startBeach(c, master);
      break;
    case "forest":
      ambienceNodes = startForest(c, master);
      break;
    case "desert":
      ambienceNodes = startDesert(c, master);
      break;
    default:
      ambienceNodes = startGenericAmbience(c, master);
      break;
  }
}

export function stopAmbience(): void {
  if (!ambienceNodes) return;
  if (ambienceNodes.interval) clearInterval(ambienceNodes.interval);
  ambienceNodes.all.forEach((s) => { try { s.stop(); } catch (_) { /* */ } });
  ambienceNodes = null;
}

// ── Terrain sounds ────────────────────────────────────

const TERRAIN_BASE = 0.22;
// Grass sits well under mud: it's the terrain you clip through constantly, so
// at mud's level it dominates the mix rather than colouring it.
const GRASS_BASE = 0.1;

interface TerrainLoopNodes {
  master: GainNode;
  all: (AudioBufferSourceNode | OscillatorNode)[];
}

let grassNodes: TerrainLoopNodes | null = null;
let mudNodes: TerrainLoopNodes | null = null;

export function startGrass(): void {
  if (grassNodes) return;
  const c = getCtx();
  const master = c.createGain();
  master.gain.value = 0;
  master.connect(c.destination);

  const noise = c.createBufferSource();
  noise.buffer = makeNoiseBuffer(c, 2, 0.3, 1.6);
  noise.loop = true;
  noise.start();

  // A broad band rather than a peak. A resonant filter anywhere in the
  // 1-2kHz region is what reads as scraping/sandpaper, and leaving the lows in
  // reads as wind; between roughly 400Hz and 3.5kHz it just sounds like noise.
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 400;
  hp.Q.value = 0.5;

  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3500;
  lp.Q.value = 0.5;

  // Random volume bumps, added on top of a gain of 1 so they scale with
  // whatever volume updateGrass() sets rather than fighting it.
  const bump = c.createBufferSource();
  bump.buffer = makeControlNoiseBuffer(c, 6, 0.0004);
  bump.loop = true;
  bump.playbackRate.value = 0.8 + Math.random() * 0.4;
  bump.start();

  const bumpDepth = c.createGain();
  bumpDepth.gain.value = 0.45;

  const bumpGain = c.createGain();
  bumpGain.gain.value = 1;
  bump.connect(bumpDepth).connect(bumpGain.gain);

  noise.connect(hp).connect(lp).connect(bumpGain).connect(master);
  grassNodes = { master, all: [noise, bump] };
}

export function updateGrass(speed01: number): void {
  if (!grassNodes) return;
  const vol = gameVol() * GRASS_BASE * Math.min(1, speed01 * 2);
  grassNodes.master.gain.setTargetAtTime(vol, getCtx().currentTime, 0.06);
}

export function stopGrass(): void {
  if (!grassNodes) return;
  grassNodes.all.forEach((s) => { try { s.stop(); } catch (_) { /* */ } });
  grassNodes = null;
}

export function startMud(): void {
  if (mudNodes) return;
  const c = getCtx();
  const master = c.createGain();
  master.gain.value = 0;
  master.connect(c.destination);

  // Slurpy body: noise through a resonant bandpass whose frequency
  // slowly wanders — the resonance creates a liquid, sucking quality
  const noise = c.createBufferSource();
  noise.buffer = makeNoiseBuffer(c, 2, 0.1, 5);
  noise.loop = true;
  noise.start();

  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 500;
  bp.Q.value = 3;

  // Slow irregular sweep for slurpy variation
  const slurpLfo = c.createOscillator();
  slurpLfo.frequency.value = 1.8;
  const slurpDepth = c.createGain();
  slurpDepth.gain.value = 350;
  slurpLfo.connect(slurpDepth).connect(bp.frequency);
  slurpLfo.start();

  // Second LFO at incommensurate rate breaks the regularity
  const slurp2 = c.createOscillator();
  slurp2.frequency.value = 0.7;
  const slurp2Depth = c.createGain();
  slurp2Depth.gain.value = 200;
  slurp2.connect(slurp2Depth).connect(bp.frequency);
  slurp2.start();

  const bodyGain = c.createGain();
  bodyGain.gain.value = 0.6;
  noise.connect(bp).connect(bodyGain).connect(master);

  // High splatter layer — white-ish noise for the watery spray
  const splatter = c.createBufferSource();
  splatter.buffer = makeNoiseBuffer(c, 2, 0.5, 1.2);
  splatter.loop = true;
  splatter.start();

  const splatterBp = c.createBiquadFilter();
  splatterBp.type = "bandpass";
  splatterBp.frequency.value = 3000;
  splatterBp.Q.value = 0.8;

  const splatterGain = c.createGain();
  splatterGain.gain.value = 0.5;
  splatter.connect(splatterBp).connect(splatterGain).connect(master);

  mudNodes = { master, all: [noise, splatter, slurpLfo, slurp2] };
}

export function updateMud(speed01: number): void {
  if (!mudNodes) return;
  const vol = gameVol() * TERRAIN_BASE * Math.min(1, speed01 * 1.5);
  mudNodes.master.gain.setTargetAtTime(vol, getCtx().currentTime, 0.06);
}

export function stopMud(): void {
  if (!mudNodes) return;
  mudNodes.all.forEach((s) => { try { s.stop(); } catch (_) { /* */ } });
  mudNodes = null;
}

// Deliberately a stylised game sound, not a simulated wreck: a low clunk, a
// short metallic ring over it, and a little noise for grit. Attempts at a
// realistic layered crash (impact/debris/tail, measured partials, convolution
// reverb) are in the git history - they were far more code and sounded worse
// in a cartoon-ish arcade game than this does.

// Grazing a rock can register on several consecutive ticks; without a floor on
// the gap the crashes stack into a roar.
let lastCrashAt = -1;
const CRASH_MIN_GAP = 0.25;
const CRASH_DURATION = 0.7;

export function playRockCrash(): void {
  const vol = gameVol();
  if (vol <= 0) return;
  const c = getCtx();
  const now = c.currentTime;
  if (now - lastCrashAt < CRASH_MIN_GAP) return;
  lastCrashAt = now;

  const out = c.createGain();
  out.gain.value = vol * 0.5;
  out.connect(c.destination);

  // Clunk: a low sine dropping fast. It settles at 70Hz rather than lower
  // because most laptop and phone speakers can't reproduce much below that.
  const clunk = c.createOscillator();
  clunk.type = "sine";
  clunk.frequency.setValueAtTime(185, now);
  clunk.frequency.exponentialRampToValueAtTime(70, now + 0.06);
  const clunkEnv = c.createGain();
  clunkEnv.gain.setValueAtTime(0.0001, now);
  clunkEnv.gain.linearRampToValueAtTime(0.9, now + 0.004);
  clunkEnv.gain.exponentialRampToValueAtTime(0.0005, now + 0.22);
  clunk.connect(clunkEnv).connect(out);
  clunk.start(now);
  clunk.stop(now + 0.24);

  // Blunt low thud under it, so the clunk has body instead of reading as a
  // bare sine.
  const thudLp = c.createBiquadFilter();
  thudLp.type = "lowpass";
  thudLp.frequency.value = 260;
  const thudEnv = c.createGain();
  thudEnv.gain.setValueAtTime(1.35, now);
  thudEnv.gain.exponentialRampToValueAtTime(0.0005, now + 0.18);

  // Chime: three partials at inharmonic ratios, ringing out the full 0.7s.
  // Inharmonic keeps it metallic rather than musical; the upper ones fade
  // sooner so it darkens as it decays.
  const base = 370 + Math.random() * 140;
  const ratios = [1, 2.76, 5.4];
  const amps = [0.32, 0.19, 0.1];
  for (let i = 0; i < ratios.length; i++) {
    const osc = c.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = base * ratios[i]! * (0.99 + Math.random() * 0.02);
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(amps[i]!, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0005, now + CRASH_DURATION - i * 0.14);
    osc.connect(env).connect(out);
    osc.start(now);
    osc.stop(now + CRASH_DURATION);
  }

  // A little noise on the strike - just enough grit that the chime doesn't
  // sound purely synthesised. One source feeds both it and the thud above.
  const noise = c.createBufferSource();
  noise.buffer = makeNoiseBuffer(c, 0.35, 0.6, 1);
  noise.start(now);
  noise.stop(now + 0.35);
  noise.connect(thudEnv).connect(thudLp).connect(out);

  const grit = c.createBiquadFilter();
  grit.type = "bandpass";
  grit.frequency.value = 2400;
  grit.Q.value = 1.1;
  const gritEnv = c.createGain();
  gritEnv.gain.setValueAtTime(0.3, now);
  gritEnv.gain.exponentialRampToValueAtTime(0.0004, now + 0.1);
  noise.connect(gritEnv).connect(grit).connect(out);
}

// ── Pickup collection ─────────────────────────────────

/** Short cheerful chime when collecting cargo from a pickup warehouse. */
export function playPickupChime(): void {
  const vol = effectsVol();
  if (vol <= 0) return;
  const c = getCtx();
  const now = c.currentTime;

  const master = c.createGain();
  master.gain.value = vol * EFFECTS_BASE;
  master.connect(c.destination);

  const freqs = [523.3, 659.3, 784.0];
  for (let i = 0; i < freqs.length; i++) {
    const t = now + i * 0.06;
    const osc = c.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freqs[i]!;
    const env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.25, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(env).connect(master);
    osc.start(t);
    osc.stop(t + 0.35);
  }
}

// ── Lifecycle helpers ──────────────────────────────────

export function stopAll(): void {
  stopEngine();
  stopWobble();
  stopAmbience();
  stopGrass();
  stopMud();
}
