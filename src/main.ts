import {
    backfillChampionTime,
    fetchCampaignOverrides,
    fetchChampionTimes,
    fetchLeaderboard,
    fetchOptimalRoute,
    fetchPlayerRecording,
    fetchStats,
    fetchSyncAccount,
    logRun,
    saveCampaignOverride,
    submitScore,
    type Difficulty,
    type LeaderboardEntry,
    type PlayerStatsResponse,
    type RemoteRecording,
} from "./game/api.js";
import { COUNTDOWN_STEP_DURATION, countdownLabel } from "./game/countdown.js";
import { GhostPlayer, ghostCollectTicks, splitDelta, type GhostRecording } from "./game/ghost.js";
import { currentUser, deleteAccount, isLoggedIn, login, logout, refreshAccount, register, updateAccount } from "./game/auth.js";
import { createInput } from "./game/input.js";
import { optimalRowIndex } from "./game/leaderboard-order.js";
import {
    MEDAL_ICON,
    MEDAL_LABEL,
    championTime,
    clampParsToOptimal,
    computeEasyMedalPars,
    computeMedalPars,
    medalFor,
    type Medal,
    type MedalPars,
} from "./game/medals.js";
import { renderMinimap, renderReplayWorld, renderWorld, updateCamera, type Camera, type GhostView, type WorldHint } from "./game/render.js";
import { startHeading } from "./game/start-heading.js";
import { distance, sub, add, scale as scaleVec, type Vec2 } from "./util/vec2.js";
import { MAX_REPLAY_RACERS, REPLAY_COLORS, ReplayTheater, type ReplayRacer } from "./game/replay.js";
import { GameSession } from "./game/session.js";
import { pullAccountBests, syncAccountState } from "./game/sync.js";
import {
    accountPromptRecentlyDeclined,
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
    recordAccountPromptDeclined,
    setNickname,
    loadSoundPrefs,
    saveSoundPrefs,
    storageFellBack,
} from "./game/storage.js";
import { resolveShareUrl, resolveSourceTag } from "./game/config.js";
import { COUNTRIES } from "./game/countries.js";
import { Tutorial } from "./game/tutorial.js";
import { CAMPAIGN_TOTAL, parseCampaignSeed } from "./level/campaign.js";
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

/** Solver routes by seed, from the server's precompute or a local solve.
 *
 * Declared up here rather than with the rest of the optimal-ghost machinery
 * below because parsFor() reads it, and parsFor runs while the first Playable is
 * built at module scope - a `const` further down the file would still be in its
 * temporal dead zone at that point, and touching it would throw before anything
 * rendered. */
const optimalRecordings = new Map<string, GhostRecording>();

/** Medal targets for a level.
 *
 * Geometry-derived, then raised if the solver's route for this seed is known to
 * be slower than the geometric gold - see clampParsToOptimal. The optimal time
 * arrives asynchronously, so this is re-run for every built level on a seed once
 * it lands (applyOptimalToPars). Easy derives from the adjusted Hard pars, since
 * the solver only ever targets Hard's physics. */
function parsFor(level: Level, seed: string, difficulty: Difficulty): MedalPars {
  const geometric = computeMedalPars(level);
  const optimalTime = optimalRecordings.get(seed)?.time;
  const hardPars = optimalTime != null ? clampParsToOptimal(geometric, optimalTime) : geometric;
  return difficulty === "easy" ? computeEasyMedalPars(hardPars) : hardPars;
}

function makePlayable(seed: string, kind: Mode, difficulty: Difficulty): Playable {
  const level = kind === "weekly" ? generateWeeklyLevel(seed) : generateLevel(seed);
  return {
    seed,
    level,
    difficulty,
    personalBest: loadPersonalBest(seed, difficulty),
    pars: parsFor(level, seed, difficulty),
  };
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
let campaignNav: { prefix: string; index: number } | null = null;

// --- Landing / campaign screen navigation -----------------------------------
const MONTH_ABBRS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/** The campaign is Hard-only, like the weekly board.
 *
 * It's a fixed 25-map ladder whose unlock gates are stated in medals, with one
 * leaderboard per map and a total summing all 25. An Easy board beside it would
 * split every one of those in two and leave the total meaning two different
 * things depending on a preference set elsewhere. So campaign maps ignore the
 * Easy/Hard preference entirely rather than honouring it. */
const CAMPAIGN_DIFFICULTY: Difficulty = "hard";

function campaignPrefix(): string {
  const now = new Date();
  return `${now.getFullYear()}-${MONTH_ABBRS[now.getMonth()]!}-`;
}

function campaignMonthLabel(): string {
  const now = new Date();
  return now.toLocaleString("en", { month: "long" });
}

let homeTarget: "landing" | "campaign" = "landing";
let campaignMonthOffset = 0;

/** Admin-chosen alternate maps, keyed by the slot's *default* seed. An entry
 * rerolls that slot's map for every player (see server/routes.ts's
 * /api/campaign/overrides), which is why it's fetched rather than stored
 * locally - all players must resolve a slot to the same seed. */
const campaignOverrides = new Map<string, string>();

/** The month `offset` months back, anchored to the 1st: going via setMonth on
 * today's date would overflow (April 31 -> May 1) for offsets taken on a 29th
 * to 31st, silently naming the wrong campaign. */
function campaignMonthDate(offset: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + offset, 1);
}

function campaignPrefixForOffset(offset: number): string {
  const d = campaignMonthDate(offset);
  return `${d.getFullYear()}-${MONTH_ABBRS[d.getMonth()]!}-`;
}

function campaignMonthLabelForOffset(offset: number): string {
  return campaignMonthDate(offset).toLocaleString("en", { month: "long", year: "numeric" });
}

/** The seed a campaign slot resolves to, applying any admin alternate-map
 * choice. The default seed stays the map's identity for override lookup, so
 * swapping the suffix back restores the original map exactly. */
function campaignSeedFor(prefix: string, index: number): string {
  const base = `${prefix}C${String(index).padStart(2, "0")}`;
  const suffix = campaignOverrides.get(base);
  return suffix ? `${base}-${suffix}` : base;
}

function campaignSeedForIndex(index: number): string {
  return campaignSeedFor(campaignPrefix(), index);
}

/** Pulls one campaign month's alternate-map choices into campaignOverrides.
 * Reports whether anything changed, so a caller can skip rebuilding the grid
 * (25 level generations) when nothing did. A failed fetch changes nothing and
 * leaves the default maps in place. */
async function loadCampaignOverrides(offset: number): Promise<boolean> {
  const prefix = campaignPrefixForOffset(offset);
  const fetched = await fetchCampaignOverrides(prefix);
  if (!fetched) return false;
  let changed = false;
  for (let i = 1; i <= CAMPAIGN_TOTAL; i++) {
    const base = `${prefix}C${String(i).padStart(2, "0")}`;
    const next = fetched[String(i).padStart(2, "0")] ?? "";
    if (next === (campaignOverrides.get(base) ?? "")) continue;
    changed = true;
    if (next) campaignOverrides.set(base, next);
    else campaignOverrides.delete(base);
  }
  return changed;
}

function showLanding(): void {
  landingScreen.classList.remove("hidden");
  startScreen.classList.add("hidden");
  campaignScreen.classList.add("hidden");
  campaignTileLabel.textContent = `${campaignMonthLabel()} Campaign`;
  updateLandingTiles();
}

function updateLandingTiles(): void {
  const campaignThumb = document.getElementById("campaign-thumb")!;
  campaignThumb.replaceChildren();
  for (let i = 1; i <= CAMPAIGN_TOTAL; i++) {
    const seed = campaignSeedForIndex(i);
    const dot = document.createElement("span");
    dot.className = "campaign-progress-dot";
    const pb = loadPersonalBest(seed, CAMPAIGN_DIFFICULTY);
    if (pb) {
      const pars = campaignHardPars.get(seed);
      const medal = pars ? medalFor(pb.time, pars) : null;
      dot.classList.add(medal ? `dot-${medal}` : "dot-done");
    }
    campaignThumb.appendChild(dot);
  }

  const dailyThumb = document.getElementById("daily-thumb")!;
  dailyThumb.replaceChildren();
  const todayPlayable = getPlayable("daily", 0, effectiveDifficulty("daily"));
  const cv = document.createElement("canvas");
  cv.width = 150;
  cv.height = 95;
  const thumbCtx = cv.getContext("2d")!;
  renderMinimap(thumbCtx, todayPlayable.level, 0, 0, cv.width, cv.height);
  dailyThumb.appendChild(cv);

  if (todayPlayable.personalBest) {
    const medal = medalFor(todayPlayable.personalBest.time, todayPlayable.pars);
    if (medal) {
      const medalSpan = document.createElement("span");
      medalSpan.className = "tile-medal";
      medalSpan.textContent = MEDAL_ICON[medal];
      dailyThumb.appendChild(medalSpan);
    }
  }
}

function showCampaignGrid(): void {
  campaignScreen.classList.remove("hidden");
  landingScreen.classList.add("hidden");
  startScreen.classList.add("hidden");
  // Paint from what's already known, then re-paint if the server's alternate-map
  // choices turn out to differ - so the grid appears instantly rather than
  // waiting on a request that usually changes nothing.
  renderCampaignGrid();
  void refreshCampaignOverrides();
}

/** Reloads the viewed month's alternate-map choices and rebuilds the grid if
 * any of them moved. */
async function refreshCampaignOverrides(): Promise<void> {
  const offset = campaignMonthOffset;
  const changed = await loadCampaignOverrides(offset);
  if (!changed || offset !== campaignMonthOffset) return;
  campaignGridBuilt = false;
  renderCampaignGrid();
}

/** How far back anyone may browse, and how far forward. Only admins can look
 * ahead: next month's maps are theirs to inspect and reroll before the campaign
 * goes live, but a player seeing them early would spoil it (and let them bank
 * times on a campaign that hasn't opened). */
const CAMPAIGN_PAST_MONTHS = 3;
const CAMPAIGN_FUTURE_MONTHS_ADMIN = 1;

function campaignMaxFutureOffset(): number {
  return currentUser()?.isAdmin === true ? CAMPAIGN_FUTURE_MONTHS_ADMIN : 0;
}

