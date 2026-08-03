import { generateLevel, todaySeed } from "./level/generate.js";
import { createInput } from "./game/input.js";
import { renderMinimap, renderWorld, updateCamera, type Camera } from "./game/render.js";
import { GameSession } from "./game/session.js";

const seed = new URLSearchParams(location.search).get("seed") || todaySeed();
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
const resultsStability = document.getElementById("results-stability")!;
const hudTimer = document.getElementById("hud-timer")!;
const hudObjective = document.getElementById("hud-objective")!;
const hudStabilityBar = document.getElementById("hud-stability-bar")!;

startDateEl.textContent = `Today's route — ${seed}`;

function resizeCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();
renderMinimap(minimapCtx, level, 0, 0, minimapCanvas.width, minimapCanvas.height);

const input = createInput(canvas);

type AppState = "start" | "playing" | "ended";
let appState: AppState = "start";
let session: GameSession | null = null;
const camera: Camera = { x: level.width / 2, y: level.height / 2 };

function stabilityColor(stability: number): string {
  if (stability > 50) return "#3ecf6b";
  if (stability > 25) return "#e0a83e";
  return "#e0453e";
}

function beginRun(): void {
  session = new GameSession(level);
  camera.x = session.truck.pos.x;
  camera.y = session.truck.pos.y;
  appState = "playing";
  startScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  hud.classList.remove("hidden");
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
  } else {
    resultsTitle.textContent = "Cargo fell off!";
    resultsTime.textContent = `Survived ${session.elapsed.toFixed(2)}s`;
    resultsStability.textContent = "Drive smoother and avoid mud and rocks.";
  }
}

startBtn.addEventListener("click", beginRun);
retryBtn.addEventListener("click", beginRun);

let lastTime = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (appState === "playing" && session) {
    session.update(dt, input.held);
    updateCamera(camera, session.truck, dt);
    renderWorld(ctx, level, session.truck, session.cargo, camera, canvas.clientWidth, canvas.clientHeight);

    hudTimer.textContent = `${session.elapsed.toFixed(1)}s`;
    hudObjective.textContent = session.allPickedUp
      ? "Deliver to destination"
      : `Pick up cargo (${session.visited.size}/${session.pickups.length})`;
    const stability = Math.round(session.cargo.stability);
    hudStabilityBar.style.width = `${stability}%`;
    hudStabilityBar.style.backgroundColor = stabilityColor(stability);

    if (session.status !== "playing") endRun();
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
