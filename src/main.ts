import {
    backfillChampionTime,
    createSyncAccount,
    fetchChampionTimes,
    fetchLeaderboard,
    fetchOptimalRoute,
    fetchPlayerRecording,
    fetchStats,
    fetchSyncAccount,
    logRun,
    pushSyncAccount,
    submitScore,
    type Difficulty,
    type LeaderboardEntry,
    type PlayerStatsResponse,
    type RemoteRecording,
} from "./game/api.js";
import { COUNTDOWN_STEP_DURATION, countdownLabel } from "./game/countdown.js";
import { GhostPlayer, ghostCollectTicks, splitDelta, type GhostRecording } from "./game/ghost.js";
import { createInput } from "./game/input.js";
import { optimalRowIndex } from "./game/leaderboard-order.js";
import {
    MEDAL_ICON,
    MEDAL_LABEL,
    championTime,
    computeEasyMedalPars,
    computeMedalPars,
    medalFor,
    type Medal,
    type MedalPars,
} from "./game/medals.js";
import { renderMinimap, renderReplayWorld, renderWorld, updateCamera, type Camera, type GhostView } from "./game/render.js";
import { MAX_REPLAY_RACERS, REPLAY_COLORS, ReplayTheater, type ReplayRacer } from "./game/replay.js";
import { GameSession } from "./game/session.js";
import {
    addPlayTime,
    clearSyncToken,
    computeBestStreak,
    getOrCreateNickname,
    loadCompletedDays,
    loadDifficultyPref,
    loadPersonalBest,
    loadAcquisitionSource,
    loadPlayedDays,
    loadPlayTime,
    loadRacePbGhostPref,
    loadSelectedLeaderboardGhost,
    loadSyncToken,
    pruneLeaderboardGhosts,
    pruneOldPersonalBests,
    recordAcquisitionSource,
    recordCompletion,
    recordPlayed,
    saveDifficultyPref,
    savePersonalBestIfBetter,
    saveRacePbGhostPref,
    saveSelectedLeaderboardGhost,
    saveSyncToken,
    hasChosenNickname,
    isDefaultNickname,
    markNicknameChosen,
    setNickname,
    loadSoundPrefs,
    saveSoundPrefs,
} from "./game/storage.js";
import { Tutorial } from "./game/tutorial.js";
import { generateLevel, generateWeeklyLevel, shiftSeed, todaySeed, weekSeed } from "./level/generate.js";
import { resolveSeedTarget } from "./level/seed-target.js";
import { getTheme } from "./level/themes.js";
import type { Level } from "./level/types.js";
import { FIXED_DT } from "./physics/constants.js";
import { BASE_MAX_SPEED, EASY_MAX_SPEED, type TruckState } from "./physics/truck.js";
import { audioState, playCountdownTone, playMedalFanfare, playPickupChime, playRockCrash, resumeAudio, setSoundPrefs, startAmbience, startEngine, startGrass, startMud, startWobble, stopAll, stopEngine, stopGrass, stopMud, stopWobble, unlockAudio, updateEngine, updateGrass, updateMud, updateWobble } from "./game/audio.js";

type Mode = "daily" | "weekly";

interface Playable {
  seed: string;
  level: Level;
  difficulty: Difficulty;
  personalBest: GhostRecording | null;
  pars: MedalPars;
  /** True for a shared-link seed that isn't a live daily/weekly period (expired
   * or non-standard): the map is playable, but it has no global leaderboard, so
   * ranking, ghost-racing others, and score submission are all disabled. */
  orphan?: boolean;
}

