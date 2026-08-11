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
  before delivery), rock/mud obstacles, and a seeded color palette. Obstacles
  are textured off the seeded palette to sit against the detailed scenery -
  rocks as bumpy stones with a lit/shadow split, a random inner facet, and
  standout accent veins - the stone shape, facet, and the split's position all
  vary per rock, but the split's angle is a shared constant so every stone reads
  as lit from the same direction; mud as
  rounded puddles (its polygon corners smoothed into a soft blob) with a drier
  rim, a darker pooled core, and a watery surface of several just-off-concentric
  ripple-ring groups (bright crest over a faint dark halo, like drips landing) -
  all purely visual, derived from each obstacle's position so it's replay-stable
  and never shifts placement (the circle/polygon hitboxes are unchanged). A pickup is
  collected when the truck actually overlaps the building (a rotated-rectangle
  hitbox that accounts for each warehouse's size, rotation, and the truck's
  radius, so collection matches what you see); once collected it turns into a
  plain, unlabelled house that blends into the scenery.
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
  trees/houses/cyclists/benches, city buildings/cars, moon
  astronauts/flags/craters, snow penguins/pines/frozen-lakes, beach
  palms/umbrellas/beach-balls, forest pines/mushrooms/logs/deer, farmland
  haybales/scarecrows/windmills/tractors, autumn
  bare-trees/pumpkins/leaf-patches, savanna acacias/grass-tufts/termite-mounds,
  volcanic charred-trees (recursive fractals)/lava-cracks/
  obsidian, swamp reeds/lily-pads/fog/frogs, candy lollipops/candy-canes/gumdrops,
  plus the seasonal Easter eggs/bunnies and New Year's fireworks/balloons. Props
  can carry a per-instance seed for deterministic in-sprite randomness (branch
  counts, leaf shapes, reed clumps, …). Like the houses, props are purely visual — they never
  affect physics or the leaderboard. Positions are precomputed deterministically
  from the seed (via an independent rng stream) so they're replay-stable, and
  placed clear of roads, warehouses, and obstacles so nothing sits on the
  drivable path. They're drawn as small code-authored vector sprites (trees
  scaled up as landmarks), culled to the visible viewport so even a dense weekly
  map only draws what's on screen.