function navigateCampaignMonth(dir: number): void {
  const next = Math.max(
    -CAMPAIGN_PAST_MONTHS,
    Math.min(campaignMaxFutureOffset(), campaignMonthOffset + dir),
  );
  if (next === campaignMonthOffset) return;
  campaignMonthOffset = next;
  campaignGridBuilt = false;
  renderCampaignGrid();
  void refreshCampaignOverrides();
}

let campaignGridBuilt = false;
let campaignGridOffset = 0;
let campaignGridCount = 0;
let campaignCells: { cell: HTMLButtonElement; index: number; seed: string; medalEl: HTMLElement }[] = [];
const campaignHardPars = new Map<string, MedalPars>();

const MEDAL_RANK: Record<Medal, number> = { bronze: 1, silver: 2, gold: 3, champion: 4 };

function ensureCampaignPars(seed: string): MedalPars {
  let pars = campaignHardPars.get(seed);
  if (!pars) {
    const level = generateLevel(seed);
    const geometric = computeMedalPars(level);
    const optimalTime = optimalRecordings.get(seed)?.time;
    pars = optimalTime != null ? clampParsToOptimal(geometric, optimalTime) : geometric;
    campaignHardPars.set(seed, pars);
  }
  return pars;
}

function campaignMedalForIndex(index: number): Medal | null {
  const seed = campaignSeedForIndex(index);
  const pb = loadPersonalBest(seed, CAMPAIGN_DIFFICULTY);
  if (!pb) return null;
  return medalFor(pb.time, ensureCampaignPars(seed));
}

function allHaveMedal(from: number, to: number, required: Medal): boolean {
  const requiredRank = MEDAL_RANK[required];
  for (let i = from; i <= to; i++) {
    const m = campaignMedalForIndex(i);
    if (!m || MEDAL_RANK[m]! < requiredRank) return false;
  }
  return true;
}

/** The unlock ladder: which maps each tier opens, and what it costs. One table
 * so the gate and the message the player reads can't drift apart. Maps 1-5 are
 * open from the start and so aren't listed. */
const CAMPAIGN_TIERS: ReadonlyArray<{
  from: number; to: number; medal: Medal; reqFrom: number; reqTo: number;
}> = [
  { from: 6, to: 10, medal: "bronze", reqFrom: 1, reqTo: 5 },
  { from: 11, to: 15, medal: "silver", reqFrom: 1, reqTo: 10 },
  { from: 16, to: 20, medal: "gold", reqFrom: 11, reqTo: 15 },
  { from: 21, to: 25, medal: "gold", reqFrom: 1, reqTo: 20 },
];

function isCampaignUnlocked(index: number): boolean {
  const tier = CAMPAIGN_TIERS.find((t) => index >= t.from && index <= t.to);
  return tier ? allHaveMedal(tier.reqFrom, tier.reqTo, tier.medal) : true;
}

/** The first tier still shut, or null once the whole ladder is open. */
function nextLockedTier(): (typeof CAMPAIGN_TIERS)[number] | null {
  return CAMPAIGN_TIERS.find((t) => !allHaveMedal(t.reqFrom, t.reqTo, t.medal)) ?? null;
}

/** How many maps the grid draws. Locked maps aren't dimmed, they're absent -
 * the tier message below the grid stands in for them - so a new player sees
 * five maps and one clear instruction rather than twenty greyed-out cells.
 * A past or preview campaign ignores the ladder and shows everything. */
function visibleCampaignCount(): number {
  if (campaignMonthOffset !== 0) return CAMPAIGN_TOTAL;
  const tier = nextLockedTier();
  return tier ? tier.from - 1 : CAMPAIGN_TOTAL;
}

/** Whether a campaign slot can be entered right now.
 *
 * The unlock ladder only governs the live campaign. A finished month is already
 * fully browsable in the grid, and an admin preview has no personal bests to
 * unlock with at all - so gating either would contradict the grid and strand
 * the player on a map with a dead Next button. The ladder itself reads the
 * current month's bests (campaignSeedForIndex), which is only meaningful while
 * that month is the one being played. */
function isCampaignSlotOpen(index: number): boolean {
  return campaignMonthOffset !== 0 || isCampaignUnlocked(index);
}

function renderCampaignGrid(): void {
  // Rebuild when the month changes, or when clearing a tier changes how many
  // maps are on show - otherwise newly unlocked maps wouldn't appear until the
  // screen was left and re-entered.
  const want = visibleCampaignCount();
  if (!campaignGridBuilt || campaignGridOffset !== campaignMonthOffset || campaignGridCount !== want) {
    buildCampaignCells(want);
    campaignGridBuilt = true;
    campaignGridOffset = campaignMonthOffset;
    campaignGridCount = want;
  }
  updateCampaignGridState();
}

function buildCampaignCells(count: number): void {
  campaignGrid.replaceChildren();
  campaignCells = [];
  const prefix = campaignPrefixForOffset(campaignMonthOffset);
  for (let i = 1; i <= count; i++) {
    const seed = campaignSeedFor(prefix, i);
    const cell = document.createElement("button") as HTMLButtonElement;
    cell.className = "campaign-cell";
    cell.type = "button";

    const cv = document.createElement("canvas");
    cv.width = 150;
    cv.height = 95;
    const cellCtx = cv.getContext("2d")!;
    const level = generateLevel(seed);
    campaignHardPars.set(seed, computeMedalPars(level));
    renderMinimap(cellCtx, level, 0, 0, cv.width, cv.height);
    cell.appendChild(cv);

    const label = document.createElement("span");
    label.className = "campaign-cell-label";
    label.textContent = String(i).padStart(2, "0");
    cell.appendChild(label);

    const medalEl = document.createElement("span");
    medalEl.className = "campaign-cell-medal";
    cell.appendChild(medalEl);

    cell.addEventListener("click", () => {
      homeTarget = "campaign";
      showDailyHome();
      showCampaignSeed(seed, campaignMonthOffset);
    });
    campaignGrid.appendChild(cell);
    campaignCells.push({ cell, index: i, seed, medalEl });
  }
}

function updateCampaignGridState(): void {
  const isCurrent = campaignMonthOffset === 0;
  const isFuture = campaignMonthOffset > 0;
  campaignMonthLabelEl.textContent = campaignMonthLabelForOffset(campaignMonthOffset);
  campaignMonthPrevBtn.disabled = campaignMonthOffset <= -CAMPAIGN_PAST_MONTHS;
  campaignMonthNextBtn.disabled = campaignMonthOffset >= campaignMaxFutureOffset();

  if (isCurrent) {
    campaignFrozenNotice.classList.add("hidden");
  } else {
    campaignFrozenNotice.textContent = isFuture
      ? "Not live yet — admin preview. Times here don't count."
      : "This campaign has ended — totals are frozen";
    campaignFrozenNotice.classList.remove("hidden");
  }

  const user = currentUser();
  const isAdmin = user?.isAdmin === true;
  campaignAdminSection.classList.toggle("hidden", !isAdmin);
  if (isAdmin) syncAltControls();

  for (const { cell, index, seed, medalEl } of campaignCells) {
    cell.classList.toggle("locked", !isCampaignSlotOpen(index));
    const pb = loadPersonalBest(seed, CAMPAIGN_DIFFICULTY);
    const pars = pb ? campaignHardPars.get(seed) : undefined;
    const medal = pb && pars ? medalFor(pb.time, pars) : null;
    medalEl.textContent = medal ? MEDAL_ICON[medal] : "";
  }

  // Counted over all 25 slots rather than over the cells on screen: the grid
  // now draws only the unlocked ones, so summing what's visible would call a
  // five-map run "complete" and submit a fifth of a campaign as a total.
  const prefix = campaignPrefixForOffset(campaignMonthOffset);
  let totalTime = 0;
  let completed = 0;
  for (let i = 1; i <= CAMPAIGN_TOTAL; i++) {
    const pb = loadPersonalBest(campaignSeedFor(prefix, i), CAMPAIGN_DIFFICULTY);
    if (pb) {
      totalTime += pb.time;
      completed++;
    }
  }

  const tier = isCurrent ? nextLockedTier() : null;
  if (tier) {
    campaignUnlockNotice.textContent =
      `Earn a ${tier.medal} medal on maps ${tier.reqFrom}-${tier.reqTo} to unlock maps ${tier.from}-${tier.to}`;
    campaignUnlockNotice.classList.remove("hidden");
  } else {
    campaignUnlockNotice.classList.add("hidden");
  }

  // One line, two jobs: the player's own total once every map is done, and
  // otherwise what's still standing between them and being on the board. A
  // total only means anything as a sum of all 25, so a partial one is never
  // shown - the count is the useful number until then.
  const allCompleted = completed === CAMPAIGN_TOTAL;
  if (allCompleted) {
    campaignTotalEl.textContent = `Total: ${formatTime(totalTime)}`;
    campaignTotalEl.classList.remove("campaign-total-pending", "hidden");
    if (isCurrent) void submitCampaignTotal(totalTime);
  } else if (isCurrent) {
    campaignTotalEl.textContent =
      `Finish all ${CAMPAIGN_TOTAL} maps to record your time (${completed}/${CAMPAIGN_TOTAL})`;
    campaignTotalEl.classList.add("campaign-total-pending");
    campaignTotalEl.classList.remove("hidden");
  } else {
    // A closed or unreleased campaign already says so directly above. Urging
    // the player to finish one whose total can never be recorded would be
    // advice they can't act on.
    campaignTotalEl.classList.add("hidden");
  }

  requestCampaignOptimals(prefix);
  renderCampaignImprovements(prefix, allCompleted);

  // The footer always has something to say now - the board, and either a total
  // or the nudge toward one - so it no longer hides itself.
  campaignFooter.classList.remove("hidden");
  void refreshCampaignLeaderboard();
}

/** How many maps the "most room to improve" list names. */
const CAMPAIGN_IMPROVE_COUNT = 3;

/** The maps with the most room to improve, ranked by percentage over optimal.
 * Only shown once all 25 maps are completed and at least one has a known
 * optimal route. */
