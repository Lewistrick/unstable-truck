import { generateLevel, generateWeeklyLevel, shiftSeed, todaySeed, weekSeed } from "./level/generate.js";
import { FIXED_DT } from "./physics/constants.js";
import {
  backfillChampionTime,
  fetchChampionTimes,
  fetchLeaderboard,
  fetchPlayerRecording,
  submitScore,
  type LeaderboardEntry,
  type RemoteRecording,
} from "./game/api.js";
import { GhostPlayer, type GhostRecording } from "./game/ghost.js";
import { createInput } from "./game/input.js";
import { renderMinimap, renderWorld, updateCamera, type Camera, type GhostView } from "./game/render.js";
import { GameSession } from "./game/session.js";
import {
  getOrCreateNickname,
  loadCompletedDays,
  loadPersonalBest,
  loadRacePbGhostPref,
  loadSelectedLeaderboardGhost,
  pruneLeaderboardGhosts,
  pruneOldPersonalBests,
  recordCompletion,
  saveRacePbGhostPref,
  savePersonalBestIfBetter,
  saveSelectedLeaderboardGhost,
  setNickname,
} from "./game/storage.js";
import {
  championTime,
  computeMedalPars,
  medalFor,
  MEDAL_ICON,
  MEDAL_LABEL,
  type Medal,
  type MedalPars,
} from "./game/medals.js";
import { getTheme } from "./level/themes.js";
import type { Level } from "./level/types.js";

type Mode = "daily" | "weekly";

interface Playable {
  seed: string;
  level: Level;
  personalBest: GhostRecording | null;
  pars: MedalPars;
}

function makePlayable(seed: string, kind: Mode): Playable {
  const level = kind === "weekly" ? generateWeeklyLevel(seed) : generateLevel(seed);
  return { seed, level, personalBest: loadPersonalBest(seed), pars: computeMedalPars(level) };
}

// Drop any personal bests past their retention age before loading anything.
pruneOldPersonalBests();

const todaysSeed = todaySeed();

// The home screen shows one browsable period at a time in the selected mode:
// a day (daily) or an ISO week (weekly), always anchored to the real calendar
// so seeds never drift based on what's been played. Levels are generated
// lazily and cached per mode so re-visiting doesn't regenerate them.
const MAX_PAST_DAYS = 30;
const MAX_PAST_WEEKS = 52;
// The streak calendar shows only the most recent week of dots (browsing and
// score retention reach back MAX_PAST_DAYS, but 30+ dots would overflow the
// strip and read as noise for an at-a-glance streak).
const STREAK_STRIP_DAYS = 7;
const playableCache: Record<Mode, Map<number, Playable>> = { daily: new Map(), weekly: new Map() };

// Clear out remembered leaderboard-ghost selections for any map that's aged out
// of the browsable window (all currently-browsable daily and weekly seeds are
// "live"), so session storage doesn't accumulate old maps.
const liveSeeds = new Set<string>();
for (let o = -MAX_PAST_DAYS; o <= 0; o++) liveSeeds.add(shiftSeed(todaysSeed, o));
for (let o = -MAX_PAST_WEEKS; o <= 0; o++) liveSeeds.add(weekSeed(o));
pruneLeaderboardGhosts(liveSeeds);

function seedFor(mode: Mode, offset: number): string {
  return mode === "weekly" ? weekSeed(offset) : shiftSeed(todaysSeed, offset);
}

function getPlayable(mode: Mode, offset: number): Playable {
  const cache = playableCache[mode];
  let playable = cache.get(offset);
  if (!playable) {
    playable = makePlayable(seedFor(mode, offset), mode);
    cache.set(offset, playable);
  }
  return playable;
}

function maxPastOffset(mode: Mode): number {
  return mode === "weekly" ? MAX_PAST_WEEKS : MAX_PAST_DAYS;
}

function describeOffset(mode: Mode, offset: number): string {
  if (mode === "weekly") {
    if (offset === 0) return "This week";
    if (offset === -1) return "Last week";
    return `${-offset} weeks ago`;
  }
  if (offset === 0) return "Today";
  if (offset === -1) return "Yesterday";
  return `${-offset} days ago`;
}

/** Formats a run time. Under a minute reads like "42.31s"; a minute or over
 * switches to "m:ss.xx" (e.g. "1:05.30"). */
