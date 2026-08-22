# User accounts

Goal: replace the sync-code system with real user accounts (username + password),
move the state that currently lives only in `localStorage` into the database
behind those accounts, protect registered names on the leaderboard, and gate the
`/logs` diagnostics page behind an admin flag.

This is a prerequisite for [itch-io-release.md](itch-io-release.md) — accounts
are what make a third-party iframe deploy work at all, since browser storage
there is partitioned or blocked. See that plan's "Dependency" note.

## Decisions taken up front

| Question | Decision |
| --- | --- |
| Game-over screen | Keeps **Retry / Share / Home**. The account prompt is a new screen *before* it, not a replacement for it. |
| Username vs nickname | The username **is** the leaderboard name. One identity, one field. |
| Anonymous submissions | Still allowed — **except** under a username that is registered. Registering a name locks it. |
| Email | Store the address and the two subscription flags. **No verification, no sending** in this plan. |

## Design constraint that governs everything below

The game is playable offline today, on purpose: every call in `src/game/api.ts`
swallows network failure and falls back to the local personal best. Accounts must
not break that. The model is **local-first with the server as the durable copy** —
`localStorage` stays as the working cache, the account becomes the thing that
survives a cleared browser, a new device, or an itch iframe. "Move state to the
database" never means "read it from the database on the hot path".

---

## Phase 1 — Schema and auth core (server)

### 1.1 Tables

- [ ] `users`:
      ```sql
      CREATE TABLE IF NOT EXISTS users (
        id             BIGSERIAL PRIMARY KEY,
        username       TEXT NOT NULL,           -- as registered, for display
        username_lower TEXT NOT NULL UNIQUE,    -- case-insensitive uniqueness
        password_hash  TEXT NOT NULL,           -- scrypt, self-describing (below)
        email          TEXT,
        notify_daily   BOOLEAN NOT NULL DEFAULT FALSE,
        notify_updates BOOLEAN NOT NULL DEFAULT FALSE,
        is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at   TIMESTAMPTZ
      );
      ```
- [ ] **Case sensitivity is a real trap here.** `scores`' primary key is
      `(seed, nickname, difficulty)` and it is case-*sensitive*, so `Erick` and
      `erick` are two separate leaderboard rows today. Usernames must be
      case-insensitively unique (hence `username_lower`), and name protection
      (Phase 2) must match case-insensitively too, or registering `Erick` leaves
      `erick` free for someone else to submit under.
- [ ] `sessions`:
      ```sql
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash   TEXT PRIMARY KEY,          -- sha256 of the bearer token
        user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at   TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
      ```
      Store the **hash**, not the token. A DB dump then isn't a pile of live
      logins, and the cost is one `sha256` per request.
- [ ] Add to `db/init.sql` *and* to `ensureSchema()` in `server/db.ts` —
      `init.sql` only runs on first DB init, so an existing deployment gets these
      tables from `ensureSchema()` only (this is the established pattern, see the
      comment at `server/index.ts:43-45`).
- [ ] Expire sessions on a schedule, alongside the existing `pruneOldRunLogs()`
      sweep (`server/index.ts:61-70`) — same shape, one more `DELETE`.

### 1.2 Password hashing

- [ ] Use `node:crypto`'s **scrypt**. No new dependency: argon2 and bcrypt are
      both native modules, and this project's whole `dependencies` list is
      `express` + `pg`. Keeping it that way matters for the Docker build.
- [ ] Store a self-describing string so parameters can change later without a
      migration: `scrypt$N$r$p$<salt-b64>$<hash-b64>`, starting at N=16384, r=8,
      p=1, 16-byte salt, 32-byte key.
- [ ] Compare with `crypto.timingSafeEqual`, never `===`.
- [ ] **Always the async `crypto.scrypt`, never `scryptSync`.** scrypt is
      deliberately CPU- and memory-heavy; a sync call blocks the event loop for
      every other request. This server already shares a small VPS with the
      solver precompute (`server/optimal.ts`), so blocking is not theoretical.

