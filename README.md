# Unstable Truck

A browser speed-run game: drive a truck with loose cargo through a road
network that's procedurally generated from today's date, pick up cargo, and
deliver it as fast as possible without letting it fall off.

## Status

What's implemented:

- Deterministic daily level generation (Mulberry32 PRNG seeded from
  `YYYY-MM-DD`): hub placement, a connected Bezier-curve road network with a
  few branching dead ends, 4-10 warehouses per level (one base, one
  destination, the rest pickups that must all be visited before delivery),
  rock/mud obstacles, and a seeded color palette.
- Truck physics: single-button steering (default left bias while coasting,
  right while held) with momentum/inertia on both turning and velocity.
  Physics run on a fixed 1/60s timestep (via an accumulator decoupled from
  `requestAnimationFrame`), which is what makes ghost replay deterministic.
- Cargo physics: the cargo box trails behind the truck with lag, destabilizing
  on sharp turns and mud, and taking a stability hit on rock impacts.
  Stability hits 0 → the run ends.
- Personal-best recording and ghost replay: each run's input (held/released
  toggle ticks) is recorded; a successful run that beats your stored best for
  that day's seed is saved to `localStorage` and can be raced against as a
  semi-transparent ghost.
- Global leaderboard, backed by a Postgres + Express server: each successful
  run is submitted under a nickname (auto-generated on first visit, editable)
  and only overwrites your prior score for that seed if it's faster. The home
  screen shows the viewed day's top 10; clicking a leaderboard row races that
  player's ghost too (up to two ghosts race at once: your personal best and a
  selected leaderboard player, each labeled in a small muted tag - "you",
  "pb", or their nickname). The game is fully playable offline/without the
  backend — score submission and the leaderboard just silently no-op if the
  server is unreachable.
- Medal targets per day: each level has deterministic gold/silver/bronze
  finish-time thresholds derived purely from its geometry (the ideal
  base → pickups → destination route length, inflated for road curvature and
  divided by an assumed good-driving speed), so they're identical for every
  player and work fully offline. The results screen shows the medal earned and
  the time needed for the next tier up.
- Daily streak and a recent-days calendar on the home screen: delivering a day
  successfully is recorded in `localStorage`; a "🔥 N-day streak" badge counts
  consecutive delivered days (with a one-day grace before today's is done), and
  a row of dots (one per navigable day, today highlighted) fills in for the
  days you've completed.
- Shareable result card: after a delivery, a Share button copies a spoiler-free
  summary (day, medal, time, cargo %, streak — no map details) to the clipboard.
  The home screen also has a Share button next to today's "Best" time that
  copies the same kind of summary for your stored personal best (today only).
- Start screen shows one day at a time (today by default), with prev/next
  arrows beside the thumbnail to browse up to 7 days back - the date,
  minimap, personal best, ghost toggle, and leaderboard panel all update
  together as you navigate. Clicking the thumbnail (or pressing Enter) jumps
  into a 3-2-1-GO countdown and starts whichever day is showing. There's no
  separate Start button. A results screen (showing your time against your
  personal best, with Retry and Home buttons) rounds it out. Escape quits a
  run, countdown, or the results screen back to the start screen; Enter
  retries from the results screen; Backspace instantly restarts the current
  run (fresh countdown included).

## Running it with Docker (recommended)

```sh
docker compose up --build
```

This builds one image (compiling both the browser frontend and the backend)
and starts two containers: `app` (Node/Express, serving both the static
frontend and the `/api/*` leaderboard endpoints) and `db` (Postgres, schema
applied automatically from `db/init.sql` on first start). Open
`http://localhost:8003`.

Postgres data persists in a named Docker volume (`db-data`) across restarts.
To reset everything (including all leaderboard data), run
`docker compose down -v`.

Defaults (all overridable via environment variables or a `.env` file):

| Variable            | Default          | Purpose                                |
| -------------------| ---------------- | --------------------------------------- |
| `APP_PORT`          | `8003`           | Host port the game is served on         |
| `POSTGRES_USER`     | `truck`          | Postgres user                           |
| `POSTGRES_PASSWORD` | `truck`          | Postgres password                       |
| `POSTGRES_DB`       | `unstable_truck` | Postgres database name                  |

## Running it locally without Docker

```sh
npm install
npm run build   # compiles the frontend (src/) and backend (server/)
npm run serve   # static-only preview on http://localhost:8123, no backend/leaderboard
```

`npm run serve` is a quick static preview (no leaderboard, no score
submission) — useful for frontend-only iteration. To run the real server
locally you need a Postgres instance reachable via `DATABASE_URL`
(`postgres://user:pass@host:5432/dbname`), with `db/init.sql` applied, then:

```sh
DATABASE_URL=postgres://truck:truck@localhost:5432/unstable_truck npm start
```

`index.html` loads the game as an ES module, which browsers refuse to do
over a bare `file://` URL — it must be served over `http://`, not opened by
double-clicking the file. If a port is already in use (Windows sometimes
reserves ranges via Hyper-V), override it (`APP_PORT` for Docker, or edit
the `serve`/`start` scripts) and try a different one. You can list currently
reserved ranges with `netsh interface ipv4 show excludedportrange protocol=tcp`.

Days are generated lazily and cached in memory as you navigate the home
screen's prev/next arrows (up to 7 days back), so browsing around doesn't
reload the page or regenerate a level you've already visited.

## Controls

Hold spacebar (desktop) or press-and-hold on the canvas (mouse/touch) to
steer right. Release to drift left. The truck always drives forward;
steering is the only input. Enter starts/retries, Escape quits to the home
screen, Backspace restarts the current run.

## Project layout

```
src/                frontend (compiles to dist/, loaded by the browser)
  util/     seeded RNG, value noise, vector math
  level/    procedural generation (roads, warehouses, obstacles, palette) + terrain queries
  physics/  truck and cargo simulation, shared fixed-timestep constant
  game/     input handling, canvas rendering, game session/state machine,
            API client, medal thresholds, localStorage (personal bests,
            nickname, completion history)
  main.ts   DOM wiring and the render loop

server/             backend (own tsconfig, compiles to server/dist/)
  index.ts  Express app: serves the static frontend + mounts the API
  routes.ts /api/scores/* handlers (submit, leaderboard, single recording)
  db.ts     Postgres queries (pg)

db/init.sql          Postgres schema (scores table), applied automatically
                      by the Postgres image on first container start
```

No bundler for the frontend: `tsc` compiles TypeScript straight to ES
modules in `dist/`, loaded directly via `<script type="module">` in
`index.html`. The backend is a separate TypeScript project (`server/`) with
its own `tsconfig.json` and output directory, so backend source is never
served as a static file.
