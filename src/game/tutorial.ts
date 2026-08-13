import type { Level, Warehouse } from "../level/types.js";
import type { CargoState } from "../physics/cargo.js";
import { FIXED_DT } from "../physics/constants.js";
import type { TruckState } from "../physics/truck.js";
import { countdownLabel } from "./countdown.js";
import { GameSession, OUT_OF_BOUNDS_TICKS } from "./session.js";
import {
    buildCargoLevel,
    buildFullLevel,
    buildMudLevel,
    buildRoadLevel,
    buildRockLevel,
    buildSteeringLevel,
} from "./tutorial-level.js";

/** How long a timed play part may run before it's cut short and re-explained. */
export const PLAY_TIME_LIMIT = 30;

/** Every tutorial section runs through the same three-part cycle: read the
 * explanation on a frozen scene, count in, play it. `complete` is the choice
 * screen shown once the drop-off is reached. */
export type TutorialPhase = "explain" | "countdown" | "play" | "complete";

/** Why a play part was cut short, so the explanation can say what went wrong. */
export type Setback = "outOfBounds" | "timeUp";

const SETBACK_NOTE: Record<Setback, string> = {
  outOfBounds: "You drove off the edge of the map. Let's go through it once more:",
  timeUp: `That took more than ${PLAY_TIME_LIMIT} seconds. Let's go through it once more:`,
};

interface Section {
  /** Shown in the coach badge, e.g. "2/6 - Cargo". */
  readonly title: string;
  /** The 'explain' part's copy, one paragraph per line. */
  readonly explain: readonly string[];
  /** The one-liner shown while the 'play' part is live. */
  readonly prompt: string;
  /** Shown on the choice screen once the section is cleared. */
  readonly cleared: string;
  /** The level to drive. Its base is where the truck starts and its drop-off is
   * what completes the section. */
  readonly level: Level;
  /** When true, driving out of bounds or running past PLAY_TIME_LIMIT sends the
   * player back to the explanation. The closing full-level section is untimed:
   * it's a real run, and a real run takes as long as it takes. */
  readonly timed: boolean;
}

function buildSections(): Section[] {
  return [
    {
      title: "Steering",
      explain: [
        "You're driving the truck. It always moves forward, and steering is the only thing you do.",
        "Do nothing and the truck curves left. Hold (press the screen, the spacebar or your mouse button) and it curves right."
      ],
      prompt: "Steer your way to the D drop-off.",
      cleared: "That one button is the whole game.",
      level: buildSteeringLevel(),
      timed: true,
    },
    {
      title: "Cargo",
      explain: [
        "Every run is a delivery: collect cargo at the W warehouses, then bring it to the D drop-off.",
        "Load up at the W, then deliver to the D.",
      ],
      prompt: "Collect the W, then deliver it to the D.",
      cleared: "Pick up, haul, drop off. That's a run.",
      level: buildCargoLevel(),
      timed: true,
    },
    {
      title: "Roads",
      explain: [
        "To go straight, alternate between holding and releasing. Get to the D drop-off.",
        "Roads are fast, grass is slower. Think about when you want to cut corners.",
        "Ride the road all the way to the drop-off.",
      ],
      prompt: "Ride the road to the D drop-off.",
      cleared: "Fast lane found.",
      level: buildRoadLevel(),
      timed: true,
    },
    {
      title: "Mud",
      explain: [
        "That brown puddle is mud. You lose most of your grip and speed.",
        "Steering around mud is almost always faster.",
      ],
      prompt: "Get around the mud and reach the D drop-off.",
      cleared: "You handled that mud well.",
      level: buildMudLevel(),
      timed: true,
    },
    {
      title: "Rocks",
      explain: [
        "Rocks are solid walls. When hit, you come to an immediate halt.",
        "There's no way through, so go around.",
      ],
      prompt: "Steer around the rock to the D drop-off.",
      cleared: "Not a scratch.",
      level: buildRockLevel(),
      timed: true,
    },
    {
      title: "A real map",
      explain: [
        "Now you know everything you need to know. Here's a real map for you.",
        "Targets outside your screen get an arrow pointing at them.",
      ],
      prompt: "Collect all three W warehouses, then deliver to the D.",
      cleared: "That's a full run. You're ready for the real thing.",
      level: buildFullLevel(),
      timed: false,
    },
  ];
}

/** Drives the whole new-player tutorial: a list of sections, each of which is
 * explained on a frozen scene, counted in 3-2-1-GO, then played on its own
 * fixed level until the truck reaches the drop-off. main.ts renders whichever
 * level is active, shows `lines` plus the buttons for the current `phase`, and
 * calls back in through tryItOut / explainAgain / nextSection. */