function formatTime(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
  }
  return `${seconds.toFixed(2)}s`;
}

let mode: Mode = "daily";
let viewedOffset = 0;
let viewed: Playable = getPlayable(mode, 0);

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const minimapCanvas = document.getElementById("minimap-canvas") as HTMLCanvasElement;
const minimapCtx = minimapCanvas.getContext("2d")!;

const startScreen = document.getElementById("start-screen")!;
const resultsScreen = document.getElementById("results-screen")!;
const helpScreen = document.getElementById("help-screen")!;
const helpBtn = document.getElementById("help-btn") as HTMLButtonElement;
const helpCloseBtn = document.getElementById("help-close-btn") as HTMLButtonElement;
const hud = document.getElementById("hud")!;
const menuBtn = document.getElementById("menu-btn") as HTMLButtonElement;
const menuOverlay = document.getElementById("menu-overlay")!;
const menuRestartBtn = document.getElementById("menu-restart") as HTMLButtonElement;
const menuHomeBtn = document.getElementById("menu-home") as HTMLButtonElement;
const viewedDateEl = document.getElementById("viewed-date")!;
const navPrevBtn = document.getElementById("nav-prev-btn") as HTMLButtonElement;
const navNextBtn = document.getElementById("nav-next-btn") as HTMLButtonElement;
const retryBtn = document.getElementById("retry-btn")!;
const homeBtn = document.getElementById("home-btn")!;
const resultsTitle = document.getElementById("results-title")!;
const resultsMedal = document.getElementById("results-medal")!;
const shareBtn = document.getElementById("share-btn") as HTMLButtonElement;
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
const bestShareBtn = document.getElementById("best-share-btn") as HTMLButtonElement;
const nicknameInput = document.getElementById("nickname-input") as HTMLInputElement;
const leaderboardHeaderEl = document.getElementById("leaderboard-header")!;
const leaderboardList = document.getElementById("leaderboard-list")!;
const ghostHint = document.getElementById("ghost-hint")!;
const streakBadge = document.getElementById("streak-badge")!;
const dayDots = document.getElementById("day-dots")!;
const progressStrip = document.getElementById("progress-strip")!;
const modeDailyBtn = document.getElementById("mode-daily") as HTMLButtonElement;
const modeWeeklyBtn = document.getElementById("mode-weekly") as HTMLButtonElement;
const medalTrack = document.getElementById("medal-track")!;

let nickname = getOrCreateNickname();
nicknameInput.value = nickname;
nicknameInput.addEventListener("change", () => {
  setNickname(nicknameInput.value);
  nickname = getOrCreateNickname();
  nicknameInput.value = nickname;
  renderLeaderboardList();
});

// The "race my own ghost" toggle is a global, session-remembered preference,
// so flipping it here carries to every level (and mode) you browse next.
pbGhostToggle.addEventListener("change", () => {
  saveRacePbGhostPref(pbGhostToggle.checked);
});