function renderCampaignImprovements(prefix: string, show: boolean): void {
  const rows: { index: number; seed: string; time: number; pct: number }[] = [];
  if (show) {
    for (let i = 1; i <= CAMPAIGN_TOTAL; i++) {
      const seed = campaignSeedFor(prefix, i);
      const pb = loadPersonalBest(seed, CAMPAIGN_DIFFICULTY);
      if (!pb) continue;
      const optimal = optimalRecordings.get(seed);
      if (!optimal) continue;
      const pct = (pb.time / optimal.time) * 100;
      if (pct <= 100) continue;
      rows.push({ index: i, seed, time: pb.time, pct });
    }
    rows.sort((a, b) => b.pct - a.pct);
  }
  const visible = show && rows.length > 0;
  campaignImproveDivider.classList.toggle("hidden", !visible);
  campaignImprove.classList.toggle("hidden", !visible);
  if (!visible) return;

  campaignImproveList.replaceChildren();
  for (const row of rows.slice(0, CAMPAIGN_IMPROVE_COUNT)) {
    const li = document.createElement("li");
    li.className = "improve-row";

    const map = document.createElement("span");
    map.className = "improve-map";
    map.textContent = String(row.index).padStart(2, "0");
    li.appendChild(map);

    const time = document.createElement("span");
    time.className = "improve-gap";
    time.textContent = formatTime(row.time);
    li.appendChild(time);

    li.addEventListener("click", () => {
      homeTarget = "campaign";
      showDailyHome();
      showCampaignSeed(row.seed, campaignMonthOffset);
    });
    campaignImproveList.appendChild(li);
  }
}

async function submitCampaignTotal(totalTime: number): Promise<void> {
  if (!isLoggedIn()) return;
  const seed = `${campaignPrefix()}CTOTAL`;
  await submitScore(seed, nickname, CAMPAIGN_DIFFICULTY, totalTime, 100, [], null, true, null);
}

async function refreshCampaignLeaderboard(): Promise<void> {
  const seed = `${campaignPrefixForOffset(campaignMonthOffset)}CTOTAL`;
  const data = await fetchLeaderboard(seed, CAMPAIGN_DIFFICULTY, nickname);
  campaignLeaderboardList.replaceChildren();
  // The board stays up even when this player has no total of their own: seeing
  // what the times to beat are is the point of it. An unreachable server is
  // called out separately, so nobody offline is told the board is empty.
  campaignLeaderboard.classList.remove("hidden");
  const entries = data ? [...data.top, ...data.context] : [];
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = data ? "No times yet - be the first!" : "Leaderboard unavailable.";
    campaignLeaderboardList.appendChild(li);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "leaderboard-row";
    if (entry.nickname === nickname) li.classList.add("self");

    const rank = document.createElement("span");
    rank.className = "leaderboard-rank";
    rank.textContent = `${entry.rank}.`;
    li.appendChild(rank);

    const name = document.createElement("span");
    name.className = "leaderboard-nickname";
    name.textContent = entry.nickname;
    li.appendChild(name);

    const time = document.createElement("span");
    time.className = "leaderboard-time";
    time.textContent = formatTime(entry.time);
    li.appendChild(time);

    campaignLeaderboardList.appendChild(li);
  }
}

/** Monochrome glyphs rather than emoji: .back-btn sets its own `color`, which a
 * text glyph inherits and an emoji ignores - an emoji would sit in the circle
 * at its own colour and clash with the settings gear beside it. */
const HOME_ICON = "⌂"; // house
const GRID_ICON = "⊞"; // quartered square, for the campaign grid

function showDailyHome(): void {
  startScreen.classList.remove("hidden");
  landingScreen.classList.add("hidden");
  campaignScreen.classList.add("hidden");
  // This one button leads back to wherever the map was opened from, so its icon
  // has to say which - the campaign grid, or the main menu.
  const toCampaign = homeTarget === "campaign";
  const label = toCampaign ? "Back to campaign" : "Main menu";
  homeBackBtn.textContent = toCampaign ? GRID_ICON : HOME_ICON;
  homeBackBtn.setAttribute("aria-label", label);
  homeBackBtn.title = label;
}

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

const landingScreen = document.getElementById("landing-screen")!;
const campaignScreen = document.getElementById("campaign-screen")!;
const campaignGrid = document.getElementById("campaign-grid")!;
const campaignTileLabel = document.getElementById("campaign-tile-label")!;
const campaignMonthLabelEl = document.getElementById("campaign-month-label")!;
const campaignFooter = document.getElementById("campaign-footer")!;
const campaignTotalEl = document.getElementById("campaign-total")!;
const campaignLeaderboard = document.getElementById("campaign-leaderboard")!;
const campaignLeaderboardList = document.getElementById("campaign-leaderboard-list")!;
const campaignImproveDivider = document.getElementById("campaign-improve-divider")!;
const campaignImprove = document.getElementById("campaign-improve")!;
const campaignImproveList = document.getElementById("campaign-improve-list")!;
const campaignMonthPrevBtn = document.getElementById("campaign-month-prev") as HTMLButtonElement;
const campaignMonthNextBtn = document.getElementById("campaign-month-next") as HTMLButtonElement;
const campaignFrozenNotice = document.getElementById("campaign-frozen-notice")!;
const campaignUnlockNotice = document.getElementById("campaign-unlock-notice")!;
const campaignAdminSection = document.getElementById("campaign-admin-section")!;
const campaignAltMapSelect = document.getElementById("campaign-alt-map") as HTMLSelectElement;
const campaignAltSelect = document.getElementById("campaign-alt-select") as HTMLSelectElement;
const campaignAltApplyBtn = document.getElementById("campaign-alt-apply") as HTMLButtonElement;
const campaignAltPreview = document.getElementById("campaign-alt-preview") as HTMLCanvasElement;
const campaignAltStatus = document.getElementById("campaign-alt-status")!;
const startScreen = document.getElementById("start-screen")!;
const homeBackBtn = document.getElementById("home-back-btn") as HTMLButtonElement;
const resultsScreen = document.getElementById("results-screen")!;
const helpScreen = document.getElementById("help-screen")!;
const helpCloseBtn = document.getElementById("help-close-btn") as HTMLButtonElement;
const profileScreen = document.getElementById("profile-screen")!;
const profileCloseBtn = document.getElementById("profile-close-btn") as HTMLButtonElement;
const profileDismissBtn = document.getElementById("profile-dismiss-btn") as HTMLButtonElement;
const accountLoggedOut = document.getElementById("account-logged-out")!;
const accountLoggedIn = document.getElementById("account-logged-in")!;
const settingsLoginBtn = document.getElementById("settings-login-btn") as HTMLButtonElement;
const settingsRegisterBtn = document.getElementById("settings-register-btn") as HTMLButtonElement;
const syncMigrateRow = document.getElementById("sync-migrate-row")!;
const syncMigrateBtn = document.getElementById("sync-migrate-btn") as HTMLButtonElement;
const accountUsernameEl = document.getElementById("account-username")!;
const accountEmailInput = document.getElementById("account-email") as HTMLInputElement;
const accountNotifyDaily = document.getElementById("account-notify-daily") as HTMLInputElement;
const accountNotifyUpdates = document.getElementById("account-notify-updates") as HTMLInputElement;
const accountCountry = document.getElementById("account-country") as HTMLSelectElement;
const accountTimezone = document.getElementById("account-timezone") as HTMLSelectElement;
const accountEmailSaveBtn = document.getElementById("account-email-save-btn") as HTMLButtonElement;
const accountEmailStatus = document.getElementById("account-email-status")!;
const accountLocationSaveBtn = document.getElementById("account-location-save-btn") as HTMLButtonElement;
const accountLocationStatus = document.getElementById("account-location-status")!;
const accountPasswordStatus = document.getElementById("account-password-status")!;
const accountCurrentPassword = document.getElementById("account-current-password") as HTMLInputElement;
const accountNewPassword = document.getElementById("account-new-password") as HTMLInputElement;
const accountPasswordBtn = document.getElementById("account-password-btn") as HTMLButtonElement;
const accountLogoutBtn = document.getElementById("account-logout-btn") as HTMLButtonElement;
const accountDeleteBtn = document.getElementById("account-delete-btn") as HTMLButtonElement;
const accountDeleteConfirm = document.getElementById("account-delete-confirm")!;
const accountDeletePassword = document.getElementById("account-delete-password") as HTMLInputElement;
const accountDeleteConfirmBtn = document.getElementById("account-delete-confirm-btn") as HTMLButtonElement;
const accountDeleteCancelBtn = document.getElementById("account-delete-cancel-btn") as HTMLButtonElement;
const accountSectionError = document.getElementById("account-section-error")!;
const adminSection = document.getElementById("admin-section")!;
const adminOptimalBtn = document.getElementById("admin-optimal-btn") as HTMLButtonElement;
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
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
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
const accountScreen = document.getElementById("account-screen")!;
const accountTitle = document.getElementById("account-title")!;
const accountChoice = document.getElementById("account-choice")!;
const accountRegisterForm = document.getElementById("account-register-form") as HTMLFormElement;
const accountLoginForm = document.getElementById("account-login-form") as HTMLFormElement;
const accountCreateBtn = document.getElementById("account-create-btn") as HTMLButtonElement;
const accountLoginBtn = document.getElementById("account-login-btn") as HTMLButtonElement;
const accountSkipBtn = document.getElementById("account-skip-btn") as HTMLButtonElement;
const accountSkipLink = document.getElementById("account-skip-link") as HTMLButtonElement;
const accountSkipNote = document.getElementById("account-skip-note")!;
const accountError = document.getElementById("account-error")!;
const registerUsername = document.getElementById("register-username") as HTMLInputElement;
const registerPassword = document.getElementById("register-password") as HTMLInputElement;
const registerEmail = document.getElementById("register-email") as HTMLInputElement;
const registerNotifyDaily = document.getElementById("register-notify-daily") as HTMLInputElement;
const registerNotifyUpdates = document.getElementById("register-notify-updates") as HTMLInputElement;
const registerCountry = document.getElementById("register-country") as HTMLSelectElement;
const registerTimezone = document.getElementById("register-timezone") as HTMLSelectElement;
const registerSubmit = document.getElementById("register-submit") as HTMLButtonElement;
const loginUsername = document.getElementById("login-username") as HTMLInputElement;
const loginPassword = document.getElementById("login-password") as HTMLInputElement;
const loginSubmit = document.getElementById("login-submit") as HTMLButtonElement;
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

