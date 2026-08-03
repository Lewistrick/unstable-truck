import { generateLevel, shiftSeed, todaySeed } from "./level/generate.js";
import { FIXED_DT } from "./physics/constants.js";
import { fetchLeaderboard, fetchPlayerRecording, submitScore, type LeaderboardEntry, type RemoteRecording } from "./game/api.js";
import { GhostPlayer, type GhostRecording } from "./game/ghost.js";
import { createInput } from "./game/input.js";
import { renderMinimap, renderWorld, updateCamera, type Camera, type GhostView } from "./game/render.js";
import { GameSession } from "./game/session.js";
import { getOrCreateNickname, loadPersonalBest, pruneOldPersonalBests, savePersonalBestIfBetter, setNickname } from "./game/storage.js";
import type { Level } from "./level/types.js";

interface Playable {
  seed: string;
  level: Level;
  personalBest: GhostRecording | null;
}

function makePlayable(seed: string): Playable {
  return { seed, level: generateLevel(seed), personalBest: loadPersonalBest(seed) };
}

// Drop any personal bests older than a week before loading anything.
pruneOldPersonalBests();

const todaysSeed = todaySeed();

// The home screen shows one browsable day at a time, always anchored to the
// real calendar date (today's seed never drifts based on what's been
// played). Levels are generated lazily as the player navigates and cached so
// re-visiting a day doesn't regenerate it.
const MAX_PAST_DAYS = 7;
const playableCache = new Map<number, Playable>();

function getPlayable(offset: number): Playable {
  let playable = playableCache.get(offset);
  if (!playable) {
    playable = makePlayable(shiftSeed(todaysSeed, offset));
    playableCache.set(offset, playable);
  }
  return playable;
}

function describeOffset(offset: number): string {
  if (offset === 0) return "Today";
  if (offset === -1) return "Yesterday";
  return `${-offset} days ago`;
}

let viewedOffset = 0;
let viewed: Playable = getPlayable(0);

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const minimapCanvas = document.getElementById("minimap-canvas") as HTMLCanvasElement;
const minimapCtx = minimapCanvas.getContext("2d")!;

const startScreen = document.getElementById("start-screen")!;
const resultsScreen = document.getElementById("results-screen")!;
const hud = document.getElementById("hud")!;
const viewedDateEl = document.getElementById("viewed-date")!;
const navPrevBtn = document.getElementById("nav-prev-btn") as HTMLButtonElement;
const navNextBtn = document.getElementById("nav-next-btn") as HTMLButtonElement;
const retryBtn = document.getElementById("retry-btn")!;
const homeBtn = document.getElementById("home-btn")!;
const resultsTitle = document.getElementById("results-title")!;
const resultsTime = document.getElementById("results-time")!;
const resultsPersonalBest = document.getElementById("results-personal-best")!;
const resultsStability = document.getElementById("results-stability")!;
const hudTimer = document.getElementById("hud-timer")!;
const hudPb = document.getElementById("hud-pb")!;
const hudObjective = document.getElementById("hud-objective")!;
const pbGhostToggle = document.getElementById("pb-ghost-toggle") as HTMLInputElement;
const pbGhostLabel = document.getElementById("pb-ghost-label")!;
const countdownOverlay = document.getElementById("countdown-overlay")!;
const countdownText = document.getElementById("countdown-text")!;
const viewedBestEl = document.getElementById("viewed-best")!;
const nicknameInput = document.getElementById("nickname-input") as HTMLInputElement;
const leaderboardHeaderEl = document.getElementById("leaderboard-header")!;
const leaderboardList = document.getElementById("leaderboard-list")!;

let nickname = getOrCreateNickname();
nicknameInput.value = nickname;
nicknameInput.addEventListener("change", () => {
  setNickname(nicknameInput.value);
  nickname = getOrCreateNickname();
  nicknameInput.value = nickname;
  renderLeaderboardList();
});

function refreshViewedUi(): void {
  viewedDateEl.textContent = `${describeOffset(viewedOffset)} — ${viewed.seed}`;
  viewedBestEl.textContent = viewed.personalBest ? `Best: ${viewed.personalBest.time.toFixed(2)}s` : "Best: —";
  if (viewed.personalBest) {
    pbGhostToggle.disabled = false;
    pbGhostToggle.checked = true;
    pbGhostLabel.textContent = `Race personal best ghost (${viewed.personalBest.time.toFixed(2)}s)`;
    hudPb.textContent = `PB: ${viewed.personalBest.time.toFixed(2)}s`;
  } else {
    pbGhostToggle.disabled = true;
    pbGhostToggle.checked = false;
    pbGhostLabel.textContent = "No personal best yet";
    hudPb.textContent = "";
  }
}

/** Picks readable text color (dark or light) for a given `hsl(h s% l%)`
 * background, since a day's road/grass/mud/rock colors are seeded per day
 * and can land anywhere in their brightness range. */
