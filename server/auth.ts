// Session tokens and the middleware that turns one into a user.
import crypto from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { getSessionUser, touchSession, touchUserLastSeen, type UserRecord } from "./db.js";

// 90 days, slid forward on use (see touchSession). This is a game played in
// daily bites; being logged out because you skipped a fortnight would be its
// own kind of bug.
const SESSION_TTL_DAYS = 90;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

/** A new session token, plus the hash to store. The raw token is returned to
 * the client once and never persisted anywhere on the server. */
export function mintSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

/** Sessions are looked up by hash, so a leaked database dump isn't a pile of
 * live logins. A plain SHA-256 is right here, unlike for passwords: the token
 * is 32 random bytes, so there is no guessable input to slow an attacker down
 * against. */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Pulls the bearer token out of the Authorization header, if there is one. */
export function bearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** The user this request is authenticated as, or null. Never throws for a
 * missing or bad token - only a database failure propagates. */
export async function authenticate(req: Request): Promise<UserRecord | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const user = await getSessionUser(tokenHash);
  if (!user) return null;
  // Best-effort bookkeeping, deliberately not awaited: neither the sliding
  // expiry nor last-seen is worth adding latency to every authenticated
  // request, and neither failing should fail the request.
  void touchSession(tokenHash, sessionExpiry()).catch(() => {});
  void touchUserLastSeen(user.id).catch(() => {});
  return user;
}

/** Wraps a handler so it only runs for an authenticated request, and receives
 * the user as a plain argument.
 *
 * A wrapper rather than ordinary `app.use` middleware because middleware can
 * only hand the user over by bolting a property onto Request, which TypeScript
 * can then only type as optional - leaving every authenticated route to re-check
 * something the middleware already guaranteed. Passing it as an argument makes
 * the guarantee visible to the compiler. */
export function requireAuth(handler: (req: Request, res: Response, user: UserRecord) => Promise<void>): RequestHandler {
  return async (req, res) => {
    let user: UserRecord | null;
    try {
      user = await authenticate(req);
    } catch (err) {
      console.error("session lookup failed:", (err as Error).message);
      res.status(503).json({ error: "storage unavailable" });
      return;
    }
    if (!user) {
      res.status(401).json({ error: "not logged in" });
      return;
    }
    await handler(req, res, user);
  };
}

/** As requireAuth, but the session also has to belong to an admin.
 *
 * 401 and 403 are kept apart deliberately: the first means "log in", which a
 * client can act on, and the second means "you are logged in and this still
 * isn't yours", which it can't. */
export function requireAdmin(handler: (req: Request, res: Response, user: UserRecord) => Promise<void>): RequestHandler {
  return requireAuth(async (req, res, user) => {
    if (!user.isAdmin) {
      res.status(403).json({ error: "admins only" });
      return;
    }
    await handler(req, res, user);
  });
}
