// Registration, login, and account self-service.
//
// Kept out of routes.ts, which is the scores/leaderboard router - these share
// no helpers with it and have their own rate limiters.
import { Router, type Request, type Response } from "express";
import {
  createSession,
  createUser,
  deleteSession,
  deleteUser,
  deleteUserSessions,
  getPasswordHash,
  getPlayerScores,
  getUserForLogin,
  getUserState,
  promoteToAdmin,
  saveUserState,
  updateUserContactPrefs,
  updateUserPassword,
  type UserRecord,
} from "./db.js";
import { EASY_CODE } from "./db.js";
import { configuredAdmins } from "./config.js";
import { mergeState, parseState } from "./account-state.js";
import { bearerToken, hashSessionToken, mintSessionToken, requireAuth, sessionExpiry } from "./auth.js";
import { hashPassword, verifyPassword } from "./password.js";
import { RateLimiter } from "./rate-limit.js";

export const authRouter = Router();

// 16 is not arbitrary: it is MAX_NICKNAME_LENGTH in routes.ts and in the
// client's storage.ts. The username IS the leaderboard name, so a username
// longer than a nickname could never appear on the board.
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 16;
const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MIN_PASSWORD_LENGTH = 8;
// scrypt has no meaningful input-length limit (unlike bcrypt's 72 bytes), so
// this is purely to stop someone posting a megabyte to burn CPU.
const MAX_PASSWORD_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
// Deliberately loose. An address is only ever proved good by sending to it, so
// a stricter pattern would reject valid addresses to no benefit.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const MAX_TIMEZONE_LENGTH = 64;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// An unthrottled login endpoint is a password oracle, and this one is about to
// be shipped to strangers. Two limiters, because either alone has a hole: the
// per-username one stops a single account being ground down from a botnet, and
// the per-IP one stops one host working through a list of usernames.
const loginByUsername = new RateLimiter(10, 15 * MINUTE);
const loginByIp = new RateLimiter(30, 15 * MINUTE);
// Registration creates rows, so it gets a slower per-IP limit of its own.
const registerByIp = new RateLimiter(5, HOUR);

/** The client's address, for rate-limit keying. Correct only because
 * `trust proxy` is set in index.ts - without it every request behind Caddy
 * carries the proxy's address and these limiters would throttle everyone as one
 * client. */
function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}

function tooManyRequests(res: Response, retryAfterSeconds: number): void {
  res.set("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ error: "too many attempts, try again later" });
}

interface ContactPrefs {
  email: string | null;
  notifyDaily: boolean;
  notifyUpdates: boolean;
  country: string | null;
  timezone: string | null;
}

const NO_CONTACT_PREFS: ContactPrefs = {
  email: null, notifyDaily: false, notifyUpdates: false,
  country: null, timezone: null,
};

/** Reads the optional email and its two subscription flags, falling back to
 * `current` for anything the body leaves out.
 *
 * The fallback is what makes PATCH a genuine partial update: a request that
 * only changes the password must not silently wipe an address it never
 * mentioned. Register passes NO_CONTACT_PREFS, so there the fallbacks are the
 * empty defaults.
 *
 * An explicit null or empty-string email clears the address - that's the only
 * way to remove one.
 *
 * The address is NOT verified: nothing is sent to it as things stand, and
 * nothing should be until a confirmation step exists. Shape-checking here
 * catches a fat-fingered field, not a wrong address. */
function parseContactPrefs(body: Record<string, unknown>, current: ContactPrefs): ContactPrefs | null {
  let email = current.email;
  if (body.email !== undefined) {
    if (body.email === null || body.email === "") {
      email = null;
    } else if (typeof body.email === "string") {
      const trimmed = body.email.trim();
      if (trimmed === "") {
        email = null;
      } else if (trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(trimmed)) {
        return null;
      } else {
        email = trimmed;
      }
    } else {
      return null;
    }
  }

  const notifyDaily = typeof body.notifyDaily === "boolean" ? body.notifyDaily : current.notifyDaily;
  const notifyUpdates = typeof body.notifyUpdates === "boolean" ? body.notifyUpdates : current.notifyUpdates;
  // Subscribing without an address is a state that can never be acted on, so
  // reject it rather than storing a flag that quietly means nothing.
  if ((notifyDaily || notifyUpdates) && email === null) return null;

  let country = current.country;
  if (body.country !== undefined) {
    if (body.country === null || body.country === "") {
      country = null;
    } else if (typeof body.country === "string" && COUNTRY_PATTERN.test(body.country)) {
      country = body.country;
    } else {
      return null;
    }
  }

  let timezone = current.timezone;
  if (body.timezone !== undefined) {
    if (body.timezone === null || body.timezone === "") {
      timezone = null;
    } else if (typeof body.timezone === "string" && body.timezone.length <= MAX_TIMEZONE_LENGTH) {
      try {
        Intl.DateTimeFormat("en", { timeZone: body.timezone });
        timezone = body.timezone;
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  return { email, notifyDaily, notifyUpdates, country, timezone };
}

function validateUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim();
  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) return null;
  if (!USERNAME_PATTERN.test(username)) return null;
  return username;
}

function validatePassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) return null;
  return value;
}

