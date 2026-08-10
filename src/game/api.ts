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

// The game can be served from the domain root (local dev / `npm start`) or
// under a sub-path behind a reverse proxy (e.g.
// https://lewistrick.com/unstable-truck/). Resolving API URLs relative to the
// document's own directory - instead of a root-absolute "/api/..." that would
// escape the sub-path and 404 - lets both work without the frontend knowing
// its deploy path. This relies on the page being served with a trailing slash
// so the base directory is right, so the proxy must redirect
// /unstable-truck -> /unstable-truck/.
const API_ROOT = new URL(".", document.baseURI);

/** Builds an absolute API URL from a path relative to the app's base (no
 * leading slash), e.g. apiUrl(`api/scores/${seed}`). */
function apiUrl(pathAndQuery: string): string {
  return new URL(pathAndQuery, API_ROOT).href;
}

/** Submits a run's result to the backend. Fails silently (returns false) if
 * the server is unreachable - the game is fully playable offline, this is
 * best-effort syncing on top of the local personal best. */
export async function submitScore(
  seed: string,
  nickname: string,
  time: number,
  stability: number,
  inputLog: number[],
  championCandidate: number | null,
  isCurrentPeriod: boolean,
): Promise<boolean> {
  try {
    const res = await fetch(apiUrl(`api/scores/${seed}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, time, stability, inputLog, championCandidate, isCurrentPeriod }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { saved?: boolean };
    return Boolean(data.saved);
  } catch {
    return false;
  }
}

/** Top 10 for a seed, plus rank-context around `nickname` if they're not
 * already in the top 10. Returns null if the server is unreachable. */
export async function fetchLeaderboard(seed: string, nickname?: string): Promise<LeaderboardResponse | null> {
  try {
    const path = nickname ? `api/scores/${seed}?nickname=${encodeURIComponent(nickname)}` : `api/scores/${seed}`;
    const res = await fetch(apiUrl(path));
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
  | "started"
  | "finished"
  | "cargo_fell_off"
  | "out_of_bounds"
  | "navigated"
  | "mode_switched"
  | "paused"
  | "resumed"
  | "replay_started"
  | "replay_stopped"
  | "help_opened"
  | "help_toggled"
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
): Promise<void> {
  try {
    const res = await fetch(apiUrl("api/runs"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed, nickname, status, collected, comment }),
    });
    if (!res.ok) console.warn(`run log "${status}" for ${seed} rejected: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`run log "${status}" for ${seed} failed to send:`, err);
  }
}

/** Freezes a seed's champion threshold if the server doesn't have one yet
 * (no-op if it already does). Used to seed a past day's threshold from its
 * record so the champion medal is beatable there. Best-effort. */
export async function backfillChampionTime(seed: string, championTime: number): Promise<void> {
  try {
    await fetch(apiUrl(`api/champions/${seed}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ championTime }),
    });
  } catch {
    // Best-effort; the medal still shows locally from the derived value.
  }
}

/** Champion-medal thresholds for several seeds at once, as a { seed: time }
 * map (seeds without a stored threshold are absent). Returns {} if the server
 * is unreachable. Used to colour the streak calendar's day dots. */
export async function fetchChampionTimes(seeds: string[]): Promise<Record<string, number>> {
  if (seeds.length === 0) return {};
  try {
    const res = await fetch(apiUrl(`api/champions?seeds=${encodeURIComponent(seeds.join(","))}`));
    if (!res.ok) return {};
    return (await res.json()) as Record<string, number>;
  } catch {
    return {};
  }
}

/** A specific player's full recording for a seed, used to build their ghost
 * when selected from the leaderboard. */
export async function fetchPlayerRecording(seed: string, nickname: string): Promise<RemoteRecording | null> {
  try {
    const res = await fetch(apiUrl(`api/scores/${seed}/${encodeURIComponent(nickname)}`));
    if (!res.ok) return null;
    return (await res.json()) as RemoteRecording;
  } catch {
    return null;
  }
}
