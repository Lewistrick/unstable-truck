import { resolveApiRoot } from "./config.js";
import { loadAuthToken } from "./storage.js";

export type Difficulty = "easy" | "hard";

export interface LeaderboardEntry {
  rank: number;
  nickname: string;
  time: number;
  stability: number;
}

export interface LeaderboardResponse {
  seed: string;
  top: LeaderboardEntry[];
  context: LeaderboardEntry[];
  /** The champion-medal threshold for this seed, or null if none is set yet. */
  championTime: number | null;
  /** Total number of ranked players for this seed (the field size a rank is
   * "out of"). Absent from older servers, so treat missing as unknown. */
  total?: number;
}

export interface RemoteRecording {
  seed: string;
  nickname: string;
  time: number;
  stability: number;
  inputLog: number[];
}

const API_ROOT = resolveApiRoot();

/** Builds an absolute API URL from a path relative to the app's base (no
 * leading slash), e.g. apiUrl(`api/scores/${seed}`). */
function apiUrl(pathAndQuery: string): string {
  return new URL(pathAndQuery, API_ROOT).href;
}

/** The Authorization header for the logged-in account, or nothing at all when
 * logged out - which is the ordinary case and stays a valid anonymous request.
 *
 * Sent on the three endpoints that now check it: submitting a score, logging a
 * run, and freezing a champion threshold. A registered player whose requests
 * arrived without this would be refused their own name. */
function authHeaders(): Record<string, string> {
  const token = loadAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** What became of a score submission.
 *
 * - `saved`      - stored, and it beat whatever was there before.
 * - `not-better` - accepted, but an existing best for that seed was faster.
 * - `name-taken` - the nickname is registered to an account and this request
 *                  wasn't logged in as it. The only outcome worth telling the
 *                  player about: it's fixable, by logging in.
 * - `failed`     - unreachable server, or any other error. Indistinguishable
 *                  from playing offline, and treated the same way: silently.
 */
export type SubmitResult = "saved" | "not-better" | "name-taken" | "failed";

/** Submits a run's result to the backend. Fails silently (returns "failed") if
 * the server is unreachable - the game is fully playable offline, this is
 * best-effort syncing on top of the local personal best. */
export async function submitScore(
  seed: string,
  nickname: string,
  difficulty: Difficulty,
  time: number,
  stability: number,
  inputLog: number[],
  championCandidate: number | null,
  isCurrentPeriod: boolean,
  medal: string | null = null,
): Promise<SubmitResult> {
  try {
    const res = await fetch(apiUrl(`api/scores/${seed}`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ nickname, difficulty, time, stability, inputLog, championCandidate, isCurrentPeriod, medal }),
    });
    if (res.status === 403) return "name-taken";
    if (!res.ok) return "failed";
    const data = (await res.json()) as { saved?: boolean };
    return data.saved ? "saved" : "not-better";
  } catch {
    return "failed";
  }
}

/** Top 10 for a (seed, difficulty), plus rank-context around `nickname` if
 * they're not already in the top 10. Returns null if the server is
 * unreachable. */
export async function fetchLeaderboard(seed: string, difficulty: Difficulty, nickname?: string): Promise<LeaderboardResponse | null> {
  try {
    const params = new URLSearchParams({ difficulty });
    if (nickname) params.set("nickname", nickname);
    const res = await fetch(apiUrl(`api/scores/${seed}?${params}`));
    if (!res.ok) return null;
    return (await res.json()) as LeaderboardResponse;
  } catch {
    return null;
  }
}

/** The event types logged for diagnostics, matching the server's RunStatus. A
 * run logs "started" then one terminal state; the rest are home-screen / session
 * interactions. The seed on each row is whichever map it applies to. */
export type RunStatus =
  | "game_started"
  | "started"
  | "finished"
  | "cargo_fell_off"
  | "out_of_bounds"
  | "navigated"
  | "mode_switched"
  | "difficulty_switched"
  | "paused"
  | "resumed"
  | "replay_started"
  | "replay_stopped"
  | "help_opened"
  | "help_toggled"
  | "tutorial_started"
  | "tutorial_ended"
  | "menu_shown"
  | "shared"
  | "username_changed";

/** Best-effort diagnostics telemetry (see run_logs). `comment` is optional
 * free-form context (e.g. an old->new nickname). Swallows failures like
 * submitScore so it never affects play, but warns to the console so a persistent
 * delivery failure is at least visible in devtools rather than silent. */