/** Issues a session for a user and returns the raw token, which is the only
 * time it exists outside the client. */
async function startSession(user: UserRecord): Promise<string> {
  const { token, tokenHash } = mintSessionToken();
  await createSession(tokenHash, user.id, sessionExpiry());
  return token;
}

authRouter.post("/api/auth/register", async (req, res) => {
  const ipLimit = registerByIp.check(clientIp(req));
  if (!ipLimit.allowed) {
    tooManyRequests(res, ipLimit.retryAfterSeconds);
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = validateUsername(body.username);
  if (!username) {
    res.status(400).json({
      error: `username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters, letters/numbers/_/- only`,
    });
    return;
  }
  const password = validatePassword(body.password);
  if (!password) {
    res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  const contact = parseContactPrefs(body, NO_CONTACT_PREFS);
  if (!contact) {
    res.status(400).json({ error: "invalid email address, or a subscription requested without one" });
    return;
  }

  try {
    const passwordHash = await hashPassword(password);
    const user = await createUser({ username, passwordHash, ...contact });
    if (!user) {
      res.status(409).json({ error: "that username is taken" });
      return;
    }
    const admins = configuredAdmins();
    if (admins && admins.some((a) => a.toLowerCase() === username.toLowerCase())) {
      await promoteToAdmin(user.id);
      user.isAdmin = true;
    }
    res.json({ token: await startSession(user), user });
  } catch (err) {
    console.error("register failed:", (err as Error).message);
    res.status(503).json({ error: "storage unavailable" });
  }
});

authRouter.post("/api/auth/login", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const submitted = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  // Keyed on the lowercased name so the limit can't be sidestepped by varying
  // capitalisation, which is exactly how the lookup itself matches.
  const ipLimit = loginByIp.check(clientIp(req));
  const nameLimit = loginByUsername.check(`u:${submitted.toLowerCase()}`);
  if (!ipLimit.allowed || !nameLimit.allowed) {
    tooManyRequests(res, Math.max(ipLimit.retryAfterSeconds, nameLimit.retryAfterSeconds));
    return;
  }

  try {
    const found = submitted === "" ? null : await getUserForLogin(submitted);
    // One message for "no such user" and "wrong password" alike. Registration
    // necessarily reveals whether a name is taken, so this isn't hiding much -
    // but there's no reason to hand out a second, quieter oracle.
    if (!found || !(await verifyPassword(password, found.passwordHash))) {
      res.status(401).json({ error: "username or password is incorrect" });
      return;
    }
    loginByUsername.reset(`u:${submitted.toLowerCase()}`);
    res.json({ token: await startSession(found.user), user: found.user });
  } catch (err) {
    console.error("login failed:", (err as Error).message);
    res.status(503).json({ error: "storage unavailable" });
  }
});

/** Ends the current session only, leaving this user's other devices alone. */
authRouter.post("/api/auth/logout", async (req, res) => {
  const token = bearerToken(req);
  if (!token) {
    res.status(204).end();
    return;
  }
  try {
    await deleteSession(hashSessionToken(token));
    res.status(204).end();
  } catch (err) {
    console.error("logout failed:", (err as Error).message);
    res.status(503).json({ error: "storage unavailable" });
  }
});

authRouter.get(
  "/api/auth/me",
  requireAuth(async (_req, res, user) => {
    res.json({ user });
  }),
);

/** Updates the email, the two subscription flags, and/or the password.
 *
 * A password change requires the current one even though the request is already
 * authenticated: a session token is a longer-lived, more easily borrowed thing
 * than a password, and this is the change that would lock the real owner out. */
authRouter.patch(
  "/api/auth/me",
  requireAuth(async (req, res, user) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const wantsPasswordChange = body.newPassword !== undefined;

    const contact = parseContactPrefs(body, {
      email: user.email,
      notifyDaily: user.notifyDaily,
      notifyUpdates: user.notifyUpdates,
      country: user.country,
      timezone: user.timezone,
    });
    if (!contact) {
      res.status(400).json({ error: "invalid email address, or a subscription requested without one" });
      return;
    }

    let newPasswordHash: string | null = null;
    if (wantsPasswordChange) {
      const newPassword = validatePassword(body.newPassword);
      if (!newPassword) {
        res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        return;
      }
      try {
        const currentHash = await getPasswordHash(user.id);
        const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
        if (!currentHash || !(await verifyPassword(currentPassword, currentHash))) {
          res.status(403).json({ error: "current password is incorrect" });
          return;
        }
        newPasswordHash = await hashPassword(newPassword);
      } catch (err) {
        console.error("password change failed:", (err as Error).message);
        res.status(503).json({ error: "storage unavailable" });
        return;
      }
    }

    try {
      const updated = await updateUserContactPrefs(
        user.id, contact.email, contact.notifyDaily, contact.notifyUpdates,
        contact.country, contact.timezone,
      );
      if (!updated) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (!newPasswordHash) {
        res.json({ user: updated });
        return;
      }
      await updateUserPassword(user.id, newPasswordHash);
      // Changing a password evicts every session, including this one, so a
      // stolen token stops working. Issuing a fresh one keeps the device that
      // made the change logged in.
      await deleteUserSessions(user.id);
      res.json({ user: updated, token: await startSession(updated) });
    } catch (err) {
      console.error("account update failed:", (err as Error).message);
      res.status(503).json({ error: "storage unavailable" });
    }
  }),
);