### 1.3 Endpoints

- [ ] `POST /api/auth/register` — `{username, password, email?, notifyDaily?, notifyUpdates?}` → `{token, user}`
- [ ] `POST /api/auth/login` — `{username, password}` → `{token, user}`
- [ ] `POST /api/auth/logout` — bearer → 204 (deletes the session row)
- [ ] `GET /api/auth/me` — bearer → user + synced state (Phase 5)
- [ ] `PATCH /api/auth/me` — bearer → change email, notification flags, password
- [ ] `DELETE /api/auth/me` — bearer → delete the account
- [ ] Validation: username 3–16 chars matching `[A-Za-z0-9_-]+`; 16 is not
      arbitrary — it's `MAX_NICKNAME_LENGTH` in both `server/routes.ts:32` and
      `src/game/storage.ts:210`, and a username longer than a nickname could
      never appear on the board. Password: minimum 8 characters, no maximum
      below 64.
- [ ] Auth middleware in `server/auth.ts`: `requireAuth` and `optionalAuth`,
      both reading `Authorization: Bearer <token>`.

### 1.4 Bearer token, not a cookie

- [ ] Session token: 32 random bytes, base64url, returned once at
      login/register and sent as `Authorization: Bearer`.
- [ ] This is a deliberate choice for the itch deploy. A cookie would need
      `SameSite=None; Secure` plus `Access-Control-Allow-Credentials` and an
      exact-origin CORS allow-list, and third-party cookies are blocked outright
      in Safari and in Chrome with 3p cookies off — the login would simply not
      persist. A bearer header sidesteps all of it.
- [ ] Consequence to document: on itch, if `localStorage` is unavailable, the
      token lives in memory only and the player is logged out on reload. Correct
      behaviour, but it should be said out loud in the UI rather than looking
      like a bug.
- [ ] The itch plan's CORS allow-list must add `Authorization` to
      `Access-Control-Allow-Headers` — without it every authenticated call fails
      preflight. Cross-referenced there.

### 1.5 Brute-force protection is not optional here

- [ ] Rate-limit `POST /api/auth/login` per username **and** per IP. An
      unthrottled login endpoint is a password oracle, and this one is about to
      be shipped to strangers.
- [ ] This pulls the itch plan's Phase 4.1 rate limiting forward: it was a
      "before an audience arrives" item, it is now a **ship blocker** for
      accounts. `app.set("trust proxy", 1)` is required for any of it to work
      behind Caddy.
- [ ] Generic failure message ("username or password is incorrect"). Don't
      over-engineer beyond that: registration necessarily reveals whether a
      username is taken, so username enumeration exists by design.

---

## Phase 2 — Protected nicknames

The rule: anonymous play continues to work, but a registered username can only be
submitted under by that account.

- [ ] `POST /api/scores/:seed` (`server/routes.ts:128`): after
      `parseSubmission()`, look up `users.username_lower = lower(nickname)`.
      - No row → anonymous submission, behaves exactly as today.
      - Row exists → require a valid bearer session for that user, else **403**
        `{error: "that name is registered — log in to submit under it"}`.
- [ ] Same rule on `POST /api/runs` (`routes.ts:165`) so the diagnostics log
      can't be forged under someone else's name — but **fail open** there (drop
      the row, return 200). `logRun` is best-effort by design (`api.ts:116-133`)
      and must never become a source of user-visible errors.
- [ ] `POST /api/champions/:seed` (`routes.ts:204`) and the `championCandidate`
      path inside score submission (`routes.ts:145-150`): require an
      authenticated session. This closes the griefing hole documented as §4.3 of
      the itch plan — `lowerChampionTime` only ever ratchets down, so one
      unauthenticated curl with `championCandidate: 0.001` currently makes a
      seed's champion medal permanently unobtainable.