function populateSelectOptions(select: HTMLSelectElement, items: ReadonlyArray<readonly [string, string]>): void {
  for (const [value, label] of items) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
}

const timezoneItems: Array<readonly [string, string]> = (
  typeof Intl !== "undefined" && Intl.supportedValuesOf
    ? Intl.supportedValuesOf("timeZone")
    : []
).map((tz) => [tz, tz.replace(/_/g, " ")] as const);

const detectedTimezone =
  typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";

populateSelectOptions(registerCountry, COUNTRIES);
populateSelectOptions(registerTimezone, timezoneItems);
populateSelectOptions(accountCountry, COUNTRIES);
populateSelectOptions(accountTimezone, timezoneItems);

if (detectedTimezone) {
  registerTimezone.value = detectedTimezone;
}

let nickname = getOrCreateNickname();

/** Adopts a name for this device.
 *
 * Only ever called with an account's username now - logging in, or upgrading an
 * old sync code. Players can no longer type a name of their own, because a name
 * on the leaderboard is something an account owns. The local nickname survives
 * as what run logs and leaderboard highlighting are keyed on. */
function applyNickname(next: string): void {
  const oldNickname = nickname;
  setNickname(next);
  nickname = getOrCreateNickname();
  renderLeaderboardList();
  if (nickname !== oldNickname) {
    void logRun(viewed.seed, nickname, "username_changed", 0, `${oldNickname} -> ${nickname}`, viewed.difficulty);
  }
}

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
  const buildTag = resolveSourceTag();
  if (buildTag) return buildTag.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "direct";
  const tagged = new URLSearchParams(location.search).get("src");
  if (tagged) return tagged.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "direct";
  if (!document.referrer) return "direct";
  try {
    const host = new URL(document.referrer).hostname.replace(/^www\./, "");
    return host.slice(0, 40) || "direct";
  } catch {
    return "unknown";
  }
}

function logGameStarted(): void {
  // Captured on the first visit and replayed on every later one, so a return
  // visit weeks afterwards still reports the channel that originally won the
  // player - which is the whole point of tracking it.
  recordAcquisitionSource(detectSource());
  void logRun(todaysSeed, nickname, "game_started", 0, `src:${loadAcquisitionSource() ?? "direct"}`, viewed.difficulty);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", logGameStarted);
} else {
  logGameStarted();
}

/** Pushes this device's progress to the account, applies whatever comes back,
 * and pulls down any personal bests this device has never seen.
 *
 * Best-effort throughout: offline, nothing happens and nothing breaks. Doing
 * both halves together is what makes logging in on a new device restore a
 * player's streak and their ghosts in one go. */
async function syncAccount(): Promise<void> {
  if (!isLoggedIn()) return;
  const applied = await syncAccountState();
  const takenBests = await pullAccountBests();
  if (!applied && takenBests === 0) return;
  if (takenBests > 0) refreshCachedPersonalBests();
  renderProgressStrip();
  refreshViewedUi();
  renderLeaderboardList();
  // Campaign medals, the campaign total and the landing tile's progress dots are
  // all derived from personal bests, so a pull that lands after they were
  // painted leaves them stale - which on a fresh device reads as "my campaign
  // records are gone". Only the grid's per-cell state is recomputed; the cells
  // themselves are unchanged, so this doesn't regenerate 25 levels.
  updateLandingTiles();
  if (!campaignScreen.classList.contains("hidden")) renderCampaignGrid();
}

/** Re-reads the personal best of every level already built this session.
 *
 * The cache holds whole generated levels, so throwing it away to pick up new
 * personal bests would mean regenerating every one of them. The geometry hasn't
 * changed - only the best time attached to it has. */
function refreshCachedPersonalBests(): void {
  for (const cacheMode of ["daily", "weekly"] as const) {
    for (const cacheDifficulty of ["easy", "hard"] as const) {
      for (const playable of playableCache[cacheMode][cacheDifficulty].values()) {
        playable.personalBest = loadPersonalBest(playable.seed, cacheDifficulty);
      }
    }
  }
}

// Re-check the login on load, so a session revoked elsewhere (a password change
// on another device) stops counting as logged in here. The cached account
// answers isLoggedIn() until this returns, and being offline leaves it alone -
// see refreshAccount(). A surviving session then syncs, which is what restores
// progress on a device that has just been logged in to.
void refreshAccount().then(syncAccount);

function refreshViewedUi(): void {
  const periodLabel = campaignNav
    ? `Campaign ${campaignNav.index} of ${CAMPAIGN_TOTAL}`
    : viewed.orphan ? "Shared map" : describeOffset(mode, viewedOffset);
  const themeName = getTheme(viewed.level.theme).name;
  viewedDateEl.textContent = campaignNav
    ? `${periodLabel} · ${themeName}`
    : `${periodLabel} · ${viewed.seed} · ${themeName}`;

  // Sharing the best time is offered only for today, and only once there's a
  // best to share (never on a shared orphan map, which has no leaderboard). The
  // button lives below the leaderboard now.
  const canShareBest = !viewed.orphan && (viewedOffset === 0 || campaignNav !== null) && viewed.personalBest != null;
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
  // The Daily/Weekly board switch means nothing on a campaign map, and the gold
  // check below would read whichever daily map was last browsed rather than this
  // one - campaign maps aren't in the daily cache at all. Hide the lot.
  if (campaignNav) {
    modeSwitch.classList.add("hidden");
    modeCta.classList.add("hidden");
    return;
  }
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
  const diffLabel = mode === "daily" ? ` · ${viewed.difficulty === "easy" ? "Easy" : "Hard"}` : "";
  const periodDesc = campaignNav
    ? `Map ${campaignNav.index}`
    : describeOffset(mode, viewedOffset);
  leaderboardHeaderEl.textContent = watchMode
    ? `Pick up to 5 racers to include in the replay`
    : `Leaderboard (${periodDesc})${diffLabel}`;
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
  if (campaignNav) {
    navPrevBtn.classList.remove("hidden");
    navNextBtn.classList.remove("hidden");
    navPrevBtn.disabled = campaignNav.index <= 1;
    navNextBtn.disabled = campaignNav.index >= CAMPAIGN_TOTAL;
    navPrevBtn.setAttribute("aria-label", "Previous map");
    navNextBtn.setAttribute("aria-label", "Next map");
    return;
  }
  if (viewed.orphan) {
    navPrevBtn.classList.add("hidden");
    navNextBtn.classList.add("hidden");
    return;
  }
  navPrevBtn.classList.remove("hidden");
  navNextBtn.classList.remove("hidden");
  navPrevBtn.disabled = viewedOffset <= -maxPastOffset(mode);
  navNextBtn.disabled = viewedOffset >= 0;
  navPrevBtn.setAttribute("aria-label", mode === "weekly" ? "Previous week" : "Previous day");
  navNextBtn.setAttribute("aria-label", mode === "weekly" ? "Next week" : "Next day");
}

function hasOlderPeriod(): boolean {
  if (campaignNav) return campaignNav.index > 1;
  return !viewed.orphan && viewedOffset > -maxPastOffset(mode);
}
function hasNewerPeriod(): boolean {
  if (campaignNav) return campaignNav.index < CAMPAIGN_TOTAL;
  return !viewed.orphan && viewedOffset < 0;
}

function renderMinimaps(): void {
  renderMinimap(minimapCtx, viewed.level, 0, 0, minimapCanvas.width, minimapCanvas.height);
  if (campaignNav) {
    paintCampaignThumb(minimapPrevCtx, minimapPrevCanvas, hasOlderPeriod() ? campaignNav.index - 1 : null);
    paintCampaignThumb(minimapNextCtx, minimapNextCanvas, hasNewerPeriod() ? campaignNav.index + 1 : null);
  } else {
    paintNeighbourThumb(minimapPrevCtx, minimapPrevCanvas, hasOlderPeriod() ? viewedOffset - 1 : null);
    paintNeighbourThumb(minimapNextCtx, minimapNextCanvas, hasNewerPeriod() ? viewedOffset + 1 : null);
  }
}

function paintNeighbourThumb(ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, offset: number | null): void {
  if (offset === null) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    return;
  }
  renderMinimap(ctx, getPlayable(mode, offset, effectiveDifficulty(mode)).level, 0, 0, cv.width, cv.height);
}

function paintCampaignThumb(ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, index: number | null): void {
  if (index === null || !campaignNav) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    return;
  }
  const seed = campaignSeedFor(campaignNav.prefix, index);
  renderMinimap(ctx, generateLevel(seed), 0, 0, cv.width, cv.height);
}

/** Re-syncs the whole home view (map, best, ghost toggle, leaderboard) to the
 * currently selected mode + offset. Also leaves any shared "orphan" seed view,
 * since a mode/offset selection is always a live period. */
function refreshViewedSelection(): void {
  campaignNav = null;
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
    void logRun(viewed.seed, nickname, "navigated", 0, `to ${describeOffset(mode, viewedOffset)}`, viewed.difficulty);
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
  void logRun(viewed.seed, nickname, "mode_switched", 0, `to ${newMode}`, viewed.difficulty);
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
  // Campaign maps run on their own fixed difficulty (CAMPAIGN_DIFFICULTY), so
  // the toggle is hidden there alongside weekly.
  const applies = mode === "daily" && campaignNav === null;
  difficultySwitch.classList.toggle("hidden", !applies || !hasPlayed);
}

/** Switches the Easy/Hard preference, persists it, and reloads the viewed map
 * on the new difficulty's board. No-op on weekly (the switch is hidden there,
 * but this stays a hard guard in case it's ever invoked programmatically). */
function switchDifficulty(next: Difficulty): void {
  // Guarded as well as hidden: refreshViewedSelection() below drops campaignNav
  // and loads the daily map for the current offset, so reaching this from a
  // campaign map would silently navigate away from it.
  if (mode !== "daily" || campaignNav !== null || difficulty === next) return;
  difficulty = next;
  saveDifficultyPref(next);
  setDifficultyVisuals();
  renderProgressStrip();
  void refreshStripChampionTimes();
  refreshViewedSelection();
  void logRun(viewed.seed, nickname, "difficulty_switched", 0, `to ${next}`, viewed.difficulty);
}