/** Deletes the account. Their scores stay - see deleteUser() in db.ts for why,
 * and for what that means for the username afterwards. */
authRouter.delete(
  "/api/auth/me",
  requireAuth(async (req, res, user) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = typeof body.password === "string" ? body.password : "";
    try {
      const currentHash = await getPasswordHash(user.id);
      if (!currentHash || !(await verifyPassword(password, currentHash))) {
        res.status(403).json({ error: "password is incorrect" });
        return;
      }
      await deleteUser(user.id);
      res.status(204).end();
    } catch (err) {
      console.error("account delete failed:", (err as Error).message);
      res.status(503).json({ error: "storage unavailable" });
    }
  }),
);


// --- Account state ----------------------------------------------------------

/** Ceiling on recordings returned by /api/me/bests. Comfortably above what the
 * client keeps: it prunes daily personal bests at 30 days and weekly ones at
 * about a year, so roughly 170 is the most it can hold. */
const MAX_BESTS = 400;

authRouter.get(
  "/api/me/state",
  requireAuth(async (_req, res, user) => {
    try {
      res.json({ state: parseState(await getUserState(user.id)) });
    } catch (err) {
      console.error("state fetch failed:", (err as Error).message);
      res.status(503).json({ error: "storage unavailable" });
    }
  }),
);

/** Folds this device's state into the account's and returns the result.
 *
 * Merging happens here rather than on the client so one set of rules governs
 * every device - see mergeState() for what they are and why. The response is
 * the merged state, which the caller writes back locally, so a push doubles as
 * a pull. */
authRouter.put(
  "/api/me/state",
  requireAuth(async (req, res, user) => {
    const incoming = parseState((req.body as Record<string, unknown>)?.state);
    try {
      const merged = mergeState(parseState(await getUserState(user.id)), incoming);
      await saveUserState(user.id, merged);
      res.json({ state: merged });
    } catch (err) {
      console.error("state save failed:", (err as Error).message);
      res.status(503).json({ error: "storage unavailable" });
    }
  }),
);

/** Every recording stored under this account's name, so a new device can
 * rebuild its personal bests in one request instead of one per seed. */
authRouter.get(
  "/api/me/bests",
  requireAuth(async (_req, res, user) => {
    try {
      const rows = await getPlayerScores(user.username, MAX_BESTS);
      res.json({
        bests: rows.map((row) => ({
          seed: row.seed,
          difficulty: row.difficulty === EASY_CODE ? "easy" : "hard",
          time: row.time,
          stability: row.stability,
          inputLog: row.inputLog,
        })),
      });
    } catch (err) {
      console.error("bests fetch failed:", (err as Error).message);
      res.status(503).json({ error: "storage unavailable" });
    }
  }),
);
