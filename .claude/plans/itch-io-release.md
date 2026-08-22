# Publishing Unstable Truck on itch.io

Goal: ship a static client (`index.html` + `style.css` + `dist/**`) as an itch.io
HTML game that talks to the existing backend at
`https://lewistrick.com/unstable-truck/`, without breaking the current
same-origin deploy.

## Dependency: user accounts land first

[user-accounts.md](user-accounts.md) is a prerequisite, and it makes this plan
noticeably smaller. Accounts are what make a third-party iframe deploy work at
all: browser storage on itch is partitioned or blocked, so without a login an
itch player's progress is a separate, disposable world. With one, they log in and
their streak, personal bests, and medals follow them in.

Three items below shrank or moved out because of it, marked **↓ accounts** where
they appear: the storage-partitioning workaround (1.4), the champion-threshold
griefing fix (4.3), and the public diagnostics endpoint (4.4). One item grew:
CORS now has to carry an `Authorization` header (1.2).

## Decisions taken up front

| Question | Decision |
| --- | --- |
| CORS scope | Allow-list: `lewistrick.com`, `*.itch.zone`, `*.hwcdn.net`, `*.itch.io`, localhost. Not a wildcard. |
| Share link from the itch build | `https://lewistrick.itch.io/unstable-truck` (the `?s=<seed>` deep link is dropped there — see 1.3). |
| Blocked/partitioned storage | Never crash: in-memory fallback. Progress portability is solved by accounts, not by anything in this plan. |

## Constraints this plan works within

- No `node`, `npm`, `tsc`, or `zip` on the host. Docker and `python3` are
  available. Every build step must run the way `scripts/typecheck.sh` does.
- `scripts/typecheck.sh` verifies the **client** only. Server changes (Phase 1.2,
  Phase 4) cannot be verified locally at all — they stay unverified until a real
  `npm run build` / deploy.
- `tsconfig.json` has `strict` + `noUncheckedIndexedAccess`. Prefer inference,
  treat every index access as nullable (see CLAUDE.md).

---

## Phase 1 — Code changes

### 1.1 Configurable API base

Today `src/game/api.ts:37` pins the API to the document's own directory:

```ts
const API_ROOT = new URL(".", document.baseURI);
```

That is exactly right for the same-origin deploy and impossible on itch, where
the document lives on itch's CDN.

- [ ] Add `src/game/config.ts` holding the build-time overrides and **one**
      `declare global` block for `Window` (three constants land here across
      1.1/1.3/1.5 — one module keeps the global augmentation in a single place).
- [ ] `resolveApiRoot()`: use `window.UNSTABLE_TRUCK_API` when set, else fall
      back to `new URL(".", document.baseURI)` — today's behaviour, byte for byte,
      when the constant is absent.
- [ ] **Normalise the trailing slash.** `new URL("api/runs", "https://x/unstable-truck")`
      resolves to `https://x/api/runs` — the sub-path is silently eaten. Append
      `/` when missing before constructing the base.
- [ ] Point `API_ROOT` at the resolved value; `apiUrl()` (`api.ts:41`) and all
      13 call sites need no changes.
- [ ] Add `scripts/api-base-check.mjs` (framework-free, same style as
      `scripts/storage-check.mjs`): stub `window`/`document` **before** importing
      the module — `api.ts` reads `document.baseURI` at module load — and assert
      four cases: no override, override with trailing slash, override without,
      and a sub-path deploy. Wire it into `npm test`.

### 1.2 CORS on the server

No CORS handling exists anywhere in `server/` today. Without it every API call
from the itch iframe fails, and the game silently degrades to offline mode —
`submitScore`/`fetchLeaderboard` swallow errors by design (`api.ts:68`, `:83`).

- [ ] New `server/cors.ts`: a small middleware, no new dependency. `cors` from
      npm would work but is ~15 lines of logic we can read ourselves.
- [ ] Allow-list, matched against the `Origin` header:
      exact `https://lewistrick.com`; suffix match on `.itch.zone`, `.hwcdn.net`,
      `.itch.io`; `http://localhost:*` and `http://127.0.0.1:*` for dev.
      Reflect the matched origin (never echo an unmatched one).
- [ ] Send `Vary: Origin` — without it a cache in front can serve one origin's
      CORS header to another.
- [ ] `Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS`,
      `Access-Control-Allow-Headers: Content-Type, Authorization`,
      `Access-Control-Max-Age: 86400`.
