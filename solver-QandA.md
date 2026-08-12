# Solver quiz

My answers about the optimal-route solver I implemented (`src/game/solver.ts`,
`src/game/sim.ts`). I've tried to be honest rather than flattering — including
where the other LLM's proposal is genuinely a better fit than what I built.

## First, what did I actually implement?

A precise name for it: **kinodynamic, macro-action, weighted A\* over a state
lattice, with state-hashing/closed-list dominance pruning, an anytime weight
ladder, and a fixed 2-opt visiting order.**

Piece by piece:

- **Kinodynamic** — every edge is expanded by stepping the *real* physics engine
  (`updateTruck`, `resolveRockCollision`, cargo follow, terrain), not by moving on
  a grid. Momentum, surface speeds, and rock collisions are all respected.
- **Macro-action** — an edge isn't one tick; it holds a single steering input
  until the discretized state leaves its lattice cell (variable length, capped).
- **State lattice + hashing** — `(pickups-collected, position cell, heading,
  speed, turn-rate)` is hashed into an integer key; a `Map` keeps only the
  fastest arrival per key (closed-list dominance pruning).
- **Anytime weight ladder** — `f = g + W·h` run at `W = 3, 2, 1.5, 1.2, 1`, each
  pruned by the best time so far.
- **Fixed order** — a 2-opt tour pins the pickup order up front.

That's essentially the other LLM's *alternative* answer — "Macro-Action A\* with
state hashing / closed-list pruning" — and a close cousin of its primary answer,
kinodynamic beam search. More on that below.

---

## Which algorithms did I consider?

- **Brute-force tree search** over the 1-bit-per-tick decision tree (~2^1000).
  Rejected immediately — astronomically large.
- **Grid A\* / Dijkstra / pure TSP on the road graph.** Rejected: they ignore the
  truck's dynamics (momentum, turn radius, surface speeds), so a "shortest" grid
  path isn't drivable. This is exactly the "physics eliminates grid pathfinders"
  point.
- **Kinodynamic beam search** (the other LLM's primary answer) — expand physics,
  keep the top-K states per depth layer.
- **Hybrid A\* / state-lattice planning** (what I chose) — expand physics, keep
  the best cost per discretized state cell, ordered by a priority queue.
- **TSP-for-order + per-leg kinodynamic planning** (decomposition). I borrowed
  half of it (the fixed order) but planned the whole route in one search rather
  than stitching independent legs.
- **Sampling-based kinodynamic planners (RRT\*/kinodynamic-RRT).** Good for huge
  continuous spaces, but weak at *optimising* short routes and awkward to make
  deterministic/repeatable.
- **MCTS** — no natural terminal reward shaping here and weaker than A\* when an
  admissible heuristic exists.
- **Reinforcement learning** — rejected on the resource constraints: training cost,
  non-determinism, and it's overkill for a per-seed offline solve.
- **Held–Karp exact TSP** for ordering — considered, but 2-opt on straight-line
  distance is enough on daily maps and far cheaper.

## How close am I to the other LLM's solution?

Very close — I effectively landed on its *alternative* name and share the DNA of
its *primary* name.

- **Same for both:** kinodynamic expansion (real physics), macro-actions, and
  state hashing / closed-list pruning. My `bestG` map *is* the "state hashing /
  closed-list pruning" it names. Its reasoning chain (tree search → kinodynamic
  because of physics → memory-bounded because of the limits) is the same reasoning
  I followed.
- **The one real difference — frontier management.** Beam search keeps a
  *fixed-width* top-K per layer; I keep a *priority queue with per-cell dominance*
  and order by an admissible heuristic. A subtle but important point: the other
  LLM's chain says "eliminate A\*", but that conflates *grid* A\* with A\* the
  *strategy*. A\* is perfectly usable in a kinodynamic setting (that's what
  "hybrid A\*" is); beam search and A\* differ only in how they manage the
  frontier, and both need the identical physics-expansion step. So I didn't
  violate its reasoning — I made a different frontier choice within it.

Verdict: I'd call it the same family, landing on the alternative it offered, with
a heuristic-guided A\* frontier instead of a fixed-width beam.

## Why do I think the implemented algorithm was the best (for *daily* maps)?

- **Determinism gives cheap, exact dominance.** The physics are deterministic, so
  I can hash exact states and confidently discard a slower arrival at the same
  cell. That's a very strong pruning lever, and it's what a plain beam width
  doesn't exploit.
- **An admissible heuristic exists** (Euclidean distance through the remaining
  ordered waypoints ÷ top speed). A\* uses it to focus the search *globally*; a
  beam only ranks *within* a layer and can permanently prune the eventual optimum
  with no way to recover.
