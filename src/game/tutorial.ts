import { sampleTerrain } from "../level/terrain.js";
import type { Level, Warehouse } from "../level/types.js";
import { FIXED_DT } from "../physics/constants.js";
import type { CargoState } from "../physics/cargo.js";
import { createTruck, resolveRockCollision, updateTruck, type TruckState } from "../physics/truck.js";
import { distance, type Vec2 } from "../util/vec2.js";
import { GameSession } from "./session.js";
import {
  buildMudSection,
  buildRoadGrassSection,
  buildRockSection,
  buildTutorialLevel,
  type TerrainSectionSpec,
} from "./tutorial-level.js";

// How long (in physics ticks, at 60/s) a hold or release must be sustained for
// the first two control lessons to register, so a momentary blip doesn't skip
// the lesson before the player has felt the truck respond. ~0.4s.
const HOLD_CONFIRM_TICKS = 24;
// How close (world units) the truck must get to a section's flag to clear it.
const GOAL_RADIUS = 34;

const EMPTY_VISITED: ReadonlySet<Warehouse> = new Set();

interface DriveStep {
  /** Instruction shown while this step is the active one. */
  readonly prompt: string;
  /** True once the player has satisfied this step. */
  isComplete(t: Tutorial): boolean;
}

// Stage 1: learn the single control, then run one delivery. These advance as
// the player actually holds, releases, collects, and delivers.
const DRIVE_STEPS: DriveStep[] = [
  {
    prompt: "Hold down to steer right — press and hold anywhere (or the spacebar). Feel the truck curve.",
    isComplete: (t) => t.sustainedHoldTicks >= HOLD_CONFIRM_TICKS,
  },
  {
    prompt: "Now let go. With nothing held, the truck drifts back to the left on its own.",
    isComplete: (t) => t.sustainedReleaseTicks >= HOLD_CONFIRM_TICKS,
  },
  {
    prompt: "That's the whole game! Steer over to the W warehouse to pick up its cargo.",
    isComplete: (t) => t.driveSession.visited.size >= 1,
  },
  {
    prompt: "Cargo loaded — keep it steady. Now haul it to the D drop-off to deliver.",
    isComplete: (t) => t.driveSession.status === "success",
  },
];

const DONE_PROMPT = "That's everything — road, grass, mud and rock. \u{1F389} You're ready to race for real!";

type Stage = "drive" | "terrain" | "done";

/** One hands-on terrain lesson: drive the fixed section level from its start to
 * its goal flag. Uses the raw truck/terrain physics directly (no cargo) so it
 * can't be lost; the only setback is the rock, which is solid and resets the
 * section on contact. */
class TerrainSection {
  readonly level: Level;
  readonly goal: Vec2;
  readonly prompt: string;
  private readonly startPos: Vec2;
  private readonly startHeading: number;
  /** Replaced (new object) on every reset, which the renderer uses as a signal
   * to snap the camera. */
  truck: TruckState;
  complete = false;

  constructor(spec: TerrainSectionSpec) {
    this.level = spec.level;
    this.goal = spec.goal;
    this.prompt = spec.prompt;
    this.startPos = spec.start.pos;
    this.startHeading = spec.start.heading;
    this.truck = createTruck(this.startPos, this.startHeading);
  }

  private reset(): void {
    this.truck = createTruck(this.startPos, this.startHeading);
  }

  tick(held: boolean): void {
    if (this.complete) return;
    const terrain = sampleTerrain(this.truck, this.level);
    updateTruck(this.truck, held, FIXED_DT, terrain, { width: this.level.width, height: this.level.height });

    // Rocks are solid: driving into one restarts the section from the top.
    for (const rock of this.level.rocks) {
      if (resolveRockCollision(this.truck, rock.pos, rock.radius)) {
        this.reset();
        return;
      }
    }

    if (distance(this.truck.pos, this.goal) <= GOAL_RADIUS) this.complete = true;
  }
}

/** Drives the whole new-player tutorial: a guided delivery (learn the control +
 * objective), then a short terrain course of hands-on sections (road/grass,
 * mud, rock), then a congratulations. main.ts renders whichever scene is active
 * and shows `prompt`; the player can Skip the current section or the whole
 * tutorial at any time. */
