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
}

export interface RemoteRecording {
  seed: string;
  nickname: string;
  time: number;
  stability: number;
  inputLog: number[];
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
): Promise<boolean> {
  try {
    const res = await fetch(`/api/scores/${seed}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, time, stability, inputLog }),
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
    const url = nickname ? `/api/scores/${seed}?nickname=${encodeURIComponent(nickname)}` : `/api/scores/${seed}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as LeaderboardResponse;
  } catch {
    return null;
  }
}

/** A specific player's full recording for a seed, used to build their ghost
 * when selected from the leaderboard. */
export async function fetchPlayerRecording(seed: string, nickname: string): Promise<RemoteRecording | null> {
  try {
    const res = await fetch(`/api/scores/${seed}/${encodeURIComponent(nickname)}`);
    if (!res.ok) return null;
    return (await res.json()) as RemoteRecording;
  } catch {
    return null;
  }
}