/** Shows a shared "orphan" seed - a generated map with no live leaderboard.
 * Playable (including racing your own local PB ghost), but ranking, others'
 * ghosts, replays, and score submission are all off, with a short notice in
 * place of the leaderboard. */
function showOrphanSeed(seed: string, genMode: Mode): void {
  campaignNav = null;
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
  leaderboardHeaderEl.textContent = campaignNav ? "Campaign" : "Shared map";
  leaderboardList.replaceChildren();
  const li = document.createElement("li");
  li.className = "leaderboard-empty";
  // campaignNav is only set alongside `orphan` for an unreleased campaign, so
  // reaching this with one set means an admin is previewing next month.
  li.textContent = campaignNav
    ? "This campaign isn't live yet — times here don't count."
    : "Leaderboards aren't available for this map.";
  leaderboardList.appendChild(li);
}

/** Shows a campaign map with a full leaderboard, ghost racing, and score
 * submission. Unlike showOrphanSeed, a live campaign map is NOT marked orphan.
 *
 * A campaign whose month hasn't started is the exception: it's admin-preview
 * only, so it's flagged orphan to keep a preview run off the board. Otherwise
 * an admin could bank times on a campaign nobody else can reach yet. */
function showCampaignSeed(seed: string, monthOffset: number): void {
  const cp = parseCampaignSeed(seed);
  if (!cp) return;
  const padded = String(cp.index).padStart(2, "0");
  campaignNav = { prefix: seed.substring(0, seed.indexOf(`C${padded}`)), index: cp.index };
  campaignMonthOffset = monthOffset;
  const preview = monthOffset > 0;
  mode = "daily";
  setModeVisuals();
  progressStrip.classList.add("hidden");
  const playable = makePlayable(seed, "daily", CAMPAIGN_DIFFICULTY);
  viewed = preview ? { ...playable, orphan: true } : playable;
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
  if (preview) {
    renderOrphanNotice();
    return;
  }
  void refreshLeaderboard();
  void restoreSelectedLeaderboardGhost();
}

/** Routes a `?s=` shared-link seed to its level: the matching live daily/weekly
 * period when it's still in the browsable window, otherwise a generated orphan
 * map. */