function refreshViewedUi(): void {
  viewedDateEl.textContent = `${describeOffset(mode, viewedOffset)} · ${viewed.seed} · ${getTheme(viewed.level.theme).name}`;
  viewedBestEl.textContent = viewed.personalBest ? `Best: ${formatTime(viewed.personalBest.time)}` : "Best: -";

  // Sharing the best time is offered only for today, and only once there's a
  // best to share.
  const canShareBest = viewedOffset === 0 && viewed.personalBest != null;
  bestShareBtn.classList.toggle("hidden", !canShareBest);
  if (canShareBest) bestShareBtn.textContent = "Share";
  if (viewed.personalBest) {
    pbGhostToggle.disabled = false;
    // Global, session-remembered preference - the choice follows you between
    // levels and across daily/weekly instead of re-checking on every level.
    pbGhostToggle.checked = loadRacePbGhostPref();
    pbGhostLabel.textContent = `Race personal best ghost (${formatTime(viewed.personalBest.time)})`;
    hudPb.textContent = `PB: ${formatTime(viewed.personalBest.time)}`;
    ghostHint.textContent = "Click any player in the leaderboard to race against their ghost.";
  } else {
    pbGhostToggle.disabled = true;
    pbGhostToggle.checked = false;
    pbGhostLabel.textContent = "No personal best yet";
    hudPb.textContent = "";
    // Racing others' ghosts unlocks only once you've set a time of your own.
    ghostHint.textContent = "Set your own time here first to race other players' ghosts.";
  }

  // Show the level's medal times immediately on navigation; the leaderboard
  // load will refresh the champion tier once it arrives.
  renderMedalTrack();
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

// --- Streak + recent-days calendar -----------------------------------------

/** Consecutive days delivered, counting back from today. Finishing today
 * extends the streak; if today isn't done yet, yesterday's streak still shows
 * (a one-day grace) until the day rolls over. */
function currentStreak(completed: Set<string>): number {
  let streak = 0;
  let offset = completed.has(todaysSeed) ? 0 : -1;
  while (completed.has(shiftSeed(todaysSeed, offset))) {
    streak++;
    offset--;
  }
  return streak;
}

/** Renders the streak badge plus one dot for each of the most recent
 * STREAK_STRIP_DAYS days (oldest on the left, today on the right). Each dot is
 * tinted by the best medal earned that day - gray for none, bronze/silver/gold,
 * and a glowing rose-gold for champion - from the local personal best against
 * that day's pars and the (server-stored) champion threshold. */
function renderProgressStrip(): void {
  const completed = loadCompletedDays();
  const streak = currentStreak(completed);
  streakBadge.textContent = streak > 0 ? `\u{1F525} ${streak}-day streak` : "";

  dayDots.replaceChildren();
  for (let offset = -STREAK_STRIP_DAYS; offset <= 0; offset++) {
    const playable = getPlayable("daily", offset);
    const seed = playable.seed;
    const best = playable.personalBest?.time ?? null;
    const champion = championTimeCache.get(seed) ?? null;
    const medal = best == null ? null : medalFor(best, playable.pars, champion);

    const dot = document.createElement("span");
    dot.className = "day-dot";
    if (medal) {
      dot.classList.add(`medal-${medal}`);
      // Pulse once per mouse-enter. Driven here (not CSS :hover) so the pulse
      // always finishes even if the pointer leaves mid-animation; removing the
      // class on animationend lets it fire again on the next entry.
      dot.addEventListener("mouseenter", () => dot.classList.add("pulsing"));
      dot.addEventListener("animationend", () => dot.classList.remove("pulsing"));
    }
    if (offset === 0) dot.classList.add("today");
    dot.title = medal ? `${seed} - ${MEDAL_LABEL[medal]}` : seed;
    dayDots.appendChild(dot);
  }
}

/** Batch-fetches the champion thresholds for the days shown in the streak strip
 * and, if anything changed, repaints it. Past days are frozen server-side so
 * this mostly settles after the first call; today's can still move as records
 * come in. Best-effort - offline just leaves the champion tint absent. */
async function refreshStripChampionTimes(): Promise<void> {
  const seeds: string[] = [];
  for (let offset = -STREAK_STRIP_DAYS; offset <= 0; offset++) seeds.push(shiftSeed(todaysSeed, offset));
  const times = await fetchChampionTimes(seeds);

  let changed = false;
  for (const [seed, time] of Object.entries(times)) {
    if (championTimeCache.get(seed) !== time) {
      championTimeCache.set(seed, time);
      changed = true;
    }
  }
  if (changed) renderProgressStrip();
}

// --- Leaderboard (for whichever day is currently viewed) -------------------

let leaderboardTop: LeaderboardEntry[] = [];
let leaderboardContext: LeaderboardEntry[] = [];
let selectedGhostEntry: { nickname: string; recording: RemoteRecording } | null = null;

// Champion-medal threshold (finish at or under it to earn champion) for the
// viewed seed, plus a per-seed cache used to colour the streak calendar. The
// server persists and freezes these per period; null means none is set yet.
let viewedChampionTime: number | null = null;
const championTimeCache = new Map<string, number>();

/** Champion threshold for the currently viewed level - the single source of
 * truth for whether a run earns the champion medal here. It's the server's
 * stored (and frozen, once its day/week is over) value; refreshLeaderboard()
 * seeds it from the day's record when the server has none yet. Null when no
 * record beats the gold time, so there's no champion tier. */
function currentChampionTime(): number | null {
  return viewedChampionTime;
}

/** Renders the medal-time "track" for the viewed level: Bronze/Silver/Gold
 * always, plus the Champion tier at the top when it's available. */
function renderMedalTrack(): void {
  const pars = viewed.pars;
  const champion = currentChampionTime();
  const tiers: Array<{ medal: Medal; time: number }> = [];
  if (champion != null) tiers.push({ medal: "champion", time: champion });
  tiers.push({ medal: "gold", time: pars.gold });
  tiers.push({ medal: "silver", time: pars.silver });
  tiers.push({ medal: "bronze", time: pars.bronze });

  medalTrack.replaceChildren();
  for (const { medal, time } of tiers) {
    const row = document.createElement("div");
    row.className = "medal-row";

    const name = document.createElement("span");
    name.className = "medal-name";
    name.textContent = `${MEDAL_ICON[medal]} ${MEDAL_LABEL[medal]}`;

    const t = document.createElement("span");
    t.className = "medal-time";
    t.textContent = formatTime(time);

    row.append(name, t);
    medalTrack.appendChild(row);
  }
}

function renderLeaderboardList(): void {
  leaderboardHeaderEl.textContent = `Leaderboard (${describeOffset(mode, viewedOffset)})`;
  // Champion depends on the leaderboard's #1, so refresh the track alongside.
  renderMedalTrack();
  leaderboardList.replaceChildren();
  if (leaderboardTop.length === 0) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "No times yet - be the first!";
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
    timeEl.textContent = formatTime(entry.time);

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
  // Racing another player's ghost is only available once you've set a time of
  // your own on the viewed level.
  if (!viewed.personalBest) return;
  if (selectedGhostEntry?.nickname === clickedNickname) {
    selectedGhostEntry = null;
    saveSelectedLeaderboardGhost(viewed.seed, null);
    renderLeaderboardList();
    return;
  }
  const recording = await fetchPlayerRecording(viewed.seed, clickedNickname);
  if (recording) {
    selectedGhostEntry = { nickname: clickedNickname, recording };
    saveSelectedLeaderboardGhost(viewed.seed, clickedNickname);
  }
  renderLeaderboardList();
}

/** Re-selects the leaderboard opponent remembered for the viewed seed (if any),
 * re-fetching its recording. Racing another player's ghost requires your own
 * time on the level, matching toggleLeaderboardGhost. Guards against the view
 * having moved on during the async fetch. */
async function restoreSelectedLeaderboardGhost(): Promise<void> {
  const seed = viewed.seed;
  const remembered = loadSelectedLeaderboardGhost(seed);
  if (!remembered || !viewed.personalBest) return;
  const recording = await fetchPlayerRecording(seed, remembered);
  if (recording && viewed.seed === seed) {
    selectedGhostEntry = { nickname: remembered, recording };
    renderLeaderboardList();
  }
}

async function refreshLeaderboard(): Promise<void> {
  const requestedSeed = viewed.seed;
  const gold = viewed.pars.gold;
  const data = await fetchLeaderboard(requestedSeed, nickname);
  // Guard against the view having moved on while the request was in flight.
  if (data && viewed.seed === requestedSeed) {
    leaderboardTop = data.top;
    leaderboardContext = data.context;

    // The champion threshold is the server's stored value. If it has none yet
    // but the day's record already beats gold, derive it from that record and
    // freeze it server-side (backfill), so the champion medal is beatable on
    // this day - including past days from before champion times were stored.
    let champion = data.championTime;
    if (champion == null) {
      const derived = championTime(gold, data.top[0]?.time ?? null);
      if (derived != null) {
        champion = derived;
        void backfillChampionTime(requestedSeed, derived);
      }
    }
    viewedChampionTime = champion;
    if (champion != null) championTimeCache.set(requestedSeed, champion);
  }
  renderLeaderboardList();
}

// --- Period navigation (day or week) ----------------------------------

function updateNavButtons(): void {
  navPrevBtn.disabled = viewedOffset <= -maxPastOffset(mode);
  navNextBtn.disabled = viewedOffset >= 0;
}

/** Re-syncs the whole home view (map, best, ghost toggle, leaderboard) to the
 * currently selected mode + offset. */
function refreshViewedSelection(): void {
  viewed = getPlayable(mode, viewedOffset);
  // A selected ghost is contextual to the exact seed it was fetched for; clear
  // it, then restore whichever opponent was remembered for this seed (if any).
  selectedGhostEntry = null;
  // Seed the champion threshold from cache (frozen past days never change), so
  // the medal track is right immediately; refreshLeaderboard() refines it.
  viewedChampionTime = championTimeCache.get(viewed.seed) ?? null;
  updateNavButtons();
  refreshViewedUi();
  paintViewedTerrainTags();
  renderMinimap(minimapCtx, viewed.level, 0, 0, minimapCanvas.width, minimapCanvas.height);
  void refreshLeaderboard();
  void restoreSelectedLeaderboardGhost();
}

function navigateTo(offset: number): void {
  viewedOffset = Math.max(-maxPastOffset(mode), Math.min(0, offset));
  refreshViewedSelection();
}

function switchMode(newMode: Mode): void {
  if (mode === newMode) return;
  mode = newMode;
  viewedOffset = 0;
  modeDailyBtn.classList.toggle("active", mode === "daily");
  modeWeeklyBtn.classList.toggle("active", mode === "weekly");
  modeDailyBtn.setAttribute("aria-selected", String(mode === "daily"));
  modeWeeklyBtn.setAttribute("aria-selected", String(mode === "weekly"));
  // The streak/calendar strip only applies to daily play.
  progressStrip.classList.toggle("hidden", mode !== "daily");
  if (mode === "daily") {
    renderProgressStrip();
    void refreshStripChampionTimes();
  }
  refreshViewedSelection();
}

navPrevBtn.addEventListener("click", () => navigateTo(viewedOffset - 1));
navNextBtn.addEventListener("click", () => navigateTo(viewedOffset + 1));
modeDailyBtn.addEventListener("click", () => switchMode("daily"));
modeWeeklyBtn.addEventListener("click", () => switchMode("weekly"));

// Swipe navigation over the map thumbnail: swipe right -> previous period,
// swipe left -> next. Pointer events unify mouse-drag (desktop) and touch
// (mobile). A recognised swipe sets `swipeConsumed` so the minimap's tap-to-
// play click (which fires right after pointerup) is skipped for that gesture.
const thumbnailNav = document.getElementById("thumbnail-nav")!;
const SWIPE_THRESHOLD = 45; // px of horizontal travel to count as a swipe
let swipeStartX = 0;
let swipeStartY = 0;
let swipeTracking = false;
let swipeConsumed = false;
thumbnailNav.addEventListener("pointerdown", (e) => {
  swipeStartX = e.clientX;
  swipeStartY = e.clientY;
  swipeTracking = true;
  swipeConsumed = false;
});
// Bound to window so a drag that lifts off the thumbnail still resolves.
window.addEventListener("pointerup", (e) => {
  if (!swipeTracking) return;
  swipeTracking = false;
  const dx = e.clientX - swipeStartX;
  const dy = e.clientY - swipeStartY;
  if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
    swipeConsumed = true;
    navigateTo(viewedOffset + (dx > 0 ? -1 : 1));
  }
});