export async function logRun(
  seed: string,
  nickname: string,
  status: RunStatus,
  collected: number,
  comment?: string,
  difficulty?: Difficulty,
): Promise<void> {
  try {
    const res = await fetch(apiUrl("api/runs"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ seed, nickname, status, collected, difficulty, comment }),
    });
    if (!res.ok) console.warn(`run log "${status}" for ${seed} rejected: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`run log "${status}" for ${seed} failed to send:`, err);
  }
}

/** Freezes a (seed, difficulty)'s champion threshold if the server doesn't have
 * one yet (no-op if it already does). Used to seed a threshold for a past day's
 * record so the champion medal is beatable there. Best-effort. */
export async function backfillChampionTime(seed: string, difficulty: Difficulty, championTime: number): Promise<void> {
  try {
    await fetch(apiUrl(`api/champions/${seed}`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ difficulty, championTime }),
    });
  } catch {
    // Best-effort; the medal still shows locally from the derived value.
  }
}

/** Champion-medal thresholds for several seeds at once on one difficulty, as a
 * { seed: time } map (seeds without a stored threshold are absent). Returns {}
 * if the server is unreachable. Used to colour the streak calendar's day dots. */
export async function fetchChampionTimes(seeds: string[], difficulty: Difficulty): Promise<Record<string, number>> {
  if (seeds.length === 0) return {};
  try {
    const params = new URLSearchParams({ seeds: seeds.join(","), difficulty });
    const res = await fetch(apiUrl(`api/champions?${params}`));
    if (!res.ok) return {};
    return (await res.json()) as Record<string, number>;
  } catch {
    return {};
  }
}

/** The server's precomputed near-optimal solver route for a daily seed, if it's
 * been solved and stored. Returns null on a 404 (not computed yet) or when the
 * server is unreachable, so the caller can fall back to solving locally.
 * Hard-only: the solver never targets Easy's slower physics. */
export async function fetchOptimalRoute(
  seed: string,
): Promise<{ seed: string; time: number; stability: number; inputLog: number[] } | null> {
  try {
    const res = await fetch(apiUrl(`api/optimal/${seed}`));
    if (!res.ok) return null;
    return (await res.json()) as { seed: string; time: number; stability: number; inputLog: number[] };
  } catch {
    return null;
  }
}

// --- Accounts --------------------------------------------------------------

/** A registered player, as the server describes them. Never carries anything
 * secret, so it is safe to cache locally. */
export interface Account {
  id: number;
  username: string;
  email: string | null;
  notifyDaily: boolean;
  notifyUpdates: boolean;
  country: string | null;
  timezone: string | null;
  isAdmin: boolean;
}

export interface RegisterFields {
  username: string;
  password: string;
  email?: string;
  notifyDaily?: boolean;
  notifyUpdates?: boolean;
  country?: string;
  timezone?: string;
}

/** Register/login either works or explains why in a sentence fit to show the
 * player. The server's own messages ("that username is taken", "username or
 * password is incorrect") are already written for that, so they are passed
 * through rather than re-worded here. */
export type AuthResponse = { ok: true; token: string; account: Account } | { ok: false; error: string };

const UNREACHABLE_MESSAGE = "Can't reach the server. Check your connection and try again.";

async function postAuth(path: string, body: unknown): Promise<AuthResponse> {
  try {
    const res = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { token?: string; user?: Account; error?: string };
    if (!res.ok || !data.token || !data.user) {
      return { ok: false, error: data.error ?? "Something went wrong. Try again." };
    }
    return { ok: true, token: data.token, account: data.user };
  } catch {
    return { ok: false, error: UNREACHABLE_MESSAGE };
  }
}

export function registerAccount(fields: RegisterFields): Promise<AuthResponse> {
  return postAuth("api/auth/register", fields);
}

export function loginAccount(username: string, password: string): Promise<AuthResponse> {
  return postAuth("api/auth/login", { username, password });
}

/** Ends the session server-side. Best-effort: the local session is dropped
 * either way, so a failure here only leaves a row to expire on its own. */
export async function logoutAccount(): Promise<void> {
  try {
    await fetch(apiUrl("api/auth/logout"), { method: "POST", headers: { ...authHeaders() } });
  } catch {
    // Nothing to do - see above.
  }
}

/** Re-reads the logged-in account.
 *
 * "logged-out" and "offline" are kept apart on purpose: the first means the
 * session is genuinely gone and the local copy should be cleared, the second
 * means we simply couldn't ask, and a cached account is still the best answer
 * available. Collapsing them would log players out every time they opened the
 * game on a train. */
export type AccountCheck = { status: "ok"; account: Account } | { status: "logged-out" } | { status: "offline" };

export async function fetchAccount(): Promise<AccountCheck> {
  try {
    const res = await fetch(apiUrl("api/auth/me"), { headers: { ...authHeaders() } });
    if (res.status === 401) return { status: "logged-out" };
    if (!res.ok) return { status: "offline" };
    const data = (await res.json()) as { user: Account };
    return { status: "ok", account: data.user };
  } catch {
    return { status: "offline" };
  }
}

/** How a player's truck looks. Stored and synced, but nothing reads it yet -
 * the renderer still draws the one fixed truck. Kept in sync with the server's
 * own copy in server/account-state.ts. */
export type TruckPattern = "horizontal" | "vertical" | "diagonal" | "striped" | "checkered";

export interface TruckAppearance {
  /** Body colour as "#rrggbb". */
  primary: string;
  /** Second colour, used by whichever pattern is chosen. */
  secondary: string;
  pattern: TruckPattern;
}

/** The per-player state an account carries - everything that used to live only
 * in localStorage. Merge rules live on the server (server/account-state.ts) so
 * one set of them governs every device. */
export interface AccountState {
  completed: string[];
  played: string[];
  difficulty: Difficulty | null;
  playTimeSeconds: number;
  source: string | null;
  truck: TruckAppearance | null;
}

export interface RemoteBest {
  seed: string;
  difficulty: Difficulty;
  time: number;
  stability: number;
  inputLog: number[];
}

/** Pushes this device's state and returns the merged result, so one round trip
 * serves as both push and pull. Null if the server couldn't be reached, which
 * is not an error - the local copy is still authoritative for play. */
export async function pushAccountState(state: AccountState): Promise<AccountState | null> {
  try {
    const res = await fetch(apiUrl("api/me/state"), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ state }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { state: AccountState }).state;
  } catch {
    return null;
  }
}

/** Every recording stored under this account, for rebuilding personal bests on
 * a device that has never seen them. One request rather than one per seed. */
export async function fetchAccountBests(): Promise<RemoteBest[]> {
  try {
    const res = await fetch(apiUrl("api/me/bests"), { headers: { ...authHeaders() } });
    if (!res.ok) return [];
    return ((await res.json()) as { bests: RemoteBest[] }).bests;
  } catch {
    return [];
  }
}

/** Fields for a partial account update. Anything left out is untouched, which
 * is what lets the settings page save an email without disturbing a password
 * and vice versa. `email: null` clears the address. */
export interface AccountUpdateFields {
  email?: string | null;
  notifyDaily?: boolean;
  notifyUpdates?: boolean;
  country?: string | null;
  timezone?: string | null;
  currentPassword?: string;
  newPassword?: string;
}

/** A password change rotates every session, so the server hands back a fresh
 * token for the device that made the change. Absent for other updates. */
export type AccountUpdateResponse = { ok: true; account: Account; token?: string } | { ok: false; error: string };

export async function patchAccount(fields: AccountUpdateFields): Promise<AccountUpdateResponse> {
  try {
    const res = await fetch(apiUrl("api/auth/me"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(fields),
    });
    const data = (await res.json().catch(() => ({}))) as { user?: Account; token?: string; error?: string };
    if (!res.ok || !data.user) return { ok: false, error: data.error ?? "Something went wrong. Try again." };
    return data.token ? { ok: true, account: data.user, token: data.token } : { ok: true, account: data.user };
  } catch {
    return { ok: false, error: UNREACHABLE_MESSAGE };
  }
}

export async function deleteAccountRequest(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(apiUrl("api/auth/me"), {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ password }),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Something went wrong. Try again." };
  } catch {
    return { ok: false, error: UNREACHABLE_MESSAGE };
  }
}

// --- Cross-device sync account API -----------------------------------------

export interface AccountData {
  token: string;
  nickname: string;
  difficulty: string | null;
  completed: string[];
}

export async function createSyncAccount(nickname: string, difficulty: string | null, completed: string[]): Promise<string | null> {
  try {
    const res = await fetch(apiUrl("api/account"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, difficulty, completed }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token: string };
    return data.token;
  } catch {
    return null;
  }
}

export async function fetchSyncAccount(token: string): Promise<AccountData | null> {
  try {
    const res = await fetch(apiUrl(`api/account/${encodeURIComponent(token)}`));
    if (!res.ok) return null;
    return (await res.json()) as AccountData;
  } catch {
    return null;
  }
}

export async function pushSyncAccount(token: string, nickname: string, difficulty: string | null, completed: string[]): Promise<AccountData | null> {
  try {
    const res = await fetch(apiUrl(`api/account/${encodeURIComponent(token)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, difficulty, completed }),
    });
    if (!res.ok) return null;
    return (await res.json()) as AccountData;
  } catch {
    return null;
  }
}

export interface PlayerStatsResponse {
  totalScores: number;
  worldFirsts: number;
  medals: { champion: number; gold: number; silver: number; bronze: number; none: number };
}

export async function fetchStats(nickname: string, difficulty: Difficulty): Promise<PlayerStatsResponse | null> {
  try {
    const params = new URLSearchParams({ difficulty });
    const res = await fetch(apiUrl(`api/stats/${encodeURIComponent(nickname)}?${params}`));
    if (!res.ok) return null;
    return (await res.json()) as PlayerStatsResponse;
  } catch {
    return null;
  }
}

/** A specific player's full recording for a (seed, difficulty), used to build
 * their ghost when selected from the leaderboard. */
export async function fetchPlayerRecording(seed: string, nickname: string, difficulty: Difficulty): Promise<RemoteRecording | null> {
  try {
    const params = new URLSearchParams({ difficulty });
    const res = await fetch(apiUrl(`api/scores/${seed}/${encodeURIComponent(nickname)}?${params}`));
    if (!res.ok) return null;
    return (await res.json()) as RemoteRecording;
  } catch {
    return null;
  }
}
