# Unstable Truck

A browser speed-run game: drive a truck with loose cargo through a road
network that's procedurally generated from today's date, pick up cargo, and
deliver it as fast as possible without letting it fall off.

## Status

What's implemented:

- Deterministic daily level generation (Mulberry32 PRNG seeded from
  `YYYY-MM-DD`): hub placement, a connected Bezier-curve road network with a
  few branching dead ends, 4-10 warehouses per level (one base marked `B`, one
  destination marked `D`, the rest pickups marked `W` that must all be visited
  before delivery), rock/mud obstacles, and a seeded color palette.
- Biome themes: each level is deterministically assigned one of many biomes
  (grassland, desert, town, city, moon, snow, beach, forest, farmland, autumn,
  savanna, volcanic, swamp, candyland) from its seed. The theme biases the
  seeded palette so the day reads as that biome (sandy desert, white snow, grey
  moon…) while still varying within the biome, and paints a subtle repeating
  ground texture (dunes, furrows, craters, city grid, speckle…). The texture is
  drawn once to an offscreen tile and painted as a cached pattern, so it costs
  no more than the flat grass fill. Holidays override the biome as a seasonal
  easter egg — snow around Christmas, autumn around Halloween, plus dedicated
  Easter and New Year's biomes (the latter two are seasonal-only, never in the
  random pool). Overrides apply to both daily maps (the exact dates, Easter
  computed each year) and weekly maps (any week the holiday falls in). The
  chosen biome's name is shown next to the date on the home screen. Themes only
  change appearance —
  they never affect road/warehouse/obstacle placement, so per-seed leaderboards
  stay comparable.
- Biome scenery: every theme scatters small, decorative, no-collision props that
  suit its biome — grassland cows/shrubs, desert cacti/tumbleweeds, town
  trees/cyclists, city buildings/cars, moon astronauts/flags, snow
  penguins/pines, beach palms/umbrellas, forest pines/mushrooms, farmland
  haybales/scarecrows, autumn bare-trees/pumpkins, savanna acacias/grass tufts,
  volcanic charred-trees/smoke-vents, swamp reeds/lily-pads, candy
  lollipops/candy-canes, plus the seasonal Easter eggs/bunnies and New Year's
  fireworks/balloons. Like the houses, props are purely visual — they never
  affect physics or the leaderboard. Positions are precomputed deterministically
  from the seed (via an independent rng stream) so they're replay-stable, and
  placed clear of roads, warehouses, and obstacles so nothing sits on the
  drivable path. They're drawn as small code-authored vector sprites (trees
  scaled up as landmarks), culled to the visible viewport so even a dense weekly
  map only draws what's on screen.
- Weekly board: a Daily/Weekly toggle on the home screen switches to a much
  larger map (5x in every dimension) seeded from the ISO year+week
  (`YYYY-Www`, e.g. `2026-W32`), with 15-25 warehouses and 30-40 purely
  decorative houses (no value, no collision) fleshing out the road network
  (weekly roads are straight lines, not curves), and much denser obstacles.
  Because the map is big, a small arrow next
  to the truck points to the nearest unvisited warehouse (red), turning green
  and pointing to the drop-off once every warehouse has been visited. Weekly
  boards can be browsed up to 52 weeks back, each with its own leaderboard.
- Truck physics: single-button steering (default left bias while coasting,
  right while held) with momentum/inertia on both turning and velocity.
  Physics run on a fixed 1/60s timestep (via an accumulator decoupled from
  `requestAnimationFrame`), which is what makes ghost replay deterministic.
- Cargo physics: cargo boxes trail behind the truck with lag, destabilizing on
  sharp turns and mud, and taking a stability hit on rock impacts. Stability
  hitting 0 ends the run. Pickups are grouped five to a box: each collected
  warehouse adds a fifth of a box's length to the current box, and once it's
  full a new box starts trailing behind it (so a long weekly route pulls a few
  growing boxes rather than a huge chain of one-per-pickup).
- Personal-best recording and ghost replay: each run's input (held/released
  toggle ticks) is recorded; a successful run that beats your stored best for
  that day's seed is saved to `localStorage` and can be raced against as a
  semi-transparent ghost.
- Global leaderboard, backed by a Postgres + Express server: each successful
  run is submitted under a nickname (auto-generated on first visit, editable)
  and only overwrites your prior score for that seed if it's faster. The home
  screen shows the viewed day's top 10; once you've set a time of your own on
  that level, clicking a leaderboard row races that player's ghost too (up to
  two ghosts race at once: your personal best and a selected leaderboard
  player, each labeled in a small muted tag - "you", "pb", or their nickname).
  The game is fully playable offline/without the
  backend — score submission and the leaderboard just silently no-op if the
  server is unreachable.