// -----------------------------------------------------------------------

function resizeCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
// On mobile, showing/hiding the browser toolbar changes the visible viewport
// without always firing a window resize, so also track the visual viewport.
window.visualViewport?.addEventListener("resize", resizeCanvas);
resizeCanvas();

// Initial paint: today (offset 0), same steps navigateTo() would do.
updateNavButtons();
refreshViewedUi();
paintViewedTerrainTags();
renderProgressStrip();
renderMinimap(minimapCtx, viewed.level, 0, 0, minimapCanvas.width, minimapCanvas.height);
void refreshLeaderboard();
void restoreSelectedLeaderboardGhost();
// Pull champion thresholds for the streak strip so its dots can show the
// champion tint, then repaint.
void refreshStripChampionTimes();

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

// --- Medal + share (results screen) ----------------------------------------

let lastShareText: string | null = null;

/** Shows the earned medal (or a "no medal" nudge) plus the time still needed
 * for the next tier up. */
function showMedal(medal: Medal | null, pars: MedalPars, champion: number | null): void {
  resultsMedal.classList.remove("hidden");
  if (!medal) {
    resultsMedal.textContent = `No medal - Bronze under ${formatTime(pars.bronze)}`;
    return;
  }
  let text = `${MEDAL_ICON[medal]} ${MEDAL_LABEL[medal]}!`;
  // Point at the next tier up. Above gold sits champion, but only when it's
  // available (a faster tier actually exists).
  if (medal === "gold" && champion != null) text += ` - Champion under ${formatTime(champion)}`;
  else if (medal === "silver") text += ` - Gold under ${formatTime(pars.gold)}`;
  else if (medal === "bronze") text += ` - Silver under ${formatTime(pars.silver)}`;
  resultsMedal.textContent = text;
}

