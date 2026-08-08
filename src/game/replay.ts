import type { Level } from "../level/types.js";
import { FIXED_DT } from "../physics/constants.js";
import { GhostPlayer, type GhostRecording } from "./ghost.js";
import type { ReplayRacerView } from "./render.js";

/** Distinct, high-contrast accent colours for up to five racers, so each is
 * tellable apart by its ring + name pill. */
export const REPLAY_COLORS = ["#ff5a5a", "#3fb7ff", "#ffd23f", "#5adf7a", "#c07bff"] as const;

/** The maximum number of ghosts that can race in one replay. */
export const MAX_REPLAY_RACERS = REPLAY_COLORS.length;

/** One racer to include in a replay: a recording plus how to label/colour it. */
export interface ReplayRacer {
  label: string;
  color: string;
  recording: GhostRecording;
}

interface RacerState {
  label: string;
  color: string;
  recording: GhostRecording;
  /** Reconstructed anew when seeking (deterministic replay from the input log). */
  player: GhostPlayer;
  /** Tick this racer crosses the finish line and freezes on its final frame. */
  finishTick: number;
}

/** Plays several recorded runs on one level at once, non-interactively, like a
 * video: play/pause, seek to any point (deterministic, so seeking re-simulates
 * each racer from the start), and a shared timeline that runs until the slowest
 * racer finishes. Rendering/UI are the caller's job (see main.ts). */
export class ReplayTheater {
  private readonly level: Level;
  private readonly racers: RacerState[];
  /** Length of the whole replay: the slowest racer's finish tick. */
  readonly totalTicks: number;
  private currentTick = 0;
  playing = false;

  constructor(level: Level, racers: readonly ReplayRacer[]) {
    this.level = level;
    this.racers = racers.map((r) => ({
      label: r.label,
      color: r.color,
      recording: r.recording,
      player: new GhostPlayer(level, r.recording),
      finishTick: Math.round(r.recording.time / FIXED_DT),
    }));
    this.totalTicks = Math.max(1, ...this.racers.map((r) => r.finishTick));
  }

  get tick(): number {
    return this.currentTick;
  }

  /** 0..1 through the timeline, for the progress bar. */
  get progress(): number {
    return this.currentTick / this.totalTicks;
  }

  /** True once the timeline has reached the end (all racers finished). */
  get atEnd(): boolean {
    return this.currentTick >= this.totalTicks;
  }

  get elapsed(): number {
    return this.currentTick * FIXED_DT;
  }

  get duration(): number {
    return this.totalTicks * FIXED_DT;
  }

  /** Per-racer render views at the current tick. */
  views(): ReplayRacerView[] {
    return this.racers.map((r) => ({
      truck: r.player.truck,
      cargoBoxes: r.player.cargoBoxes,
      label: r.label,
      color: r.color,
    }));
  }

  /** Starts playback. If we're sitting at the end, restart from the top first
   * (matching how a video's play button behaves). */
  play(): void {
    if (this.atEnd) this.seekTo(0);
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Advances the timeline by one physics tick. The caller drives this from a
   * fixed-timestep accumulator (same as live play) only while `playing`. Stops
   * and pauses on the final frame so the finish positions stay on screen. */
  step(): void {
    if (this.currentTick >= this.totalTicks) {
      this.playing = false;
      return;
    }
    for (const r of this.racers) r.player.update(FIXED_DT);
    this.currentTick++;
    if (this.currentTick >= this.totalTicks) this.playing = false;
  }

  /** Jumps to an absolute tick by re-simulating every racer from the start
   * (replay is deterministic, so this is exact). */
  seekTo(tick: number): void {
    const target = Math.max(0, Math.min(this.totalTicks, Math.round(tick)));
    for (const r of this.racers) {
      r.player = new GhostPlayer(this.level, r.recording);
      for (let i = 0; i < target; i++) r.player.update(FIXED_DT);
    }
    this.currentTick = target;
  }

  /** Jumps to a fraction (0..1) of the timeline - what the progress bar uses. */
  seekToFraction(fraction: number): void {
    this.seekTo(fraction * this.totalTicks);
  }
}
