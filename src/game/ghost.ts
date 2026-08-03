import type { Level } from "../level/types.js";
import { GameSession } from "./session.js";

/** A recorded run: just enough to reconstruct it exactly through the same
 * deterministic physics used live - the seed (which level to replay it
 * against), the finish time, final cargo stability, and the list of
 * held/released toggle times from GameSession.inputLog. */
export interface GhostRecording {
  seed: string;
  time: number;
  stability: number;
  inputLog: number[];
}

/** Whether the input button was held at time `t`, given a chronological list
 * of toggle times starting from released. */
function heldAtTime(inputLog: number[], t: number): boolean {
  let toggles = 0;
  for (const toggleTime of inputLog) {
    if (toggleTime > t) break;
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
  private elapsed = 0;
  finished = false;

  constructor(level: Level, recording: GhostRecording) {
    this.session = new GameSession(level);
    this.recording = recording;
  }

  get truck() {
    return this.session.truck;
  }

  get cargo() {
    return this.session.cargo;
  }

  update(dt: number): void {
    if (this.finished) return;
    if (this.elapsed >= this.recording.time) {
      this.finished = true;
      return;
    }
    const held = heldAtTime(this.recording.inputLog, this.elapsed);
    this.session.update(dt, held);
    this.elapsed += dt;
  }
}
