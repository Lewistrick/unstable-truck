import { generateLevel, shiftSeed, todaySeed } from "./level/generate.js";
import { GhostPlayer, type GhostRecording } from "./game/ghost.js";
import { createInput } from "./game/input.js";
import { renderMinimap, renderWorld, updateCamera, type Camera, type GhostView } from "./game/render.js";
import { GameSession } from "./game/session.js";
import { loadPersonalBest, savePersonalBestIfBetter } from "./game/storage.js";

const initialParams = new URLSearchParams(location.search);
const seed = initialParams.get("seed") || todaySeed();
const autostart = initialParams.get("start") === "1";
if (autostart) {
  // Consume the one-shot autostart flag so refreshing the page doesn't
  // immediately restart a run.
  history.replaceState(null, "", `${location.pathname}?seed=${seed}`);
}
const level = generateLevel(seed);

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const minimapCanvas = document.getElementById("minimap-canvas") as HTMLCanvasElement;
const minimapCtx = minimapCanvas.getContext("2d")!;

const startScreen = document.getElementById("start-screen")!;
const resultsScreen = document.getElementById("results-screen")!;
const hud = document.getElementById("hud")!;
const startDateEl = document.getElementById("start-date")!;
const startBtn = document.getElementById("start-btn")!;
const retryBtn = document.getElementById("retry-btn")!;
const resultsTitle = document.getElementById("results-title")!;
const resultsTime = document.getElementById("results-time")!;
const resultsPersonalBest = document.getElementById("results-personal-best")!;
const resultsStability = document.getElementById("results-stability")!;
const hudTimer = document.getElementById("hud-timer")!;
const hudPb = document.getElementById("hud-pb")!;
const hudObjective = document.getElementById("hud-objective")!;
const hudStabilityBar = document.getElementById("hud-stability-bar")!;
const pbGhostToggle = document.getElementById("pb-ghost-toggle") as HTMLInputElement;
const pbGhostLabel = document.getElementById("pb-ghost-label")!;
const countdownOverlay = document.getElementById("countdown-overlay")!;
const countdownText = document.getElementById("countdown-text")!;

startDateEl.textContent = seed === todaySeed() ? `Today's route — ${seed}` : `Route for ${seed}`;

/** Navigating to ?seed=<date>&start=1 is how the game switches which day is
 * active and jumps straight into a (countdown-gated) run for it - used by
 * the past-level thumbnails below. */
function goToSeed(targetSeed: string): void {
  location.search = `?seed=${targetSeed}&start=1`;
}

const PAST_LEVEL_LABELS = ["Yesterday", "2 days ago"];
for (let i = 0; i < PAST_LEVEL_LABELS.length; i++) {
  const pastSeed = shiftSeed(seed, -(i + 1));
  const pastLevel = generateLevel(pastSeed);
  const pastBest = loadPersonalBest(pastSeed);

  const cardEl = document.getElementById(`past-level-card-${i + 1}`)!;
  const dateEl = document.getElementById(`past-level-date-${i + 1}`)!;
  const bestEl = document.getElementById(`past-level-best-${i + 1}`)!;
  const canvasEl = document.getElementById(`past-level-canvas-${i + 1}`) as HTMLCanvasElement;
  const pastCtx = canvasEl.getContext("2d")!;

  dateEl.textContent = `${PAST_LEVEL_LABELS[i]} — ${pastSeed}`;
  bestEl.textContent = pastBest ? `Best: ${pastBest.time.toFixed(2)}s` : "Best: —";
  renderMinimap(pastCtx, pastLevel, 0, 0, canvasEl.width, canvasEl.height);

  cardEl.addEventListener("click", () => goToSeed(pastSeed));
  cardEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      goToSeed(pastSeed);
    }
  });
}

let personalBest: GhostRecording | null = loadPersonalBest(seed);

function refreshPersonalBestUi(): void {
  if (personalBest) {
    pbGhostToggle.disabled = false;
    pbGhostToggle.checked = true;
    pbGhostLabel.textContent = `Race personal best ghost (${personalBest.time.toFixed(2)}s)`;
    hudPb.textContent = `PB: ${personalBest.time.toFixed(2)}s`;
  } else {
    pbGhostToggle.disabled = true;
    pbGhostToggle.checked = false;
    pbGhostLabel.textContent = "No personal best yet";
    hudPb.textContent = "";
  }
}
refreshPersonalBestUi();

function resizeCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();
renderMinimap(minimapCtx, level, 0, 0, minimapCanvas.width, minimapCanvas.height);
minimapCanvas.addEventListener("click", () => beginRun());
minimapCanvas.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    beginRun();
  }
});

const input = createInput(canvas);

type AppState = "start" | "countdown" | "playing" | "ended";
let appState: AppState = "start";
let session: GameSession | null = null;
let ghost: GhostPlayer | null = null;
let countdownElapsed = 0;
const camera: Camera = { x: level.width / 2, y: level.height / 2 };

// "GO" gets its own step so it's visible for one beat before play begins.
const COUNTDOWN_STEPS = ["3", "2", "1", "GO"];
const COUNTDOWN_STEP_DURATION = 0.8;

