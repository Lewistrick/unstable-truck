// The logged-in session: who the player is, and how that changes.
//
// Network calls live in api.ts with every other endpoint; this module owns the
// state around them - the cached account, and persisting or dropping it. Kept
// separate so main.ts asks "is anyone logged in?" without touching storage or
// fetch directly.
import { fetchAccount, loginAccount, logoutAccount, registerAccount } from "./api.js";
import type { Account, AuthResponse, RegisterFields } from "./api.js";
import { clearAuthSession, loadAuthSession, saveAuthSession } from "./storage.js";

let session = loadAuthSession();

/** The logged-in account, or null. Answers from the local cache, so it is
 * correct offline and needs no await. */
export function currentUser(): Account | null {
  return session?.account ?? null;
}

export function isLoggedIn(): boolean {
  return session !== null;
}

function adopt(result: AuthResponse): AuthResponse {
  if (result.ok) {
    session = { token: result.token, account: result.account };
    saveAuthSession(result.token, result.account);
  }
  return result;
}

export async function register(fields: RegisterFields): Promise<AuthResponse> {
  return adopt(await registerAccount(fields));
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  return adopt(await loginAccount(username, password));
}

export async function logout(): Promise<void> {
  await logoutAccount();
  session = null;
  clearAuthSession();
}

/** Re-reads the account from the server, if there is a session at all.
 *
 * Only a definite 401 drops the local session. Being offline leaves it exactly
 * as it was - the game is playable without a network, and logging someone out
 * for boarding a train would be a bug, not a security measure. */
export async function refreshAccount(): Promise<void> {
  if (!session) return;
  const check = await fetchAccount();
  if (check.status === "logged-out") {
    session = null;
    clearAuthSession();
  } else if (check.status === "ok") {
    session = { token: session.token, account: check.account };
    saveAuthSession(session.token, check.account);
  }
}