- [ ] Client (`src/game/api.ts`): `submitScore` sends the auth header when a
      session exists, and returns a distinguishable result for 403 so the UI can
      say "that name is taken — log in" rather than failing silently. Note the
      current signature returns a bare `boolean` (`api.ts:48-71`); this needs a
      richer result type.
- [ ] Registering a username that already has anonymous scores **inherits**
      them. There's no proof of ownership available, so this is first-come. It's
      still strictly better than today, where any name is submittable by anyone;
      worth one sentence in the register form so it isn't a surprise.

---

## Phase 3 — Client auth and the post-run prompt

### 3.1 `src/game/auth.ts`

- [ ] `register()`, `login()`, `logout()`, `currentUser()`, `authHeaders()`,
      `isLoggedIn()`.
- [ ] Token stored under `unstable-truck:auth`, through the `safeStorage` shim
      the itch plan adds (§1.4 there) so a blocked `localStorage` degrades to an
      in-memory session instead of throwing.
- [ ] Cache the user object locally so the UI can render logged-in state before
      `GET /api/auth/me` returns — and so it still renders offline.

### 3.2 The prompt after the first finished run

Replaces the nickname prompt: markup at `index.html:294-305`, logic at
`src/main.ts:1657-1700`.

- [ ] Title: **"Log in or create an account to register your score"**.
- [ ] Three buttons: **Create account** / **Log in** / **Don't register score**.
- [ ] *Create account* → username (prefilled from the current nickname),
      password, optional email, the two subscription checkboxes.
- [ ] *Log in* → username, password.
- [ ] *Don't register score* → drops the pending submission and continues, which
      is exactly what the existing Cancel handler does (`main.ts:1691-1696`).
- [ ] All three paths land on the results screen, which **keeps Retry / Share /
      Home** and the "Enter to retry · Esc for home" hint (`index.html:285-291`).
- [ ] Reuse the deferred-submission mechanic as-is. `pendingScoreSubmit`
      (`main.ts:1660`) is a closure that reads `nickname` at call time
      specifically so the run lands under the finally-chosen name — that design
      already fits accounts, it just gains more outcomes.
- [ ] Trigger condition changes from
      `submitRun && !hasChosenNickname() && isDefaultNickname(nickname)`
      (`main.ts:1846`) to `submitRun && !isLoggedIn() && !recentlyDeclined()`.
- [ ] **Don't nag.** Today `hasChosenNickname()` guarantees the question is asked
      once. Proposed replacement: "Don't register score" sets a declined-at
      timestamp and suppresses the prompt for 7 days; the settings page always
      offers login in the meantime. Open question below if you'd rather it be
      once-ever or every-run.
- [ ] Escape maps to "Don't register score" (currently Escape → cancel,
      `main.ts:2634-2635`).
- [ ] Error and offline states: username taken, wrong password, server
      unreachable. **The prompt must never trap a player** — if the server is
      down, the only working button is "Don't register score", and it should say
      so rather than spinning.

---

## Phase 4 — Settings page: replace the sync section

You're right that this section is unclear today — "Generate sync code" / "Enter
code" / "Link" / "Unlink" is four concepts for one idea.

- [ ] Delete `#sync-section` (`index.html:219-240`) and its handlers:
      `updateSyncUi` (`main.ts:2276-2287`), `doSync` (`main.ts:2317-2334`), and
      the button listeners (`main.ts:2551-2610`).
- [ ] Logged out → "Log in" / "Create account".
- [ ] Logged in → username, email + the two checkboxes, change password, log out,
      delete account. Deleting an account is the one destructive action here, so
      it needs a confirm step.
- [ ] The nickname row (`index.html:211-216`) becomes read-only when logged in —
      the username *is* the name, so an editable nickname field next to it would
      be a second, lying identity.
- [ ] `#stats-section` keeps working; it already queries the server by name
      (`fetchStats`, `api.ts:235-244`).

### 4.1 Migrating existing sync-code holders

- [ ] On load, if `unstable-truck:sync` holds a token and there's no auth token,
      offer: "set a password to turn your sync code into an account". Holding the
      code is possession-proof, so the nickname and completed days carry across
      with no ownership question — the one clean migration path available.