function stabilityColor(stability: number): string {
  if (stability > 50) return "#3ecf6b";
  if (stability > 25) return "#e0a83e";
  return "#e0453e";
}

function beginRun(): void {
  session = new GameSession(level);
  ghost = personalBest && pbGhostToggle.checked ? new GhostPlayer(level, personalBest) : null;
  camera.x = session.truck.pos.x;
  camera.y = session.truck.pos.y;
  countdownElapsed = 0;
  appState = "countdown";
  startScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  hud.classList.remove("hidden");
  countdownOverlay.classList.remove("hidden");
}

function endRun(): void {
  if (!session) return;
  appState = "ended";
  hud.classList.add("hidden");
  resultsScreen.classList.remove("hidden");
  if (session.status === "success") {
    resultsTitle.textContent = "Delivered!";
    resultsTime.textContent = `Time: ${session.elapsed.toFixed(2)}s`;
    resultsStability.textContent = `Cargo stability at delivery: ${Math.round(session.cargo.stability)}%`;

    const previousBest = personalBest;
    const recording: GhostRecording = {
      seed,
      time: session.elapsed,
      stability: session.cargo.stability,
      inputLog: session.inputLog.slice(),
    };
    const isNewBest = savePersonalBestIfBetter(recording);
    if (isNewBest) {
      personalBest = recording;
      refreshPersonalBestUi();
    }
    resultsPersonalBest.textContent = !previousBest
      ? "New personal best!"
      : isNewBest
        ? `New personal best! (previous: ${previousBest.time.toFixed(2)}s)`
        : `Personal best: ${previousBest.time.toFixed(2)}s`;
  } else {
    resultsTitle.textContent = "Cargo fell off!";
    resultsTime.textContent = `Survived ${session.elapsed.toFixed(2)}s`;
    resultsStability.textContent = "Drive smoother and avoid mud and rocks.";
    resultsPersonalBest.textContent = "";
  }
}

/** Abandons the current run or countdown (no result is recorded) and returns to the start screen. */
function abortRun(): void {
  if (appState !== "playing" && appState !== "countdown") return;
  appState = "start";
  session = null;
  ghost = null;
  hud.classList.add("hidden");
  countdownOverlay.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
}

startBtn.addEventListener("click", beginRun);
retryBtn.addEventListener("click", beginRun);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") abortRun();
  if (e.key === "Enter" && appState === "ended") beginRun();
});

// Physics run on a fixed timestep, independent of render framerate. This is
// what makes ghost replay deterministic: elapsed time (and therefore every
// recorded input-toggle timestamp) is always an exact multiple of FIXED_DT,
// so replaying the same toggle list drives the exact same sequence of
// physics steps no matter how the real frame timing varied between the
// recording run and any later replay. A variable per-frame dt would instead
// integrate momentum/collisions slightly differently each time, and those
// tiny differences compound into a visibly different route.
const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 8;
let accumulator = 0;

function renderScene(activeSession: GameSession, frameDt: number): void {
  updateCamera(camera, activeSession.truck, frameDt);
  const ghostViews: GhostView[] = ghost ? [{ truck: ghost.truck, cargo: ghost.cargo }] : [];
  renderWorld(
    ctx,
    level,
    activeSession.truck,
    activeSession.cargo,
    activeSession.visited,
    ghostViews,
    camera,
    canvas.clientWidth,
    canvas.clientHeight,
  );
}

let lastTime = performance.now();
function frame(now: number): void {
  const frameDt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;

  if (appState === "countdown" && session) {
    // Input is tracked continuously regardless of app state (see input.ts),
    // so a press during the countdown is already reflected in input.held
    // and takes effect on the very first physics tick once play begins.
    countdownElapsed += frameDt;
    const stepIndex = Math.floor(countdownElapsed / COUNTDOWN_STEP_DURATION);
    if (stepIndex >= COUNTDOWN_STEPS.length) {
      appState = "playing";
      accumulator = 0;
      countdownOverlay.classList.add("hidden");
    } else {
      countdownText.textContent = COUNTDOWN_STEPS[stepIndex]!;
      renderScene(session, frameDt);
      hudTimer.textContent = "0.0s";
      hudObjective.textContent = `Pick up cargo (0/${session.pickups.length})`;
      hudStabilityBar.style.width = "100%";
      hudStabilityBar.style.backgroundColor = stabilityColor(100);
    }
  } else if (appState === "playing" && session) {
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      session.update(FIXED_DT, input.held);
      ghost?.update(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    renderScene(session, frameDt);

    hudTimer.textContent = `${session.elapsed.toFixed(1)}s`;
    hudObjective.textContent = session.allPickedUp
      ? "Deliver to destination"
      : `Pick up cargo (${session.visited.size}/${session.pickups.length})`;
    const stability = Math.round(session.cargo.stability);
    hudStabilityBar.style.width = `${stability}%`;
    hudStabilityBar.style.backgroundColor = stabilityColor(stability);

    if (session.status !== "playing") endRun();
  } else {
    accumulator = 0;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (autostart) beginRun();