function makePlayable(seed: string, kind: Mode, difficulty: Difficulty): Playable {
  const level = kind === "weekly" ? generateWeeklyLevel(seed) : generateLevel(seed);
  const hardPars = computeMedalPars(level);
  const pars = difficulty === "easy" ? computeEasyMedalPars(hardPars) : hardPars;
  return { seed, level, difficulty, personalBest: loadPersonalBest(seed, difficulty), pars };
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
// Cached per (mode, difficulty, offset). Weekly's "easy" slot is simply never
// populated - weekly is always played as Hard (see effectiveDifficulty).
const playableCache: Record<Mode, Record<Difficulty, Map<number, Playable>>> = {
  daily: { easy: new Map(), hard: new Map() },
  weekly: { easy: new Map(), hard: new Map() },
};

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

function getPlayable(mode: Mode, offset: number, difficulty: Difficulty): Playable {
  const cache = playableCache[mode][difficulty];
  let playable = cache.get(offset);
  if (!playable) {
    playable = makePlayable(seedFor(mode, offset), mode, difficulty);
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
  // The streak/calendar strip only applies to live daily play, and only once
  // there's an active streak - delegate to its single visibility owner.
  updateStreakStripVisibility();
  // The Easy/Hard switch only makes sense (and only shows) in daily mode.
  updateDifficultySwitchVisibility();
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

// --- Easy/Hard difficulty ----------------------------------------------------
// A single global preference, independent of (and persisted across) both the
// viewed offset and the daily/weekly mode. Weekly is always played as Hard
// regardless of this preference - effectiveDifficulty() is the one place that
// reconciles the two, and every level lookup goes through it rather than
// reading `difficulty` directly.

/** A brand-new player (nothing delivered yet, in either difficulty) defaults to
 * Easy; anyone who has finished at least one run defaults to Hard. Reuses the
 * same "hasPlayed" signal the difficulty switch's own reveal condition uses, so
 * the two stay in lockstep. */
function defaultDifficulty(): Difficulty {
  return loadCompletedDays().size > 0 ? "hard" : "easy";
}

let difficulty: Difficulty = loadDifficultyPref() ?? defaultDifficulty();
// Lock in that default the first time it's computed, so it doesn't silently
// flip to "hard" the moment the player finishes their first (default-Easy)
// run - once resolved, the choice sticks until they explicitly toggle it.
if (loadDifficultyPref() == null) saveDifficultyPref(difficulty);

/** The difficulty actually in effect for `mode`: weekly ignores the preference
 * entirely and is always Hard (there is no Easy weekly board). */
function effectiveDifficulty(mode: Mode): Difficulty {
  return mode === "weekly" ? "hard" : difficulty;
}

let viewed: Playable = getPlayable(mode, 0, effectiveDifficulty(mode));

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const minimapCanvas = document.getElementById("minimap-canvas") as HTMLCanvasElement;
const minimapCtx = minimapCanvas.getContext("2d")!;
// The two flanking canvases of the carousel: the previous (older) and next
// (newer) period's maps, drawn so they can peek in as the track is dragged.
const minimapPrevCanvas = document.getElementById("minimap-prev") as HTMLCanvasElement;
const minimapPrevCtx = minimapPrevCanvas.getContext("2d")!;
const minimapNextCanvas = document.getElementById("minimap-next") as HTMLCanvasElement;
const minimapNextCtx = minimapNextCanvas.getContext("2d")!;

const startScreen = document.getElementById("start-screen")!;
const resultsScreen = document.getElementById("results-screen")!;
const helpScreen = document.getElementById("help-screen")!;
const helpCloseBtn = document.getElementById("help-close-btn") as HTMLButtonElement;
const profileScreen = document.getElementById("profile-screen")!;
const profileBtn = document.getElementById("profile-btn") as HTMLButtonElement;
const profileCloseBtn = document.getElementById("profile-close-btn") as HTMLButtonElement;
const syncGenerateBtn = document.getElementById("sync-generate-btn") as HTMLButtonElement;
const syncLinkInput = document.getElementById("sync-link-input") as HTMLInputElement;
const syncLinkBtn = document.getElementById("sync-link-btn") as HTMLButtonElement;
const syncUnlinked = document.getElementById("sync-unlinked")!;
const syncLinked = document.getElementById("sync-linked")!;
const syncCodeValue = document.getElementById("sync-code-value")!;
const syncCopyBtn = document.getElementById("sync-copy-btn") as HTMLButtonElement;
const syncStatus = document.getElementById("sync-status")!;
const syncNowBtn = document.getElementById("sync-now-btn") as HTMLButtonElement;
const syncUnlinkBtn = document.getElementById("sync-unlink-btn") as HTMLButtonElement;
const syncError = document.getElementById("sync-error")!;
const statsLocal = document.getElementById("stats-local")!;
const statsServer = document.getElementById("stats-server")!;
const statsServerError = document.getElementById("stats-server-error")!;
const statsDiffSwitch = document.getElementById("stats-difficulty-switch")!;
const statsDiffEasy = document.getElementById("stats-diff-easy") as HTMLButtonElement;
const statsDiffHard = document.getElementById("stats-diff-hard") as HTMLButtonElement;
const soundGameSlider = document.getElementById("sound-game") as HTMLInputElement;
const soundAmbientSlider = document.getElementById("sound-ambient") as HTMLInputElement;
const soundEffectsSlider = document.getElementById("sound-effects") as HTMLInputElement;
const soundGameVal = document.getElementById("sound-game-val")!;
const soundAmbientVal = document.getElementById("sound-ambient-val")!;
const soundEffectsVal = document.getElementById("sound-effects-val")!;
const soundGameMute = document.getElementById("sound-game-mute") as HTMLButtonElement;
const soundAmbientMute = document.getElementById("sound-ambient-mute") as HTMLButtonElement;
const soundEffectsMute = document.getElementById("sound-effects-mute") as HTMLButtonElement;
const tutorialBtn = document.getElementById("tutorial-btn") as HTMLButtonElement;
const howToBtn = document.getElementById("howto-btn") as HTMLButtonElement;
const tutorialOverlay = document.getElementById("tutorial-overlay")!;
const tutorialBadge = document.getElementById("tutorial-badge")!;
const tutorialPrompt = document.getElementById("tutorial-prompt")!;
const tutorialTimer = document.getElementById("tutorial-timer")!;
const tutorialTryBtn = document.getElementById("tutorial-try-btn") as HTMLButtonElement;
const tutorialAgainBtn = document.getElementById("tutorial-again-btn") as HTMLButtonElement;
const tutorialNextBtn = document.getElementById("tutorial-next-btn") as HTMLButtonElement;
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
const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const countdownOverlay = document.getElementById("countdown-overlay")!;
const countdownText = document.getElementById("countdown-text")!;
const bestShareBtn = document.getElementById("best-share-btn") as HTMLButtonElement;
const nicknameInput = document.getElementById("nickname-input") as HTMLInputElement;
const nicknameSettingsSave = document.getElementById("nickname-settings-save") as HTMLButtonElement;
const nicknameScreen = document.getElementById("nickname-screen")!;
const nicknamePromptInput = document.getElementById("nickname-prompt-input") as HTMLInputElement;
const nicknamePromptSave = document.getElementById("nickname-prompt-save") as HTMLButtonElement;
const nicknamePromptCancel = document.getElementById("nickname-prompt-cancel") as HTMLButtonElement;
const leaderboardHeaderEl = document.getElementById("leaderboard-header")!;
const leaderboardList = document.getElementById("leaderboard-list")!;
const streakBadge = document.getElementById("streak-badge")!;
const dayDots = document.getElementById("day-dots")!;
const progressStrip = document.getElementById("progress-strip")!;
const modeDailyBtn = document.getElementById("mode-daily") as HTMLButtonElement;
const modeWeeklyBtn = document.getElementById("mode-weekly") as HTMLButtonElement;
const modeSwitch = document.getElementById("mode-switch")!;
const modeCta = document.getElementById("mode-cta")!;
const difficultySwitch = document.getElementById("difficulty-switch")!;
const difficultyEasyBtn = document.getElementById("difficulty-easy") as HTMLButtonElement;
const difficultyHardBtn = document.getElementById("difficulty-hard") as HTMLButtonElement;
const medalTrack = document.getElementById("medal-track")!;

let nickname = getOrCreateNickname();
nicknameInput.value = nickname;

/** Persists a new nickname from wherever it was entered (the settings field or
 * the post-run prompt) and brings the rest of the UI into line. setNickname()
 * ignores blank input, so re-reading the stored value is what keeps the field
 * showing the name that actually took effect. */
function applyNickname(next: string): void {
  const oldNickname = nickname;
  setNickname(next);
  nickname = getOrCreateNickname();
  nicknameInput.value = nickname;
  renderLeaderboardList();
  if (nickname !== oldNickname) {
    void logRun(viewed.seed, nickname, "username_changed", 0, `${oldNickname} -> ${nickname}`);
    if (loadSyncToken()) void doSync();
  }
}

nicknameInput.addEventListener("change", () => applyNickname(nicknameInput.value));

// Explicit save alongside the field's own change handler. The handler already
// persists on blur, so this is about affordance and confirmation - and saving
// here counts as choosing a name, which retires the post-run prompt.
nicknameSettingsSave.addEventListener("click", () => {
  applyNickname(nicknameInput.value);
  markNicknameChosen();
  nicknameSettingsSave.textContent = "Saved!";
  window.setTimeout(() => {
    nicknameSettingsSave.textContent = "Save";
  }, 1400);
});

/** Works out where this visit came from, for acquisition tracking.
 *
 * An explicit `?src=` tag wins, so put one on every link you post
 * (`?src=reddit-webgames`, `?src=itch`) - it survives the many places that
 * strip referrers, and it distinguishes two posts to the same site. Otherwise
 * fall back to the referring hostname. Anything unattributable is "direct",
 * which covers bookmarks, typed URLs, and most links opened from mobile apps.
 *
 * The value reaches the database, so it's length-capped and restricted to
 * harmless characters rather than trusted - `?src=` is attacker-controllable
 * like any query string. */
function detectSource(): string {
  const tagged = new URLSearchParams(location.search).get("src");
  if (tagged) return tagged.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "direct";
  if (!document.referrer) return "direct";
  try {
    const host = new URL(document.referrer).hostname.replace(/^www\./, "");
    return host === location.hostname ? "direct" : host.slice(0, 40);
  } catch {
    return "unknown";
  }
}

function logGameStarted(): void {
  // Captured on the first visit and replayed on every later one, so a return
  // visit weeks afterwards still reports the channel that originally won the
  // player - which is the whole point of tracking it.
  recordAcquisitionSource(detectSource());
  void logRun(todaysSeed, nickname, "game_started", 0, `src:${loadAcquisitionSource() ?? "direct"}`);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", logGameStarted);
} else {
  logGameStarted();
}

// Pull remote state on load if a sync token is stored.
if (loadSyncToken()) {
  void doSync();
}

function refreshViewedUi(): void {
  const periodLabel = viewed.orphan ? "Shared map" : describeOffset(mode, viewedOffset);
  viewedDateEl.textContent = `${periodLabel} · ${viewed.seed} · ${getTheme(viewed.level.theme).name}`;

  // Sharing the best time is offered only for today, and only once there's a
  // best to share (never on a shared orphan map, which has no leaderboard). The
  // button lives below the leaderboard now.
  const canShareBest = !viewed.orphan && viewedOffset === 0 && viewed.personalBest != null;
  bestShareBtn.classList.toggle("hidden", !canShareBest);
  if (canShareBest) bestShareBtn.textContent = "Share personal best";

  hudPb.textContent = viewed.personalBest ? `PB: ${formatTime(viewed.personalBest.time)}` : "";

  // Show the level's medal times immediately on navigation; the leaderboard
  // load will refresh the champion tier once it arrives. The PB chip also
  // reflects the current "race my PB ghost" preference.
  renderMedalTrack();

  // "Watch a replay" unlocks with the same personal-best gate as ghost racing.
  updateWatchButton();

  updateModeSwitchVisibility();

  // Solve this map for its Optimal ghost in the background (opt-in, daily-only).
  requestOptimal(viewed);
}

/** The Daily/Weekly switch (pinned to the very bottom) is a progressive-disclosure
 * unlock: a newcomer never sees it, and it appears with a "bigger challenge"
 * invite only once they've earned gold on Hard mode. In weekly mode the
 * toggle always shows (minus the invite) so there's a way back to daily. */
function updateModeSwitchVisibility(): void {
  // Check if Hard mode has a gold medal on the viewed seed (regardless of current difficulty)
  const hardPlayable = mode === "daily" ? getPlayable("daily", viewedOffset, "hard") : viewed;
  const hasGold = hardPlayable.personalBest != null && hardPlayable.personalBest.time <= hardPlayable.pars.gold;
  modeSwitch.classList.toggle("hidden", !(mode === "weekly" || hasGold));
  // The invite is a daily -> weekly nudge, so it's hidden once you're on weekly.
  modeCta.classList.toggle("hidden", !(mode === "daily" && hasGold));
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
  // Hide the streak counter entirely until there's a streak to show.
  const hasStreak = streak > 0;
  streakBadge.textContent = hasStreak ? `\u{1F525} ${streak}-day streak` : "";
  streakBadge.classList.toggle("hidden", !hasStreak);

  dayDots.replaceChildren();
  // The strip only ever shows in daily mode, so this is just `difficulty` -
  // but routed through effectiveDifficulty() to keep every lookup consistent.
  const stripDifficulty = effectiveDifficulty("daily");
  for (let offset = -STREAK_STRIP_DAYS; offset <= 0; offset++) {
    const playable = getPlayable("daily", offset, stripDifficulty);
    const seed = playable.seed;
    const best = playable.personalBest?.time ?? null;
    const champion = championTimeCache.get(champKey(seed, stripDifficulty)) ?? null;
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
    dot.title = medal ? `${seed} - ${MEDAL_LABEL[medal]}` : seed;
    dayDots.appendChild(dot);
  }
  updateStreakStripVisibility();
}

/** The streak strip (badge + recent-day dots) shows only for live daily play
 * on Hard mode, and only once the player has an active streak - a brand-new or
 * lapsed player gets a cleaner home. Single source of truth for the strip's visibility. */
function updateStreakStripVisibility(): void {
  const hasStreak = currentStreak(loadCompletedDays()) > 0;
  progressStrip.classList.toggle("hidden", mode !== "daily" || difficulty !== "hard" || !hasStreak);
}

/** Batch-fetches the champion thresholds for the days shown in the streak
 * strip (on the currently selected difficulty) and, if anything changed,
 * repaints it. Past days are frozen server-side so this mostly settles after
 * the first call; today's can still move as records come in. Best-effort -
 * offline just leaves the champion tint absent. */
async function refreshStripChampionTimes(): Promise<void> {
  const stripDifficulty = effectiveDifficulty("daily");
  const seeds: string[] = [];
  for (let offset = -STREAK_STRIP_DAYS; offset <= 0; offset++) seeds.push(shiftSeed(todaysSeed, offset));
  const times = await fetchChampionTimes(seeds, stripDifficulty);

  let changed = false;
  for (const [seed, time] of Object.entries(times)) {
    const key = champKey(seed, stripDifficulty);
    if (championTimeCache.get(key) !== time) {
      championTimeCache.set(key, time);
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
// viewed seed+difficulty, plus a per-(seed, difficulty) cache used to colour
// the streak calendar. The server persists and freezes these per period; null
// means none is set yet.
let viewedChampionTime: number | null = null;
const championTimeCache = new Map<string, number>();
function champKey(seed: string, difficulty: Difficulty): string {
  return `${difficulty}:${seed}`;
}

/** Champion threshold for the currently viewed level - the single source of
 * truth for whether a run earns the champion medal here. It's the server's
 * stored (and frozen, once its day/week is over) value; refreshLeaderboard()
 * seeds it from the day's record when the server has none yet. Null when no
 * record beats the gold time, so there's no champion tier. */
function currentChampionTime(): number | null {
  return viewedChampionTime;
}

// Icon for the personal-best chip - the player's own truck, distinct from the
// medal icons. It always shows the truck; the PB-ghost on/off state is conveyed
// by an inner glow (and a brief text flash on toggle), not by swapping the icon.
const PB_ICON = "\u{1F69A}"; // 🚚

// When the PB chip is clicked, it briefly shows "Ghost enabled/disabled" before
// settling into its new state. pbFlashMsg holds the message during that window.
const PB_FLASH_MS = 850;
let pbFlashMsg: string | null = null;
let pbFlashTimer: number | undefined;

// Per-medal glow colours ("r, g, b" triples), matching the streak dots' --glow
// in style.css - keep the two in sync. FAINT_GLOW is a bluish grey for a PB
// that's slower than every medal.
const MEDAL_GLOW: Record<Medal, string> = {
  champion: "244, 202, 187",
  gold: "255, 216, 115",
  silver: "226, 232, 239",
  bronze: "217, 148, 87",
};
const FAINT_GLOW = "150, 165, 190";

/** Renders the medal + personal-best "chips" for the viewed level: one small
 * rounded tile per available time, laid out left to right in ascending (fastest
 * first) order. Gold/Silver/Bronze always show; PB and Champion join in only
 * when they exist. Each tile stacks an icon, the time's name, and the time, and
 * carries a colour glow that pulses once on hover (same flourish as the streak
 * dots). The PB tile borrows the glow of the medal immediately to its right (the
 * best medal it earned); a PB slower than every medal glows a faint bluish grey.
 * The PB tile is also the control for racing your PB ghost: clicking it toggles
 * the (global, session-remembered) preference, flashing a confirmation and then
 * carrying an inner whitish-gold glow while it's on. */
function renderMedalTrack(): void {
  const pars = viewed.pars;
  const champion = currentChampionTime();
  const pb = viewed.personalBest?.time ?? null;
  const pbGhostOn = loadRacePbGhostPref();

  const chips: Array<{ icon: string; name: string; time: number; medal: Medal | null }> = [];
  if (pb != null) chips.push({ icon: PB_ICON, name: "PB", time: pb, medal: null });
  if (champion != null) chips.push({ icon: MEDAL_ICON.champion, name: MEDAL_LABEL.champion, time: champion, medal: "champion" });
  chips.push({ icon: MEDAL_ICON.gold, name: MEDAL_LABEL.gold, time: pars.gold, medal: "gold" });
  chips.push({ icon: MEDAL_ICON.silver, name: MEDAL_LABEL.silver, time: pars.silver, medal: "silver" });
  chips.push({ icon: MEDAL_ICON.bronze, name: MEDAL_LABEL.bronze, time: pars.bronze, medal: "bronze" });
  chips.sort((a, b) => a.time - b.time);

  medalTrack.replaceChildren();
  chips.forEach((chip, i) => {
    const isPb = chip.medal === null;
    const cell = document.createElement("div");
    cell.className = "medal-chip";

    // A medal chip glows in its own colour; the PB chip borrows the glow of the
    // medal to its right, or a faint bluish grey when it's the slowest of all.
    let glow = FAINT_GLOW;
    let faint = true;
    if (chip.medal) {
      glow = MEDAL_GLOW[chip.medal];
      faint = false;
    } else {
      const rightMedal = chips[i + 1]?.medal;
      if (rightMedal) {
        glow = MEDAL_GLOW[rightMedal];
        faint = false;
      }
    }
    cell.style.setProperty("--glow", glow);
    if (faint) cell.classList.add("glow-faint");

    // Pulse once per mouse-enter, driven here (not CSS :hover) so it always runs
    // to completion and can fire again next entry - exactly like the streak dots.
    cell.addEventListener("mouseenter", () => cell.classList.add("pulsing"));
    cell.addEventListener("animationend", () => cell.classList.remove("pulsing"));

    // The PB chip doubles as the "race my PB ghost" switch: clicking it flips the
    // preference, flashes a confirmation, then settles with (or without) an inner
    // glow marking it selected.
    if (isPb) {
      cell.classList.add("pb-chip");
      cell.setAttribute("role", "button");
      cell.tabIndex = 0;
      cell.title = pbGhostOn ? "Racing your PB ghost - click to turn off" : "Click to race your PB ghost";
      const toggle = () => {
        saveRacePbGhostPref(!loadRacePbGhostPref());
        flashPbGhost(loadRacePbGhostPref());
      };
      cell.addEventListener("click", toggle);
      cell.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });

      // Mid-toggle: show the transient message instead of the usual contents, and
      // hold off the inner glow until the flash clears.
      if (pbFlashMsg != null) {
        cell.classList.add("flashing");
        const flash = document.createElement("span");
        flash.className = "medal-chip-flash";
        flash.textContent = pbFlashMsg;
        cell.appendChild(flash);
        medalTrack.appendChild(cell);
        return;
      }
      if (pbGhostOn) cell.classList.add("active");
    }

    const icon = document.createElement("span");
    icon.className = "medal-chip-icon";
    icon.textContent = chip.icon;

    const name = document.createElement("span");
    name.className = "medal-chip-name";
    name.textContent = chip.name;

    const t = document.createElement("span");
    t.className = "medal-chip-time";
    t.textContent = formatTime(chip.time);

    cell.append(icon, name, t);
    medalTrack.appendChild(cell);
  });
}

/** Flashes "Ghost enabled/disabled" inside the PB chip for a beat, then re-renders
 * so the chip settles into its new state (inner glow on/off). */
function flashPbGhost(on: boolean): void {
  pbFlashMsg = on ? "Ghost enabled" : "Ghost disabled";
  window.clearTimeout(pbFlashTimer);
  pbFlashTimer = window.setTimeout(() => {
    pbFlashMsg = null;
    renderMedalTrack();
  }, PB_FLASH_MS);
  renderMedalTrack();
}

/** Builds the pinned "Optimal" leaderboard row for the solver's route: a trophy
 * rank marker, the label, and the solved time. Visually distinct via the
 * `optimal` class. Outside watch mode it's non-interactive (it's always raced as
 * a ghost during play); in watch mode it's a pickable racer like any leaderboard
 * row, so it can be included in a replay. */
function buildOptimalRow(recording: GhostRecording): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "leaderboard-row optimal";

  if (watchMode) {
    const capReached = totalWatchPicks() >= MAX_REPLAY_RACERS;
    li.classList.add("pickable");
    if (optimalPicked) li.classList.add("picked");
    else if (capReached) li.classList.add("pick-disabled");
    const check = document.createElement("span");
    check.className = "leaderboard-check";
    check.textContent = optimalPicked ? "✓" : "";
    li.appendChild(check);
    li.addEventListener("click", toggleOptimalPick);
  } else {
    li.title = "Computer-solved near-optimal route - raced as a ghost";
  }

  const rankEl = document.createElement("span");
  rankEl.className = "leaderboard-rank";
  rankEl.textContent = "\u{1F3AF}"; // 🎯

  const nameEl = document.createElement("span");
  nameEl.className = "leaderboard-nickname";
  nameEl.textContent = `\u{1F916} ${OPTIMAL_LABEL}`; // 🤖 Optimal

  const timeEl = document.createElement("span");
  timeEl.className = "leaderboard-time";
  timeEl.textContent = formatTime(recording.time);

  li.append(rankEl, nameEl, timeEl);
  return li;
}

/** Total racers currently picked for a replay: leaderboard players plus the
 * Optimal ghost if it's selected. Bounded by MAX_REPLAY_RACERS. */
function totalWatchPicks(): number {
  return watchSelection.size + (optimalPicked ? 1 : 0);
}

/** Toggles the Optimal ghost in/out of the replay selection, respecting the cap. */
function toggleOptimalPick(): void {
  if (optimalPicked) {
    optimalPicked = false;
  } else {
    if (totalWatchPicks() >= MAX_REPLAY_RACERS) return;
    optimalPicked = true;
  }
  updateWatchBar();
  renderLeaderboardList();
}

function renderLeaderboardList(): void {
  // A shared orphan map has no leaderboard; keep its notice instead of painting
  // rows (still refresh the medal track, which is derived from the level).
  if (viewed.orphan) {
    renderMedalTrack();
    renderOrphanNotice();
    return;
  }
  // The Easy/Hard split only exists in daily mode (weekly is Hard-only, so
  // labelling it would be redundant noise).
  const diffLabel = mode === "daily" ? ` · ${viewed.difficulty === "easy" ? "Easy" : "Hard"}` : "";
  leaderboardHeaderEl.textContent = watchMode
    ? `Pick up to 5 racers to include in the replay`
    : `Leaderboard (${describeOffset(mode, viewedOffset)})${diffLabel}`;
  // Champion depends on the leaderboard's #1, so refresh the track alongside.
  renderMedalTrack();
  leaderboardList.replaceChildren();

  // The solver's Optimal route (when ?optimal=true and this map is solved) is a
  // benchmark time, not a pinned banner: it's slotted into the board by its time
  // like any other entry, so a real player who beats it ranks above it. In watch
  // mode it's a pickable racer like any other row; otherwise it's just shown (it's
  // always raced as a ghost during play).
  const optimal = optimalForViewed();

  if (leaderboardTop.length === 0) {
    // No player times yet: show the Optimal row alone, or the "be the first" prompt.
    if (optimal) leaderboardList.appendChild(buildOptimalRow(optimal));
    else {
      const li = document.createElement("li");
      li.className = "leaderboard-empty";
      li.textContent = "No times yet - be the first!";
      leaderboardList.appendChild(li);
    }
    return;
  }

  // In watch mode, rows once the 1-5 cap is hit (and not already picked) are
  // inert until something is deselected. The Optimal pick counts toward the cap.
  const capReached = totalWatchPicks() >= MAX_REPLAY_RACERS;

  // Slot the Optimal benchmark row into the board by its time (the board is
  // already fastest-first), so a real player who beats it appears above it.
  const entries = [...leaderboardTop, ...leaderboardContext];
  const optimalIndex = optimal ? optimalRowIndex(entries.map((e) => e.time), optimal.time) : -1;
  for (let i = 0; i < entries.length; i++) {
    if (i === optimalIndex) leaderboardList.appendChild(buildOptimalRow(optimal!));
    const entry = entries[i]!;
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
  // Optimal is slower than every shown entry: it goes last.
  if (optimalIndex === entries.length) leaderboardList.appendChild(buildOptimalRow(optimal!));
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
    saveSelectedLeaderboardGhost(viewed.seed, viewed.difficulty, null);
    renderLeaderboardList();
    return;
  }
  const recording = await fetchPlayerRecording(viewed.seed, clickedNickname, viewed.difficulty);
  if (recording) {
    selectedGhostEntry = { nickname: clickedNickname, recording };
    saveSelectedLeaderboardGhost(viewed.seed, viewed.difficulty, clickedNickname);
  }
  renderLeaderboardList();
}

/** Re-selects the leaderboard opponent remembered for the viewed (seed,
 * difficulty) (if any), re-fetching its recording. Racing another player's
 * ghost requires your own time on the level, matching toggleLeaderboardGhost.
 * Guards against the view having moved on during the async fetch. */
async function restoreSelectedLeaderboardGhost(): Promise<void> {
  const seed = viewed.seed;
  const requestedDifficulty = viewed.difficulty;
  const remembered = loadSelectedLeaderboardGhost(seed, requestedDifficulty);
  if (!remembered || !viewed.personalBest) return;
  const recording = await fetchPlayerRecording(seed, remembered, requestedDifficulty);
  if (recording && viewed.seed === seed && viewed.difficulty === requestedDifficulty) {
    selectedGhostEntry = { nickname: remembered, recording };
    renderLeaderboardList();
  }
}

async function refreshLeaderboard(): Promise<void> {
  const requestedSeed = viewed.seed;
  const requestedDifficulty = viewed.difficulty;
  const gold = viewed.pars.gold;
  const data = await fetchLeaderboard(requestedSeed, requestedDifficulty, nickname);
  // Guard against the view having moved on while the request was in flight.
  if (data && viewed.seed === requestedSeed && viewed.difficulty === requestedDifficulty) {
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
        void backfillChampionTime(requestedSeed, requestedDifficulty, derived);
      }
    }
    viewedChampionTime = champion;
    if (champion != null) championTimeCache.set(champKey(requestedSeed, requestedDifficulty), champion);
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

/** True when there's an older/newer period to swipe to from the current view.
 * A shared orphan map is off the day/week timeline, so it has no neighbours. */
function hasOlderPeriod(): boolean {
  return !viewed.orphan && viewedOffset > -maxPastOffset(mode);
}
function hasNewerPeriod(): boolean {
  return !viewed.orphan && viewedOffset < 0;
}

/** Paints the carousel: the centre canvas is the viewed map, and the flanking
 * canvases hold the previous (older) and next (newer) maps so a swipe reveals
 * the real neighbour sliding in. Missing neighbours (timeline edges, orphan
 * maps) are cleared to an empty slot. */
function renderMinimaps(): void {
  renderMinimap(minimapCtx, viewed.level, 0, 0, minimapCanvas.width, minimapCanvas.height);
  paintNeighbourThumb(minimapPrevCtx, minimapPrevCanvas, hasOlderPeriod() ? viewedOffset - 1 : null);
  paintNeighbourThumb(minimapNextCtx, minimapNextCanvas, hasNewerPeriod() ? viewedOffset + 1 : null);
}

/** Draws the map at `offset` into a flanking carousel canvas, or clears it to an
 * empty slot when there's no neighbour there. */
function paintNeighbourThumb(ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, offset: number | null): void {
  if (offset === null) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    return;
  }
  renderMinimap(ctx, getPlayable(mode, offset, effectiveDifficulty(mode)).level, 0, 0, cv.width, cv.height);
}

/** Re-syncs the whole home view (map, best, ghost toggle, leaderboard) to the
 * currently selected mode + offset. Also leaves any shared "orphan" seed view,
 * since a mode/offset selection is always a live period. */
function refreshViewedSelection(): void {
  viewed = getPlayable(mode, viewedOffset, effectiveDifficulty(mode));
  // A live period has a leaderboard + streak strip again; restore the chrome
  // that showOrphanSeed() hides.
  replayControls.classList.remove("hidden");
  setModeVisuals();
  // Changing level cancels any in-progress replay-racer picking.
  exitWatchMode();
  // A selected ghost is contextual to the exact seed+difficulty it was fetched
  // for; clear it, then restore whichever opponent was remembered there (if any).
  selectedGhostEntry = null;
  // Seed the champion threshold from cache (frozen past days never change), so
  // the medal track is right immediately; refreshLeaderboard() refines it.
  viewedChampionTime = championTimeCache.get(champKey(viewed.seed, viewed.difficulty)) ?? null;
  updateNavButtons();
  refreshViewedUi();
  paintViewedTerrainTags();
  renderMinimaps();
  void refreshLeaderboard();
  void restoreSelectedLeaderboardGhost();
}

function navigateTo(offset: number): void {
  const prevSeed = viewed.seed;
  viewedOffset = Math.max(-maxPastOffset(mode), Math.min(0, offset));
  refreshViewedSelection();
  // Log a real map change only (boundary clicks that don't move are skipped).
  if (viewed.seed !== prevSeed) {
    void logRun(viewed.seed, nickname, "navigated", 0, `to ${describeOffset(mode, viewedOffset)}`);
  }
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
  void logRun(viewed.seed, nickname, "mode_switched", 0, `to ${newMode}`);
}

/** Syncs the Easy/Hard toggle buttons to the current `difficulty`, and shows
 * the switch itself only where it applies (see updateDifficultySwitchVisibility). */
function setDifficultyVisuals(): void {
  difficultyEasyBtn.classList.toggle("active", difficulty === "easy");
  difficultyHardBtn.classList.toggle("active", difficulty === "hard");
  difficultyEasyBtn.setAttribute("aria-selected", String(difficulty === "easy"));
  difficultyHardBtn.setAttribute("aria-selected", String(difficulty === "hard"));
  updateDifficultySwitchVisibility();
}

/** The Easy/Hard switch is daily-only (weekly has no Easy board) and, like the
 * Daily/Weekly switch, a progressive-disclosure unlock: it stays hidden until
 * the player has finished at least one run, in either difficulty - the same
 * "hasPlayed" signal defaultDifficulty() uses. Before
 * that, a brand-new player just plays the (default-Easy) game with no toggle
 * to be confused by. */
function updateDifficultySwitchVisibility(): void {
  const hasPlayed = loadCompletedDays().size > 0;
  difficultySwitch.classList.toggle("hidden", mode !== "daily" || !hasPlayed);
}

/** Switches the Easy/Hard preference, persists it, and reloads the viewed map
 * on the new difficulty's board. No-op on weekly (the switch is hidden there,
 * but this stays a hard guard in case it's ever invoked programmatically). */
function switchDifficulty(next: Difficulty): void {
  if (mode !== "daily" || difficulty === next) return;
  difficulty = next;
  saveDifficultyPref(next);
  setDifficultyVisuals();
  renderProgressStrip();
  void refreshStripChampionTimes();
  refreshViewedSelection();
  void logRun(viewed.seed, nickname, "difficulty_switched", 0, `to ${next}`);
}

/** Shows a shared "orphan" seed - a generated map with no live leaderboard.
 * Playable (including racing your own local PB ghost), but ranking, others'
 * ghosts, replays, and score submission are all off, with a short notice in
 * place of the leaderboard. */
function showOrphanSeed(seed: string, genMode: Mode): void {
  mode = genMode;
  setModeVisuals();
  progressStrip.classList.add("hidden"); // no streak strip for a one-off map
  viewed = { ...makePlayable(seed, genMode, effectiveDifficulty(genMode)), orphan: true };
  exitWatchMode();
  selectedGhostEntry = null;
  viewedChampionTime = null;
  leaderboardTop = [];
  leaderboardContext = [];
  leaderboardTotal = null;
  updateNavButtons();
  refreshViewedUi();
  paintViewedTerrainTags();
  renderMinimaps();
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
difficultyEasyBtn.addEventListener("click", () => switchDifficulty("easy"));
difficultyHardBtn.addEventListener("click", () => switchDifficulty("hard"));

// Carousel navigation over the map thumbnail: drag/swipe right -> previous
// (older) period, left -> next (newer). While dragging, the track follows the
// finger so the neighbouring map slides in like a carousel; on release it snaps
// to the chosen map (past the threshold) or springs back. Pointer events unify
// mouse-drag (desktop) and touch (mobile). A committed swipe sets
// `swipeConsumed` so the minimap's tap-to-play click (which fires right after
// pointerup) is skipped for that gesture.
const minimapViewport = document.getElementById("minimap-viewport")!;
const minimapTrack = document.getElementById("minimap-track")!;
const SWIPE_THRESHOLD = 45; // px of horizontal travel to commit to a neighbour
const SWIPE_ENGAGE = 8; // px before a drag is treated as a horizontal swipe
const EDGE_RESISTANCE = 0.25; // drag past a timeline edge moves this much
const SNAP_MS = 260; // keep in sync with #minimap-track.snapping transition
const CAROUSEL_GAP = 10; // px gutter between maps; keep in sync with #minimap-track gap
let swipeStartX = 0;
let swipeStartY = 0;
let swipeTracking = false; // a pointer is down on the viewport
let swipeEngaged = false; // the drag has been recognised as horizontal
let swipeConsumed = false; // the gesture committed to a neighbour (suppress tap)
let viewportWidth = 0; // width of one carousel slot, measured at drag start

/** Distance to step the track by one map: a full slot plus the gutter between
 * maps. Measured fresh so it tracks the current viewport width. */
function slotStride(): number {
  return viewportWidth + CAROUSEL_GAP;
}
/** Offsets the track by `dx` px from its centred rest position (one slot-plus-
 * gutter to the left, since the middle canvas is the second of three). */
function setTrackOffset(dx: number): void {
  minimapTrack.style.transform = `translateX(${-slotStride() + dx}px)`;
}
/** Returns the track to its centred rest position, driven by CSS. */
function restTrack(): void {
  minimapTrack.style.transform = "";
}

minimapViewport.addEventListener("pointerdown", (e) => {
  // A shared orphan map isn't on the day/week timeline, so there's nothing to
  // swipe to (the Daily/Weekly toggle is the way back to a live period).
  if (viewed.orphan || e.button > 0) return;
  swipeStartX = e.clientX;
  swipeStartY = e.clientY;
  swipeTracking = true;
  swipeEngaged = false;
  swipeConsumed = false;
  viewportWidth = minimapViewport.clientWidth;
  minimapTrack.classList.remove("snapping");
});

window.addEventListener("pointermove", (e) => {
  if (!swipeTracking) return;
  const dx = e.clientX - swipeStartX;
  const dy = e.clientY - swipeStartY;
  if (!swipeEngaged) {
    // Let a clearly vertical drag fall through to page scrolling instead.
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SWIPE_ENGAGE) {
      swipeTracking = false;
      return;
    }
    if (Math.abs(dx) < SWIPE_ENGAGE) return;
    swipeEngaged = true;
  }
  // Rubber-band against a timeline edge so the track can't be dragged toward a
  // neighbour that doesn't exist.
  let travel = dx;
  if ((dx > 0 && !hasOlderPeriod()) || (dx < 0 && !hasNewerPeriod())) travel = dx * EDGE_RESISTANCE;
  setTrackOffset(travel);
});

// Bound to window so a drag that lifts off the thumbnail still resolves.
window.addEventListener("pointerup", (e) => {
  if (!swipeTracking) return;
  swipeTracking = false;
  if (!swipeEngaged) return; // a tap, not a drag - leave tap-to-play to click
  // A real drag happened, so the trailing click is drag fallout, not tap-to-play
  // - suppress it whether we commit to a neighbour or spring back.
  swipeConsumed = true;
  const dx = e.clientX - swipeStartX;
  const dy = e.clientY - swipeStartY;
  let dir = 0; // -1 = older (right swipe), +1 = newer (left swipe)
  if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
    if (dx > 0 && hasOlderPeriod()) dir = -1;
    else if (dx < 0 && hasNewerPeriod()) dir = 1;
  }
  minimapTrack.classList.add("snapping");
  if (dir === 0) {
    setTrackOffset(0); // spring back to the current map
    window.setTimeout(() => {
      minimapTrack.classList.remove("snapping");
      restTrack();
    }, SNAP_MS);
    return;
  }
  // Slide the chosen neighbour fully into the viewport, then commit and recenter
  // instantly. The neighbour canvas already holds the destination map, so the
  // recenter is seamless: the same pixels are simply relabelled as "current".
  setTrackOffset(dir === -1 ? slotStride() : -slotStride());
  window.setTimeout(() => {
    minimapTrack.classList.remove("snapping");
    const shown = dir === -1 ? minimapPrevCanvas : minimapNextCanvas;
    minimapCtx.drawImage(shown, 0, 0);
    restTrack();
    navigateTo(viewedOffset + dir);
  }, SNAP_MS);
});

// If the browser takes over the gesture (e.g. it becomes a page scroll), spring
// the track back rather than leaving it stranded mid-drag.
window.addEventListener("pointercancel", () => {
  if (!swipeTracking) return;
  swipeTracking = false;
  if (!swipeEngaged) return;
  minimapTrack.classList.add("snapping");
  setTrackOffset(0);
  window.setTimeout(() => {
    minimapTrack.classList.remove("snapping");
    restTrack();
  }, SNAP_MS);
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
// Sync the Easy/Hard toggle's active button and visibility to the resolved
// starting difficulty.
setDifficultyVisuals();
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
  // Freezing the game has to freeze its sound too. The per-frame audio updates
  // live in the unpaused branch of the frame loop, so anything already looping
  // would otherwise hold its last level indefinitely. Resetting the remembered
  // terrain means resuming on grass or in mud re-triggers that loop cleanly.
  if (paused) {
    stopEngine();
    stopWobble();
    stopGrass();
    stopMud();
    prevOnRoad = true;
    prevInMud = false;
  } else if (appState === "playing") {
    startEngine();
    startWobble();
  }
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
  void logRun(active.seed, nickname, paused ? "paused" : "resumed", session?.visited.size ?? 0);
  // Space is the steering key; drop focus so it doesn't also re-toggle this
  // button once it's been clicked/tapped.
  hudTimer.blur();
});

// --- Replay theater state --------------------------------------------------
// "Watch" mode turns the leaderboard into a 1-5 racer picker; starting a replay
// plays those recordings back together, non-interactively, on their own screen.
let watchMode = false;
const watchSelection = new Set<string>();
// Whether the solver's Optimal ghost is picked for the replay (tracked separately
// from the nickname set, since it isn't a server player recording). Counts toward
// the 1-5 racer cap.
let optimalPicked = false;
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
// The solver's "Optimal" ghost, raced alongside the others when ?optimal=true and
// the viewed map has been solved (see the optimal-solver section below).
let optimalGhost: GhostPlayer | null = null;
// The collection ticks of the ghost the live split time is measured against
// (the pb ghost when it's racing, else the leaderboard ghost), or null when no
// ghost is raced. Precomputed once per run.
let referenceCollectTicks: number[] | null = null;
let active: Playable = viewed;
let countdownElapsed = 0;
let lastCountdownStep = -1;
let prevOnRoad = true;
let prevInMud = false;
let prevVisitedCount = 0;
const camera: Camera = { x: viewed.level.width / 2, y: viewed.level.height / 2 };

// --- "Optimal" solver ghost (opt-in via ?optimal=true) ---------------------
// With ?optimal=true, a background Web Worker solves each daily map for a
// near-record delivery route and surfaces it as an "Optimal" leaderboard entry
// plus an extra ghost to race. The search is a heavy single-core compute (up to
// ~15s), so it runs off the main thread and its result is cached per seed. The
// daily-format solver assumes only a handful of warehouses, so it's daily-only
// (weekly maps are far too large).
const optimalEnabled = new URLSearchParams(window.location.search).get("optimal") === "true";
const OPTIMAL_LABEL = "Optimal";
const optimalRecordings = new Map<string, GhostRecording>();
const optimalPending = new Set<string>();
let optimalWorker: Worker | null = null;
let optimalWorkerBroken = false;

/** Lazily creates the shared solver worker, or returns null if the environment
 * can't spin up a module worker (we fall back to an on-thread solve then). */
function getOptimalWorker(): Worker | null {
  if (optimalWorker) return optimalWorker;
  if (optimalWorkerBroken) return null;
  try {
    const w = new Worker(new URL("./game/solver-worker.js", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent) => {
      const data = e.data as { ok: boolean; seed: string; recording?: GhostRecording };
      optimalPending.delete(data.seed);
      if (data.ok && data.recording) receiveOptimal(data.seed, data.recording);
    };
    w.onerror = () => {
      optimalWorkerBroken = true;
    };
    optimalWorker = w;
    return w;
  } catch {
    optimalWorkerBroken = true;
    return null;
  }
}

/** Records a solved route and, if it's for the map on screen, repaints the board
 * so the "Optimal" row appears. */
function receiveOptimal(seed: string, recording: GhostRecording): void {
  optimalRecordings.set(seed, recording);
  if (viewed.seed === seed) renderLeaderboardList();
}

/** Kicks off (or reuses a cached) optimal route for a daily seed when
 * ?optimal=true. Prefers the server's precomputed route (no wait); only if the
 * server hasn't solved it yet - or is unreachable - does it fall back to solving
 * locally. No-op for weekly maps, orphan maps, Easy (the solver only ever
 * targets Hard's physics - there's no Easy optimal ghost), or when already
 * solved/in flight. */
function requestOptimal(playable: Playable): void {
  const { seed, level } = playable;
  if (!optimalEnabled || level.kind !== "daily" || playable.difficulty !== "hard") return;
  if (optimalRecordings.has(seed) || optimalPending.has(seed)) return;
  optimalPending.add(seed);

  // Server precompute first - the common case is an instant cache hit.
  void fetchOptimalRoute(seed).then((remote) => {
    if (remote && Array.isArray(remote.inputLog)) {
      optimalPending.delete(seed);
      receiveOptimal(seed, { seed, time: remote.time, stability: remote.stability, inputLog: remote.inputLog });
    } else {
      solveOptimalLocally(playable);
    }
  });
}

/** Fallback when the server has no precomputed route (fresh day not yet solved,
 * offline, or static hosting): solve on the client. Uses the background worker
 * when available, else a shorter on-thread solve. Assumes `seed` is already
 * marked pending by requestOptimal. */
function solveOptimalLocally(playable: Playable): void {
  const { seed, level } = playable;
  const worker = getOptimalWorker();
  if (worker) {
    worker.postMessage({ seed });
    return;
  }
  // No module-worker support: fall back to a shorter on-thread solve. It briefly
  // blocks the tab, but ?optimal=true is an explicit power-user flag, and the
  // solver module is only fetched in this fallback path.
  void import("./game/solver.js").then(({ solve }) => {
    const result = solve(level, { timeBudgetMs: 5000 });
    optimalPending.delete(seed);
    if (result.success) {
      receiveOptimal(seed, { seed, time: result.time, stability: result.stability, inputLog: result.inputLog });
    }
  });
}

/** The optimal recording for the viewed seed once solved (null otherwise, when
 * the feature is off, or on Easy - there's no Easy optimal ghost). */
function optimalForViewed(): GhostRecording | null {
  return optimalEnabled && viewed.difficulty === "hard" ? optimalRecordings.get(viewed.seed) ?? null : null;
}

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
  renderMinimaps();
  void refreshLeaderboard();
  void restoreSelectedLeaderboardGhost();
}

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
  // Two separate leaderboards only exist on daily maps, so only note the
  // difficulty there - weekly is unambiguously Hard.
  const diffSuffix = playable.level.kind === "daily" && playable.difficulty === "easy" ? " (Easy)" : "";
  const lines = [
    `\u{1F69A} Unstable Truck ${board}${diffSuffix} - ${playable.seed}`,
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
 * transient "Copied!"/"Copy failed" label before reverting to `restLabel`.
 * `source` labels which Share button it is in the run log (e.g. "results",
 * "best"). */
function attachShareHandler(btn: HTMLButtonElement, source: string, restLabel: string, getText: () => string | null): void {
  let resetTimer: number | undefined;
  btn.addEventListener("click", async () => {
    const text = getText();
    if (!text) return;
    const ok = await copyText(text);
    void logRun(viewed.seed, nickname, "shared", 0, `${source}: ${ok ? "copied" : "copy failed"}`);
    btn.textContent = ok ? "Copied!" : "Copy failed";
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      btn.textContent = restLabel;
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

// Time played is banked once per session. Finishing a run is only one of the
// ways one can be over: abandoning to the menu and restarting mid-run both
// leave a session behind without ever reaching endRun(), and that time counts
// just as much as a failed run's does. The flag keeps a run that ends and is
// then left via the menu from being counted twice.
let playTimeBanked = false;

function bankPlayTime(): void {
  if (!session || playTimeBanked) return;
  addPlayTime(session.elapsed);
  playTimeBanked = true;
}

function beginRun(playable: Playable): void {
  // Bank the outgoing run before its session is replaced - restarting mid-run
  // (Backspace, Retry, the menu's Restart) comes straight back through here.
  bankPlayTime();
  // Start from silence. Restarting mid-run re-enters here without passing
  // through endRun() or goHome(), and the start* functions are no-ops when a
  // node already exists - so without this the previous run's terrain loop would
  // keep sounding, frozen at whatever level it held, for the whole new run.
  stopAll();
  active = playable;
  session = new GameSession(playable.level, { difficulty: playable.difficulty });
  playTimeBanked = false;
  // Counts the day as played the moment a run starts, win or lose. Mirrors the
  // guard on recordCompletion so the two stay comparable: daily maps only,
  // never a shared orphan.
  if (playable.level.kind === "daily" && !playable.orphan) recordPlayed(playable.seed);
  pbGhost =
    playable.personalBest && loadRacePbGhostPref()
      ? new GhostPlayer(playable.level, playable.personalBest, playable.difficulty)
      : null;
  leaderboardGhost =
    selectedGhostEntry && selectedGhostEntry.recording.seed === playable.seed
      ? new GhostPlayer(playable.level, selectedGhostEntry.recording, playable.difficulty)
      : null;
  // The Optimal ghost races whenever it's been solved for this map (?optimal=true,
  // Hard only - there's no Easy optimal ghost).
  const optimalRec = optimalEnabled && playable.difficulty === "hard" ? optimalRecordings.get(playable.seed) : undefined;
  optimalGhost = optimalRec ? new GhostPlayer(playable.level, optimalRec, "hard") : null;

  // Live split time is measured against the pb ghost whenever it's racing (even
  // alongside a leaderboard ghost); otherwise the leaderboard ghost if that's
  // the only one. Precompute that ghost's per-checkpoint collection ticks.
  const referenceRecording: GhostRecording | RemoteRecording | null =
    pbGhost && playable.personalBest
      ? playable.personalBest
      : leaderboardGhost && selectedGhostEntry
        ? selectedGhostEntry.recording
        : null;
  referenceCollectTicks = referenceRecording
    ? ghostCollectTicks(playable.level, referenceRecording, playable.difficulty)
    : null;
  hudDelta.textContent = "";
  hudDelta.className = "";
  camera.x = session.truck.pos.x;
  camera.y = session.truck.pos.y;
  countdownElapsed = 0;
  lastCountdownStep = -1;
  prevOnRoad = true;
  prevInMud = false;
  prevVisitedCount = 0;
  appState = "countdown";
  setPaused(false);
  startEngine();
  startAmbience(playable.level.theme);
  // Diagnostic run log: a run begins here (best-effort, ignores failures).
  void logRun(playable.seed, nickname, "started", 0);
  setMenuOpen(false);
  startScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  // Leaving the results behind also drops the name prompt and anything it
  // was holding, so a queued submission can never outlive its run.
  nicknameScreen.classList.add("hidden");
  pendingScoreSubmit = null;
  hud.classList.remove("hidden");
  countdownOverlay.classList.remove("hidden");
}

// The finished run's leaderboard submission, held back while the player is
// asked what name to use. Saving runs it under the chosen name; cancelling
// drops it, keeping that run off the board entirely.
let pendingScoreSubmit: (() => void) | null = null;

/** Asks a player still carrying an auto-generated "Racer1234" name how they
 * want to appear, in place of the results screen rather than on top of it. */
function openNicknamePrompt(submit: () => void): void {
  pendingScoreSubmit = submit;
  nicknamePromptInput.value = nickname;
  nicknameScreen.classList.remove("hidden");
  nicknamePromptInput.focus();
  nicknamePromptInput.select();
}

/** Dismisses the prompt and hands the player on to the results they'd normally
 * have seen straight away. */
function closeNicknamePrompt(): void {
  nicknameScreen.classList.add("hidden");
  resultsScreen.classList.remove("hidden");
}

nicknamePromptSave.addEventListener("click", () => {
  applyNickname(nicknamePromptInput.value);
  // Marked chosen even if the name is unchanged - they were asked and answered.
  markNicknameChosen();
  const submit = pendingScoreSubmit;
  pendingScoreSubmit = null;
  closeNicknamePrompt();
  // Submitted after applyNickname() so the run lands under the new name.
  submit?.();
});

nicknamePromptCancel.addEventListener("click", () => {
  // Neither submits nor marks the name as chosen: this run stays off the
  // leaderboard, and the question comes back after the next finished run.
  pendingScoreSubmit = null;
  closeNicknamePrompt();
});

nicknamePromptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nicknamePromptSave.click();
});

function endRun(): void {
  if (!session) return;
  stopAll();
  bankPlayTime();
  appState = "ended";
  setPaused(false);
  // Diagnostic run log: record how the run ended and how many warehouses were
  // collected (best-effort; a "finished" here with no matching leaderboard row
  // points at a score-submission drop).
  const runStatus =
    session.status === "success" ? "finished" : session.failReason === "outOfBounds" ? "out_of_bounds" : "cargo_fell_off";
  // Record the run's final time too: the finish time on success, or how long the
  // truck survived before failing.
  const timeNote =
    session.status === "success"
      ? `finished in ${formatTime(session.elapsed)}`
      : `survived ${formatTime(session.elapsed)}`;
  void logRun(active.seed, nickname, runStatus, session.visited.size, timeNote);
  hud.classList.add("hidden");
  // Revealing the results is deferred to the end of this function: a player who
  // still has an auto-generated name is asked what to call themselves first,
  // and the results wait behind that.
  // Set by the success branch below, then either run or discarded once that
  // question is settled.
  let submitRun: (() => void) | null = null;
  // The Easy/Hard split only exists on daily maps, so only label results there
  // (weekly is unambiguously Hard).
  const diffSuffix = active.level.kind === "daily" ? ` · ${active.difficulty === "easy" ? "Easy" : "Hard"}` : "";
  if (session.status === "success") {
    resultsTitle.textContent = `Delivered!${diffSuffix}`;
    resultsTime.textContent = `Time: ${formatTime(session.elapsed)}`;
    resultsStability.textContent = `Cargo stability at delivery: ${Math.round(session.stability)}%`;

    // The champion reference is the leaderboard's current #1 (as last loaded,
    // i.e. the record being chased, not this just-finished run).
    const champion = currentChampionTime();
    const medal = medalFor(session.elapsed, active.pars, champion);
    showMedal(medal, active.pars, champion);
    if (medal) playMedalFanfare(medal);

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
    const isNewBest = savePersonalBestIfBetter(recording, active.difficulty);
    if (isNewBest) {
      active.personalBest = recording;
      // No navigation happens mid-run, so `active` is still `viewed` here.
      refreshViewedUi();
    }

    // Mark the day delivered and repaint the streak strip - AFTER saving the
    // personal best above, so today's dot renders with its freshly-earned medal
    // (read from active.personalBest) instead of staying grey until a refresh.
    // The streak is a live daily-play concept only (never a shared orphan map).
    if (active.level.kind === "daily" && !active.orphan) {
      recordCompletion(active.seed);
      renderProgressStrip();
      if (loadSyncToken()) void doSync();
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
      const submittedDifficulty = active.difficulty;
      const championCandidate = championTime(active.pars.gold, recording.time);
      const isCurrentPeriod =
        active.level.kind === "weekly" ? submittedSeed === weekSeed(0) : submittedSeed === todaysSeed;
      // Deferred rather than called: `nickname` is read when this runs, so a
      // name chosen at the prompt is the one the run is submitted under.
      submitRun = () =>
        void submitScore(
          submittedSeed,
          nickname,
          submittedDifficulty,
          recording.time,
          recording.stability,
          recording.inputLog,
          championCandidate,
          isCurrentPeriod,
          medal,
        ).then(async () => {
          if (submittedSeed === viewed.seed && submittedDifficulty === viewed.difficulty) {
            await refreshLeaderboard();
            // The board now reflects this run, so the player's world rank is
            // final - fold it into the share text (a no-op if they're unranked).
            lastShareText = buildShareText(sharePlayable, shareTime, medal, myWorldRank());
          }
          // A new record today can lower the champion threshold; refresh the strip
          // so the day's dot recolours (the player may gain or lose champion) -
          // only while the strip is still showing that same difficulty.
          if (active.level.kind === "daily" && submittedDifficulty === difficulty) void refreshStripChampionTimes();
        });
    }
  } else if (session.failReason === "outOfBounds") {
    // Easy ignores both failure reasons (see GameSession.update), so reaching
    // either branch below means this was necessarily a Hard run - no need to
    // label it, unlike the success branch above.
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

  // A run worth putting on the leaderboard, by someone who has never been asked
  // what to call themselves, is the one moment where the question is actually
  // worth interrupting for. `submitRun` being set already implies a successful,
  // non-orphan run, so there's nothing to ask about otherwise.
  if (submitRun && !hasChosenNickname() && isDefaultNickname(nickname)) {
    openNicknamePrompt(submitRun);
  } else {
    submitRun?.();
    resultsScreen.classList.remove("hidden");
  }
}

/** Leaves a run, countdown, or the results screen (no result is recorded if
 * mid-run) and returns to the start screen. */
function goHome(): void {
  if (appState !== "playing" && appState !== "countdown" && appState !== "ended") return;
  appState = "start";
  // Abandoning a run mid-flight (Escape, or the menu's Home button) is a second
  // exit path alongside endRun(), and it has to silence the run too - otherwise
  // the engine, ambience and any terrain loop keep playing over the menu.
  stopAll();
  // Abandoning part-way through still counts as time played - bank it before
  // the session it's measured from is dropped.
  bankPlayTime();
  setPaused(false);
  setMenuOpen(false);
  session = null;
  pbGhost = null;
  optimalGhost = null;
  leaderboardGhost = null;
  hud.classList.add("hidden");
  countdownOverlay.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  // Leaving the results behind also drops the name prompt and anything it
  // was holding, so a queued submission can never outlive its run.
  nicknameScreen.classList.add("hidden");
  pendingScoreSubmit = null;
  startScreen.classList.remove("hidden");
  // A just-finished first delivery flips "has played", which reveals the browse
  // arrows and the Easy/Hard switch - re-evaluate both now that we're back on
  // the menu, rather than waiting for the next navigation/mode change to do it.
  updateNavButtons();
  updateDifficultySwitchVisibility();
  // Returning to the menu is a page-internal transition (no reload), so
  // game_started never re-fires here - log it as its own menu-shown event.
  void logRun(viewed.seed, nickname, "menu_shown", 0);
}

retryBtn.addEventListener("click", () => beginRun(active));
homeBtn.addEventListener("click", goHome);

// --- New-player tutorial ---------------------------------------------------
// A short, guided course of unfailable practice sections, each explained on a
// frozen scene and then played. It renders straight from the Tutorial rather
// than through the normal run's render state, shows its own coach overlay
// instead of the HUD, and never touches scores, ghosts, or storage beyond
// marking itself seen on exit.

// The active tutorial section's truck; when this object reference changes (a
// new section, a retry after a setback, "Explain again") the camera snaps to it
// instead of panning across empty ground.
let lastTutorialTruck: TruckState | null = null;

/** Syncs the coach overlay (badge, copy, timer, buttons) and the shared 3-2-1-GO
 * overlay to the tutorial's current section and phase. */
function refreshTutorialOverlay(): void {
  if (!tutorial) return;
  const explaining = tutorial.phase === "explain";
  const cleared = tutorial.phase === "complete";
  const last = tutorial.isLastSection;

  const badge = `${tutorial.sectionNumber}/${tutorial.sectionCount} · ${tutorial.sectionTitle}`;
  const copy = tutorial.lines.join("\n");
  // This runs every frame, and re-assigning identical text still rebuilds the
  // text node - which would yank a scrolled-down explanation back to the top on
  // the very next frame. So only write when something actually changed.
  if (tutorialBadge.textContent !== badge) tutorialBadge.textContent = badge;
  if (tutorialPrompt.textContent !== copy) tutorialPrompt.textContent = copy;
  const left = tutorial.secondsLeft;
  tutorialTimer.textContent = left === null ? "" : `${left}s left`;
  tutorialTimer.classList.toggle("hidden", left === null);
  // Only an 'explain' part takes pointer events (see the CSS): while playing,
  // presses must fall through the card to the canvas to steer the truck.
  tutorialOverlay.classList.toggle("explaining", explaining);

  tutorialTryBtn.classList.toggle("hidden", !explaining);
  // The choice offered once a section is cleared: go over it again, move on -
  // or, on the last section, finish (which is also why "Skip tutorial" drops
  // out there, since it would do the same thing).
  tutorialAgainBtn.classList.toggle("hidden", !cleared);
  tutorialNextBtn.classList.toggle("hidden", !cleared || last);
  tutorialDoneBtn.classList.toggle("hidden", !cleared || !last);
  tutorialSkipBtn.classList.toggle("hidden", cleared && last);
  // Bailing out of a section is offered while working on it, never after it's
  // been cleared (and not on the last one, where skipping is just leaving).
  tutorialSkipSectionBtn.classList.toggle("hidden", cleared || last);

  const count = tutorial.countdownLabel;
  countdownOverlay.classList.toggle("hidden", count === null);
  if (count !== null) countdownText.textContent = count;
}

/** Enters the tutorial from the start screen: a fresh guided run with the coach
 * overlay up. Rendering is driven directly from the Tutorial (see the frame
 * loop), so it doesn't touch the normal run's render state or ghosts. */
function startTutorial(): void {
  void logRun(viewed.seed, nickname, "tutorial_started", 0);
  tutorial = new Tutorial();
  lastTutorialTruck = null;
  camera.x = tutorial.activeTruck.pos.x;
  camera.y = tutorial.activeTruck.pos.y;
  accumulator = 0;
  appState = "tutorial";

  startScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  // Leaving the results behind also drops the name prompt and anything it
  // was holding, so a queued submission can never outlive its run.
  nicknameScreen.classList.add("hidden");
  pendingScoreSubmit = null;
  hud.classList.add("hidden");
  countdownOverlay.classList.add("hidden");
  tutorialOverlay.classList.remove("hidden");
  refreshTutorialOverlay();
}

/** Leaves the tutorial (completed or skipped) back to the start screen.
 * `reason` is logged as free-form context (e.g. how the player left: finished,
 * skipped, escape). */
function endTutorial(reason = "closed"): void {
  if (appState !== "tutorial") return;
  void logRun(viewed.seed, nickname, "tutorial_ended", 0, reason);
  tutorial = null;
  appState = "start";
  tutorialOverlay.classList.add("hidden");
  // The 3-2-1-GO overlay is shared with normal runs, so make sure a count-in
  // that was on screen when the player bailed doesn't outlive the tutorial.
  countdownOverlay.classList.add("hidden");
  startScreen.classList.remove("hidden");
}

/** Wires a coach-overlay button, dropping keyboard focus first: the spacebar is
 * the steering control, so a button left focused after a click would fire again
 * on the player's next hold. */
function onTutorialAction(btn: HTMLButtonElement, run: () => void): void {
  btn.addEventListener("click", () => {
    btn.blur();
    run();
  });
}

tutorialBtn.addEventListener("click", startTutorial);
onTutorialAction(tutorialSkipBtn, () => endTutorial("skipped"));
onTutorialAction(tutorialDoneBtn, () => endTutorial("finished"));
onTutorialAction(tutorialTryBtn, () => {
  tutorial?.tryItOut();
  refreshTutorialOverlay();
});
onTutorialAction(tutorialAgainBtn, () => {
  tutorial?.explainAgain();
  refreshTutorialOverlay();
});
// "Next section" and "Skip section" do the same thing - move on - and differ
// only in whether the section was cleared first. Neither can run out of
// sections (both are hidden on the last one), but if one somehow did, leaving
// the tutorial is the right landing spot.
for (const [btn, reason] of [
  [tutorialNextBtn, "finished"],
  [tutorialSkipSectionBtn, "section_skipped"],
] as const) {
  onTutorialAction(btn, () => {
    if (tutorial && !tutorial.nextSection()) endTutorial(reason);
    else refreshTutorialOverlay();
  });
}

// --- Replay theater --------------------------------------------------------
// Pick 1-5 leaderboard players and watch their ghosts race each other, with a
// video-style player (play/pause, a seekable progress bar, and stop). Like
// racing a ghost, it needs your own time on the level first.

/** Shows the "Create a replay" button only once there's a personal best on the
 * viewed level (same gate as racing a ghost); hidden entirely otherwise, rather
 * than shown-but-disabled. */
function updateWatchButton(): void {
  const unlocked = viewed.personalBest != null;
  watchBtn.classList.toggle("hidden", !unlocked);
}

/** The pick-bar's prompt and "Show replay" label are static; this just gates the
 * button on having picked at least one racer - a leaderboard player or the
 * Optimal ghost (capped at MAX_REPLAY_RACERS by the toggles). */
function updateWatchBar(): void {
  replayStartBtn.disabled = totalWatchPicks() < 1;
}

function enterWatchMode(): void {
  if (viewed.personalBest == null) return; // gated, mirrors the button state
  watchMode = true;
  watchSelection.clear();
  optimalPicked = false;
  watchBtn.classList.add("hidden");
  replaySelectBar.classList.remove("hidden");
  // Reset any leftover prompt/label from a prior aborted attempt.
  replayStartBtn.textContent = "Show replay";
  updateWatchBar();
  renderLeaderboardList();
}

function exitWatchMode(): void {
  if (!watchMode) return;
  watchMode = false;
  watchSelection.clear();
  optimalPicked = false;
  replaySelectBar.classList.add("hidden");
  watchBtn.classList.remove("hidden");
  renderLeaderboardList();
}

/** Toggles a player into/out of the replay selection, capped at 5 (the Optimal
 * ghost, if picked, counts toward that cap). */
function toggleWatchPick(nickname: string): void {
  if (watchSelection.has(nickname)) {
    watchSelection.delete(nickname);
  } else {
    if (totalWatchPicks() >= MAX_REPLAY_RACERS) return;
    watchSelection.add(nickname);
  }
  updateWatchBar();
  renderLeaderboardList();
}

/** Fetches the selected players' recordings and opens the replay theater. The
 * picked Optimal ghost (if any) is included directly from its solved recording -
 * no fetch, since it isn't a server player. */
async function startReplay(): Promise<void> {
  const seed = viewed.seed;
  const level = viewed.level;
  const replayDifficulty = viewed.difficulty;
  const nicknames = [...watchSelection];
  const optimalRecording = optimalPicked ? optimalRecordings.get(seed) : undefined;
  if (nicknames.length === 0 && !optimalRecording) return;

  replayStartBtn.disabled = true;
  replayStartBtn.textContent = "Loading…";
  const recordings = await Promise.all(nicknames.map((n) => fetchPlayerRecording(seed, n, replayDifficulty)));

  const racers: ReplayRacer[] = [];
  // The Optimal ghost leads the pack (first colour) when picked.
  if (optimalRecording) {
    racers.push({ label: OPTIMAL_LABEL, color: REPLAY_COLORS[0]!, recording: optimalRecording });
  }
  recordings.forEach((rec, i) => {
    if (rec) racers.push({ label: nicknames[i]!, color: REPLAY_COLORS[racers.length]!, recording: rec });
  });
  if (racers.length === 0) {
    // Offline or the recordings couldn't be fetched; stay in pick mode.
    replayStartBtn.textContent = "Show replay";
    replaySelectCount.textContent = "Couldn't load those replays - try again.";
    updateWatchBar();
    return;
  }

  replay = new ReplayTheater(level, racers, replayDifficulty);
  replayLevel = level;
  replayProgress.max = String(replay.totalTicks);
  replayProgress.value = "0";
  replayScrubbing = false;
  accumulator = 0;
  exitWatchMode();
  void logRun(seed, nickname, "replay_started", 0, `${racers.length} racers: ${racers.map((r) => r.label).join(", ")}`);

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
  void logRun(replayLevel?.seed ?? viewed.seed, nickname, "replay_stopped", 0);
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
helpDetailCheckbox.addEventListener("change", () => {
  setHelpDetail(helpDetailCheckbox.checked);
  void logRun(viewed.seed, nickname, "help_toggled", 0, helpDetailCheckbox.checked ? "full" : "summary");
});

function openHelp(): void {
  helpOpen = true;
  setHelpDetail(false); // always reopen on the summary
  helpScreen.classList.remove("hidden");
  void logRun(viewed.seed, nickname, "help_opened", 0);
}
function closeHelp(): void {
  helpOpen = false;
  helpScreen.classList.add("hidden");
}
howToBtn.addEventListener("click", openHelp);
helpCloseBtn.addEventListener("click", closeHelp);
helpScreen.addEventListener("click", (e) => {
  if (e.target === helpScreen) closeHelp();
});

// --- Profile screen --------------------------------------------------------

let profileOpen = false;

function showSyncError(msg: string): void {
  syncError.textContent = msg;
  syncError.classList.remove("hidden");
}
function hideSyncError(): void {
  syncError.classList.add("hidden");
}

function updateSyncUi(): void {
  const token = loadSyncToken();
  if (token) {
    syncUnlinked.classList.add("hidden");
    syncLinked.classList.remove("hidden");
    syncCodeValue.textContent = token;
  } else {
    syncUnlinked.classList.remove("hidden");
    syncLinked.classList.add("hidden");
  }
  hideSyncError();
}

function applyRemoteState(data: { nickname: string; difficulty: string | null; completed: string[] }): void {
  if (data.nickname) {
    setNickname(data.nickname);
    nickname = getOrCreateNickname();
    nicknameInput.value = nickname;
  }
  if (data.difficulty === "easy" || data.difficulty === "hard") {
    saveDifficultyPref(data.difficulty);
  }
  if (data.completed.length > 0) {
    for (const seed of data.completed) recordCompletion(seed);
    renderProgressStrip();
  }
  renderLeaderboardList();
  refreshViewedUi();
}

async function syncPersonalBest(): Promise<void> {
  const recording = await fetchPlayerRecording(viewed.seed, nickname, viewed.difficulty);
  if (!recording) return;
  const ghost: GhostRecording = { seed: recording.seed, time: recording.time, stability: recording.stability, inputLog: recording.inputLog };
  if (savePersonalBestIfBetter(ghost, viewed.difficulty)) {
    viewed.personalBest = ghost;
    playableCache[mode][viewed.difficulty].delete(viewedOffset);
    refreshViewedUi();
  }
}

async function doSync(): Promise<void> {
  const token = loadSyncToken();
  if (!token) return;
  syncNowBtn.disabled = true;
  syncStatus.textContent = "Syncing…";
  const completed = [...loadCompletedDays()];
  const diffPref = loadDifficultyPref();
  const result = await pushSyncAccount(token, nickname, diffPref, completed);
  if (!result) {
    syncStatus.textContent = "Sync failed";
    syncNowBtn.disabled = false;
    return;
  }
  applyRemoteState(result);
  await syncPersonalBest();
  syncStatus.textContent = `Synced just now`;
  syncNowBtn.disabled = false;
}

function formatPlayTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(totalSeconds)}s`;
}

function renderLocalStats(): void {
  const completed = loadCompletedDays();
  // Streaks are a completion concept - they're about finishing days in a row -
  // but "days played" and "first day" are not, so those read from the played
  // history, which counts a day whether or not the run was ever finished.
  const played = loadPlayedDays();
  const sorted = [...played].sort();
  const daysPlayed = played.size;
  const streak = currentStreak(completed);
  const bestStreak = computeBestStreak(completed);
  const firstDay = sorted.length > 0 ? sorted[0]! : "—";
  const playTime = formatPlayTime(loadPlayTime());

  statsLocal.innerHTML = "";
  const rows: [string, string][] = [
    ["Days played", String(daysPlayed)],
    ["Current streak", streak > 0 ? `${streak} days` : "—"],
    ["Best streak", bestStreak > 0 ? `${bestStreak} days` : "—"],
    ["First day", firstDay],
    ["Total play time", playTime],
  ];
  for (const [label, value] of rows) {
    const l = document.createElement("span");
    l.className = "stat-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "stat-value";
    v.textContent = value;
    statsLocal.append(l, v);
  }
}

let statsDifficulty: Difficulty = "hard";

function renderServerStats(data: PlayerStatsResponse | null): void {
  statsServer.innerHTML = "";
  if (!data) {
    statsServerError.textContent = "Server stats unavailable";
    statsServerError.classList.remove("hidden");
    return;
  }
  statsServerError.classList.add("hidden");

  const totalMedals = data.medals.champion + data.medals.gold + data.medals.silver + data.medals.bronze;
  const rows: [string, string][] = [
    ["Scores submitted", String(data.totalScores)],
    ["Medals earned", String(totalMedals)],
    ["World #1 finishes", String(data.worldFirsts)],
  ];
  for (const [label, value] of rows) {
    const l = document.createElement("span");
    l.className = "stat-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "stat-value";
    v.textContent = value;
    statsServer.append(l, v);
  }

  if (totalMedals > 0 || data.medals.none > 0) {
    const medalRow = document.createElement("div");
    medalRow.className = "stat-medals";
    const icons: [string, number][] = [
      ["\u{1F3C6}", data.medals.champion],
      ["\u{1F947}", data.medals.gold],
      ["\u{1F948}", data.medals.silver],
      ["\u{1F949}", data.medals.bronze],
    ];
    for (const [icon, count] of icons) {
      if (count === 0) continue;
      const span = document.createElement("span");
      span.className = "medal-count";
      span.textContent = `${icon} ${count}`;
      medalRow.append(span);
    }
    statsServer.append(medalRow);
  }
}

async function loadServerStats(): Promise<void> {
  statsServer.innerHTML = "";
  statsServerError.textContent = "Loading…";
  statsServerError.classList.remove("hidden");
  const data = await fetchStats(nickname, statsDifficulty);
  renderServerStats(data);
}

function updateStatsDifficultyUi(): void {
  statsDiffEasy.classList.toggle("active", statsDifficulty === "easy");
  statsDiffHard.classList.toggle("active", statsDifficulty === "hard");
  statsDiffEasy.setAttribute("aria-selected", String(statsDifficulty === "easy"));
  statsDiffHard.setAttribute("aria-selected", String(statsDifficulty === "hard"));
}

statsDiffEasy.addEventListener("click", () => {
  if (statsDifficulty === "easy") return;
  statsDifficulty = "easy";
  updateStatsDifficultyUi();
  void loadServerStats();
});
statsDiffHard.addEventListener("click", () => {
  if (statsDifficulty === "hard") return;
  statsDifficulty = "hard";
  updateStatsDifficultyUi();
  void loadServerStats();
});

const MUTE_ICON = "\u{1F508}"; // 🔈 speaker with no waves
const UNMUTE_ICON = "\u{1F50A}"; // 🔊 speaker with waves

function updateMuteBtn(btn: HTMLButtonElement, muted: boolean): void {
  btn.textContent = muted ? MUTE_ICON : UNMUTE_ICON;
  btn.classList.toggle("muted", muted);
  btn.title = muted ? "Unmute" : "Mute";
}

function syncSoundUi(): void {
  const p = loadSoundPrefs();
  soundGameSlider.value = String(p.game);
  soundAmbientSlider.value = String(p.ambient);
  soundEffectsSlider.value = String(p.effects);
  soundGameVal.textContent = `${p.game}%`;
  soundAmbientVal.textContent = `${p.ambient}%`;
  soundEffectsVal.textContent = `${p.effects}%`;
  updateMuteBtn(soundGameMute, p.gameMuted);
  updateMuteBtn(soundAmbientMute, p.ambientMuted);
  updateMuteBtn(soundEffectsMute, p.effectsMuted);
}

function openProfile(): void {
  profileOpen = true;
  nicknameInput.value = nickname;
  updateSyncUi();
  renderLocalStats();
  syncSoundUi();
  statsDifficulty = difficulty;
  updateStatsDifficultyUi();
  statsDiffSwitch.classList.remove("hidden");
  void loadServerStats();
  profileScreen.classList.remove("hidden");
}
function closeProfile(): void {
  profileOpen = false;
  profileScreen.classList.add("hidden");
}
profileBtn.addEventListener("click", openProfile);
profileCloseBtn.addEventListener("click", closeProfile);
profileScreen.addEventListener("click", (e) => {
  if (e.target === profileScreen) closeProfile();
});

// --- Sound settings wiring ---
function applySoundPrefs(): void {
  const p = loadSoundPrefs();
  p.game = +soundGameSlider.value;
  p.ambient = +soundAmbientSlider.value;
  p.effects = +soundEffectsSlider.value;
  soundGameVal.textContent = `${p.game}%`;
  soundAmbientVal.textContent = `${p.ambient}%`;
  soundEffectsVal.textContent = `${p.effects}%`;
  saveSoundPrefs(p);
  setSoundPrefs(p);
}
soundGameSlider.addEventListener("input", applySoundPrefs);
soundAmbientSlider.addEventListener("input", applySoundPrefs);
soundEffectsSlider.addEventListener("input", applySoundPrefs);

function toggleMute(key: "gameMuted" | "ambientMuted" | "effectsMuted", btn: HTMLButtonElement): void {
  const p = loadSoundPrefs();
  p[key] = !p[key];
  updateMuteBtn(btn, p[key]);
  saveSoundPrefs(p);
  setSoundPrefs(p);
}
soundGameMute.addEventListener("click", () => toggleMute("gameMuted", soundGameMute));
soundAmbientMute.addEventListener("click", () => toggleMute("ambientMuted", soundAmbientMute));
soundEffectsMute.addEventListener("click", () => toggleMute("effectsMuted", soundEffectsMute));

// Load saved prefs at startup
setSoundPrefs(loadSoundPrefs());

// Mobile browsers refuse to start an AudioContext outside a user gesture, and
// a context that first gets created outside one stays suspended for good - so
// on a phone the game's first sound is silently discarded and nothing works
// for the rest of the session. Unlock on the very first interaction of any
// kind, then drop the listeners.
// Listeners are capture-phase and cover every gesture type there is: the input
// layer calls preventDefault() on touchstart, and buttons stop events of their
// own, so a bubble-phase listener can be starved of the very gesture it needs.
const UNLOCK_EVENTS = ["pointerdown", "touchstart", "touchend", "mousedown", "click", "keydown"] as const;
function unlockOnFirstGesture(): void {
  unlockAudio();
  // Keep listening until the context genuinely reports "running". On some
  // mobile browsers the first gesture creates the context but the resume only
  // takes effect on a later one, and unhooking after a single attempt leaves
  // the game silent for the rest of the session.
  if (audioState() !== "running") return;
  for (const ev of UNLOCK_EVENTS) window.removeEventListener(ev, unlockOnFirstGesture, true);
}
for (const ev of UNLOCK_EVENTS) window.addEventListener(ev, unlockOnFirstGesture, true);

// Mobile suspends the context whenever the page goes to the background; coming
// back needs an explicit resume or everything stays silent.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) resumeAudio();
});

syncGenerateBtn.addEventListener("click", async () => {
  hideSyncError();
  syncGenerateBtn.disabled = true;
  const completed = [...loadCompletedDays()];
  const diffPref = loadDifficultyPref();
  const token = await createSyncAccount(nickname, diffPref, completed);
  syncGenerateBtn.disabled = false;
  if (!token) {
    showSyncError("Could not create sync code. Try again later.");
    return;
  }
  saveSyncToken(token);
  updateSyncUi();
  syncStatus.textContent = "Synced just now";
});

syncLinkBtn.addEventListener("click", async () => {
  hideSyncError();
  const code = syncLinkInput.value.trim().toLowerCase();
  if (!/^[a-z2-9]{6}$/.test(code)) {
    showSyncError("Code must be 6 characters.");
    return;
  }
  syncLinkBtn.disabled = true;
  const account = await fetchSyncAccount(code);
  syncLinkBtn.disabled = false;
  if (!account) {
    showSyncError("Code not found. Check and try again.");
    return;
  }
  saveSyncToken(code);
  applyRemoteState(account);
  // Push local state to merge completed days
  void doSync();
  updateSyncUi();
});

syncCopyBtn.addEventListener("click", async () => {
  const token = loadSyncToken();
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    syncCopyBtn.textContent = "Copied!";
    setTimeout(() => { syncCopyBtn.textContent = "Copy"; }, 1500);
  } catch {
    syncCopyBtn.textContent = "Failed";
    setTimeout(() => { syncCopyBtn.textContent = "Copy"; }, 1500);
  }
});

syncNowBtn.addEventListener("click", () => void doSync());

syncUnlinkBtn.addEventListener("click", () => {
  clearSyncToken();
  updateSyncUi();
  syncStatus.textContent = "";
});

attachShareHandler(shareBtn, "results", "Share", () => lastShareText);
attachShareHandler(bestShareBtn, "best", "Share personal best", currentBestShareText);
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
// The explicit Play button is the discoverable way to start; tapping the map
// still works as a shortcut.
playBtn.addEventListener("click", () => beginRun(viewed));

window.addEventListener("keydown", (e) => {
  // The leaderboard-name prompt is modal: Enter saves (handled on the field
  // itself) and Escape cancels, while the run controls behind it stay inert -
  // otherwise Enter would save the name and immediately restart the run.
  if (!nicknameScreen.classList.contains("hidden")) {
    if (e.key === "Escape") nicknamePromptCancel.click();
    return;
  }
  // While the help overlay is up it captures Escape (to close itself) and
  // swallows the other run controls.
  if (profileOpen) {
    if (e.key === "Escape") closeProfile();
    return;
  }
  if (helpOpen) {
    if (e.key === "Escape") closeHelp();
    return;
  }
  // The tutorial owns its input: Escape skips it, and the normal run controls
  // (Enter/Backspace) are inert while it's up. Spacebar still steers via input.ts.
  if (appState === "tutorial") {
    if (e.key === "Escape") endTutorial("escape");
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
  if (optimalGhost) {
    ghostViews.push({ truck: optimalGhost.truck, cargoBoxes: optimalGhost.cargoBoxes, label: "optimal" });
  }
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
    const step = countdownLabel(countdownElapsed);
    if (step === null) {
      appState = "playing";
      accumulator = 0;
      countdownOverlay.classList.add("hidden");
      startWobble();
    } else {
      const stepIdx = Math.floor(countdownElapsed / COUNTDOWN_STEP_DURATION);
      if (stepIdx !== lastCountdownStep) {
        lastCountdownStep = stepIdx;
        playCountdownTone(step === "GO");
      }
      countdownText.textContent = step;
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
        optimalGhost?.update(FIXED_DT);
        leaderboardGhost?.update(FIXED_DT);
        accumulator -= FIXED_DT;
        steps++;
      }
    } else {
      accumulator = 0;
    }
    if (!paused) {
      const topSpeed = session.difficulty === "easy" ? EASY_MAX_SPEED : BASE_MAX_SPEED;
      const speed01 = session.truck.speed / topSpeed;
      updateEngine(speed01);
      updateWobble(session.stability);

      const { onRoad, inMud } = session.lastTerrain;
      const onGrass = !onRoad && !inMud;
      const wasOnGrass = !prevOnRoad && !prevInMud;
      if (onGrass && !wasOnGrass) startGrass();
      if (onGrass) updateGrass(speed01);
      if (!onGrass && wasOnGrass) stopGrass();

      if (inMud && !prevInMud) startMud();
      if (inMud) updateMud(speed01);
      if (!inMud && prevInMud) stopMud();

      prevOnRoad = onRoad;
      prevInMud = inMud;

      if (session.rockHitThisTick) playRockCrash();

      if (session.visited.size > prevVisitedCount) {
        playPickupChime();
        prevVisitedCount = session.visited.size;
      }
    }
    renderScene(session, paused ? 0 : frameDt);

    hudTimer.textContent = formatTime(session.elapsed);
    hudObjective.textContent = session.allPickedUp
      ? "Deliver to destination"
      : `Pick up cargo (${session.visited.size}/${session.pickups.length})`;
    updateSplitDelta();

    if (session.status !== "playing") endRun();
  } else if (appState === "tutorial" && tutorial) {
    // Only a "play" part advances physics: an explanation, its 3-2-1-GO count-in
    // and the cleared-section choice all freeze the truck on the start line (or
    // wherever it finished), while the scene keeps re-rendering underneath.
    const playing = tutorial.phase === "play";
    if (playing) {
      accumulator += frameDt;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        tutorial.tick(input.held);
        accumulator -= FIXED_DT;
        steps++;
      }
    } else {
      tutorial.advanceCountdown(frameDt); // no-op unless counting in
      accumulator = 0;
    }
    // A restart (new section, retry after a setback, "Explain again") hands over
    // a fresh truck object; snap the camera to it rather than panning across.
    if (tutorial.activeTruck !== lastTutorialTruck) {
      camera.x = tutorial.activeTruck.pos.x;
      camera.y = tutorial.activeTruck.pos.y;
      lastTutorialTruck = tutorial.activeTruck;
    }
    updateCamera(camera, tutorial.activeTruck, playing ? frameDt : 0);
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