- **Anytime behaviour matched the brief.** The budget varies and the hard 8-pickup
  maps need "a valid route now, a better one if there's time." The weight ladder
  delivers that; a single-width beam does not.
- **The fixed-order reduction is the real win** and is orthogonal to beam-vs-A\*:
  it collapses "which pickups are done" from a `2^pickups` bitmask to a small
  count, which is what made 6–8-pickup maps tractable at all.
- **Validity is guaranteed by construction** — expanding the real engine means any
  route found is drivable and never drops cargo, and I re-verify by replaying
  through a real `GameSession`.

Honest caveat: "best" is scoped to *daily* maps within the memory budget. On a
much larger map, A\*'s open/closed sets are a memory liability and a fixed-width
beam would actually be the safer choice (see the weekly section).

## What trade-offs did I make?

- **Fixed order (2-opt) sacrifices global order-optimality.** If road topology
  makes a non-geometric order faster, I won't find it. In exchange I avoid the
  `2^pickups` blowup.
- **Lattice discretization sacrifices exactness.** Bucketing position/heading/
  speed/turn-rate and merging states by cell is non-Markovian (I drop the exact
  angular velocity within a bucket), so I can miss the true optimum. Validity is
  preserved; optimality is approximate.
- **Return-on-first-*reached*-goal, not first-*popped*.** Even the `W = 1` rung
  isn't a proven optimum — it's a strong route that strictly beats the previous
  bound. I traded a provable-optimality guarantee for speed.
- **Macro-edges coarsen control.** Steering can only toggle at cell boundaries, so
  very fine sub-cell maneuvers are unavailable to the search (the greedy fallback
  can toggle every tick, which is why I keep it).
- **Memory vs. completeness.** A hard 5M-node cap bounds RAM but can stop a search
  before it converges on a hard map.

## What improvements did I make over the vanilla algorithm?

Over textbook A\*:

- **Variable-length macro edges** ("hold until the lattice cell changes"). Vanilla
  fixed-step expansion collapses a from-rest start onto its own cell and the search
  dies; macro-edges fix that and cut branching.
- **State-lattice dominance** instead of an exact closed set (which would be
  infinite over continuous state).
- **Order-fixing** to turn an exponential objective into a linear one.
- **Anytime weight ladder** (a restarting-weighted-A\* flavour) for feasibility
  first, then improvement — instead of one admissible pass that may never reach a
  goal in budget.
- **A spatial index for exact-but-fast terrain** (`level/level-index.ts`): the live
  "am I on a road?" test scans every road sample; I bucket samples into a grid for
  the same answer in ~O(1), which is what makes millions of physics steps feasible.
- **Real-engine expansion + post-hoc verification**, so a found route is
  guaranteed drivable and reproduces exactly as a ghost.
- **Memory hygiene**: node snapshots are freed once expanded; only the parent/edge
  chain is kept for reconstruction.

## Given more resources, what other choices would I make?

- **A road-aware heuristic.** Replace Euclidean-÷-top-speed with a precomputed
  shortest-time distance field (a Dijkstra pass on a weighted grid that respects
  road/grass/mud speeds). A much tighter heuristic dramatically cuts expansions —
  the single biggest lever left.
- **True optimality:** return-on-*pop* and proper node reopening (ARA\*), so the
  `W = 1` rung is provably optimal for the fixed order.
- **Search over several candidate orders** (top-K from Held–Karp/LKH) in parallel,
  or fold the order back into the state as a bitmask once the heuristic is strong
  enough to keep it tractable.
- **Parallelism** — the weight ladder / multiple orders map naturally onto several
  cores (the brief limited me to one).
- **Finer or adaptive lattice**, including angular velocity as a first-class keyed
  dimension.
- **Bidirectional search** from base and destination.

---

## Running it on a weekly map (~20 warehouses)

### Will runtime scale linearly, logarithmically, exponentially, or not at all?

It depends entirely on the *order* decision, which is the whole reason I fixed it:

- **In the number of warehouses alone (map size held constant): roughly linear.**
  Because the order is pinned by 2-opt, "pickups done" is a small *count* in the
  state key (a `×legs` factor), not a `2^warehouses` bitmask. 2-opt itself is
  polynomial. So the warehouse count on its own is not the exponential term.
- **But a weekly map is not just "more warehouses" — it's 5× bigger per axis =
  ~25× the area** (`WEEKLY_SCALE = 5`). The lattice has ~25× more position cells,
  and routes are longer. That area term dominates, so real-world scaling is
  **super-linear / polynomial**, and — critically — **memory-bound to the point of
  "not at all"** within the given limits (see below).
