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
