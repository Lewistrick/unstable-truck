import { FIXED_DT } from "../physics/constants.js";
import type { Level } from "../level/types.js";
import { GameSession } from "./session.js";

/** A recorded run: just enough to reconstruct it exactly through the same
 * deterministic physics used live - the seed (which level to replay it
 * against), the finish time, final cargo stability, and the list of
 * held/released toggle tick indices from GameSession.inputLog. */
export interface GhostRecording {
  seed: string;
  time: number;
  stability: number;
  /** Tick indices (not seconds) at which input toggled held/released. */
  inputLog: number[];
}

/** Whether the input button was held at tick `tick`, given a chronological
 * list of toggle tick indices starting from released. */
function heldAtTick(inputLog: number[], tick: number): boolean {
  let toggles = 0;
  for (const toggleTick of inputLog) {
    if (toggleTick > tick) break;
    toggles++;
  }
  return toggles % 2 === 1;
}

/** Replays a GhostRecording by driving a real GameSession with the recorded
 * input log instead of live input, so the ghost's truck/cargo/pickups behave
 * exactly like a live run would. Rendered as a semi-transparent overlay. */
export class GhostPlayer {
  private readonly session: GameSession;
  private readonly recording: GhostRecording;
  private readonly finishTick: number;
  finished = false;

  constructor(level: Level, recording: GhostRecording) {
    this.session = new GameSession(level);
    this.recording = recording;
    this.finishTick = Math.round(recording.time / FIXED_DT);
  }

  get truck() {
    return this.session.truck;
  }

  get cargoBoxes() {
    return this.session.cargoBoxes;
  }

  update(dt: number): void {
    if (this.finished) return;
    if (this.session.currentTick >= this.finishTick) {
      this.finished = true;
      return;
    }
    const held = heldAtTick(this.recording.inputLog, this.session.currentTick);
    this.session.update(dt, held);
  }
}

/** Re-simulates a recording to completion through a fresh session and returns
 * the ticks at which it collected each warehouse, in collection order. It's
 * deterministic, so these match the collections the live ghost makes - used to
 * compute the live split time against the player. */
export function ghostCollectTicks(level: Level, recording: GhostRecording): number[] {
  const session = new GameSession(level);
  const finishTick = Math.round(recording.time / FIXED_DT);
  while (session.status === "playing" && session.currentTick < finishTick) {
    session.update(FIXED_DT, heldAtTick(recording.inputLog, session.currentTick));
  }
  return session.collectTicks.slice();
}

/** The split time (in seconds) at the player's latest reached checkpoint: the
 * tick gap to the ghost at the same *number* of warehouses collected (the order
 * they were collected in is ignored), times `dt`. Negative means the player is
 * ahead. Null until the player has reached a checkpoint the ghost also reached. */
export function splitDelta(playerCollectTicks: number[], ghostCollectTicks: number[], dt: number): number | null {
  const k = playerCollectTicks.length;
  if (k === 0 || k > ghostCollectTicks.length) return null;
  return (playerCollectTicks[k - 1]! - ghostCollectTicks[k - 1]!) * dt;
}