- **If I had *not* fixed the order, it would be exponential** (`2^20` ≈ a million
  pickup-subsets) and hopeless.

So: *linear-ish in warehouse count by design, but in practice "does not scale" to
the weekly map* because the 25× area blowup blows the memory budget.

### If 8 warehouses takes 1 minute, how long for 20?

Two very different numbers depending on the design, which is the instructive part:

- **Naive/exponential reading** (what you'd get *without* order-fixing, `2^n`
  masks): `2^20 / 2^8 = 4096×` → ~**68 hours**. My design specifically avoids this.
- **My design's actual dominant cost:** ~25× (area) × ~2.5× (legs, 21 vs 9) ≈
  **~50–60×** the states to explore → on the order of **~1 hour** of compute *if
  memory and the heuristic held up*.

The catch: they don't. The daily-8 case already uses ~2M nodes / ~630 MB. Scaling
that ~60× is ~120M nodes / tens of GB — it hits the 5M-node / 1.5 GB guardrail
almost immediately and would return only a rough weighted/greedy route, not an
optimal one. **Honest bottom line: within the 60 s / 1.5 GB budget it would *not*
produce an optimal weekly route at all; unconstrained, expect ~an hour and far
more than 1.5 GB.**

### Would another algorithm be more efficient for weekly?

Yes — this is where my daily-tuned choice stops being the right one:

- **Decomposition (the clean win):** solve the order with a real TSP solver
  (Held–Karp for ≤~15, LKH/2-opt beyond) on *road-network* distances, then plan
  each leg with a *local* kinodynamic A\* bounded by that leg's length, stitching
  legs with a light DP over a few boundary (entry heading/speed) states. Per-leg
  work is bounded by leg size, not whole-map size, so this scales ~linearly in
  warehouses and stays within memory.
- **Beam search / SMA\* (memory-bounded):** here the other LLM's primary answer is
  genuinely better than mine. On a 25×-bigger map, A\*'s open/closed sets are the
  liability; a fixed-width beam (or simplified-memory-bounded A\*) caps RAM by
  construction, trading completeness for a hard memory ceiling — exactly the right
  trade on a huge map.
- **A road-aware heuristic** (as above) would also help a lot regardless of frontier.

So: for weekly, **decomposition + a memory-bounded frontier (beam/SMA\*) + a
road-aware heuristic** would beat my daily-optimised A\*.

---

## Bonus: would a static language (Rust) help?

### Would it be faster?

**Yes, meaningfully — roughly 3–10×.** The hot loop is physics stepping plus a
state clone per edge. In JS that means GC pressure from the per-node clones,
dynamic property access, and bounds/typeof checks. Rust gives cache-friendly
value structs, arena/pool allocation (no GC pauses), predictable layout, and SIMD
headroom. The search is allocation-heavy, which is precisely where Rust's manual
memory control pays off most.

### Would it require an entire rewrite of the physics engine?

**No — a modest port, not a rewrite.** The physics is small and self-contained:
`truck.ts`, `cargo.ts`, `terrain.ts` are a few hundred lines of pure math with no
DOM. Porting them is bounded work. The real cost isn't size, it's **duplication
risk**: you'd then have two engines that must stay bit-identical, or you compile
*one* (Rust → WebAssembly) and use it from both the game and the solver.

### Could physics (and scenery gen) live in a static language for a more performant game?

**Yes — compile Rust to WASM and share it between the live game and the solver.**
Benefits: speed, a single source of truth for the physics, and strong determinism.
Rendering stays in JS/Canvas; only the simulation and generation cross into WASM.

Two caveats worth flagging honestly:

- **Determinism is load-bearing here.** The entire ghost/replay/leaderboard system
  depends on *bit-exact* reproduction of float math. WASM and JS both use IEEE-754,
  but transcendental functions (`sin`, `cos`, `hypot`) and operation ordering can
  differ between JS's `Math` and Rust's `std`. A port that isn't bit-identical
  would silently invalidate every stored recording. That's the main engineering
  risk, and it's manageable but must be designed for (e.g., a shared, fixed
  implementation of the transcendentals).
- **Interop and build cost.** A WASM toolchain, and JS↔WASM boundary crossings for
  anything the renderer needs each frame, add complexity that only pays off if the
  simulation is actually the bottleneck (for the *game* it currently isn't; for the
  *solver* it clearly is).

---

## Follow-up clarifications

