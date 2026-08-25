import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const DIST_BASE = pathToFileURL(path.join(projectRoot, "dist") + path.sep).href;

const FIXED_DT = 1 / 60;
const MAX_TICKS = 36_000;
const MAX_INPUT_LOG_LENGTH = 10_000;

type Difficulty = "easy" | "hard";

interface SessionLike {
  status: string;
  elapsed: number;
  currentTick: number;
  update(dt: number, held: boolean): void;
}

let mods: {
  generateLevel: (seed: string) => unknown;
  GameSession: new (level: unknown, options: { difficulty: Difficulty }) => SessionLike;
} | null = null;

async function loadModules(): Promise<NonNullable<typeof mods>> {
  if (mods) return mods;
  const [genMod, sessionMod] = await Promise.all([
    import(new URL("level/generate.js", DIST_BASE).href),
    import(new URL("game/session.js", DIST_BASE).href),
  ]);
  mods = {
    generateLevel: genMod.generateLevel,
    GameSession: sessionMod.GameSession,
  };
  return mods;
}

export async function validateReplay(
  seed: string,
  difficulty: Difficulty,
  inputLog: number[],
  expectedTime: number,
): Promise<{ valid: boolean; reason?: string }> {
  if (inputLog.length > MAX_INPUT_LOG_LENGTH) {
    return { valid: false, reason: "input log too long" };
  }

  const { generateLevel, GameSession } = await loadModules();
  const level = generateLevel(seed);
  const session = new GameSession(level, { difficulty });

  let logIndex = 0;
  let held = false;

  while (session.status === "playing" && session.currentTick < MAX_TICKS) {
    while (logIndex < inputLog.length && inputLog[logIndex]! <= session.currentTick) {
      held = !held;
      logIndex++;
    }
    session.update(FIXED_DT, held);
  }

  if (session.status !== "success") {
    return { valid: false, reason: "replay did not complete a delivery" };
  }

  if (Math.abs(session.elapsed - expectedTime) > FIXED_DT * 1.5) {
    return { valid: false, reason: "replay time does not match submission" };
  }

  return { valid: true };
}