- [ ] **`Authorization` is not optional** once accounts exist — it's the header
      the bearer token rides in (user-accounts.md §1.4). Leaving it out fails
      every authenticated call at preflight, and the symptom (login works, then
      nothing else does) points nowhere near the cause.
- [ ] **No** `Access-Control-Allow-Credentials`. Nothing uses cookies — the
      session token is a bearer header by deliberate choice, precisely so this
      stays off (user-accounts.md §1.4). Turning it on would drag in
      `SameSite=None` cookies that Safari blocks outright in an iframe.
- [ ] Handle preflight inside the middleware (`req.method === "OPTIONS"` →
      `res.sendStatus(204)`). **Do not** write `app.options("*", ...)` — this is
      Express 5, where path-to-regexp v8 rejects a bare `*`. The JSON
      `Content-Type` on `POST /api/scores/:seed` guarantees a preflight, so this
      path is load-bearing, not theoretical.
- [ ] Mount it in `server/index.ts` before `app.use(scoresRouter)` (`index.ts:30`)
      and scope it to `/api` — the static `index.html`/`style.css`/`logs` routes
      don't need it.
- [ ] Confirm Caddy is not stripping or duplicating CORS headers on the
      `/unstable-truck` route. Duplicated `Access-Control-Allow-Origin` headers
      are treated as invalid by browsers.
- [ ] Verify after deploy (cannot be checked locally):
      `curl -i -H 'Origin: https://html-classic.itch.zone' https://lewistrick.com/unstable-truck/api/champions?seeds=2026-08-21&difficulty=hard`
      and the same with `-X OPTIONS -H 'Access-Control-Request-Method: POST'`.

### 1.3 Deep links

**Inbound** — `?s=<seed>` (`src/main.ts:1447`) can never arrive: itch does not
forward its page's query string into the game iframe. There is no code fix.

- [ ] Accept it. The day-nav arrows are already always visible (commit `9818a57`)
      and the minimap prev/next thumbs (`index.html:81-84`) cover browsing, so
      reaching a specific past day is a few clicks rather than impossible.
- [ ] Sanity-check that arrow navigation reaches the full 30-day browse window
      (`storage.ts:12` `DAILY_MAX_AGE_MS`) — that's the practical replacement for
      the deep link.

**Outbound — this is a real bug on itch, not just a missing feature.**
`gameUrl()` (`src/main.ts:1489-1499`) returns `origin + pathname` for any hosted
http(s) page. Inside the itch iframe that is the CDN URL
(`https://html-classic.itch.zone/html/<build-id>/index.html`) — non-canonical,
unshareable, and it changes every time you push a new build. Every shared result
from the itch build would carry a link that rots.

- [ ] Add `window.UNSTABLE_TRUCK_SHARE_URL`, read via `config.ts`.
      `gameUrl()` prefers it over `origin + pathname`; the existing
      `FALLBACK_GAME_URL` (`main.ts:1487`) stays as the local/dev fallback.
- [ ] `shareLinkFor()` (`main.ts:1501-1504`) must **not** append `?s=<seed>` when
      the share URL is an override — any host that needs an override is by
      definition one that can't forward a query string. Treat "override set"
      as "no seed param".
- [ ] Set it to `https://lewistrick.itch.io/unstable-truck` in the itch build
      (per the decision above). Consequence, accepted: a recipient lands on
      today's map rather than the shared seed.
- [ ] *Optional refinement, not chosen:* also print the seed in the share text so
      a recipient can arrow to it. Cheap, and it partly recovers what the link
      loses. Flagging it because it's the only way to keep both itch attribution
      and a usable pointer to the map.

### 1.4 localStorage in a third-party iframe — **↓ accounts**

Two separate problems: it might **throw**, and even when it works it's a
different bucket from lewistrick.com. Accounts solve the second one entirely.
The first still needs fixing here — a login can't help a page that crashed
before it rendered.

**Crash risk (highest-priority item in Phase 1).** `src/main.ts:324` runs
`let nickname = getOrCreateNickname();` at module top level, and that function
both reads and *writes* `localStorage` (`storage.ts:215-218`). In Chrome with
third-party cookies blocked, and in any iframe sandboxed without
`allow-same-origin`, merely touching `window.localStorage` throws a
`SecurityError`. That aborts module evaluation before anything renders — the
player gets a black canvas and no error UI. `storage.ts` has no `try`/`catch`
around any of its ~40 storage calls.

- [ ] Add a `safeStorage` shim at the top of `src/game/storage.ts`: probe the
      real `localStorage`/`sessionStorage` once inside a `try`, fall back to an
      in-memory `Map`-backed object with the same surface.