### A\*, Beam Search, and their variants — explained without the jargon

Picture the solver as a person with unlimited patience, a whiteboard, and a magic
"what-if" button: press it while the truck is in any situation and it shows you
the two futures — *keep holding the steering* or *let go* — and where the truck
ends up a moment later. Solving the map means finding the sequence of hold/release
choices that reaches every warehouse and the drop-off fastest. The whiteboard
fills with half-finished routes; the whole game is deciding **which half-finished
route to keep working on next**.

- **A\*** is the "follow the most promising lead" strategy. For each half-finished
  route it adds two numbers: **time already spent** getting here, plus a **smart
  guess of the time still left** (roughly: straight-line distance to the remaining
  warehouses at top speed). It always continues whichever route has the smallest
  total. Because the guess never *overestimates*, A\* won't be fooled into ignoring
  a route that looks long now but is actually shortest — that's what lets it find
  genuinely fast solutions instead of merely okay ones. The cost is bookkeeping: it
  remembers a lot of half-finished routes, which eats memory.

- **Beam Search** is the "only keep your best few ideas" strategy. At every stage
  it looks at all the half-finished routes, keeps just the *K* best-looking ones
  (say, the 500 most promising), and **throws the rest away**. That keeps memory
  tiny and predictable, but it's a gamble: if the eventual best route looked
  unpromising early, it gets discarded and can never come back. Beam trades the
  guarantee of a good answer for a hard cap on memory.

- **The variants** are mostly about *patience vs. thoroughness*:
  - **Weighted A\*** — the impatient A\*. It exaggerates the "guess of time left"
    so it rushes toward the goal. It finds *a* route much faster, but that route
    can be a bit longer than the best.
  - **Anytime A\* / the weight ladder** (what I used) — run the impatient version
    first to get a route in hand, then re-run progressively more carefully, keeping
    the best route found so far. You always have an answer, and it improves with
    time.
  - **Hybrid A\*** — plain A\* is usually taught on a checkerboard grid where you
    step square to square. "Hybrid" means running the same strategy while obeying
    real driving physics (momentum, turning circle) instead of teleporting between
    squares. My solver is this kind.
  - **SMA\* / memory-bounded A\*** — A\* that, when its whiteboard gets full, starts
    erasing its least-promising notes to stay under a memory limit. It's basically
    A\* borrowing beam search's discipline.

For this game, all of them share the same "press the what-if button on the real
physics" core; they differ only in *which half-finished routes they keep* and *how
eagerly they chase the goal*.

### What is an 'edge'?

An **edge** is one move from one situation to the next — a single arrow on that
whiteboard connecting "truck was here, doing this" to "truck is now there, doing
that." In a checkerboard version of A\*, an edge is "step one square." In my
solver, an edge is a **macro-action**: *hold one steering input (say, "keep
turning left") and let the truck run until its situation has changed meaningfully*
— it's crossed into a new patch of the map, or swung to a noticeably different
heading or speed. So one edge might be 3 ticks in a tight moment or 20 ticks
coasting down a straight. Using these longer edges (instead of re-deciding every
single tick) is what stops the search from drowning in near-identical states,
especially right at the start when the truck is barely moving.

### What are weights, and why ladder them?

The **weight** is how much the solver *trusts and inflates* its guess of "time
still left" relative to "time already spent."

- **Weight = 1** — balanced and honest. This finds the best routes but explores
  cautiously, so it's slow and on the hardest maps might not finish in time.
- **Weight > 1** — impatient. Multiplying the "distance left" guess makes the
  solver lunge toward the goal and ignore scenic detours. It finds *a* valid route
  very fast, but that route can be somewhat longer than optimal (up to the weight
  factor).

**Laddering** means running the search several times with a decreasing weight —
`3 → 2 → 1.5 → 1.2 → 1` — each run told "don't bother with anything slower than the
best route you've already found." The first, most impatient run guarantees we have
*some* valid route in hand almost immediately (crucial on the 8-warehouse maps);
each calmer run then tightens it toward optimal, and we stop when the clock runs
out. It's the "get an answer first, make it better if there's time" approach — much
safer under a strict time budget than betting everything on one slow, careful pass
that might not reach the goal at all.

### Why didn't I go for Beam Search?

For the **daily** maps, four reasons — but with an honest asterisk:

1. **The physics are deterministic, so I can be smarter than a fixed beam.** Because
   the same situation always plays out the same way, I can recognise "I've already
   reached this exact patch-of-map/heading/speed faster before" and drop the slower
   copy. That dominance pruning is more surgical than beam search's blunt "keep the
   best *K*, bin the rest" — beam can bin a state that was actually worth keeping.
2. **I have a trustworthy distance estimate, and A\* exploits it globally.** Beam
   only ranks routes *against each other at the current stage*; A\* ranks every
   half-finished route in existence on one scale, so it won't strand the
   slow-looking-but-actually-best route the way a beam can.
3. **I needed an "always have an answer" guarantee**, which the weight ladder gives
   cleanly. A single fixed-width beam doesn't naturally offer "rough now, better
   later."
4. **On daily maps memory was never the problem** — and memory is beam search's
   one big advantage. When its advantage doesn't apply, A\*'s better routes win.

The asterisk: on the **weekly** map that calculus flips. There the map is ~25×
bigger, A\*'s memory appetite becomes the binding constraint, and beam search's
guaranteed memory ceiling is exactly what you'd want. So it's not that beam search
is worse in general — it's that it was the wrong tool for the *daily* job and the
right tool for the *weekly* one.

### Would I recommend a port to Rust? (given a small physics deviation is fine)

**Yes, conditionally — and your "small deviation is OK" removes the scariest
blocker.** The reason I hedged before was that a not-bit-identical port silently
breaks every saved ghost. If you're fine with a slight deviation, that fear goes
away: you'd bump the stored-recording version once (the game already discards
old-format recordings), old ghosts retire, and everyone re-races on the new
engine. Clean.