- [ ] Server: `POST /api/auth/register-from-sync` taking the sync token, reading
      the existing `accounts` row (`db/init.sql`, token/nickname/difficulty/
      completed) and creating a `users` row seeded from it.
- [ ] Keep `POST/GET/PUT /api/account*` (`routes.ts:330-398`) alive for a
      deprecation window, then delete them and drop the `accounts` table.

---

## Phase 5 — Moving `localStorage` state into the account

Current keys in `src/game/storage.ts`, and where each should live:

| Key | Today | Proposed |
| --- | --- | --- |
| `:pb:<difficulty>:<seed>` | local | **Already server-side** in `scores.input_log` — pull down on login |
| `:completed` (streak) | local + sync | Account |
| `:played` | local only | Account |
| `:difficulty` | local + sync | Account |
| `:playtime` | local only | Account |
| `:source` (acquisition) | local only | Account (first-touch, per user) |
| `:nickname` | local | Obsolete when logged in — the username is the name |
| `:nickname-chosen` | local | Obsolete, replaced by the declined-at timestamp |
| `:sound` | local | **Stay local** — volume is a property of the device and room, not the person |
| session ghost prefs | `sessionStorage` | **Stay local** — deliberately session-scoped (`storage.ts:366-407`) |

- [ ] Store the account-side state as a `user_state` JSONB column on `users`,
      not as a table per concept. It's read and written whole, never queried by
      field.
- [ ] Merge semantics on login/sync: **union** for `completed` and `played`
      (never lose a day), **max** for play time, server-wins for the difficulty
      preference. Union-merge is what the existing sync already does
      (`routes.ts:389`) — keep the rule so behaviour doesn't change under
      players.
- [ ] Personal bests need a **bulk** endpoint: `GET /api/me/bests` returning
      every stored recording for the account. Pulling them one at a time through
      `fetchPlayerRecording` (`api.ts:248`) would be ~60 requests for a 30-day
      window across two difficulties.
- [ ] Keep writing everything to `localStorage` as well. The account is the
      durable copy; the local copy is what makes the game work on a train.

---

## Phase 6 — Admin and the logs page

- [ ] `users.is_admin`, defaulting false.
- [ ] Bootstrap the first admin from an `ADMIN_USERNAMES` env var read at boot
      (alongside `ensureSchema()`, `server/index.ts:46`), promoting those
      usernames if they exist. Avoids hand-written SQL on the VPS and is
      idempotent.
- [ ] `GET /api/runs` (`routes.ts:188-195`) requires an admin session → 401
      without a token, 403 with a non-admin one.
- [ ] `logs.html` gains a small login form and sends the bearer token on its
      `fetch('api/runs?…')` call (`logs.html:240`). Gate the **data**, not the
      HTML — the page is inert without it, and gating one thing is easier to
      reason about than two.
- [ ] Once this lands, `logs.html` is safe to serve publicly, so the itch plan's
      "must not ship logs.html" hardens into "excluded for tidiness".
- [ ] Consider whether `GET /api/scores/:seed/:nickname` (`routes.ts:286`) should
      stay public — it serves ghost recordings, so it must, but note it means
      input logs are public data. That's fine and worth knowing.

---

## Phase 7 — Email fields (store only)

Per the decision above: columns and UI, no verification and no sending.

- [ ] `email`, `notify_daily`, `notify_updates` on `users`; optional email field
      plus two checkboxes in the register form and the settings page.
- [ ] Basic shape validation only (contains `@`, length cap). No uniqueness
      constraint — two accounts sharing a family address is legitimate.
- [ ] **Consequence to write down now:** these addresses are unverified, so a
      typo is undetectable and nothing can safely be sent to them later without a
      confirm step first. Whenever sending gets built, it starts with
      re-confirming everything collected here.
- [ ] **No email means no password recovery.** Say so at the point of
      registration — it's the strongest reason to give an address, more than
      reminders are.