/** Public URL used in share text when the game is opened from a real site,
 * hosted address (not localhost or a bare file). */
const FALLBACK_GAME_URL = "https://lewistrick.com/unstable-truck";

/** The link to include in shared results: the page's own address when it's a
 * hosted http(s) URL (sub-path deploys included, minus any query/hash), or the
 * canonical public URL for local/dev contexts where the address isn't
 * shareable. */
function gameUrl(): string {
  const { protocol, hostname, origin, pathname } = window.location;
  const hosted =
    (protocol === "https:" || protocol === "http:") &&
    hostname !== "" &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1";
  return hosted ? origin + pathname : FALLBACK_GAME_URL;
}

/** Spoiler-free result summary for the clipboard - no route/map details, just
 * the day, finish time, earned medal, and a link to play. */
function buildShareText(playable: Playable, time: number, medal: Medal | null): string {
  const medalEmoji = medal ? ` ${MEDAL_ICON[medal]}` : "";
  return [
    `\u{1F69A} Unstable Truck - ${playable.seed}`,
    `I finished in a time of ${formatTime(time)}${medalEmoji}`,
    "Can you beat my time? #unstabletruck",
    gameUrl(),
  ].join("\n");
}

/** Spoiler-free summary of the currently-viewed day's stored best time, or
 * null if there isn't one. Used by the home-screen "Best time" Share button. */