export class Tutorial {
  readonly driveLevel: Level;
  readonly driveSession: GameSession;
  private stage: Stage = "drive";
  private driveStepIndex = 0;
  /** Consecutive ticks the button has been held / released, for the first two
   * lessons. Reset when a control lesson is cleared so the next one needs a
   * fresh gesture rather than leftover credit. */
  sustainedHoldTicks = 0;
  sustainedReleaseTicks = 0;

  private readonly sections: TerrainSection[];
  private sectionIndex = 0;

  constructor() {
    this.driveLevel = buildTutorialLevel();
    this.driveSession = new GameSession(this.driveLevel, { practice: true });
    this.sections = [buildRoadGrassSection(), buildMudSection(), buildRockSection()].map(
      (spec) => new TerrainSection(spec),
    );
  }

  /** Clamped so the terminal "done" stage keeps rendering the last section. */
  private get currentSection(): TerrainSection {
    return this.sections[Math.min(this.sectionIndex, this.sections.length - 1)]!;
  }

  /** The instruction to show for the current stage/step. */
  get prompt(): string {
    if (this.stage === "drive") return DRIVE_STEPS[this.driveStepIndex]!.prompt;
    if (this.stage === "terrain") return this.currentSection.prompt;
    return DONE_PROMPT;
  }

  /** True once the whole tutorial is finished (terminal congratulations). */
  get isDone(): boolean {
    return this.stage === "done";
  }

  /** True while any section (the steering run or a terrain section) is active,
   * so a per-section Skip button can be shown. False only on the terminal
   * "done" stage. */
  get canSkipSection(): boolean {
    return this.stage !== "done";
  }

  // --- Render state: whichever scene (delivery run or terrain section) is live.
  get activeLevel(): Level {
    return this.stage === "drive" ? this.driveLevel : this.currentSection.level;
  }
  get activeTruck(): TruckState {
    return this.stage === "drive" ? this.driveSession.truck : this.currentSection.truck;
  }
  get activeCargo(): readonly CargoState[] {
    return this.stage === "drive" ? this.driveSession.cargoBoxes : [];
  }
  get activeVisited(): ReadonlySet<Warehouse> {
    return this.stage === "drive" ? this.driveSession.visited : EMPTY_VISITED;
  }
  get goalMarkers(): readonly Vec2[] {
    return this.stage === "drive" ? [] : [this.currentSection.goal];
  }

  /** Skips the current section (the per-section Skip button). From the steering
   * run it jumps straight to the terrain course; within the terrain course it
   * advances to the next section (or the finish). No effect once done. */
  skipSection(): void {
    if (this.stage === "drive") {
      this.stage = "terrain";
      this.sectionIndex = 0;
    } else if (this.stage === "terrain") {
      this.advanceSection();
    }
  }

  private advanceSection(): void {
    this.sectionIndex++;
    if (this.sectionIndex >= this.sections.length) this.stage = "done";
  }

  /** Advances the active scene and the step machine by one physics tick. Call
   * once per fixed tick, then read `prompt` / the render getters. */
  tick(held: boolean): void {
    if (this.stage === "drive") {
      this.driveSession.update(FIXED_DT, held);
      this.sustainedHoldTicks = held ? this.sustainedHoldTicks + 1 : 0;
      this.sustainedReleaseTicks = held ? 0 : this.sustainedReleaseTicks + 1;

      // Clear every drive step already satisfied (normally one). Resetting the
      // gesture counters between the two control lessons means clearing "hold"
      // doesn't instantly clear "release".
      while (this.driveStepIndex < DRIVE_STEPS.length && DRIVE_STEPS[this.driveStepIndex]!.isComplete(this)) {
        this.driveStepIndex++;
        this.sustainedHoldTicks = 0;
        this.sustainedReleaseTicks = 0;
      }
      if (this.driveStepIndex >= DRIVE_STEPS.length) {
        this.stage = "terrain";
        this.sectionIndex = 0;
      }
    } else if (this.stage === "terrain") {
      const section = this.currentSection;
      section.tick(held);
      if (section.complete) this.advanceSection();
    }
    // "done": the scene is static; nothing to advance.
  }
}
