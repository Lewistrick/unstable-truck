/** The fixed physics timestep, in seconds per tick. Both the live game loop
 * (main.ts's accumulator) and ghost replay (GhostPlayer) must advance by
 * exactly this amount per step so that a tick index means the same thing in
 * both places - that's what makes replay deterministic and lets recorded
 * input-toggle points be stored as plain tick integers instead of floats. */
export const FIXED_DT = 1 / 60;
