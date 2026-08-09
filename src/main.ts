import { generateLevel, generateWeeklyLevel, shiftSeed, todaySeed, weekSeed } from "./level/generate.js";
import { resolveSeedTarget } from "./level/seed-target.js";
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
import { GhostPlayer, ghostCollectTicks, splitDelta, type GhostRecording } from "./game/ghost.js";
import { createInput } from "./game/input.js";
import { renderMinimap, renderReplayWorld, renderWorld, updateCamera, type Camera, type GhostView } from "./game/render.js";
import { GameSession } from "./game/session.js";
import { Tutorial } from "./game/tutorial.js";
import { MAX_REPLAY_RACERS, REPLAY_COLORS, ReplayTheater, type ReplayRacer } from "./game/replay.js";
import type { TruckState } from "./physics/truck.js";
import {
  getOrCreateNickname,
  hasSeenTutorial,
  loadCompletedDays,
  loadPersonalBest,
  markTutorialSeen,
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
  /** True for a shared-link seed that isn't a live daily/weekly period (expired
   * or non-standard): the map is playable, but it has no global leaderboard, so
   * ranking, ghost-racing others, and score submission are all disabled. */
  orphan?: boolean;
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

/** Syncs the Daily/Weekly toggle buttons and the streak strip's visibility to
 * the current `mode`. */
function setModeVisuals(): void {
  modeDailyBtn.classList.toggle("active", mode === "daily");
  modeWeeklyBtn.classList.toggle("active", mode === "weekly");
  modeDailyBtn.setAttribute("aria-selected", String(mode === "daily"));
  modeWeeklyBtn.setAttribute("aria-selected", String(mode === "weekly"));
  // The streak/calendar strip only applies to live daily play.
  progressStrip.classList.toggle("hidden", mode !== "daily");
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
const tutorialBtn = document.getElementById("tutorial-btn") as HTMLButtonElement;
const tutorialOverlay = document.getElementById("tutorial-overlay")!;
const tutorialPrompt = document.getElementById("tutorial-prompt")!;
const tutorialSkipBtn = document.getElementById("tutorial-skip-btn") as HTMLButtonElement;
const tutorialSkipSectionBtn = document.getElementById("tutorial-skip-section-btn") as HTMLButtonElement;
const tutorialDoneBtn = document.getElementById("tutorial-done-btn") as HTMLButtonElement;
const watchBtn = document.getElementById("watch-btn") as HTMLButtonElement;
const replayControls = document.getElementById("replay-controls")!;
const replaySelectBar = document.getElementById("replay-select-bar")!;
const replaySelectCount = document.getElementById("replay-select-count")!;
const replayCancelBtn = document.getElementById("replay-cancel-btn") as HTMLButtonElement;
const replayStartBtn = document.getElementById("replay-start-btn") as HTMLButtonElement;
const replayOverlay = document.getElementById("replay-overlay")!;
const replayPlayBtn = document.getElementById("replay-play-btn") as HTMLButtonElement;
const replayTimeEl = document.getElementById("replay-time")!;
const replayProgress = document.getElementById("replay-progress") as HTMLInputElement;
const replayStopBtn = document.getElementById("replay-stop-btn") as HTMLButtonElement;
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
const hudTimer = document.getElementById("hud-timer") as HTMLButtonElement;
const pauseIndicator = document.getElementById("pause-indicator")!;
const hudDelta = document.getElementById("hud-delta")!;
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
  const periodLabel = viewed.orphan ? "Shared map" : describeOffset(mode, viewedOffset);
  viewedDateEl.textContent = `${periodLabel} · ${viewed.seed} · ${getTheme(viewed.level.theme).name}`;
  viewedBestEl.textContent = viewed.personalBest ? `Best: ${formatTime(viewed.personalBest.time)}` : "Best: -";

  // Sharing the best time is offered only for today, and only once there's a
  // best to share (never on a shared orphan map, which has no leaderboard).
  const canShareBest = !viewed.orphan && viewedOffset === 0 && viewed.personalBest != null;
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

  // "Watch a replay" unlocks with the same personal-best gate as ghost racing.
  updateWatchButton();
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
// Total ranked players for the viewed seed (the field a rank is "out of"), or
// null when the server didn't report it (offline, or an older server).
let leaderboardTotal: number | null = null;
let selectedGhostEntry: { nickname: string; recording: RemoteRecording } | null = null;

/** The player's world rank for the currently-loaded leaderboard (seed = the
 * viewed seed), read from the top-10 or the rank-context window, or null when
 * they're unranked here or the field size is unknown. */
function myWorldRank(): { rank: number; total: number } | null {
  if (leaderboardTotal == null) return null;
  const mine = [...leaderboardTop, ...leaderboardContext].find((e) => e.nickname === nickname);
  return mine ? { rank: mine.rank, total: leaderboardTotal } : null;
}

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
  // A shared orphan map has no leaderboard; keep its notice instead of painting
  // rows (still refresh the medal track, which is derived from the level).
  if (viewed.orphan) {
    renderMedalTrack();
    renderOrphanNotice();
    return;
  }
  leaderboardHeaderEl.textContent = watchMode
    ? `Pick racers (${describeOffset(mode, viewedOffset)})`
    : `Leaderboard (${describeOffset(mode, viewedOffset)})`;
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

  // In watch mode, rows once the 1-5 cap is hit (and not already picked) are
  // inert until something is deselected.
  const capReached = watchSelection.size >= MAX_REPLAY_RACERS;
  for (const entry of [...leaderboardTop, ...leaderboardContext]) {
    const li = document.createElement("li");
    li.className = "leaderboard-row";
    if (entry.nickname === nickname) li.classList.add("self");

    const picked = watchSelection.has(entry.nickname);
    if (watchMode) {
      if (picked) li.classList.add("picked");
      else if (capReached) li.classList.add("pick-disabled");
      const check = document.createElement("span");
      check.className = "leaderboard-check";
      check.textContent = picked ? "✓" : "";
      li.appendChild(check);
    } else if (selectedGhostEntry?.nickname === entry.nickname) {
      li.classList.add("selected");
    }

    const rankEl = document.createElement("span");
    rankEl.className = "leaderboard-rank";
    rankEl.textContent = String(entry.rank);

    const nameEl = document.createElement("span");
    nameEl.className = "leaderboard-nickname";
    nameEl.textContent =
      !watchMode && selectedGhostEntry?.nickname === entry.nickname ? `\u{1F4F7} ${entry.nickname}` : entry.nickname;

    const timeEl = document.createElement("span");
    timeEl.className = "leaderboard-time";
    timeEl.textContent = formatTime(entry.time);

    li.append(rankEl, nameEl, timeEl);
    li.addEventListener("click", () => {
      if (watchMode) toggleWatchPick(entry.nickname);
      else void toggleLeaderboardGhost(entry.nickname);
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
    leaderboardTotal = typeof data.total === "number" ? data.total : null;

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
  // A shared orphan map isn't part of the browsable day/week timeline, so there's
  // nowhere to step to - use the Daily/Weekly toggle to return to a live period.
  if (viewed.orphan) {
    navPrevBtn.disabled = true;
    navNextBtn.disabled = true;
    return;
  }
  navPrevBtn.disabled = viewedOffset <= -maxPastOffset(mode);
  navNextBtn.disabled = viewedOffset >= 0;
}

/** Re-syncs the whole home view (map, best, ghost toggle, leaderboard) to the
 * currently selected mode + offset. Also leaves any shared "orphan" seed view,
 * since a mode/offset selection is always a live period. */
function refreshViewedSelection(): void {
  viewed = getPlayable(mode, viewedOffset);
  // A live period has a leaderboard + streak strip again; restore the chrome
  // that showOrphanSeed() hides.
  replayControls.classList.remove("hidden");
  setModeVisuals();
  // Changing level cancels any in-progress replay-racer picking.
  exitWatchMode();
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
  // Re-selecting the current mode is normally a no-op, but from a shared orphan
  // seed it's the way back to the live period, so allow it in that case.
  if (mode === newMode && !viewed.orphan) return;
  mode = newMode;
  viewedOffset = 0;
  setModeVisuals();
  if (mode === "daily") {
    renderProgressStrip();
    void refreshStripChampionTimes();
  }
  refreshViewedSelection();
}

/** Shows a shared "orphan" seed - a generated map with no live leaderboard.
 * Playable (including racing your own local PB ghost), but ranking, others'
 * ghosts, replays, and score submission are all off, with a short notice in
 * place of the leaderboard. */
function showOrphanSeed(seed: string, genMode: Mode): void {
  mode = genMode;
  setModeVisuals();
  progressStrip.classList.add("hidden"); // no streak strip for a one-off map
  viewed = { ...makePlayable(seed, genMode), orphan: true };
  exitWatchMode();
  selectedGhostEntry = null;
  viewedChampionTime = null;
  leaderboardTop = [];
  leaderboardContext = [];
  leaderboardTotal = null;
  updateNavButtons();
  refreshViewedUi();
  paintViewedTerrainTags();
  renderMinimap(minimapCtx, viewed.level, 0, 0, minimapCanvas.width, minimapCanvas.height);
  ghostHint.textContent = "This is a shared map - global leaderboards aren't available for it.";
  renderOrphanNotice();
}

/** Replaces the leaderboard with a short "no leaderboard here" notice for a
 * shared orphan map, and hides the controls that need a leaderboard (racing
 * others' ghosts, watching replays). */
function renderOrphanNotice(): void {
  replayControls.classList.add("hidden");
  leaderboardHeaderEl.textContent = "Shared map";
  leaderboardList.replaceChildren();
  const li = document.createElement("li");
  li.className = "leaderboard-empty";
  li.textContent = "Leaderboards aren't available for this map.";
  leaderboardList.appendChild(li);
}

/** Routes a `?s=` shared-link seed to its level: the matching live daily/weekly
 * period when it's still in the browsable window, otherwise a generated orphan
 * map. */
function openSharedSeed(seed: string): void {
  const target = resolveSeedTarget(seed, MAX_PAST_DAYS, MAX_PAST_WEEKS);
  if (target.kind === "live") {
    mode = target.mode;
    viewedOffset = target.offset;
    if (mode === "daily") {
      renderProgressStrip();
      void refreshStripChampionTimes();
    }
    refreshViewedSelection();
    return;
  }
  showOrphanSeed(seed, target.mode);
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
  // A shared orphan map isn't on the day/week timeline, so swiping does nothing
  // (the Daily/Weekly toggle is the way back to a live period).
  if (viewed.orphan) return;
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

// Prepare the streak strip up front so it's ready whenever daily play is shown
// (a shared weekly/orphan link keeps it hidden until the user switches to daily).
renderProgressStrip();
// Pull champion thresholds for the streak strip so its dots can show the
// champion tint, then repaint.
void refreshStripChampionTimes();
// The initial home-screen paint / `?s=` deep-link resolution runs below, once
// the run-state `let`s it touches (watchMode, active, camera) are declared.

const input = createInput(canvas);

type AppState = "start" | "countdown" | "playing" | "ended" | "tutorial" | "replay";
let appState: AppState = "start";
let session: GameSession | null = null;
let tutorial: Tutorial | null = null;
// When paused, the playing branch of the frame loop stops advancing physics,
// ghosts, and the clock - the frozen frame keeps rendering and a "Paused"
// banner shows near the top. Only meaningful during `playing`.
let paused = false;

/** Freezes or resumes an in-progress run, syncing the bottom timer button
 * (which doubles as the pause control) and the top "Paused" banner. */
function setPaused(next: boolean): void {
  paused = next;
  pauseIndicator.classList.toggle("hidden", !paused);
  hudTimer.classList.toggle("paused", paused);
  hudTimer.setAttribute("aria-pressed", String(paused));
  hudTimer.setAttribute("aria-label", paused ? "Resume" : "Pause");
  hudTimer.title = paused ? "Resume" : "Pause";
}

// The timer at the bottom is the pause/resume control. A native <button> so a
// tap (mobile) or Enter/Space (keyboard) works; only toggles during live play.
hudTimer.addEventListener("click", () => {
  if (appState !== "playing") return;
  setPaused(!paused);
  // Space is the steering key; drop focus so it doesn't also re-toggle this
  // button once it's been clicked/tapped.
  hudTimer.blur();
});

// --- Replay theater state --------------------------------------------------
// "Watch" mode turns the leaderboard into a 1-5 racer picker; starting a replay
// plays those recordings back together, non-interactively, on their own screen.
let watchMode = false;
const watchSelection = new Set<string>();
let replay: ReplayTheater | null = null;
let replayLevel: Level | null = null;
// The replay's own fit-all camera (kept separate from the live-play camera).
const replayCamera: Camera = { x: 0, y: 0 };
let replayZoom = 1;
// Progress-bar scrubbing: pause while dragging, resume after if it was playing.
let replayScrubbing = false;
let replayResumeAfterScrub = false;
let pbGhost: GhostPlayer | null = null;
let leaderboardGhost: GhostPlayer | null = null;
// The collection ticks of the ghost the live split time is measured against
// (the pb ghost when it's racing, else the leaderboard ghost), or null when no
// ghost is raced. Precomputed once per run.
let referenceCollectTicks: number[] | null = null;
let active: Playable = viewed;
let countdownElapsed = 0;
const camera: Camera = { x: viewed.level.width / 2, y: viewed.level.height / 2 };

// A `?s=<seed>` deep link opens that exact map (the matching live day/week, or a
// generated orphan when it's expired/non-standard); otherwise start on today.
// This runs here - after the run-state let-bindings above - because the render
// helpers it calls (via exitWatchMode/refreshViewedSelection) read them.
const sharedSeed = new URLSearchParams(window.location.search).get("s")?.trim();
if (sharedSeed) {
  openSharedSeed(sharedSeed);
} else {
  // Initial paint: today (offset 0), same steps navigateTo() would do.
  updateNavButtons();
  refreshViewedUi();
  paintViewedTerrainTags();
  renderMinimap(minimapCtx, viewed.level, 0, 0, minimapCanvas.width, minimapCanvas.height);
  void refreshLeaderboard();
  void restoreSelectedLeaderboardGhost();
}

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

/** The share link for a seed: the base game URL plus `?s=<seed>`, so opening it
 * drops the recipient straight onto that day's/week's map. */
function shareLinkFor(seed: string): string {
  return `${gameUrl()}?s=${encodeURIComponent(seed)}`;
}

/** Spoiler-free result summary for the clipboard - no route/map details, just
 * the board (Daily/Weekly), the seed, finish time, earned medal, world rank (when
 * known), and a deep link back to that exact map. */
function buildShareText(
  playable: Playable,
  time: number,
  medal: Medal | null,
  rank: { rank: number; total: number } | null,
): string {
  const medalEmoji = medal ? ` ${MEDAL_ICON[medal]}` : "";
  const board = playable.level.kind === "weekly" ? "Weekly" : "Daily";
  const lines = [
    `\u{1F69A} Unstable Truck ${board} - ${playable.seed}`,
    `I finished in a time of ${formatTime(time)}${medalEmoji}`,
  ];
  if (rank) lines.push(`Ranked #${rank.rank} in the world`);
  lines.push("Can you beat my time? #unstabletruck", shareLinkFor(playable.seed));
  return lines.join("\n");
}

/** Spoiler-free summary of the currently-viewed day's stored best time, or
 * null if there isn't one. Used by the home-screen "Best time" Share button. */
function currentBestShareText(): string | null {
  const best = viewed.personalBest;
  if (!best) return null;
  return buildShareText(viewed, best.time, medalFor(best.time, viewed.pars), myWorldRank());
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

  // Live split time is measured against the pb ghost whenever it's racing (even
  // alongside a leaderboard ghost); otherwise the leaderboard ghost if that's
  // the only one. Precompute that ghost's per-checkpoint collection ticks.
  const referenceRecording: GhostRecording | RemoteRecording | null =
    pbGhost && playable.personalBest
      ? playable.personalBest
      : leaderboardGhost && selectedGhostEntry
        ? selectedGhostEntry.recording
        : null;
  referenceCollectTicks = referenceRecording ? ghostCollectTicks(playable.level, referenceRecording) : null;
  hudDelta.textContent = "";
  hudDelta.className = "";
  camera.x = session.truck.pos.x;
  camera.y = session.truck.pos.y;
  countdownElapsed = 0;
  appState = "countdown";
  setPaused(false);
  setMenuOpen(false);
  startScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  hud.classList.remove("hidden");
  countdownOverlay.classList.remove("hidden");
}

function endRun(): void {
  if (!session) return;
  appState = "ended";
  setPaused(false);
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
    // The streak is a live daily-play concept only (never a shared orphan map).
    if (active.level.kind === "daily" && !active.orphan) {
      recordCompletion(active.seed);
      renderProgressStrip();
    }
    // Capture run details so the async leaderboard callback below can fold the
    // world rank into the share text without racing a later navigation/retry.
    const sharePlayable = active;
    const shareTime = session.elapsed;
    // Seed the share text now (no rank yet, and none at all on an orphan map);
    // it's rebuilt with the world rank once the leaderboard reload lands.
    lastShareText = buildShareText(sharePlayable, shareTime, medal, null);
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

    // A shared orphan map has no live leaderboard, so there's nothing to submit
    // to or rank against - the local PB above is all that's kept.
    if (!active.orphan) {
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
      ).then(async () => {
        if (submittedSeed === viewed.seed) {
          await refreshLeaderboard();
          // The board now reflects this run, so the player's world rank is
          // final - fold it into the share text (a no-op if they're unranked).
          lastShareText = buildShareText(sharePlayable, shareTime, medal, myWorldRank());
        }
        // A new record today can lower the champion threshold; refresh the strip
        // so the day's dot recolours (the player may gain or lose champion).
        if (active.level.kind === "daily") void refreshStripChampionTimes();
      });
    }
  } else if (session.failReason === "outOfBounds") {
    resultsTitle.textContent = "Hey, come back!";
    resultsTime.textContent = `Survived ${formatTime(session.elapsed)}`;
    resultsStability.textContent = "You're trying to steal my truck, aren't you?";
    resultsPersonalBest.textContent = "";
    resultsMedal.classList.add("hidden");
    shareBtn.classList.add("hidden");
    lastShareText = null;
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
  setPaused(false);
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

// --- New-player tutorial ---------------------------------------------------
// A short, guided practice run on a fixed, unfailable level. It reuses the
// normal render loop (via `active` + renderScene) but shows its own coach
// overlay instead of the HUD, and never touches scores, ghosts, or storage
// beyond marking itself seen on exit.

// The active tutorial scene's truck; when this object reference changes (a new
// section, a rock-reset, or the drive->terrain hand-off) the camera snaps to it
// instead of panning across empty ground.
let lastTutorialTruck: TruckState | null = null;

/** Syncs the coach overlay (prompt + buttons) to the tutorial's current stage. */
function refreshTutorialOverlay(): void {
  if (!tutorial) return;
  tutorialPrompt.textContent = tutorial.prompt;
  const done = tutorial.isDone;
  // Once finished, "Let's go!" replaces "Skip tutorial" (they'd do the same
  // thing, so only one shows). Per-section skip only during the terrain course.
  tutorialDoneBtn.classList.toggle("hidden", !done);
  tutorialSkipBtn.classList.toggle("hidden", done);
  tutorialSkipSectionBtn.classList.toggle("hidden", !tutorial.canSkipSection);
}

/** Enters the tutorial from the start screen: a fresh guided run with the coach
 * overlay up. Rendering is driven directly from the Tutorial (see the frame
 * loop), so it doesn't touch the normal run's render state or ghosts. */
function startTutorial(): void {
  tutorial = new Tutorial();
  lastTutorialTruck = null;
  camera.x = tutorial.activeTruck.pos.x;
  camera.y = tutorial.activeTruck.pos.y;
  accumulator = 0;
  appState = "tutorial";

  startScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  hud.classList.add("hidden");
  countdownOverlay.classList.add("hidden");
  tutorialOverlay.classList.remove("hidden");
  refreshTutorialOverlay();
}

/** Leaves the tutorial (completed or skipped) back to the start screen, marking
 * it seen so it won't auto-open again. */
function endTutorial(): void {
  if (appState !== "tutorial") return;
  markTutorialSeen();
  tutorial = null;
  appState = "start";
  tutorialOverlay.classList.add("hidden");
  startScreen.classList.remove("hidden");
}

tutorialBtn.addEventListener("click", startTutorial);
tutorialSkipBtn.addEventListener("click", endTutorial);
tutorialDoneBtn.addEventListener("click", endTutorial);
tutorialSkipSectionBtn.addEventListener("click", () => {
  tutorial?.skipSection();
  refreshTutorialOverlay();
});

// --- Replay theater --------------------------------------------------------
// Pick 1-5 leaderboard players and watch their ghosts race each other, with a
// video-style player (play/pause, a seekable progress bar, and stop). Like
// racing a ghost, it needs your own time on the level first.

/** Enables the "Watch a replay" button only once there's a personal best on the
 * viewed level (same gate as racing a ghost). */
function updateWatchButton(): void {
  const unlocked = viewed.personalBest != null;
  watchBtn.disabled = !unlocked;
  watchBtn.title = unlocked ? "" : "Set your own time here first to watch replays.";
}

function updateWatchBar(): void {
  const n = watchSelection.size;
  replaySelectCount.textContent = `Pick 1–5 racers (${n}/${MAX_REPLAY_RACERS})`;
  replayStartBtn.textContent = `Watch (${n})`;
  replayStartBtn.disabled = n < 1;
}

function enterWatchMode(): void {
  if (viewed.personalBest == null) return; // gated, mirrors the button state
  watchMode = true;
  watchSelection.clear();
  watchBtn.classList.add("hidden");
  replaySelectBar.classList.remove("hidden");
  updateWatchBar();
  renderLeaderboardList();
}

function exitWatchMode(): void {
  if (!watchMode) return;
  watchMode = false;
  watchSelection.clear();
  replaySelectBar.classList.add("hidden");
  watchBtn.classList.remove("hidden");
  renderLeaderboardList();
}

/** Toggles a player into/out of the replay selection, capped at 5. */
function toggleWatchPick(nickname: string): void {
  if (watchSelection.has(nickname)) {
    watchSelection.delete(nickname);
  } else {
    if (watchSelection.size >= MAX_REPLAY_RACERS) return;
    watchSelection.add(nickname);
  }
  updateWatchBar();
  renderLeaderboardList();
}

/** Fetches the selected players' recordings and opens the replay theater. */
async function startReplay(): Promise<void> {
  const seed = viewed.seed;
  const level = viewed.level;
  const nicknames = [...watchSelection];
  if (nicknames.length === 0) return;

  replayStartBtn.disabled = true;
  replayStartBtn.textContent = "Loading…";
  const recordings = await Promise.all(nicknames.map((n) => fetchPlayerRecording(seed, n)));

  const racers: ReplayRacer[] = [];
  recordings.forEach((rec, i) => {
    if (rec) racers.push({ label: nicknames[i]!, color: REPLAY_COLORS[racers.length]!, recording: rec });
  });
  if (racers.length === 0) {
    // Offline or the recordings couldn't be fetched; stay in pick mode.
    replaySelectCount.textContent = "Couldn't load those replays - try again.";
    updateWatchBar();
    return;
  }

  replay = new ReplayTheater(level, racers);
  replayLevel = level;
  replayProgress.max = String(replay.totalTicks);
  replayProgress.value = "0";
  replayScrubbing = false;
  accumulator = 0;
  exitWatchMode();

  appState = "replay";
  startScreen.classList.add("hidden");
  replayOverlay.classList.remove("hidden");
  updateReplayCamera(0, true); // frame all racers at the start line
  replay.play();
  updateReplayControls();
}

/** Leaves the replay theater back to the main menu. */
function stopReplay(): void {
  if (appState !== "replay") return;
  replay = null;
  replayLevel = null;
  appState = "start";
  replayOverlay.classList.add("hidden");
  startScreen.classList.remove("hidden");
}

/** Fits the camera to the pack of racers (centre + zoom), never zooming in past
 * 1:1. Snaps instantly on seek, else eases for smooth playback. */
function updateReplayCamera(frameDt: number, snap: boolean): void {
  if (!replay) return;
  const views = replay.views();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const view of views) {
    minX = Math.min(minX, view.truck.pos.x);
    maxX = Math.max(maxX, view.truck.pos.x);
    minY = Math.min(minY, view.truck.pos.y);
    maxY = Math.max(maxY, view.truck.pos.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const pad = 320; // world-unit breathing room around the pack
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const targetZoom = Math.min(1, cw / (maxX - minX + pad), ch / (maxY - minY + pad));

  if (snap) {
    replayCamera.x = cx;
    replayCamera.y = cy;
    replayZoom = targetZoom;
    return;
  }
  const k = Math.min(1, 4.5 * frameDt);
  replayCamera.x += (cx - replayCamera.x) * k;
  replayCamera.y += (cy - replayCamera.y) * k;
  replayZoom += (targetZoom - replayZoom) * k;
}

/** Formats seconds as m:ss for the player's time readout. */
function fmtClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateReplayControls(): void {
  if (!replay) return;
  replayPlayBtn.textContent = replay.playing ? "⏸" : "▶"; // ⏸ / ▶
  replayTimeEl.textContent = `${fmtClock(replay.elapsed)} / ${fmtClock(replay.duration)}`;
  // Don't fight the user's drag: only mirror the tick into the bar when idle.
  if (!replayScrubbing) replayProgress.value = String(replay.tick);
}

watchBtn.addEventListener("click", enterWatchMode);
replayCancelBtn.addEventListener("click", exitWatchMode);
replayStartBtn.addEventListener("click", () => {
  void startReplay();
});
replayStopBtn.addEventListener("click", stopReplay);
replayPlayBtn.addEventListener("click", () => {
  replay?.togglePlay();
  updateReplayControls();
});
replayProgress.addEventListener("pointerdown", () => {
  if (!replay) return;
  replayScrubbing = true;
  replayResumeAfterScrub = replay.playing;
  replay.pause();
});
replayProgress.addEventListener("input", () => {
  if (!replay) return;
  replay.seekTo(Number(replayProgress.value));
  updateReplayCamera(0, true);
  updateReplayControls();
});
window.addEventListener("pointerup", () => {
  if (!replayScrubbing) return;
  replayScrubbing = false;
  if (replay && replayResumeAfterScrub && !replay.atEnd) replay.play();
});

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
  // The tutorial owns its input: Escape skips it, and the normal run controls
  // (Enter/Backspace) are inert while it's up. Spacebar still steers via input.ts.
  if (appState === "tutorial") {
    if (e.key === "Escape") endTutorial();
    return;
  }
  // The replay theater: Escape stops (back to menu), Space toggles play/pause.
  if (appState === "replay") {
    if (e.key === "Escape") stopReplay();
    else if (e.code === "Space") {
      e.preventDefault();
      replay?.togglePlay();
      updateReplayControls();
    }
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

/** Refreshes the split-time readout under the timer: the difference to the
 * raced ghost at the player's latest checkpoint. Green (with a minus sign) when
 * ahead or tied, red (with a plus sign) when behind; blank until there's a
 * ghost and a reached checkpoint. */
function updateSplitDelta(): void {
  if (!session || !referenceCollectTicks) {
    hudDelta.textContent = "";
    hudDelta.className = "";
    return;
  }
  const delta = splitDelta(session.collectTicks, referenceCollectTicks, FIXED_DT);
  if (delta === null) {
    hudDelta.textContent = "";
    hudDelta.className = "";
    return;
  }
  const ahead = delta <= 0;
  const sign = delta < 0 ? "-" : delta > 0 ? "+" : "";
  hudDelta.textContent = `${sign}${Math.abs(delta).toFixed(2)}s`;
  hudDelta.className = ahead ? "ahead" : "behind";
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
    // Paused freezes everything - truck, ghosts, and the clock - by skipping the
    // physics steps entirely; the scene still re-renders (frozen) each frame.
    if (!paused) {
      accumulator += frameDt;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        session.update(FIXED_DT, input.held);
        pbGhost?.update(FIXED_DT);
        leaderboardGhost?.update(FIXED_DT);
        accumulator -= FIXED_DT;
        steps++;
      }
    } else {
      accumulator = 0;
    }
    renderScene(session, paused ? 0 : frameDt);

    hudTimer.textContent = formatTime(session.elapsed);
    hudObjective.textContent = session.allPickedUp
      ? "Deliver to destination"
      : `Pick up cargo (${session.visited.size}/${session.pickups.length})`;
    updateSplitDelta();

    if (session.status !== "playing") endRun();
  } else if (appState === "tutorial" && tutorial) {
    // The tutorial has no countdown: physics advance immediately so the truck's
    // default left curve is visible while the player reads the first prompt.
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      tutorial.tick(input.held);
      accumulator -= FIXED_DT;
      steps++;
    }
    // A new scene (section change / rock-reset / drive->terrain) hands over a
    // fresh truck object; snap the camera to it rather than panning across.
    if (tutorial.activeTruck !== lastTutorialTruck) {
      camera.x = tutorial.activeTruck.pos.x;
      camera.y = tutorial.activeTruck.pos.y;
      lastTutorialTruck = tutorial.activeTruck;
    }
    updateCamera(camera, tutorial.activeTruck, frameDt);
    renderWorld(
      ctx,
      tutorial.activeLevel,
      tutorial.activeTruck,
      tutorial.activeCargo,
      tutorial.activeVisited,
      [],
      camera,
      canvas.clientWidth,
      canvas.clientHeight,
      tutorial.goalMarkers,
    );
    refreshTutorialOverlay();
  } else if (appState === "replay" && replay && replayLevel) {
    if (replay.playing) {
      accumulator += frameDt;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        replay.step();
        accumulator -= FIXED_DT;
        steps++;
      }
    } else {
      accumulator = 0;
    }
    updateReplayCamera(frameDt, false);
    renderReplayWorld(ctx, replayLevel, replay.views(), replayCamera, replayZoom, canvas.clientWidth, canvas.clientHeight);
    updateReplayControls();
  } else {
    accumulator = 0;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// First-time visitors (no session yet) are dropped straight into the guided
// tutorial; it's also always reachable from the Tutorial button. Completing or
// skipping it marks it seen so it won't auto-open again.
if (!hasSeenTutorial()) startTutorial();