function currentBestShareText(): string | null {
  const best = viewed.personalBest;
  if (!best) return null;
  return buildShareText(viewed, best.time, medalFor(best.time, viewed.pars));
}

/** Wires a Share button to copy text (from `getText`) on click, flashing a
 * transient "Copied!"/"Copy failed" label before reverting to "Share". */
function attachShareHandler(btn: HTMLButtonElement, getText: () => string | null): void {
  let resetTimer: number | undefined;
  btn.addEventListener("click", async () => {
    const text = getText();
    if (!text) return;
    const ok = await copyText(text);
    btn.textContent = ok ? "Copied!" : "Copy failed";
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      btn.textContent = "Share";
    }, 1600);
  });
}

/** Copies text to the clipboard, falling back to a hidden-textarea + execCommand
 * for contexts without the async clipboard API. Returns whether it worked. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

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
  setMenuOpen(false);
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
    resultsTime.textContent = `Time: ${formatTime(session.elapsed)}`;
    resultsStability.textContent = `Cargo stability at delivery: ${Math.round(session.stability)}%`;

    // The champion reference is the leaderboard's current #1 (as last loaded,
    // i.e. the record being chased, not this just-finished run).
    const champion = currentChampionTime();
    const medal = medalFor(session.elapsed, active.pars, champion);
    showMedal(medal, active.pars, champion);

    // Mark the day delivered (drives the streak + calendar) before building
    // the share text, so a fresh completion is reflected in the streak count.
    // The streak is a daily-play concept only.
    if (active.level.kind === "daily") {
      recordCompletion(active.seed);
      renderProgressStrip();
    }
    lastShareText = buildShareText(active, session.elapsed, medal);
    shareBtn.textContent = "Share";
    shareBtn.classList.remove("hidden");

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
        ? `New personal best! (previous: ${formatTime(previousBest.time)})`
        : `Personal best: ${formatTime(previousBest.time)}`;

    // Best-effort sync to the shared leaderboard; works offline too since
    // submitScore() swallows network failures and the local PB above is
    // already saved regardless. The champion candidate this run implies
    // (null if slower than gold) lets the server lower the seed's champion
    // threshold, but only for the player's current day/week so past maps stay
    // frozen.
    const submittedSeed = active.seed;
    const championCandidate = championTime(active.pars.gold, recording.time);
    const isCurrentPeriod =
      active.level.kind === "weekly" ? submittedSeed === weekSeed(0) : submittedSeed === todaysSeed;
    submitScore(
      submittedSeed,
      nickname,
      recording.time,
      recording.stability,
      recording.inputLog,
      championCandidate,
      isCurrentPeriod,
    ).then(() => {
      if (submittedSeed === viewed.seed) void refreshLeaderboard();
      // A new record today can lower the champion threshold; refresh the strip
      // so the day's dot recolours (the player may gain or lose champion).
      if (active.level.kind === "daily") void refreshStripChampionTimes();
    });
  } else {
    resultsTitle.textContent = "Cargo fell off!";
    resultsTime.textContent = `Survived ${formatTime(session.elapsed)}`;
    resultsStability.textContent = "Drive smoother and avoid mud and rocks.";
    resultsPersonalBest.textContent = "";
    resultsMedal.classList.add("hidden");
    shareBtn.classList.add("hidden");
    lastShareText = null;
  }
}

/** Leaves a run, countdown, or the results screen (no result is recorded if
 * mid-run) and returns to the start screen. */