- [ ] Ship `DELETE /api/auth/me` (Phase 1.3) and one plain sentence about what
      the address is for, from day one. Cheapest possible posture for an
      EU-hosted site storing personal data, and much easier now than retrofitted.

---

## What else could be tied to an account

Answering the open question — grouped by how much they're worth.

**Already implied, near-free once accounts exist**
- Streak and completed days (today's sync payload).
- Played days, total play time, difficulty preference.
- Personal-best recordings, pulled down on any new device.
- Medal counts and world-firsts — `getPlayerStats` already computes these by
  name (`routes.ts:301`); they just become trustworthy.
- Acquisition source as a first-touch property of the *person* rather than the
  browser profile, which is what you actually wanted to measure.
- Account age and last-seen — the retention numbers the run log can only
  approximate.

**Genuinely valuable, small**
- **Name protection** (Phase 2) — the reason the leaderboard becomes meaningful.
- **Admin flag** (Phase 6).
- **A ban / shadow-ban flag.** Once scores are attributable, moderation is a
  boolean instead of an impossibility.
- **Timezone.** Seeds are keyed to the *client's* local date, so the server has
  no idea what "today" means for a given player. Needed for daily reminders, and
  it also makes run-log analysis honest.
- **Per-account rate limits**, which are far more meaningful than per-IP ones on
  mobile networks.

**Plausible later**
- Favourite / bookmarked seeds.
- Achievements or badges beyond medals (first champion, 7-day streak, every
  biome).
- Friends or a follow list, and a friends-only leaderboard filter — the single
  most retention-positive feature on this list.
- Ghost preferences that follow the player (which ghost to race by default).
- Replay history beyond the personal best — "every run I've made on this seed".
- Profile page at a shareable URL, which also gives share links something better
  to point at than the game root.
- Language / locale.

**Deliberately not**
- Sound preferences (device-scoped, see Phase 5).
- Session ghost selections (`storage.ts:366-407`, session-scoped by design).

---

## Sequencing

1. Phase 1 (schema, auth core, login rate limit) — nothing user-visible.
2. Phase 6 (admin + logs gating) — small, independent, and it closes a live
   information leak. Ship it early rather than at the end.
3. Phase 3 (client auth + post-run prompt) and Phase 2 (name protection)
   together — the prompt is pointless without protection, and protection is
   hostile without the prompt.
4. Phase 4 (settings) + 4.1 (sync migration).
5. Phase 5 (state migration).
6. Phase 7 (email fields) can ride along with Phase 3's form.

## Verification

- [ ] `scripts/typecheck.sh` after every client change.
- [ ] New framework-free checks in `scripts/`, matching the existing style:
      password hash round-trip, session expiry, and the protected-nickname
      decision table (unregistered → allowed, registered + no token → 403,
      registered + wrong user's token → 403, registered + right token → saved).
- [ ] Everything under `server/` stays **unverified locally** — no `node`, no
      `npm ci`. Say so plainly rather than calling it done.
- [ ] Manual pass: register, log out, log back in, submit a score under a
      protected name while logged out (expect 403), decline the prompt and
      confirm the results screen still shows Retry / Share / Home.

## Open questions

1. **Re-prompt cadence.** After "Don't register score": ask again in 7 days
   (proposed), once ever, or after every finished run?
2. **Username changes.** Allowed at all? If yes, `scores` rows are keyed by
   nickname text, so a rename either rewrites history or splits it. Simplest
   answer for now is "no renames", which is worth deciding before anyone has an
   account.
3. **Do you want a guest→account upgrade that carries local history?** A player
   with three weeks of local progress who registers on day 22 — do their existing
   anonymous scores under that nickname become theirs (Phase 2's inheritance), or
   should the client also push local completed days on first login? The second is
   a few lines and much friendlier.
4. **Admin bootstrap:** `ADMIN_USERNAMES` env var (proposed) or one manual SQL
   `UPDATE` on the VPS?
