# Unstable Truck

Browser-based daily speed-run parcel-delivery game. Vanilla TypeScript + HTML5
Canvas on the client, Express + Postgres on the server. No framework and no
bundler — `tsc` compiles `src/` straight to `dist/` as ES modules.

## Verifying changes

There is no `node`, `npm`, or `tsc` on the host and no `node_modules` — but
Docker is available, so the client **can** be typechecked in about 6 seconds:

```sh
scripts/typecheck.sh
```

Run it after every TypeScript change, before wrapping up. It runs the same
`tsc` version the Docker build uses (pinned to `package-lock.json`) inside the
`node:22-alpine` image, with the compiler cached in a Docker volume and the
repo mounted read-only. A pass means the same thing as a client pass in
`npm run build`; it catches the strict-mode errors below in seconds instead of
after a failed image build.

What it does **not** cover: `npm run build:server` (`server/` imports express
and pg, so it needs a real `npm ci`) and the test suite. Server-side or test
changes are still unverified until the user builds — say so plainly rather than
calling them "working" or "done".

## Type rules that have actually broken the build

`tsconfig.json` sets `strict` **and** `noUncheckedIndexedAccess`, which is
stricter than most TypeScript projects. Two error classes reached Docker before
`scripts/typecheck.sh` existed — both are now caught locally, but they are the
patterns worth watching for:

- **Indexed reads are `T | undefined`.** Every `arr[i]`, `record[key]`, and
  `Record<string, X>` property read needs a `!` or a guard — including a read
  from a local you just assigned from an index. Writes (`arr[i] = x`) are fine.
  Reached Docker as TS18048.
- **Don't widen typed arrays with an explicit annotation.** Declaring
  `function f(): Float32Array` widens the buffer parameter to
  `Float32Array<ArrayBufferLike>`, which Web Audio's `WaveShaperNode.curve`
  (`Float32Array<ArrayBuffer>`) rejects. Let the constructor's inference stand.
  Reached Docker as TS2322.

The lesson behind both: prefer inference over hand-written annotations, and
treat every index access as nullable.

## Audio

`src/game/audio.ts` owns all sound. Three volume channels, each with its own
mute, persisted via `loadSoundPrefs()`/`saveSoundPrefs()` in `storage.ts`:
`gameVol()` (engine, cargo wobble, terrain, rock crash), `ambientVol()` (biome
beds), `effectsVol()` (countdown, pickup chime, medal fanfare).

Everything is synthesized with the Web Audio API — there are no audio assets.
When tuning a sound, mirror the change in the sound-preview artifact so the two
don't drift.

Two synthesis lessons worth keeping, both learned the slow way:

- **Sustained noise with a gradual envelope is how you synthesize wind.** If a
  sound is meant to be an impact or a texture and it reads as "whooshy", the
  envelope is the cause, not the filter. Impacts want instant attacks and short
  decays.
- **Metal reads as metal because its modes are inharmonic.** Ring a set of
  irrational frequency ratios (not a harmonic series), damp the higher modes
  faster than the lower ones, and detune the low modes into beating pairs.