export class Tutorial {
  /** Which part of the current section is showing. Only this class writes it. */
  phase: TutorialPhase = "explain";
  /** Set when a play part was cut short; cleared when the player moves on. */
  setback: Setback | null = null;

  private readonly sections: Section[];
  private index = 0;
  /** The live run of the current section. Replaced (a new object, so main.ts
   * snaps its camera) whenever a section is restarted. */
  private session: GameSession;
  private countdownElapsed = 0;
  /** Consecutive ticks the truck has been pinned against the map edge. */
  private boundaryTicks = 0;

  constructor() {
    this.sections = buildSections();
    this.session = new GameSession(this.sections[0]!.level, { practice: true });
  }

  private get section(): Section {
    return this.sections[this.index]!;
  }

  get sectionNumber(): number {
    return this.index + 1;
  }
  get sectionCount(): number {
    return this.sections.length;
  }
  get sectionTitle(): string {
    return this.section.title;
  }
  get isLastSection(): boolean {
    return this.index === this.sections.length - 1;
  }

  /** The coach copy for the current phase, one paragraph per line. */
  get lines(): readonly string[] {
    switch (this.phase) {
      case "explain":
        return this.setback ? [SETBACK_NOTE[this.setback], ...this.section.explain] : this.section.explain;
      case "complete":
        return [this.section.cleared];
      default:
        // Counting in shows the goal the player is about to chase, so the line
        // doesn't change under them the moment GO disappears.
        return [this.section.prompt];
    }
  }

  /** The 3-2-1-GO label to show, or null when no count-in is running. */
  get countdownLabel(): string | null {
    return this.phase === "countdown" ? countdownLabel(this.countdownElapsed) : null;
  }

  /** Whole seconds left in a timed play part, or null when there's no limit
   * running (untimed section, or not playing). */
  get secondsLeft(): number | null {
    if (this.phase !== "play" || !this.section.timed) return null;
    return Math.max(0, Math.ceil(PLAY_TIME_LIMIT - this.session.elapsed));
  }

  // --- Render state: the active section's level and its live run.
  get activeLevel(): Level {
    return this.section.level;
  }
  get activeTruck(): TruckState {
    return this.session.truck;
  }
  get activeCargo(): readonly CargoState[] {
    return this.session.cargoBoxes;
  }
  get activeVisited(): ReadonlySet<Warehouse> {
    return this.session.visited;
  }

  /** Puts the current section back at its start line, frozen until play begins. */
  private restart(): void {
    this.session = new GameSession(this.section.level, { practice: true });
    this.boundaryTicks = 0;
  }

  /** "Try it out": counts in, then hands the truck over to the player. */
  tryItOut(): void {
    if (this.phase !== "explain") return;
    this.restart();
    this.countdownElapsed = 0;
    this.phase = "countdown";
  }

  /** "Explain again": back to the explanation of this same section. */
  explainAgain(): void {
    this.restart();
    this.setback = null;
    this.phase = "explain";
  }

  /** "Next section" / "Skip section". Returns false when there is no next one,
   * i.e. the caller should close the tutorial. */
  nextSection(): boolean {
    if (this.isLastSection) return false;
    this.index++;
    this.explainAgain();
    return true;
  }

  /** Advances the count-in. Call once per rendered frame (it runs on wall-clock
   * time, not physics ticks - nothing is moving yet). */
  advanceCountdown(dt: number): void {
    if (this.phase !== "countdown") return;
    this.countdownElapsed += dt;
    if (countdownLabel(this.countdownElapsed) === null) this.phase = "play";
  }

  /** Advances the live play part by one physics tick. A no-op in every other
   * phase, so the caller can drive it from an unconditional fixed-step loop. */
  tick(held: boolean): void {
    if (this.phase !== "play") return;
    this.session.update(FIXED_DT, held);
    if (this.session.status === "success") {
      this.phase = "complete";
      return;
    }
    // The run itself is a practice one (cargo can't be lost, the edge can't end
    // it), so the two setbacks are counted here instead - they send the player
    // back to the explanation rather than ending anything.
    if (!this.section.timed) return;
    this.boundaryTicks = this.session.truck.atBoundary ? this.boundaryTicks + 1 : 0;
    if (this.boundaryTicks >= OUT_OF_BOUNDS_TICKS) this.setBack("outOfBounds");
    else if (this.session.elapsed >= PLAY_TIME_LIMIT) this.setBack("timeUp");
  }

  private setBack(reason: Setback): void {
    this.restart();
    this.setback = reason;
    this.phase = "explain";
  }
}
