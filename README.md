# Unstable Truck

A browser speed-run game: drive a truck with loose cargo through a road
network that's procedurally generated from today's date, pick up cargo, and
deliver it as fast as possible without letting it fall off.

## Status

This is the **core gameplay loop only** — no leaderboard, ghosts, or backend
yet. What's implemented:

- Deterministic daily level generation (Mulberry32 PRNG seeded from
  `YYYY-MM-DD`): hub placement, a connected Bezier-curve road network with a
  few branching dead ends, warehouse placement (base/pickup/destination),
  rocks/mud/rough-terrain obstacles, and a seeded color palette.
- Truck physics: single-button steering (default left bias while coasting,
  right while held) with momentum/inertia on both turning and velocity.
- Cargo physics: the cargo box trails behind the truck with lag, destabilizing
  on sharp turns, mud, rough terrain, and rock impacts. Stability hits 0 →
  the run ends.
- Start screen with a minimap preview of the day's level, an in-game HUD
  (timer, objective, stability meter), and a results screen.

Not yet built: global leaderboard, ghost replays, personal-best storage,
backend/database. See the project's design doc for the full intended scope.

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

To test a specific day's level instead of today's, add `?seed=YYYY-MM-DD` to
the URL.

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