function contrastTextFor(hslColor: string): string {
  const match = hslColor.match(/hsl\(\s*[\d.-]+\s+[\d.]+%\s+([\d.]+)%/);
  const lightness = match ? parseFloat(match[1]!) : 50;
  return lightness > 55 ? "#12161c" : "#f5f7fa";
}

function paintTerrainTag(id: string, backgroundColor: string): void {
  const el = document.getElementById(id)!;
  el.style.backgroundColor = backgroundColor;
  el.style.color = contrastTextFor(backgroundColor);
}

function paintViewedTerrainTags(): void {
  paintTerrainTag("tag-road", viewed.level.palette.road);
  paintTerrainTag("tag-grass", viewed.level.palette.grass);
  paintTerrainTag("tag-mud", viewed.level.palette.mud);
  paintTerrainTag("tag-rock", viewed.level.palette.rock);
}

// --- Leaderboard (for whichever day is currently viewed) -------------------

let leaderboardTop: LeaderboardEntry[] = [];
let leaderboardContext: LeaderboardEntry[] = [];
let selectedGhostEntry: { nickname: string; recording: RemoteRecording } | null = null;

function renderLeaderboardList(): void {
  leaderboardHeaderEl.textContent = `Leaderboard (${describeOffset(viewedOffset)})`;
  leaderboardList.replaceChildren();
  if (leaderboardTop.length === 0) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "No times yet — be the first!";
    leaderboardList.appendChild(li);
    return;
  }

  for (const entry of [...leaderboardTop, ...leaderboardContext]) {
    const li = document.createElement("li");
    li.className = "leaderboard-row";
    if (entry.nickname === nickname) li.classList.add("self");
    if (selectedGhostEntry?.nickname === entry.nickname) li.classList.add("selected");

    const rankEl = document.createElement("span");
    rankEl.className = "leaderboard-rank";
    rankEl.textContent = String(entry.rank);

    const nameEl = document.createElement("span");
    nameEl.className = "leaderboard-nickname";
    nameEl.textContent = selectedGhostEntry?.nickname === entry.nickname ? `\u{1F4F7} ${entry.nickname}` : entry.nickname;

    const timeEl = document.createElement("span");
    timeEl.className = "leaderboard-time";
    timeEl.textContent = `${entry.time.toFixed(2)}s`;

    li.append(rankEl, nameEl, timeEl);
    li.addEventListener("click", () => {
      void toggleLeaderboardGhost(entry.nickname);
    });
    leaderboardList.appendChild(li);
  }
}

/** Selecting a leaderboard row races their ghost alongside (or instead of)
 * the personal-best ghost; clicking the same row again deselects it. Only
 * one leaderboard player can be selected at a time. */
async function toggleLeaderboardGhost(clickedNickname: string): Promise<void> {
  if (selectedGhostEntry?.nickname === clickedNickname) {
    selectedGhostEntry = null;
    renderLeaderboardList();
    return;
  }
  const recording = await fetchPlayerRecording(viewed.seed, clickedNickname);
  if (recording) selectedGhostEntry = { nickname: clickedNickname, recording };
  renderLeaderboardList();
}

async function refreshLeaderboard(): Promise<void> {
  const data = await fetchLeaderboard(viewed.seed, nickname);
  if (data) {
    leaderboardTop = data.top;
    leaderboardContext = data.context;
  }
  renderLeaderboardList();
}

// --- Day navigation ---------------------------------------------------

function updateNavButtons(): void {
  navPrevBtn.disabled = viewedOffset <= -MAX_PAST_DAYS;
  navNextBtn.disabled = viewedOffset >= 0;
}

function navigateTo(offset: number): void {
  viewedOffset = Math.max(-MAX_PAST_DAYS, Math.min(0, offset));
  viewed = getPlayable(viewedOffset);
  // A selected ghost is contextual to the day it was fetched for.
  selectedGhostEntry = null;
  updateNavButtons();
  refreshViewedUi();
  paintViewedTerrainTags();
  renderMinimap(minimapCtx, viewed.level, 0, 0, minimapCanvas.width, minimapCanvas.height);
  void refreshLeaderboard();
}

navPrevBtn.addEventListener("click", () => navigateTo(viewedOffset - 1));
navNextBtn.addEventListener("click", () => navigateTo(viewedOffset + 1));

// -----------------------------------------------------------------------

function resizeCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// Initial paint: today (offset 0), same steps navigateTo() would do.
updateNavButtons();
refreshViewedUi();
paintViewedTerrainTags();
renderMinimap(minimapCtx, viewed.level, 0, 0, minimapCanvas.width, minimapCanvas.height);
void refreshLeaderboard();

const input = createInput(canvas);

type AppState = "start" | "countdown" | "playing" | "ended";
let appState: AppState = "start";
let session: GameSession | null = null;
let pbGhost: GhostPlayer | null = null;
let leaderboardGhost: GhostPlayer | null = null;
let active: Playable = viewed;
let countdownElapsed = 0;
const camera: Camera = { x: viewed.level.width / 2, y: viewed.level.height / 2 };

