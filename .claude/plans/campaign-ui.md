# Showing the Campaign

Goal: give players a way to discover, enter, and track progress through the 25
campaign maps. Campaign map navigation (C01–C25 prev/next buttons + swipe) is
already wired up; this plan covers the entry point and progress presentation.

## Context

Campaign maps are procedurally generated at increasing difficulty (6×4 grid to
10×7, widening roads that narrow, escalating obstacles). They use orphan-style
seeds (`2026-aug-C07`) with no leaderboard. The nav buttons and swipe carousel
are already functional — what's missing is a way to get there and a sense of
progression.

---

## Blueprint A: Third Mode Tab

Add "Campaign" alongside Daily / Weekly in the mode toggle at the bottom of the
home screen. The campaign reuses the same one-at-a-time carousel, progress
strip, and medal track that daily/weekly already have.

### How it works

- The `Mode` type grows to `"daily" | "weekly" | "campaign"`.
- Selecting the Campaign tab sets `mode = "campaign"` and `viewedOffset = 0`
  (pointing at the first unfinished map, or C01 on a fresh start).
- `seedFor("campaign", offset)` builds the campaign seed for that index.
- The carousel, nav buttons, and swipe all operate on index 1–25 (already done).
- A progress strip below the minimap shows 25 small dots/cells — one per map,
  coloured by medal earned (empty = unplayed, bronze/silver/gold/champion).
  Tapping a dot jumps to that map.
- The medal track below the minimap shows par times for the viewed map, same as
  daily.
- Campaign progress persists in localStorage (and syncs via accounts once that
  lands), keyed by campaign seed prefix (`2026-aug-`).

### Unlock gate

Same progressive disclosure as weekly: hidden until the player has earned at
least one gold medal on Hard daily, then appears with a short invite label.

### Pros

- Smallest surface area — reuses the entire home screen; no new screens.
- Familiar: players already know the carousel + medal track pattern.
- The 25-dot strip doubles as a progress overview and a random-access picker.

### Cons

- 25 maps in a linear strip is harder to scan than a grid.
- Campaign doesn't naturally fit the day/week metaphor (it isn't calendar-tied),
  so the tab row could read as overloaded.
- No room for narrative flavour (difficulty names, region labels, etc.).

### Estimated scope

- Mode plumbing + seedFor extension: ~80 lines.
- Campaign progress strip component: ~120 lines (similar to streak strip).
- Tab visibility and unlock gate: ~30 lines.
- Storage helpers (campaign completion/medals): ~60 lines.
- Total: **~290 lines**, mostly in `main.ts` and `storage.ts`.

---

## Blueprint B: Level-Select Grid

A dedicated overlay panel (like the stats or profile panel) with a 5×5 grid of
all 25 maps. Each cell shows a tiny thumbnail, its number, and a medal icon.
Tapping a cell opens that map in the carousel view.

### How it works

- A "Campaign" button appears on the home screen (near the Daily/Weekly toggle,
  or beside Tutorial / How To).
- Clicking it opens a `#campaign-panel` overlay that covers the home content.
- The panel renders a 5×5 grid of `<canvas>` thumbnails (50×32 px each, same
  minimap renderer at low res). Each cell shows:
  - The map number (C01–C25).
  - A medal pip below it (empty / bronze / silver / gold / champion).
  - A lock icon if gating is enabled and the map is beyond the player's reach.
- Tapping an unlocked cell closes the overlay and opens that map in the campaign
  carousel (via `showOrphanSeed`).
- An optional "Play next" button at the top jumps to the first unfinished map.
- A header shows aggregate stats: "12 / 25 completed · 4 gold".

### Gating options

Two sub-choices worth deciding up front:

| Approach | Rule |
| --- | --- |
| **Fully open** | All 25 maps playable from the start. Medals fill in as you play. |
| **Progressive unlock** | Each map unlocks when you earn at least bronze on the previous one. |

Progressive unlock gives a clearer sense of journey; fully open respects
players who want to skip around. Could start open and add locking as a "strict
mode" toggle later.

