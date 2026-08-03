# Unstable Truck

A browser speed-run game: drive a truck with loose cargo through a road
network that's procedurally generated from today's date, pick up cargo, and
deliver it as fast as possible without letting it fall off.

## Status

No global leaderboard or backend yet — everything runs and saves locally.
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
  toggle times) is recorded; a successful run that beats your stored best for
  that day's seed is saved to `localStorage` and can be raced against as a
  semi-transparent ghost.
- Start screen showing today's level plus playable thumbnails for the
  previous two days (each with its own personal-best time) - always anchored
  to the real calendar date, regardless of which level was last played;
  clicking any thumbnail jumps into a 3-2-1-GO countdown and starts that
  level. A personal-best ghost toggle, an in-game HUD (timer, objective,
  stability meter, PB time), and a results screen (showing your time against
  your personal best) round it out. Escape quits a run/countdown back to the
  start screen; Enter retries from the results screen.

Not yet built: global leaderboard, daily-best-player ghost, backend/database.
See the project's design doc for the full intended scope.

## Running it locally

```sh
npm install
npm run build   # compiles src/**/*.ts -> dist/**/*.js
npm run serve   # serves the project on http://localhost:8123 (or use any static server)
```

Open `http://localhost:8123` in a browser. During development, run
`npm run watch` in a separate terminal to recompile on save.

`index.html` loads the game as an ES module, which browsers refuse to do
over a bare `file://` URL — it must be served over `http://`, not opened by
double-clicking the file. If `npm run serve` fails with a Windows
`PermissionError: [WinError 10013]` on the port, that port is likely in a
range Windows/Hyper-V has reserved and blocked; edit the port number in the
`serve` script in `package.json` (or run
`python -m http.server <some-other-port>` directly) and try a different one.
You can list currently reserved ranges with
`netsh interface ipv4 show excludedportrange protocol=tcp`.

The home screen always generates today's level plus the previous two days
up front (there's no `?seed=` URL override anymore) - clicking any of the
three thumbnails plays that level directly, in-memory, with no page reload.

## Controls

Hold spacebar (desktop) or press-and-hold on the canvas (mouse/touch) to
steer right. Release to drift left. The truck always drives forward;
steering is the only input.

## Project layout

```
src/
  util/     seeded RNG, value noise, vector math
  level/    procedural generation (roads, warehouses, obstacles, palette) + terrain queries
  physics/  truck and cargo simulation
  game/     input handling, canvas rendering, game session/state machine
  main.ts   DOM wiring and the render loop
```

No bundler: `tsc` compiles TypeScript straight to ES modules in `dist/`,
loaded directly via `<script type="module">` in `index.html`.