My actual recommendation is about *scope*, and it depends on your goal:

- **If daily gold-in-15s is good enough:** don't port yet. The current solver
  already meets the stated budget; a port is effort without a user-visible win.
- **If you want the solver to be snappier, tighter (closer to truly optimal), or
  to reach the weekly map:** **yes, port the solver's hot loop** (the physics step
  + the search) to Rust → WebAssembly, called from the existing worker. That's
  where ~all the compute is, it's a few hundred lines, and it's isolated from the
  live game, so it's the best effort-to-payoff ratio (~3–10×). I'd keep the final
  "replay the found route and confirm it delivers" check in JS as a safety net, so
  a small engine deviation can't ship a ghost that visibly fails.
- **If you also want a tidier long-term architecture:** port the physics *once* to
  Rust/WASM and have **both** the game and the solver call it. More work, but it
  kills the "two engines drifting apart" risk permanently — and since you accept a
  small deviation, the one-time recording reset is an acceptable price.

There's also a fourth option that may beat all of the above (see the languages
answer): because this is a *daily* game, you could **precompute** each day's
optimal route on a server in any fast language and just ship the resulting
input-log — no browser porting at all.

### What other languages would I consider — and is any more promising than Rust?

Rust is the safe, high-performance default, but for *this* codebase a couple of
options are arguably more pragmatic:

- **AssemblyScript** — a TypeScript-flavoured language that compiles to WebAssembly.
  This is the standout for *this* project: the engine is already TypeScript, so the
  port is closer to a translation than a rewrite, and it runs in the browser worker
  with far less friction than Rust's toolchain. Raw speed is a notch below Rust
  (it has a lightweight garbage collector), but for tight numeric loops it's in the
  same ballpark and *much* cheaper to adopt here. **For minimum effort in the
  browser, I'd rank it above Rust.**
- **Zig** — as fast as Rust, simpler language, excellent small WASM output, and easy
  low-level float control. Younger ecosystem. A strong middle ground.
- **C / C++** — top-tier performance and the most mature game/numeric ecosystems,
  with fine-grained control over float behaviour (handy if you *did* care about
  determinism). Weaker memory-safety guarantees than Rust; compiles to WASM via
  Emscripten. A fine choice, mainly a matter of taste vs. Rust.
- **Go (or TinyGo for WASM)** — pleasant and fast to write, but it has a garbage
  collector, so the win over well-written JS is smaller than Rust/Zig/C give, and
  WASM binaries are larger. More attractive for the *server-side precompute* path
  than for the browser.
- **Any native language, for offline precompute** — if you take the "solve each
  daily map once on a server and serve the input-log" route, you don't need WASM at
  all, so you can reach for whatever's fastest and most comfortable (native Rust,
  C++, or Go). Given the daily format, this is often the smartest architecture:
  zero client compute, and the language choice stops being constrained by the
  browser.

**Bottom line:** for a *browser* port with the least rewrite, **AssemblyScript is
the most promising** precisely because the code is already TypeScript; for maximum
performance and robustness, **Rust** (or Zig/C++) still wins; and for a daily game,
**precomputing server-side in any fast native language** may sidestep the question
entirely.