function openSharedSeed(seed: string): void {
  const cp = parseCampaignSeed(seed);
  if (cp) {
    homeTarget = "campaign";
    showDailyHome();
    showCampaignSeed(seed, 0);
    return;
  }
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

function navigateCampaign(dir: number): void {
  if (!campaignNav) return;
  const newIndex = campaignNav.index + dir;
  if (newIndex < 1 || newIndex > CAMPAIGN_TOTAL) return;
  const newSeed = campaignSeedFor(campaignNav.prefix, newIndex);
  showCampaignSeed(newSeed, campaignMonthOffset);
}

navPrevBtn.addEventListener("click", () => {
  if (campaignNav) navigateCampaign(-1);
  else navigateTo(viewedOffset - 1);
});
navNextBtn.addEventListener("click", () => {
  if (campaignNav) navigateCampaign(1);
  else navigateTo(viewedOffset + 1);
});
modeDailyBtn.addEventListener("click", () => switchMode("daily"));
modeWeeklyBtn.addEventListener("click", () => switchMode("weekly"));
difficultyEasyBtn.addEventListener("click", () => switchDifficulty("easy"));
difficultyHardBtn.addEventListener("click", () => switchDifficulty("hard"));

// --- Landing / campaign screen wiring ---
document.getElementById("campaign-tile")!.addEventListener("click", showCampaignGrid);
document.getElementById("daily-tile")!.addEventListener("click", () => {
  homeTarget = "landing";
  showDailyHome();
  refreshViewedSelection();
});
document.getElementById("campaign-back-btn")!.addEventListener("click", showLanding);
campaignMonthPrevBtn.addEventListener("click", () => navigateCampaignMonth(-1));
campaignMonthNextBtn.addEventListener("click", () => navigateCampaignMonth(1));
for (let i = 1; i <= CAMPAIGN_TOTAL; i++) {
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = String(i).padStart(2, "0");
  campaignAltMapSelect.appendChild(opt);
}

/** Draws the map the selected slot+variant would resolve to, without changing
 * anything for anyone: this is the "what would I be shipping?" check before
 * Apply writes the choice to the server. */
function renderAltPreview(): void {
  const index = Number(campaignAltMapSelect.value);
  if (!Number.isInteger(index) || index < 1) return;
  const suffix = campaignAltSelect.value;
  const base = `${campaignPrefixForOffset(campaignMonthOffset)}C${String(index).padStart(2, "0")}`;
  const seed = suffix ? `${base}-${suffix}` : base;
  const previewCtx = campaignAltPreview.getContext("2d")!;
  renderMinimap(previewCtx, generateLevel(seed), 0, 0, campaignAltPreview.width, campaignAltPreview.height);
  campaignAltStatus.classList.add("hidden");
}

/** Syncs the variant dropdown to whatever the selected slot currently uses, so
 * opening the panel shows the live choice rather than a stale one. */
function syncAltControls(): void {
  const index = Number(campaignAltMapSelect.value);
  const base = `${campaignPrefixForOffset(campaignMonthOffset)}C${String(index).padStart(2, "0")}`;
  campaignAltSelect.value = campaignOverrides.get(base) ?? "";
  renderAltPreview();
}

campaignAltMapSelect.addEventListener("change", syncAltControls);
campaignAltSelect.addEventListener("change", renderAltPreview);

campaignAltApplyBtn.addEventListener("click", () => {
  const index = Number(campaignAltMapSelect.value);
  if (!Number.isInteger(index) || index < 1) return;
  const suffix = campaignAltSelect.value;
  const prefix = campaignPrefixForOffset(campaignMonthOffset);
  campaignAltApplyBtn.disabled = true;
  campaignAltStatus.textContent = "Saving...";
  campaignAltStatus.classList.remove("hidden");
  void saveCampaignOverride(prefix, index, suffix).then((result) => {
    campaignAltApplyBtn.disabled = false;
    if (!result.ok) {
      campaignAltStatus.textContent = result.error;
      return;
    }
    const base = `${prefix}C${String(index).padStart(2, "0")}`;
    if (suffix) campaignOverrides.set(base, suffix);
    else campaignOverrides.delete(base);
    campaignAltStatus.textContent = suffix
      ? `Map ${index} now uses variant ${suffix} for everyone.`
      : `Map ${index} restored to the default.`;
    // The slot's seed changed, so its cached level, pars and cell art are all
    // stale - rebuild the grid from scratch.
    campaignGridBuilt = false;
    renderCampaignGrid();
  });
});
homeBackBtn.addEventListener("click", () => {
  if (homeTarget === "campaign") showCampaignGrid();
  else showLanding();
});
document.getElementById("landing-tutorial-btn")!.addEventListener("click", () => {
  homeTarget = "landing";
  showDailyHome();
  startTutorial();
});
document.getElementById("landing-howto-btn")!.addEventListener("click", () => {
  showDailyHome();
  openHelp();
});

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
  if ((viewed.orphan && !campaignNav) || e.button > 0) return;
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
    if (campaignNav) navigateCampaign(dir);
    else navigateTo(viewedOffset + dir);
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
  void logRun(active.seed, nickname, paused ? "paused" : "resumed", session?.visited.size ?? 0, undefined, active.difficulty);
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
let countdownStepDuration = COUNTDOWN_STEP_DURATION;
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

/** Records a solved route, re-derives the seed's medal pars from it, and - if
 * it's for the map on screen - repaints the board and the medal chips. */
function receiveOptimal(seed: string, recording: GhostRecording): void {
  optimalRecordings.set(seed, recording);
  applyOptimalToPars(seed);
  if (viewed.seed === seed) {
    renderLeaderboardList();
    renderMedalTrack();
    renderProgressStrip();
  }
}

/** Re-derives medal pars for every level already built on a seed, after its
 * optimal time arrives. Mutating the cached Playables is what updates `viewed`
 * and `active` too - they hold the same objects. */
function applyOptimalToPars(seed: string): void {
  for (const cacheDifficulty of ["easy", "hard"] as const) {
    for (const playable of playableCache.daily[cacheDifficulty].values()) {
      if (playable.seed === seed) playable.pars = parsFor(playable.level, seed, cacheDifficulty);
    }
  }
  if (campaignHardPars.has(seed)) {
    campaignHardPars.delete(seed);
    ensureCampaignPars(seed);
    updateCampaignGridState();
  }
}

/** Fetches (or reuses a cached) optimal route for a daily seed.
 *
 * The server's precomputed route is fetched for everyone, not just under
 * ?optimal=true, because its time is what keeps gold achievable when the
 * geometric heuristic undershoots (see parsFor). Only the local-solve fallback
 * stays behind the flag - a ~15s search is fine for a power user who asked for
 * the ghost, and not something to spend a normal player's CPU on for a medal
 * adjustment.
 *
 * No-op for weekly maps, orphan maps, Easy (the solver only ever targets Hard's
 * physics), or when already solved/in flight. */
function requestOptimal(playable: Playable): void {
  const { seed, level } = playable;
  if (level.kind === "weekly" || playable.orphan || playable.difficulty !== "hard") return;
  if (optimalRecordings.has(seed) || optimalPending.has(seed)) return;
  optimalPending.add(seed);

  const isCampaign = !!parseCampaignSeed(seed);

  // Server precompute first - the common case is an instant cache hit.
  void fetchOptimalRoute(seed).then((remote) => {
    if (remote && Array.isArray(remote.inputLog)) {
      optimalPending.delete(seed);
      receiveOptimal(seed, { seed, time: remote.time, stability: remote.stability, inputLog: remote.inputLog });
    } else if (!isCampaign && optimalEnabled) {
      solveOptimalLocally(playable);
    } else {
      optimalPending.delete(seed);
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

function requestCampaignOptimals(prefix: string): void {
  for (let i = 1; i <= CAMPAIGN_TOTAL; i++) {
    const seed = campaignSeedFor(prefix, i);
    if (optimalRecordings.has(seed) || optimalPending.has(seed)) continue;
    optimalPending.add(seed);
    void fetchOptimalRoute(seed).then((remote) => {
      optimalPending.delete(seed);
      if (remote && Array.isArray(remote.inputLog)) {
        receiveOptimal(seed, { seed, time: remote.time, stability: remote.stability, inputLog: remote.inputLog });
      }
    });
  }
}

/** The optimal recording for the viewed seed once solved (null otherwise, when
 * the feature is off, or on Easy - there's no Easy optimal ghost). */
function optimalForViewed(): GhostRecording | null {
  if (viewed.difficulty !== "hard") return null;
  const isCampaign = !!parseCampaignSeed(viewed.seed);
  if (isCampaign) {
    return campaignMonthOffset < 0 ? optimalRecordings.get(viewed.seed) ?? null : null;
  }
  return optimalEnabled ? optimalRecordings.get(viewed.seed) ?? null : null;
}

// A `?s=<seed>` deep link opens that exact map (the matching live day/week, or a
// generated orphan when it's expired/non-standard); otherwise start on today.
// This runs here - after the run-state let-bindings above - because the render
// helpers it calls (via exitWatchMode/refreshViewedSelection) read them.
const sharedSeed = new URLSearchParams(window.location.search).get("s")?.trim();
if (sharedSeed) {
  showDailyHome();
  openSharedSeed(sharedSeed);
} else {
  // No deep link: show the landing screen. The start-screen stays hidden until
  // the player picks Daily or a campaign map.
  showLanding();
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

/** The link to include in shared results: a build-time override when set (the
 * itch embed needs this — its own origin is a CDN URL that rots every build),
 * else the page's own address when it's a hosted http(s) URL (sub-path deploys
 * included, minus any query/hash), else the canonical public URL. */
function gameUrl(): string {
  const override = resolveShareUrl();
  if (override) return override;
  const { protocol, hostname, origin, pathname } = window.location;
  const hosted =
    (protocol === "https:" || protocol === "http:") &&
    hostname !== "" &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1";
  return hosted ? origin + pathname : FALLBACK_GAME_URL;
}

/** The share link for a seed: the base game URL plus `?s=<seed>` when the host
 * can forward query strings, or just the base URL on hosts that can't (itch). */
function shareLinkFor(seed: string): string {
  if (resolveShareUrl()) return gameUrl();
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
    void logRun(viewed.seed, nickname, "shared", 0, `${source}: ${ok ? "copied" : "copy failed"}`, viewed.difficulty);
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

let levelHints: readonly WorldHint[] = [];

function roadNormalAt(pos: Vec2, level: Level): Vec2 {
  let bestDist = Infinity;
  let bestIdx = 0;
  let bestRoad = level.roads[0]!;
  for (const road of level.roads) {
    for (let i = 0; i < road.samples.length; i++) {
      const d = distance(pos, road.samples[i]!);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
        bestRoad = road;
      }
    }
  }
  const samples = bestRoad.samples;
  const i0 = Math.max(0, bestIdx - 1);
  const i1 = Math.min(samples.length - 1, bestIdx + 1);
  const tangent = sub(samples[i1]!, samples[i0]!);
  const len = Math.hypot(tangent.x, tangent.y);
  if (len < 0.001) return { x: 0, y: -1 };
  const nx = -tangent.y / len;
  const ny = tangent.x / len;
  const toPos = sub(pos, samples[bestIdx]!);
  const side = toPos.x * nx + toPos.y * ny;
  return side >= 0 ? { x: nx, y: ny } : { x: -nx, y: -ny };
}

function hintOverlapsObstacle(pos: Vec2, level: Level, ignore?: Vec2): boolean {
  for (const rock of level.rocks) {
    if (ignore && rock.pos.x === ignore.x && rock.pos.y === ignore.y) continue;
    if (distance(pos, rock.pos) < rock.radius + 50) return true;
  }
  for (const mud of level.muds) {
    if (ignore && mud.pos.x === ignore.x && mud.pos.y === ignore.y) continue;
    if (distance(pos, mud.pos) < mud.radius + 30) return true;
  }
  return false;
}

function hintPos(target: Vec2, level: Level, offset: number, ignore?: Vec2): Vec2 {
  const normal = roadNormalAt(target, level);
  const preferred = add(target, scaleVec(normal, offset));
  if (!hintOverlapsObstacle(preferred, level, ignore)) return preferred;
  const flipped = add(target, scaleVec(normal, -offset));
  if (!hintOverlapsObstacle(flipped, level, ignore)) return flipped;
  return add(target, scaleVec(normal, offset * 1.5));
}

function controlHintPos(base: Vec2, heading: number): Vec2 {
  const dist = 100;
  const behind = { x: base.x - Math.cos(heading) * dist, y: base.y - Math.sin(heading) * dist };
  if (behind.y <= base.y) return behind;
  const perp = heading + Math.PI / 2;
  const left = { x: base.x + Math.cos(perp) * dist, y: base.y + Math.sin(perp) * dist };
  if (left.y <= base.y) return left;
  const right = { x: base.x - Math.cos(perp) * dist, y: base.y - Math.sin(perp) * dist };
  if (right.y <= base.y) return right;
  return { x: base.x, y: base.y - dist };
}

function buildCampaign1Hints(level: Level, session: GameSession): WorldHint[] {
  const heading = startHeading(level, session.base, session.pickups, session.destination);
  const cp = controlHintPos(session.base.pos, heading);
  const hints: WorldHint[] = [{
    lines: ["hold to go right", "release to go left"],
    ...cp,
  }];
  const firstPickup = session.pickups[0];
  if (firstPickup) {
    const p = hintPos(firstPickup.pos, level, 110);
    hints.push({ lines: ["this is a warehouse", "visit them all"], arrowTo: firstPickup.pos, ...p });
  }
  {
    const p = hintPos(session.destination.pos, level, 110);
    hints.push({ lines: ["this is the drop-off", "finish the level here"], arrowTo: session.destination.pos, ...p });
  }
  if (level.muds.length > 0) {
    let closest = level.muds[0]!;
    let closestDist = distance(session.base.pos, closest.pos);
    for (let i = 1; i < level.muds.length; i++) {
      const d = distance(session.base.pos, level.muds[i]!.pos);
      if (d < closestDist) { closest = level.muds[i]!; closestDist = d; }
    }
    const p = hintPos(closest.pos, level, closest.radius + 60, closest.pos);
    hints.push({ lines: ["this is mud", "it's slippery"], arrowTo: closest.pos, ...p });
  }
  if (level.rocks.length > 0) {
    let closest = level.rocks[0]!;
    let closestDist = distance(session.base.pos, closest.pos);
    for (let i = 1; i < level.rocks.length; i++) {
      const d = distance(session.base.pos, level.rocks[i]!.pos);
      if (d < closestDist) { closest = level.rocks[i]!; closestDist = d; }
    }
    const p = hintPos(closest.pos, level, closest.radius + 60, closest.pos);
    hints.push({ lines: ["this is a rock", "drive around it"], arrowTo: closest.pos, ...p });
  }
  return hints;
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
  levelHints = campaignNav?.index === 1 && playable.level.kind === "campaign"
    ? buildCampaign1Hints(playable.level, session)
    : [];
  countdownElapsed = 0;
  countdownStepDuration = campaignNav?.index === 1 && playable.level.kind === "campaign" ? 1.2 : COUNTDOWN_STEP_DURATION;
  lastCountdownStep = -1;
  prevOnRoad = true;
  prevInMud = false;
  prevVisitedCount = 0;
  appState = "countdown";
  setPaused(false);
  startEngine();
  startAmbience(playable.level.theme);
  // Diagnostic run log: a run begins here (best-effort, ignores failures).
  void logRun(playable.seed, nickname, "started", 0, undefined, playable.difficulty);
  setMenuOpen(false);
  startScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  // Leaving the results behind also drops the account prompt and anything it
  // was holding, so a queued submission can never outlive its run.
  closeAccountPrompt();
  pendingScoreSubmit = null;
  hud.classList.remove("hidden");
  countdownOverlay.classList.remove("hidden");
}

// The finished run's leaderboard submission, held back while the player is
// asked what name to use. Every exit from the prompt runs it: under the account
// name after logging in or registering, under this device's generated nickname
// after skipping. Only abandoning the run entirely drops it.
let pendingScoreSubmit: (() => void) | null = null;

/** Where the prompt was opened from, which decides its wording, where it
 * returns to, and whether backing out counts as declining. */
type AccountPromptContext = "run" | "settings";
let accountPromptContext: AccountPromptContext = "run";

/** Asks a logged-out player to sign in, in place of whatever screen they came
 * from rather than on top of it.
 *
 * One panel, three views: the choice, and a form behind each of the first two
 * buttons. The settings page opens the same forms rather than growing a second
 * copy of them - it just starts on one directly and returns there afterwards. */
function openAccountPrompt(
  submit: (() => void) | null,
  context: AccountPromptContext = "run",
  view: HTMLElement = accountChoice,
): void {
  pendingScoreSubmit = submit;
  accountPromptContext = context;
  accountTitle.textContent =
    context === "run"
      ? storageFellBack
        ? "Log in to keep your score — progress won't survive a reload here"
        : "Log in or create an account to keep your progress"
      : "Log in or create an account";
  // Skipping after a run still puts the score up, under this device's generated
  // nickname - so the button names that nickname, and the note under it spells
  // out what the player gives up by not registering. From settings there is no
  // score in play and it's an ordinary cancel.
  const skipLabel = context === "run" ? `Continue as ${nickname}` : "Cancel";
  accountSkipBtn.textContent = skipLabel;
  accountSkipLink.textContent = skipLabel;
  accountSkipNote.textContent =
    `Your time goes on the leaderboard as ${nickname}. The name isn't reserved, ` +
    `and your progress stays on this device only.`;
  accountSkipNote.classList.toggle("hidden", context !== "run");
  showAccountView(view);
  registerUsername.value = nickname;
  registerPassword.value = "";
  registerEmail.value = "";
  registerNotifyDaily.checked = false;
  registerNotifyUpdates.checked = false;
  registerCountry.value = "";
  registerTimezone.value = detectedTimezone;
  loginUsername.value = nickname;
  loginPassword.value = "";
  syncNotifyAvailability();
  accountScreen.classList.remove("hidden");
  const firstField = view === accountLoginForm ? loginUsername : view === accountRegisterForm ? registerUsername : null;
  firstField?.focus();
  firstField?.select();
}

/** Shows one of the prompt's three views and hides the rest. The skip link
 * rides along: it belongs on the forms, where the choice's own third button
 * isn't visible, so there is always a way out. */
function showAccountView(view: HTMLElement): void {
  for (const el of [accountChoice, accountRegisterForm, accountLoginForm]) {
    el.classList.toggle("hidden", el !== view);
  }
  accountSkipLink.classList.toggle("hidden", view === accountChoice);
  accountError.classList.add("hidden");
  setAccountBusy(false);
}

function closeAccountPrompt(): void {
  accountScreen.classList.add("hidden");
}

/** Hands the player back to wherever they were: the results they would have
 * seen straight away, or the settings panel they left. */
function finishAccountPrompt(): void {
  closeAccountPrompt();
  if (accountPromptContext === "run") resultsScreen.classList.remove("hidden");
  else openProfile();
}

function showAccountError(message: string): void {
  accountError.textContent = message;
  accountError.classList.remove("hidden");
}

/** Disables the forms while a request is in flight, so a double tap can't
 * register twice. The skip button stays live on purpose - a player must never
 * be stuck waiting on a server that isn't going to answer. */
function setAccountBusy(busy: boolean): void {
  registerSubmit.disabled = busy;
  loginSubmit.disabled = busy;
  registerSubmit.textContent = busy ? "Creating…" : "Create account";
  loginSubmit.textContent = busy ? "Logging in…" : "Log in";
}

/** A subscription needs somewhere to send to, and the server rejects the
 * combination outright, so the boxes only unlock once an address is typed. */
function syncNotifyAvailability(): void {
  const hasEmail = registerEmail.value.trim() !== "";
  registerNotifyDaily.disabled = !hasEmail;
  registerNotifyUpdates.disabled = !hasEmail;
  if (!hasEmail) {
    registerNotifyDaily.checked = false;
    registerNotifyUpdates.checked = false;
  }
}

/** Runs the held-back submission under the now-logged-in identity.
 *
 * The username is the leaderboard name, so the local nickname follows it -
 * otherwise the queued submission would go up under whatever this device was
 * called before, which is a name the account may not even own. */
function completeAccountPrompt(username: string): void {
  applyNickname(username);
  // An account supersedes the old sync code, however this player got here.
  clearSyncToken();
  const submit = pendingScoreSubmit;
  pendingScoreSubmit = null;
  finishAccountPrompt();
  submit?.();
  // Logging in on a fresh device is the moment this matters most: it is what
  // brings back a streak, a difficulty preference, and every personal-best
  // ghost the account has stored.
  void syncAccount();
}

/** Declines the account. After a run the score still goes up - anonymously,
 * under this device's generated nickname, which the server accepts for any name
 * nobody has registered - and the question stays away for a week rather than
 * greeting every finish. From the settings page it is just a cancel: there is no
 * score in play, and it shouldn't buy a week's silence the player never asked
 * for. */
function declineAccountPrompt(): void {
  if (accountPromptContext === "run") recordAccountPromptDeclined();
  const submit = pendingScoreSubmit;
  pendingScoreSubmit = null;
  finishAccountPrompt();
  submit?.();
}

accountCreateBtn.addEventListener("click", () => {
  showAccountView(accountRegisterForm);
  registerUsername.focus();
  registerUsername.select();
});

accountLoginBtn.addEventListener("click", () => {
  showAccountView(accountLoginForm);
  loginUsername.focus();
  loginUsername.select();
});

accountSkipBtn.addEventListener("click", declineAccountPrompt);
accountSkipLink.addEventListener("click", declineAccountPrompt);
registerEmail.addEventListener("input", syncNotifyAvailability);

// forEach rather than for-of: the tsconfig lib list is ES2022 + DOM without
// DOM.Iterable, so a NodeList isn't iterable as far as the compiler is
// concerned.
document.querySelectorAll<HTMLButtonElement>(".account-back").forEach((backBtn) => {
  backBtn.addEventListener("click", () => showAccountView(accountChoice));
});

accountRegisterForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAccountBusy(true);
  accountError.classList.add("hidden");
  const email = registerEmail.value.trim();
  const country = registerCountry.value;
  const tz = registerTimezone.value;
  const result = await register({
    username: registerUsername.value.trim(),
    password: registerPassword.value,
    ...(email ? { email } : {}),
    notifyDaily: registerNotifyDaily.checked,
    notifyUpdates: registerNotifyUpdates.checked,
    ...(country ? { country } : {}),
    ...(tz ? { timezone: tz } : {}),
  });
  setAccountBusy(false);
  if (!result.ok) {
    showAccountError(result.error);
    return;
  }
  completeAccountPrompt(result.account.username);
});

accountLoginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAccountBusy(true);
  accountError.classList.add("hidden");
  const result = await login(loginUsername.value.trim(), loginPassword.value);
  setAccountBusy(false);
  if (!result.ok) {
    showAccountError(result.error);
    return;
  }
  completeAccountPrompt(result.account.username);
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
  void logRun(active.seed, nickname, runStatus, session.visited.size, timeNote, active.difficulty);
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
      void syncAccountState();
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
        active.level.kind === "campaign" ? submittedSeed.startsWith(campaignPrefix())
          : active.level.kind === "weekly" ? submittedSeed === weekSeed(0) : submittedSeed === todaysSeed;
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
    resultsStability.textContent =
      session.failReason === "cargoRock" ? "Crashing that rock lost you your cargo!"
      : session.failReason === "cargoMud" ? "You slipped in the mud and lost your cargo!"
      : "Drive smoother and avoid mud and rocks.";
    resultsPersonalBest.textContent = "";
    resultsMedal.classList.add("hidden");
    shareBtn.classList.add("hidden");
    lastShareText = null;
  }

  if (campaignNav && session.status === "success" && campaignNav.index < CAMPAIGN_TOTAL && isCampaignSlotOpen(campaignNav.index + 1)) {
    nextBtn.classList.remove("hidden");
  } else {
    nextBtn.classList.add("hidden");
  }

  // A logged-out run still reaches the board, under this device's generated
  // nickname - the server takes any name nobody has registered. So the prompt is
  // about owning that name and keeping the progress, not about whether the run
  // counts, and every path below submits.
  //
  // `submitRun` being set already implies a successful, non-orphan run, so there
  // is nothing to ask about otherwise. Someone who declined recently isn't asked
  // again for a week; their runs keep going up anonymously in the meantime.
  if (submitRun && !isLoggedIn() && !accountPromptRecentlyDeclined()) {
    openAccountPrompt(submitRun);
  } else {
    submitRun?.();
    resultsScreen.classList.remove("hidden");
  }
}

/** Tears a run down and puts the start screen back up.
 *
 * Shared by every exit from a run so they can't drift apart: this was once
 * duplicated into goNextCampaign, which omitted the start-screen reveal and
 * left the player staring at an empty canvas with the loop still running.
 * Anything that ends a run belongs here, not in one caller. */
function leaveRunToStartScreen(): void {
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
  // Leaving the results behind also drops the account prompt and anything it
  // was holding, so a queued submission can never outlive its run.
  closeAccountPrompt();
  pendingScoreSubmit = null;
  startScreen.classList.remove("hidden");
}

/** Leaves a run, countdown, or the results screen (no result is recorded if
 * mid-run) and returns to the start screen. */
function goHome(): void {
  if (appState !== "playing" && appState !== "countdown" && appState !== "ended") return;
  leaveRunToStartScreen();
  // A just-finished first delivery flips "has played", which reveals the browse
  // arrows and the Easy/Hard switch - re-evaluate both now that we're back on
  // the menu, rather than waiting for the next navigation/mode change to do it.
  updateNavButtons();
  updateDifficultySwitchVisibility();
  // Returning to the menu is a page-internal transition (no reload), so
  // game_started never re-fires here - log it as its own menu-shown event.
  void logRun(viewed.seed, nickname, "menu_shown", 0, undefined, viewed.difficulty);
}

/** Advances from the results screen to the next campaign map, landing on its
 * start screen rather than launching straight into a run. */
function goNextCampaign(): void {
  if (appState !== "ended" || !campaignNav || campaignNav.index >= CAMPAIGN_TOTAL) return;
  leaveRunToStartScreen();
  navigateCampaign(1);
  updateNavButtons();
  updateDifficultySwitchVisibility();
}

retryBtn.addEventListener("click", () => beginRun(active));
nextBtn.addEventListener("click", goNextCampaign);
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
  void logRun(viewed.seed, nickname, "tutorial_started", 0, undefined, viewed.difficulty);
  tutorial = new Tutorial();
  lastTutorialTruck = null;
  camera.x = tutorial.activeTruck.pos.x;
  camera.y = tutorial.activeTruck.pos.y;
  accumulator = 0;
  appState = "tutorial";

  startScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  // Leaving the results behind also drops the account prompt and anything it
  // was holding, so a queued submission can never outlive its run.
  closeAccountPrompt();
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
  void logRun(viewed.seed, nickname, "tutorial_ended", 0, reason, viewed.difficulty);
  tutorial = null;
  appState = "start";
  tutorialOverlay.classList.add("hidden");
  // The 3-2-1-GO overlay is shared with normal runs, so make sure a count-in
  // that was on screen when the player bailed doesn't outlive the tutorial.
  countdownOverlay.classList.add("hidden");
  if (homeTarget === "campaign") showCampaignGrid();
  else if (homeTarget === "landing") showLanding();
  else startScreen.classList.remove("hidden");
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
  void logRun(seed, nickname, "replay_started", 0, `${racers.length} racers: ${racers.map((r) => r.label).join(", ")}`, viewed.difficulty);

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
  void logRun(replayLevel?.seed ?? viewed.seed, nickname, "replay_stopped", 0, undefined, viewed.difficulty);
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
  void logRun(viewed.seed, nickname, "help_toggled", 0, helpDetailCheckbox.checked ? "full" : "summary", viewed.difficulty);
});