- Medal targets: each level has deterministic gold/silver/bronze finish-time
  thresholds derived purely from its geometry (the ideal
  base → pickups → destination route length, inflated for road curvature and
  divided by an assumed good-driving speed), so they're identical for every
  player and work fully offline. Above gold sits a leaderboard-driven
  Champion tier at `gold - 3*(gold - top)/4` (three quarters of the way from
  the gold time down to the current #1 time); it unlocks as soon as someone
  sets a gold time (a leaderboard #1 faster than gold). The home screen shows a
  medal-time track (Champion when
  available, then Gold/Silver/Bronze) for both the daily and weekly boards, and
  the results screen shows the medal earned plus the next tier up.
- Daily streak and a recent-days calendar on the home screen: delivering a day
  successfully is recorded in `localStorage`; a "🔥 N-day streak" badge counts
  consecutive delivered days (with a one-day grace before today's is done), and
  a row of dots (one per navigable day, today highlighted) fills in for the
  days you've completed.
- Shareable result card: after a delivery, a Share button copies a spoiler-free
  summary (day, finish time, earned medal, and a link back to the game — no map
  details) to the clipboard. The link is the page's own hosted URL, falling
  back to the public address for local/dev play.
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

For local testing, run the base file together with the local overlay (it swaps
the production reverse-proxy network for a throwaway local one, so nothing extra
needs to exist first):

```sh
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

This builds one image (compiling both the browser frontend and the backend)
and starts two containers: `app` (Node/Express, listening on port `8003`,
serving both the static frontend and the `/api/*` leaderboard endpoints) and
`db` (Postgres, schema applied automatically from `db/init.sql` on first
start). Open `http://localhost:8003`.

The app port is published on `127.0.0.1` only (not the host's public
interface), which is enough for local testing and safe on a server where the
reverse proxy fronts it instead.

In **production**, the base file is used on its own. There the app joins the
external Docker network `host-edge` (created by the Caddy proxy stack; the
compose file refers to it by the local alias `edge`) so the proxy can route to
it. See "Deploying behind a reverse proxy" below.

```sh
docker compose up -d --build
```

Postgres data persists in a named Docker volume (`db-data`) across restarts.
To reset everything (including all leaderboard data), run
`docker compose down -v`.

Defaults (all overridable via environment variables or a `.env` file):

| Variable            | Default          | Purpose                                      |
| ------------------- | ---------------- | -------------------------------------------- |
| `APP_PORT`          | `8003`           | Localhost port the game is published on      |
| `POSTGRES_USER`     | `truck`          | Postgres user                                |
| `POSTGRES_PASSWORD` | `truck`          | Postgres password                            |
| `POSTGRES_DB`       | `unstable_truck` | Postgres database name                       |

### Deploying behind a reverse proxy under a sub-path

The frontend resolves both its assets and its `/api/*` calls relative to the
page's own URL (never root-absolute), so the game can be served from a
sub-path like `https://example.com/unstable-truck/` with no rebuild — as long
as the proxy strips the prefix before forwarding and redirects the bare path
to a trailing slash. With [Caddy](https://caddyserver.com) and the app reached
over the shared `host-edge` network as `unstable-truck:8003`:

```caddy
redir /unstable-truck /unstable-truck/
handle /unstable-truck/* {
	uri strip_prefix /unstable-truck
	reverse_proxy unstable-truck:8003
}
```

The trailing-slash redirect matters: relative URLs only resolve correctly when
the page is served at `/unstable-truck/`. `strip_prefix` turns the proxied
`/unstable-truck/style.css`, `/unstable-truck/dist/main.js`, and
`/unstable-truck/api/...` back into the root paths the app actually serves.

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
screen, Backspace restarts the current run. During a run, a hamburger menu in
the top-left corner opens Restart/Home buttons - the touch equivalent of
Backspace/Escape (steering or restarting dismisses it).

A "How to play" button on the home screen opens a help overlay covering the
objective, controls, terrain, and daily/leaderboard basics (close it with the
Close button, Escape, or by tapping the backdrop).

## Project layout

```
src/                frontend (compiles to dist/, loaded by the browser)
  util/     seeded RNG, value noise, vector math
  level/    procedural generation (roads, warehouses, obstacles, palette,
            biome themes, decorative scenery) + terrain queries
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