- Weekly board: a Daily/Weekly toggle switches to a much
  larger map (5x in every dimension) seeded from the ISO year+week
  (`YYYY-Www`, e.g. `2026-W32`), with 15-25 warehouses and 30-40 purely
  decorative houses (no value, no collision) fleshing out the road network
  (weekly roads are straight lines, not curves), and much denser obstacles.
  Because the map is big, a small arrow next
  to the truck points to the nearest unvisited warehouse (red), turning green
  and pointing to the drop-off once every warehouse has been visited. Weekly
  boards can be browsed up to 52 weeks back, each with its own leaderboard. The
  Daily/Weekly toggle is a progressive-disclosure unlock: it sits at the very
  bottom of the home screen and only appears - under a "Want a bigger challenge?"
  invite - once you've earned gold on the viewed level, so first-timers aren't
  faced with the choice up front (in weekly mode the toggle always shows so
  there's a way back to daily).
- Truck physics: single-button steering (default left bias while coasting,
  right while held) with momentum/inertia on both turning and velocity.
  Physics run on a fixed 1/60s timestep (via an accumulator decoupled from
  `requestAnimationFrame`), which is what makes ghost replay deterministic.
- Cargo physics: cargo boxes trail behind the truck with lag, destabilizing on
  sharp turns and mud, and taking a stability hit on rock impacts. Stability
  hitting 0 ends the run. Obstacle hitboxes use the truck's actual body: rocks
  collide against its (heading-oriented) rectangle rather than a bounding
  circle, and a mud patch counts once any body corner is over it - so both line
  up with what's drawn instead of a fixed circle around the truck's center.
  Driving into the map edge and holding there (a brief clip is forgiven) also
  ends the run - as leaving the delivery area, with its own playful game-over
  message. Both
  are tuned a couple of pixels forgiving (like the warehouse pickup pad, but
  negative), so it looks like the truck just grazes a rock or the edge of the
  mud rather than stopping short. Pickups are grouped five to a box: each collected
  warehouse adds a fifth of a box's length to the current box, and once it's
  full a new box starts trailing behind it (so a long weekly route pulls a few
  growing boxes rather than a huge chain of one-per-pickup).
- Personal-best recording and ghost replay: each run's input (held/released
  toggle ticks) is recorded; a successful run that beats your stored best for
  that day's seed is saved to `localStorage` and can be raced against as a
  semi-transparent ghost. While racing a ghost, a live split time under the
  timer shows how far ahead (green, minus sign) or behind (red, plus sign) you
  are, measured at each warehouse pickup by the *number* collected rather than
  which ones (so route order doesn't matter). The ghost's per-checkpoint ticks
  are recovered by deterministically re-simulating its input log; with two
  ghosts racing, the split is measured against the personal-best one.
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
- Event log (diagnostics): interactions append to a `run_logs` table, each row
  holding nickname, seed, an optional free-form `comment`, and a server
  timestamp. Loading the game adds a `game_started` row; a run adds a `started`
  row and one terminal row (`finished`, `cargo_fell_off`, or `out_of_bounds`)
  with the warehouses collected; home-screen activity adds `navigated`,
  `mode_switched`, `paused`/`resumed`, `replay_started`/`replay_stopped`,
  `help_opened`/`help_toggled` (comment `summary`/`full`),
  `tutorial_started`/`tutorial_ended` (comment `skipped`/`finished`/`escape`),
  `menu_shown` (returning to the menu from a run via Home - a page-internal
  transition, so distinct from the page-load `game_started`), `shared`
  (tapping either Share button; comment names the source and copy result, e.g.
  `results: copied`), and `username_changed` (comment `old -> new`). This makes
  visible what the leaderboard can't: only *successful* runs submit a score, so a
  run that ended in `cargo_fell_off` never reached the board. It's best-effort
  telemetry (POST `/api/runs`), independent of scoring, and never affects
  gameplay. A `finished` row with no matching `scores` entry flags a
  score-submission drop; such drops are also logged server-side
  (`console.error`) and client-side (`console.warn`), since the client otherwise
  swallows a failed submit silently. Rows are pruned after 7 days (at boot and
  daily). An unlisted `/logs` page (not linked from the game) shows the log
  newest-first, 100 rows at a time with a "Show 100 more" button, backed by
  `GET /api/runs`.
- Replay theater: watch 1–5 leaderboard runs race each other, non-interactively.
  A "Create a replay" button under the leaderboard (unlocked by the same
  personal-best gate as ghost racing) turns the list into a picker ("select
  ghosts") — tap up to five players, then Show replay (or Cancel). The chosen recordings play back together on their
  own screen with a video-style player: play/pause, a **seekable** progress bar
  (replay is deterministic, so scrubbing re-simulates each racer to that exact
  point), and a ■ stop button to return to the menu. The camera auto-frames the whole pack
  (fit-all zoom, never past 1:1), each racer wears a coloured ring + name tag,
  the timeline runs until the slowest racer finishes, and playback pauses on the
  final frame so the finish order stays on screen.
- Medal targets: each level has deterministic gold/silver/bronze finish-time
  thresholds derived purely from its geometry (the ideal
  base → pickups → destination route length — a 2-opt-optimized tour, so it
  tracks the route a strong player actually drives rather than an inflated
  estimate — inflated for road curvature and divided by an assumed good-driving
  speed), so they're identical for every player and work fully offline. Gold
  lands at roughly 1.36× the straight-line-at-top-speed floor on every map, so
  difficulty stays consistent whether a track has four pickups or twenty-five.
  Each tier's raw time is then rounded up to a whole second with a half-second
  of headroom first (`ceil(raw + 0.5)`), so a raw gold of 17.68s shows as a
  clean, achievable 19s rather than a tight fractional target. Above gold sits a Champion tier at
  `gold - 3*(gold - top)/4` (three quarters of the way from the gold time down
  to the world record time); it unlocks as soon as someone sets a gold time (a record
  faster than gold). Unlike the geometry-derived tiers, the Champion threshold
  is a server-stored, per-seed value: while a day/week is the *current* period a
  new world record ratchets it down (so a player can gain or lose Champion as it
  moves), but once that period is over the threshold is frozen: a later record
  on an old map updates the leaderboard, but not the medal. Anyone finishing at
  or under a day's (frozen) threshold earns Champion, on past days too. Days
  whose threshold was never captured live (e.g. from before this was stored) get
  it backfilled from their record the first time they're viewed, then frozen.
  The home screen shows these as a row of small rounded tiles - one per
  available time (your PB and Champion when they exist, plus Gold/Silver/Bronze),
  each stacking an icon, its name, and the time, laid out fastest-first - for
  both boards. Each tile carries a colour glow (the same resting-glow +
  pulse-on-hover flourish as the streak dots); the PB tile borrows the glow of
  the medal it earned, or a faint bluish grey when it's slower than bronze. The
  results screen shows the medal earned plus the next tier up.
- Daily streak and a recent-days calendar on the home screen: delivering a day
  successfully is recorded in `localStorage`; a "🔥 N-day streak" badge counts
  consecutive delivered days (with a one-day grace before today's is done), and
  a row of dots (the most recent week, today highlighted) is tinted by the best
  medal earned that day: gray for none, bronze/silver/gold, and rose-gold for
  Champion. Each medal dot carries a small resting glow in its own colour and
  pulses once, brighter, when you hover it.
- Shareable result card: after a delivery, a Share button copies a spoiler-free
  summary to the clipboard — the board (Daily/Weekly) and seed, finish time and
  earned medal, your world rank ("#N in the world", when the leaderboard is
  reachable), and a link back to the game (no map details). The link carries the
  map's seed as `?s=<seed>`, so opening it drops the recipient straight onto that
  exact day/week. The base link is the page's own hosted URL, falling back to the
  public address for local/dev play.
  The home screen also has a Share button next to today's "Best" time that
  copies the same kind of summary for your stored personal best (today only).
- Shared-map deep links: opening the game with `?s=<seed>` loads that map. A
  seed that's a still-browsable day (≤30 days) or week (≤52 weeks) lands on its
  live board; any other seed — an expired period, or a non-standard string — is
  generated and fully playable as a one-off "shared map", but with no global
  leaderboard, ranking, ghost-racing, replays, or score submission (a short
  notice replaces the leaderboard). Use the Daily/Weekly toggle to return to a
  live period.
- New-player tutorial: a first-time visitor (no stored progress yet) is dropped
  straight into a short, guided, unfailable practice tutorial. A coach banner
  walks through it step by step, gated on what the player actually does. It has
  two parts:
  - **Learn to drive.** On a fixed, calm grassland level (base, one pickup, one
    drop-off along a wide road, no obstacles): hold to steer right, then release
    to drift left, then collect the `W`, then deliver to the `D`.
  - **A terrain course** of three hands-on sections, each a small level with a
    goal flag to drive to: *road vs grass* (the road is the fast lane), *mud*
    (a puddle to steer around rather than through — no rock in this one), and
    *rock* (a solid boulder you must go around — no mud in this one; hitting it
    restarts the section).

  A **Skip section** button skips just the current section — from the steering
  run it jumps straight to the terrain course, and within the course it moves to
  the next section. The persistent **Skip tutorial** button (or Escape) leaves
  to the main menu at any point. Finishing the course shows a "Let's go!" button
  (and hides Skip tutorial, since they'd do the same thing).

  The run is unfailable throughout (a `practice` game session that ignores the
  cargo and out-of-bounds game-overs), records no score, and races no ghosts. It
  auto-opens only once (a `localStorage` "seen" flag) and is always reachable
  afterwards from a **Tutorial** button directly under the home screen's Play
  button, alongside a **How To** button that opens the same How-to-Play help as
  the round **?** in the header.
- Start screen shows one day at a time (today by default), with prev/next
  arrows beside the thumbnail to browse up to 30 days back - the date,
  minimap, personal best, ghost toggle, and leaderboard panel all update
  together as you navigate. You can also swipe the thumbnail left/right (or
  click-drag on desktop): it works as a carousel, the neighbouring day's map
  sliding in with your finger and snapping into place on release. (The streak calendar strip still shows just the
  most recent week of dots.) Ghost choices are remembered for the session: a
  "show ghost" checkbox beside the best time is a global preference that follows
  you across every level and mode, while a selected leaderboard opponent is
  remembered per level and re-selected when you return to it. A **Play** button
  (with **Tutorial** and **How To** buttons directly below it, or pressing
  Enter, or clicking the thumbnail as a shortcut) jumps into a 3-2-1-GO countdown
  and starts whichever day is showing. A results screen (showing your time against
  your personal best, with Retry and Home buttons) rounds it out. Escape quits a
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
start; the app also runs an idempotent `CREATE TABLE IF NOT EXISTS` at boot so
tables added after a DB was first initialised — like `champions` and
`run_logs` — appear without a manual migration). Open `http://localhost:8003`.

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
screen's prev/next arrows (up to 30 days back), so browsing around doesn't
reload the page or regenerate a level you've already visited.

## Controls

Hold spacebar (desktop) or press-and-hold on the canvas (mouse/touch) to
steer right. Release to drift left. The truck always drives forward;
steering is the only input. Enter starts/retries, Escape quits to the home
screen, Backspace restarts the current run. During a run, a hamburger menu in
the top-left corner opens Restart/Home buttons - the touch equivalent of
Backspace/Escape (steering or restarting dismisses it). Tapping the timer at
the bottom pauses the run - the truck, any racing ghosts, and the clock all
freeze and a "Paused" banner shows near the top; tap it again to resume.

A "?" help button in the home screen's header (aligned with the title rather
than stacked above it) opens a help overlay covering the objective, controls,
terrain, and daily/leaderboard basics (close it with the Close button, Escape,
or by tapping the backdrop). The footer pairs a "Tutorial" button that
(re)starts the guided practice run described above with a "How To" button that
opens the same help overlay.

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
    props/  one file per scenery sprite (cow, palm, tractor, windmill, …),
            with shared drawing helpers and a kind->drawer registry (index.ts)
  main.ts   DOM wiring and the render loop

server/             backend (own tsconfig, compiles to server/dist/)
  index.ts  Express app: serves the static frontend + mounts the API
  routes.ts /api/scores/* and /api/champions handlers (submit, leaderboard,
             single recording, champion-threshold read/backfill)
  db.ts     Postgres queries (pg), incl. ensureSchema() run at startup

db/init.sql          Postgres schema (scores + champions tables), applied
                      automatically by the Postgres image on first container
                      start; ensureSchema() backstops it for existing DBs
```

No bundler for the frontend: `tsc` compiles TypeScript straight to ES
modules in `dist/`, loaded directly via `<script type="module">` in
`index.html`. The backend is a separate TypeScript project (`server/`) with
its own `tsconfig.json` and output directory, so backend source is never
served as a static file.