function openHelp(): void {
  helpOpen = true;
  setHelpDetail(false); // always reopen on the summary
  helpScreen.classList.remove("hidden");
  void logRun(viewed.seed, nickname, "help_opened", 0, undefined, viewed.difficulty);
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

/** Repaints everything in the settings panel that depends on being logged in:
 * the account section's two views, and the nickname field, which goes
 * read-only because the username IS the leaderboard name - an editable
 * nickname beside it would be a second, lying identity. */
function updateAccountUi(): void {
  const user = currentUser();
  accountLoggedOut.classList.toggle("hidden", user !== null);
  accountLoggedIn.classList.toggle("hidden", user === null);
  // The upgrade offer only means anything to someone holding an old code who
  // hasn't already got an account.
  syncMigrateRow.classList.toggle("hidden", user !== null || loadSyncToken() === null);
  adminSection.classList.toggle("hidden", !user?.isAdmin);
  adminOptimalBtn.textContent = `Optimal: ${optimalEnabled ? "on" : "off"}`;
  accountDeleteConfirm.classList.add("hidden");
  accountSectionError.classList.add("hidden");
  accountEmailStatus.classList.add("hidden");
  accountLocationStatus.classList.add("hidden");
  accountPasswordStatus.classList.add("hidden");
  if (user) {
    accountUsernameEl.textContent = user.username;
    accountEmailInput.value = user.email ?? "";
    accountNotifyDaily.checked = user.notifyDaily;
    accountNotifyUpdates.checked = user.notifyUpdates;
    accountCountry.value = user.country ?? "";
    accountTimezone.value = user.timezone ?? "";
  }
  syncAccountNotifyAvailability();
}

/** Same rule as the register form: a subscription needs an address to send to,
 * and the server rejects the pair outright. */
function syncAccountNotifyAvailability(): void {
  const hasEmail = accountEmailInput.value.trim() !== "";
  accountNotifyDaily.disabled = !hasEmail;
  accountNotifyUpdates.disabled = !hasEmail;
  if (!hasEmail) {
    accountNotifyDaily.checked = false;
    accountNotifyUpdates.checked = false;
  }
}

function flashDetailStatus(el: HTMLElement, message: string, durationMs = 3000): void {
  el.textContent = message;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), durationMs);
}