function goHome(): void {
  if (appState !== "playing" && appState !== "countdown" && appState !== "ended") return;
  appState = "start";
  setMenuOpen(false);
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

// In-run hamburger menu: gives touch devices the Restart/Home that desktop
// gets from Backspace/Esc. Lives inside #hud, so it's only present during a run.
function setMenuOpen(open: boolean): void {
  menuOverlay.classList.toggle("hidden", !open);
  menuBtn.setAttribute("aria-expanded", String(open));
}
menuBtn.addEventListener("click", () => setMenuOpen(menuOverlay.classList.contains("hidden")));
menuRestartBtn.addEventListener("click", () => {
  setMenuOpen(false);
  beginRun(active);
});
menuHomeBtn.addEventListener("click", () => {
  setMenuOpen(false);
  goHome();
});
// Steering (a press on the canvas) dismisses an open menu.
canvas.addEventListener("pointerdown", () => setMenuOpen(false));

// Help overlay, opened from the home screen. Shows a brief summary by default,
// with a toggle to reveal the full guide.
const helpSummary = document.getElementById("help-summary")!;
const helpFull = document.getElementById("help-full")!;
const helpDetailCheckbox = document.getElementById("help-detail-checkbox") as HTMLInputElement;
let helpOpen = false;

// The switch is off (unchecked) for the summary, on for the full guide; only
// one body is shown at a time.
function setHelpDetail(showFull: boolean): void {
  helpSummary.classList.toggle("hidden", showFull);
  helpFull.classList.toggle("hidden", !showFull);
  helpDetailCheckbox.checked = showFull;
}
helpDetailCheckbox.addEventListener("change", () => setHelpDetail(helpDetailCheckbox.checked));

function openHelp(): void {
  helpOpen = true;
  setHelpDetail(false); // always reopen on the summary
  helpScreen.classList.remove("hidden");
}
function closeHelp(): void {
  helpOpen = false;
  helpScreen.classList.add("hidden");
}
helpBtn.addEventListener("click", openHelp);
helpCloseBtn.addEventListener("click", closeHelp);
// Tapping the dimmed backdrop (outside the panel) closes it.
helpScreen.addEventListener("click", (e) => {
  if (e.target === helpScreen) closeHelp();
});

attachShareHandler(shareBtn, () => lastShareText);
attachShareHandler(bestShareBtn, currentBestShareText);
minimapCanvas.addEventListener("click", () => {
  // A swipe gesture ends in a synthetic click on the map; don't treat it as
  // tap-to-play.
  if (swipeConsumed) {
    swipeConsumed = false;
    return;
  }
  beginRun(viewed);
});
minimapCanvas.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    beginRun(viewed);
  }
});

window.addEventListener("keydown", (e) => {
  // While the help overlay is up it captures Escape (to close itself) and
  // swallows the other run controls.
  if (helpOpen) {
    if (e.key === "Escape") closeHelp();
    return;
  }
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
      hudTimer.textContent = formatTime(0);
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

    hudTimer.textContent = formatTime(session.elapsed);
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