// "GO" gets its own step so it's visible for one beat before play begins.
const COUNTDOWN_STEPS = ["3", "2", "1", "GO"];
const COUNTDOWN_STEP_DURATION = 0.8;

function beginRun(playable: Playable): void {
  active = playable;
  session = new GameSession(playable.level);
  pbGhost = playable.personalBest && pbGhostToggle.checked ? new GhostPlayer(playable.level, playable.personalBest) : null;
  leaderboardGhost =
    selectedGhostEntry && selectedGhostEntry.recording.seed === playable.seed
      ? new GhostPlayer(playable.level, selectedGhostEntry.recording)
      : null;
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
    resultsStability.textContent = `Cargo stability at delivery: ${Math.round(session.stability)}%`;

    const previousBest = active.personalBest;
    const recording: GhostRecording = {
      seed: active.seed,
      time: session.elapsed,
      stability: session.stability,
      inputLog: session.inputLog.slice(),
    };
    const isNewBest = savePersonalBestIfBetter(recording);
    if (isNewBest) {
      active.personalBest = recording;
      // No navigation happens mid-run, so `active` is still `viewed` here.
      refreshViewedUi();
    }
    resultsPersonalBest.textContent = !previousBest
      ? "New personal best!"
      : isNewBest
        ? `New personal best! (previous: ${previousBest.time.toFixed(2)}s)`
        : `Personal best: ${previousBest.time.toFixed(2)}s`;

    // Best-effort sync to the shared leaderboard; works offline too since
    // submitScore() swallows network failures and the local PB above is
    // already saved regardless.
    const submittedSeed = active.seed;
    submitScore(submittedSeed, nickname, recording.time, recording.stability, recording.inputLog).then(() => {
      if (submittedSeed === viewed.seed) void refreshLeaderboard();
    });
  } else {
    resultsTitle.textContent = "Cargo fell off!";
    resultsTime.textContent = `Survived ${session.elapsed.toFixed(2)}s`;
    resultsStability.textContent = "Drive smoother and avoid mud and rocks.";
    resultsPersonalBest.textContent = "";
  }
}

/** Leaves a run, countdown, or the results screen (no result is recorded if
 * mid-run) and returns to the start screen. */
function goHome(): void {
  if (appState !== "playing" && appState !== "countdown" && appState !== "ended") return;
  appState = "start";
  session = null;
  pbGhost = null;
  leaderboardGhost = null;
  hud.classList.add("hidden");
  countdownOverlay.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
}

retryBtn.addEventListener("click", () => beginRun(active));
homeBtn.addEventListener("click", goHome);
minimapCanvas.addEventListener("click", () => beginRun(viewed));
minimapCanvas.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    beginRun(viewed);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") goHome();
  if (e.key === "Enter") {
    if (appState === "ended") beginRun(active);
    else if (appState === "start") beginRun(viewed);
  }
  if (e.key === "Backspace" && (appState === "playing" || appState === "countdown")) {
    e.preventDefault(); // Backspace defaults to browser back-navigation.
    beginRun(active);
  }
});

// Physics run on a fixed timestep, independent of render framerate. This is
// what makes ghost replay deterministic: each update() call always advances
// exactly one tick, so replaying the same toggle-tick list drives the exact
// same sequence of physics steps no matter how the real frame timing varied
// between the recording run and any later replay. A variable per-frame dt
// would instead integrate momentum/collisions slightly differently each
// time, and those tiny differences compound into a visibly different route.
const MAX_STEPS_PER_FRAME = 8;
let accumulator = 0;

function renderScene(activeSession: GameSession, frameDt: number): void {
  updateCamera(camera, activeSession.truck, frameDt);
  const ghostViews: GhostView[] = [];
  if (pbGhost) ghostViews.push({ truck: pbGhost.truck, cargoBoxes: pbGhost.cargoBoxes, label: "pb" });
  if (leaderboardGhost) {
    ghostViews.push({
      truck: leaderboardGhost.truck,
      cargoBoxes: leaderboardGhost.cargoBoxes,
      label: selectedGhostEntry?.nickname ?? "ghost",
    });
  }
  renderWorld(
    ctx,
    active.level,
    activeSession.truck,
    activeSession.cargoBoxes,
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
    }
  } else if (appState === "playing" && session) {
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      session.update(FIXED_DT, input.held);
      pbGhost?.update(FIXED_DT);
      leaderboardGhost?.update(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    renderScene(session, frameDt);

    hudTimer.textContent = `${session.elapsed.toFixed(1)}s`;
    hudObjective.textContent = session.allPickedUp
      ? "Deliver to destination"
      : `Pick up cargo (${session.visited.size}/${session.pickups.length})`;

    if (session.status !== "playing") endRun();
  } else {
    accumulator = 0;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