function showAccountSectionError(message: string): void {
  accountSectionError.textContent = message;
  accountSectionError.classList.remove("hidden");
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
  updateAccountUi();
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
// Every menu's gear opens the same panel, wired by class rather than by id so
// a new screen only has to drop a .settings-btn into its header row.
// forEach rather than for-of: the project's lib config has no DOM.Iterable, so
// a NodeList isn't iterable here.
document.querySelectorAll<HTMLButtonElement>(".settings-btn").forEach((btn) => {
  btn.addEventListener("click", openProfile);
});
profileCloseBtn.addEventListener("click", closeProfile);
profileDismissBtn.addEventListener("click", closeProfile);
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

// Pull-to-refresh on mobile navigation screens. The body never scrolls (the
// layout is overflow:hidden) so the browser's native gesture can't fire; this
// reimplements it as a touch drag on any .screen element that's at scrollTop 0.
const PULL_THRESHOLD = 100;
const pullIndicator = document.getElementById("pull-indicator")!;
let pullStartY = 0;
let pulling = false;

function isNavigationScreen(): boolean {
  return appState === "start" || appState === "ended";
}

document.addEventListener("touchstart", (e) => {
  if (!isNavigationScreen()) return;
  const touch = e.touches[0];
  if (!touch) return;
  const target = e.target as HTMLElement;
  const screen = target.closest(".screen") as HTMLElement | null;
  if (!screen || screen.scrollTop > 0) return;
  pullStartY = touch.clientY;
  pulling = true;
  pullIndicator.classList.remove("hidden");
}, { passive: true });

document.addEventListener("touchmove", (e) => {
  if (!pulling) return;
  const touch = e.touches[0];
  if (!touch) return;
  const dy = touch.clientY - pullStartY;
  if (dy > 0) {
    const progress = Math.min(dy / PULL_THRESHOLD, 1);
    pullIndicator.style.top = `${Math.min(dy * 0.4, 60)}px`;
    pullIndicator.style.opacity = String(progress);
    pullIndicator.classList.toggle("visible", progress > 0.1);
  } else {
    pullIndicator.classList.remove("visible");
  }
}, { passive: true });

document.addEventListener("touchend", () => {
  if (!pulling) return;
  pulling = false;
  const wasVisible = pullIndicator.classList.contains("visible");
  const top = parseFloat(pullIndicator.style.top || "0");
  pullIndicator.classList.remove("visible");
  pullIndicator.classList.add("hidden");
  pullIndicator.style.top = "0";
  pullIndicator.style.opacity = "0";
  if (wasVisible && top >= PULL_THRESHOLD * 0.4) {
    location.reload();
  }
}, { passive: true });

settingsLoginBtn.addEventListener("click", () => {
  closeProfile();
  openAccountPrompt(null, "settings", accountLoginForm);
});

settingsRegisterBtn.addEventListener("click", () => {
  closeProfile();
  openAccountPrompt(null, "settings", accountRegisterForm);
});

/** Turns an old sync code into a real account.
 *
 * Holding the code is the only proof of ownership available, so this is the one
 * migration that can carry a nickname across without an ownership question. The
 * code's completed days are merged into local storage first, then the ordinary
 * register form opens - so whatever the account ends up holding starts from
 * everything this player had. */
syncMigrateBtn.addEventListener("click", async () => {
  const token = loadSyncToken();
  if (!token) return;
  syncMigrateBtn.disabled = true;
  const account = await fetchSyncAccount(token);
  syncMigrateBtn.disabled = false;
  if (account) {
    for (const seed of account.completed) recordCompletion(seed);
    renderProgressStrip();
    // The code's nickname wins: it's the name their scores are already under.
    if (account.nickname) applyNickname(account.nickname);
  }
  closeProfile();
  openAccountPrompt(null, "settings", accountRegisterForm);
});

accountEmailInput.addEventListener("input", syncAccountNotifyAvailability);

accountEmailSaveBtn.addEventListener("click", async () => {
  accountEmailSaveBtn.disabled = true;
  const email = accountEmailInput.value.trim();
  const result = await updateAccount({
    email: email === "" ? null : email,
    notifyDaily: accountNotifyDaily.checked,
    notifyUpdates: accountNotifyUpdates.checked,
  });
  accountEmailSaveBtn.disabled = false;
  if (result.ok) flashDetailStatus(accountEmailStatus, "Saved.");
  else showAccountSectionError(result.error);
});

accountLocationSaveBtn.addEventListener("click", async () => {
  accountLocationSaveBtn.disabled = true;
  const country = accountCountry.value;
  const tz = accountTimezone.value;
  const result = await updateAccount({
    country: country === "" ? null : country,
    timezone: tz === "" ? null : tz,
  });
  accountLocationSaveBtn.disabled = false;
  if (result.ok) flashDetailStatus(accountLocationStatus, "Saved.");
  else showAccountSectionError(result.error);
});

accountPasswordBtn.addEventListener("click", async () => {
  accountPasswordBtn.disabled = true;
  const result = await updateAccount({
    currentPassword: accountCurrentPassword.value,
    newPassword: accountNewPassword.value,
  });
  accountPasswordBtn.disabled = false;
  if (!result.ok) {
    showAccountSectionError(result.error);
    return;
  }
  accountCurrentPassword.value = "";
  accountNewPassword.value = "";
  flashDetailStatus(accountPasswordStatus, "Password changed. Other devices have been logged out.", 5000);
});

accountLogoutBtn.addEventListener("click", async () => {
  accountLogoutBtn.disabled = true;
  await logout();
  accountLogoutBtn.disabled = false;
  updateAccountUi();
});

accountDeleteBtn.addEventListener("click", () => {
  accountDeletePassword.value = "";
  accountDeleteConfirm.classList.remove("hidden");
  accountDeletePassword.focus();
});

accountDeleteCancelBtn.addEventListener("click", () => {
  accountDeleteConfirm.classList.add("hidden");
});

accountDeleteConfirmBtn.addEventListener("click", async () => {
  accountDeleteConfirmBtn.disabled = true;
  const result = await deleteAccount(accountDeletePassword.value);
  accountDeleteConfirmBtn.disabled = false;
  if (!result.ok) {
    showAccountSectionError(result.error);
    return;
  }
  updateAccountUi();
});

adminOptimalBtn.addEventListener("click", () => {
  const url = new URL(window.location.href);
  if (optimalEnabled) {
    url.searchParams.delete("optimal");
  } else {
    url.searchParams.set("optimal", "true");
  }
  window.location.href = url.toString();
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
  // The account prompt is modal: Enter submits whichever form is open (the
  // browser does that for us) and Escape declines, while the run controls
  // behind it stay inert - otherwise Enter would submit the form and
  // immediately restart the run as well.
  if (!accountScreen.classList.contains("hidden")) {
    if (e.key === "Escape") declineAccountPrompt();
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
    e.preventDefault();
    beginRun(active);
  }
  if ((e.key === "p" || e.key === "P") && appState === "playing") {
    setPaused(!paused);
    void logRun(active.seed, nickname, paused ? "paused" : "resumed", session?.visited.size ?? 0, undefined, active.difficulty);
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
    levelHints,
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
    const step = countdownLabel(countdownElapsed, countdownStepDuration);
    if (step === null) {
      appState = "playing";
      accumulator = 0;
      countdownOverlay.classList.add("hidden");
      startWobble();
    } else {
      const stepIdx = Math.floor(countdownElapsed / countdownStepDuration);
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
updateLandingTiles();
// The landing tile's campaign dots are keyed to each slot's resolved seed, so
// pull this month's alternate-map choices and repaint if any of them differ
// from the defaults just drawn.
void loadCampaignOverrides(0).then((changed) => {
  if (changed) updateLandingTiles();
});
requestAnimationFrame(frame);