- [ ] Route every call site through it: `storage.ts:49-123` (personal bests +
      pruning), `152-206` (completed/played/source), `215-247` (nickname),
      `261-268` (play time), `300-322` (difficulty + sync token), `344-362`
      (sound prefs), `378-407` (session-scoped ghost prefs).
- [ ] Keep the shim's shape identical to `MockStorage` in
      `scripts/storage-check.mjs` so the existing test keeps working, and extend
      that check with a storage stub whose `getItem` **throws**, asserting the
      module still returns sane defaults rather than propagating.
- [ ] Export `isEmbedded()` (`window.self !== window.top`) from `config.ts`.

**Partitioning (the common case, not an error).** Safari 16.1+ and Firefox strict
ETP partition third-party storage rather than blocking it: it works, but it's
keyed to the itch.io first party, so local progress on itch is a separate bucket
from lewistrick.com.

Nothing to build here any more. The account prompt after the first finished run
(user-accounts.md §3.2) already asks exactly the right question at exactly the
right moment, and a logged-in player's streak, personal bests, and medals live
server-side regardless of which bucket the browser hands out. What's left is
copy, not code:

- [ ] When storage fell back to memory, say so once — a logged-out player on
      itch is playing a session that won't survive a reload, and that should read
      as a reason to log in rather than as a bug.

**New, and specific to the iframe: password entry.** Password managers frequently
don't autofill inside a cross-origin iframe, and asking someone to type a
password into an embedded frame on a third-party site is phishing-shaped even
when it's legitimate. Options, in order of preference:

- [ ] Offer a "log in on lewistrick.com" button that opens the real site in a new
      tab, and have the game pick up the session afterwards. Cleanest, but needs a
      hand-off mechanism (a short-lived code entered back in the game — which is
      the one genuinely good use for the sync-code UX being retired).
- [ ] Or accept in-iframe login and make the form visibly branded, so at least it
      doesn't look like a generic credential box.
- [ ] Decide this before the itch page leaves draft; it changes what Phase 3's
      login form has to be.

### 1.5 Acquisition tracking

`detectSource()` (`main.ts:368-378`) prefers `?src=`, then falls back to the
referring hostname. On itch, `?src=` is unreachable, and the iframe's
`document.referrer` is the itch page — usually
`https://lewistrick.itch.io/unstable-truck`, possibly trimmed to the bare origin
by referrer policy. Either way `detectSource()` returns `lewistrick.itch.io`, so
this *mostly* works already.

- [ ] Don't rely on "mostly". Add `window.UNSTABLE_TRUCK_SRC = "itch"` as the
      third build constant, checked ahead of `?src=` in `detectSource()`.
      Deterministic, immune to referrer policy, and it distinguishes the itch
      embed from someone else embedding the itch page elsewhere. Keep the
      referrer fallback untouched.
- [ ] Preserve the existing sanitisation (`main.ts:370`) — the constant is ours,
      but running it through the same filter costs nothing and keeps one path.
- [ ] Note for reading the numbers later: first-touch is stored in
      `localStorage` (`storage.ts:170-182`), so under partitioning the same human
      playing on itch and on the website is two acquisition records. These are
      channel counts, not unique humans — until the source moves onto the account
      (user-accounts.md §5), at which point a logged-in player counts once.

### 1.6 Known dead code on itch (no action, just don't be surprised)

- `?optimal=true` (`main.ts:1354`) is unreachable on itch, so the solver-worker
  ghost never activates there. The worker URL itself
  (`new Worker(new URL("./game/solver-worker.js", import.meta.url))`,
  `main.ts:1367`) resolves fine on static hosting — it's only the opt-in flag
  that can't be set.

### Phase 1 verification