### Pros

- The full 25-map landscape is visible at a glance — you see how far you've
  come and what's left.
- Grid is natural for a fixed set (25 maps fits a 5×5 grid exactly).
- The overlay pattern is already used (stats, profile, help) — no new layout
  paradigm.
- Room for visual polish: the thumbnails give each map an identity.

### Cons

- Rendering 25 thumbnails at panel open has a cost (~150 ms on mobile if
  uncached; can be deferred or cached in an offscreen canvas).
- More HTML/CSS than Blueprint A — a new panel with its own layout.
- Two "homes" for campaign (the grid to pick, the carousel to play) is slightly
  more complex than one.

### Estimated scope

- HTML panel + CSS grid layout: ~60 lines.
- Grid renderer (25 thumbnails + medals): ~140 lines.
- Campaign button, open/close, unlock gate: ~50 lines.
- Storage helpers: ~60 lines (same as A).
- Total: **~310 lines**, split across `index.html`, `style.css`, `main.ts`,
  `storage.ts`.

---

## Blueprint C: Continuous Run

Campaign is played as a single session: the player starts at C01 and plays each
map in sequence. After completing a map, a brief interstitial shows the result
and advances to the next. The run ends when all 25 are done (or the player
quits).

### How it works

- A "Start Campaign" button on the home screen begins the run.
- The game enters a `campaignRun` state that tracks `currentIndex` (1–25),
  per-map times, and medals earned.
- After each map's results screen, a "Next map" button (instead of "Retry")
  advances to the next. "Retry" is still available but replays the same map.
- A persistent HUD strip at the top shows progress: `C07 / 25 · 4:32 total`.
- When the player finishes C25, a campaign-complete screen shows aggregate
  stats: total time, medal breakdown, best/worst splits.
- The run is resumable: if the player quits mid-campaign (Home button or
  closing the tab), the run state is saved and restored on return. A "Resume
  campaign" button replaces "Start campaign" when a run is in progress.
- Individual map PBs and medals are still saved per-seed, so the map carousel
  (Blueprint A's mode tab or a simple entry point) can show them.

### Difficulty

Campaign maps have their own built-in difficulty curve (grid size, road width,
obstacles). No Easy/Hard toggle — the campaign IS the difficulty ramp. This is
already how campaign generation works (see `campaignParams()`).

### Pros

- The most game-like option — momentum and pacing are built in.
- Total-time tracking creates a natural speedrun target.
- Resumability means a player can chip away at it across sessions.
- The interstitial is a natural place for flavour text ("The roads get narrower
  from here…").

### Cons

- Largest implementation: a new game-flow state machine layered on top of the
  existing session/results cycle.
- The results screen, retry logic, and HUD all need campaign-aware branches.
- Resumability adds persistence complexity (save/restore mid-run state).
- Players who want to replay a specific map need a separate entry point anyway
  (at which point you're partially building A or B too).

### Estimated scope

- Campaign run state machine + HUD strip: ~200 lines.
- Results screen campaign branch (Next map, aggregate stats): ~120 lines.
- Campaign-complete screen: ~80 lines.
- Resume/save/restore logic: ~100 lines.
- Total: **~500 lines**, touching `main.ts`, `index.html`, `style.css`,
  `storage.ts`, and possibly `session.ts`.

---

## Comparison

| | A: Mode Tab | B: Level Grid | C: Continuous Run |
| --- | --- | --- | --- |
| **Size** | ~290 lines | ~310 lines | ~500 lines |
| **Reuse** | High (carousel, strip) | Medium (new panel) | Low (new flow) |
| **At-a-glance progress** | 25-dot strip | 5×5 grid with thumbnails | HUD bar during run |
| **Random access** | Dot tap + nav arrows | Grid tap | Not during a run |
| **Pacing / momentum** | Player-driven | Player-driven | Built in |
| **Future extensibility** | Straightforward | Room for locking, regions | Speedrun leaderboards |

All three can coexist: B or A as the entry/progress view, C as the play mode.
But starting with one keeps the scope focused.