- [ ] `scripts/typecheck.sh` after every client change (CLAUDE.md rule).
- [ ] `npm test` (needs the user's machine — no node on this host) for the new
      `api-base-check.mjs` and the extended `storage-check.mjs`.
- [ ] State plainly that `server/cors.ts` is **unverified** until a real build —
      `server/` imports express and needs a genuine `npm ci`.
- [ ] Regression check that matters most: load the existing
      `https://lewistrick.com/unstable-truck/` deploy and confirm nothing
      changed. Every constant is absent there, so every path must fall back to
      today's behaviour.

---

## Phase 2 — Build & packaging

### 2.1 `scripts/build-itch.sh`

Mirror `scripts/typecheck.sh`: same `node:22-alpine` image, same pinned
`typescript@5.9.3` in the `unstable-truck-tsc` Docker volume. One difference —
typecheck mounts the repo **read-only** with `--noEmit`; this build needs to
emit, so mount a writable staging directory and compile with
`--outDir /out/dist`.

- [ ] Staging tree, `index.html` at the **zip root** (itch requires this — a
      nested folder means the game won't launch):
      ```
      index.html      generated: repo index.html + injected config <script>
      style.css       copied verbatim
      dist/**         tsc output
      ```
- [ ] Generate the itch `index.html` by injecting the config block immediately
      before `<script type="module" src="dist/main.js">` (`index.html:307`):
      ```html
      <script>
        window.UNSTABLE_TRUCK_API = "https://lewistrick.com/unstable-truck/";
        window.UNSTABLE_TRUCK_SHARE_URL = "https://lewistrick.itch.io/unstable-truck";
        window.UNSTABLE_TRUCK_SRC = "itch";
      </script>
      ```
      Generate it — do not keep a second hand-maintained `index.html` in the
      repo. The two would drift the first time the HUD changes.
- [ ] Strip `dist/**/*.js.map`. `tsconfig.json` sets `sourceMap: true`, and the
      zip ships no `src/`, so every map is dead weight that 404s in devtools.
      (Alternative: ship `src/` too. Not worth the size.)
- [ ] Deliberately excluded, and worth asserting in the script rather than
      trusting: `logs.html`, `server/`, `db/`,
      `images/` (dev-only biome screenshots from `scripts/screenshots.mjs`),
      `scripts/`, `README.md`, `solver-QandA.md`, `.git/`.
- [ ] Note on `logs.html`: once it's admin-gated (user-accounts.md §6) it's safe
      to serve publicly, so excluding it is tidiness rather than a security
      requirement. The zip assertion below stays anyway — it costs one line and
      the day someone flips that gating off is not the day you want to find out.
- [ ] Zip without `zip` on the host: `python3 -m zipfile -c out/unstable-truck-itch.zip <staged files>`.
- [ ] Post-build assertion: `python3 -m zipfile -l` the result and fail loudly if
      `index.html` is not at the root, or if `logs.html` appears anywhere.
- [ ] Add `"build:itch": "scripts/build-itch.sh"` to `package.json`. The shell
      script is the real entry point (no npm on this host); the npm script is a
      documented alias for the user's machine and CI.
- [ ] Add `out/` to `.gitignore`.
- [ ] Note: the Google Fonts `<link>` (`index.html:8-10`) stays as-is — itch
      allows outbound requests from the game iframe. Confirm it actually loads
      during the Phase 3 draft test; if it doesn't, the fallback font stack in
      `style.css` is what players will see.

### 2.2 butler

- [ ] Install: download `https://broth.itch.zone/butler/linux-amd64/LATEST/archive/default`,
      unzip (`python3 -m zipfile -e`), drop the binary in `~/.local/bin`,
      `chmod +x`. Do not commit it.
- [ ] `butler login` (opens a browser for an API key; stores creds outside the
      repo in `~/.config/itch/`).
- [ ] `butler push out/unstable-truck-itch.zip lewistrick/unstable-truck:html5`
      — the `html5` channel name is what tells itch this is a browser build.
- [ ] `butler status lewistrick/unstable-truck` to confirm the upload processed.
- [ ] Optional: `--userversion` from `package.json`'s `version` so uploads are
      distinguishable in the itch dashboard.
- [ ] The very first upload must still be wired up in the web UI (marking the
      file playable-in-browser, embed size) — butler pushes bytes, it doesn't
      configure the page. Phase 3 covers that.

---

## Phase 3 — itch.io page (your homework, with the specifics filled in)

- [ ] Project kind: **HTML**. Upload the zip, tick *"This file will be played in
      the browser"*.
- [ ] **Embed size.** Nothing in the code constrains this — `#app` is
      `100vw × 100dvh` (`style.css:17-24`) and the canvas resizes to its client
      box (`main.ts:1241-1251`), so the layout is fully fluid. Suggested
      **960×640**. One real constraint: `@media (max-width: 420px)`
      (`style.css:1130`) switches to the mobile layout, so keep the embed
      comfortably wider than 420px unless you want that.
- [ ] Tick **mobile friendly** — touch handling already exists
      (`src/game/input.ts:33`, `main.ts:2531-2533`).
- [ ] Enable the **fullscreen button**.
- [ ] Prefer **click-to-start** over autostart. Beyond being nicer, the click is
      the user gesture that unlocks audio — `audio.ts:13-28` documents that iOS
      Safari only starts an `AudioContext` from a real gesture, and autoplay
      policy is stricter still inside a cross-origin iframe.
- [ ] Cover image (630×500), gameplay GIF, screenshots — `images/screenshots/`
      already has biome renders from `scripts/screenshots.mjs` if useful.
- [ ] Description, one-button controls explainer, tags (`daily`, `speedrun`,
      `one-button`, `arcade`, `html5`), classification **Game**, free /
      donations, comments on.
- [ ] Mention in the description that an account keeps your streak and personal
      bests across devices, and that playing logged-out in the embed means
      progress may not survive a reload — cheaper to explain up front than to
      answer in comments.

### Draft testing (before going public)

Publish as **Restricted** / draft, then open the real embed URL and verify:

- [ ] **Leaderboard through CORS** — Network tab: `GET api/scores/<seed>` returns
      200 with an `access-control-allow-origin` header; console shows no CORS
      error.
- [ ] **Score submit** — a 204 `OPTIONS` preflight precedes a 200
      `POST api/scores/<seed>` returning `{"saved":true}`.
- [ ] **Record the actual `Origin` header** on those requests and reconcile it
      with the Phase 1.2 allow-list. This is the step that confirms itch's real
      CDN hostname; if it's not covered, the allow-list needs one more entry and
      a redeploy.
- [ ] **localStorage survives a reload** — log in, reload the embed, still
      logged in. If storage is blocked in that browser, expect logged-out and
      confirm the game still plays rather than breaking.
- [ ] **Login works through CORS** — `POST api/auth/login` returns a token, and a
      following authenticated call carries `Authorization` through preflight
      without error. This is the check that catches a missing
      `Access-Control-Allow-Headers` entry.
- [ ] **Password manager behaviour** in the iframe — whether autofill offers
      anything at all, which decides §1.4's login hand-off question.
- [ ] **Audio starts** after the click-to-start gesture.
- [ ] **Fullscreen layout** is right at the chosen embed size *and* in fullscreen.
- [ ] **Acquisition tag lands** — check `/logs` for a `game_started` row with
      `src:itch`.
- [ ] Test the two storage tails explicitly: **Chrome with third-party cookies
      blocked** (the case that can throw) and **Safari** (partitioned). The game
      must boot and be playable in both, even if progress doesn't persist.

---

## Phase 4 — Before an audience actually arrives

The API stops being "my site's backend" and becomes an open endpoint shipped to
strangers. Four items below are on your list; three more came out of reading the
routes and are flagged as **found**.

### 4.1 Rate limiting

**Partly pulled forward.** `POST /api/auth/login` must be rate-limited before
accounts ship at all (user-accounts.md §1.5) — an unthrottled login endpoint is a
password oracle. So the limiter infrastructure, and `trust proxy` with it, exists
by the time this phase starts; what's left here is applying it to the rest.

- [ ] Limit `POST /api/scores/:seed` (`routes.ts:128`), `POST /api/runs`
      (`routes.ts:165`), the auth endpoints, and `POST /api/champions/:seed`
      (`routes.ts:204`).
- [ ] Per-**account** limits alongside per-IP ones, now that submissions are
      attributable. Far more meaningful than IP limits on mobile networks, where
      thousands of players share a CGNAT address.
- [ ] **`app.set("trust proxy", 1)` in `server/index.ts`.** Behind Caddy, every
      request otherwise carries the proxy's IP: a per-IP limiter either does
      nothing or throttles the entire internet as one client. This is the single
      easiest thing to get wrong here.
- [ ] In-memory limiter is fine — one app container (`docker-compose.yml`), no
      horizontal scaling. `express-rate-limit` if you'd rather not hand-roll.
- [ ] Keep limits generous enough for real play: `POST /api/runs` fires on many
      ordinary interactions (`navigated`, `paused`, `mode_switched`, …), so a
      naive "10 requests/minute" would throttle a legitimate browsing session.

### 4.2 Server-side replay validation

Genuinely feasible, and most of the plumbing exists:

- [ ] The server already imports compiled client modules on a worker thread —
      `server/optimal.ts:152` and `server/optimal-worker.ts:37-47` dynamically
      import `level/generate.js` from `dist/`. Validation reuses that exact
      pattern.
- [ ] `scripts/replay-check.mjs` already replays an input log through the sim, so
      the algorithm is written; it needs porting to the server side.
- [ ] Validation = generate the level from the seed, replay the submitted
      `inputLog` through the deterministic sim, assert the resulting time matches
      the submitted `time` within a tick's tolerance and that all cargo was
      delivered.
- [ ] Measure first: if a replay is single-digit milliseconds, verify before
      insert; if not, accept-then-verify on the worker thread and delete
      losers. Do not put a slow replay on the request path.
- [ ] Note `parseSubmission` (`routes.ts:91-123`) currently validates *shape*
      only — any well-formed body with `time: 0.001` is accepted and ranked.

### 4.3 Champion-threshold griefing — **↓ accounts**

`POST /api/scores/:seed` accepts `championCandidate` and, when
`isCurrentPeriod: true`, passes it to `lowerChampionTime` (`routes.ts:145-150`),
whose SQL only ever ratchets **down** (`db.ts:285-297`). There is no auth and no
plausibility check, so one curl with `championCandidate: 0.001` permanently makes
the champion medal unobtainable for that seed.

Largely handled by user-accounts.md §2, which requires an authenticated session
for the champion path — vandalism becomes attributable, and bannable. What
remains is the plausibility check, which is cheap and worth having anyway:

- [ ] Clamp `championCandidate` to the submitted `time`. A champion threshold
      below any real run is nonsense by definition, logged in or not.
- [ ] Better still: only honour it for a submission that passed replay
      validation (4.2).

### 4.4 Public diagnostics endpoint — **↓ accounts, moved out**

`GET /api/runs` (`routes.ts:188-195`) and the `/logs` page (`index.ts:26-28`)
are unauthenticated and expose every player's nickname, seed, and `src:`
acquisition tag. This is now **user-accounts.md §6** (admin gating), which is
sequenced early there precisely because it closes a live leak rather than a
hypothetical one.

- [ ] Nothing to do here. Just confirm it actually landed before the itch page
      leaves draft — `curl https://lewistrick.com/unstable-truck/api/runs`
      should not return rows.

### 4.5 Account spam — **↓ accounts**

- [ ] The old sync endpoint `POST /api/account` (`routes.ts:330`) is retired by
      user-accounts.md §4.1. Its replacement, `POST /api/auth/register`, has the
      same unauthenticated row-creation shape — confirm 4.1's limiter covers the
      auth routes and not only score submission.

### 4.6 Ops readiness

- [ ] **DB backups.** `docker-compose.yml` defines the `db-data` volume but no
      dump job anywhere in the repo. Confirm a `pg_dump` schedule exists off-box;
      a volume is not a backup.
- [ ] **VPS headroom.** `startPrecomputeSchedule()` (`index.ts:52`, `optimal.ts`)
      is a heavy single-core solve on a worker thread that competes with request
      serving. Check core count and what happens when a precompute overlaps a
      traffic spike.
- [ ] **Caddy rate limits.** Note that `rate_limit` is **not** in a standard Caddy
      build — it needs the `caddy-ratelimit` plugin and a custom binary. If that's
      more than you want, the app-level limiter (4.1) is the pragmatic answer.
- [ ] **90-day run-log retention** (`db.ts:232`). `run_logs` grows per *event*,
      not per run — `game_started`, `navigated`, `paused`, `mode_switched`, and a
      dozen more (`api.ts:91-110`) — so it scales with engagement, not player
      count. Check current row count and table size, extrapolate at 100× traffic,
      and decide between a shorter window, sampling the low-value statuses, or an
      index review on `created_at`.
- [ ] Confirm the prune sweep (`index.ts:61-70`) can still finish in reasonable
      time against a much larger table.

---

## Open questions

1. Do you want the itch build to keep the seed visible in shared text (1.3's
   optional refinement), given the link can't carry it?
2. Is there an existing `pg_dump` backup job outside this repo, or is 4.6 the
   first time backups get set up?
3. **In-iframe login or hand-off to lewistrick.com?** (1.4) This is the one that
   should be answered before Phase 3 of the accounts plan builds its login form,
   since it decides whether that form ever needs to work inside an iframe.
4. Phase 4 ordering: is rate limiting alone enough to go public, with replay
   validation following, or should 4.2 land before the itch page leaves draft?
   (4.3 and 4.4 are answered by the accounts plan either way.)
5. Does the itch release wait for the full accounts plan, or only for Phases 1–3
   of it (auth core, name protection, the post-run prompt)? Phases 4–7 there —
   settings UI, state migration, email fields — aren't load-bearing for a working
   itch build.
