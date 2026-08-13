/** The 3-2-1-GO count-in shown before a run starts, and before every hands-on
 * "play" part of the new-player tutorial - one definition so both count in at
 * the same pace. */

export const COUNTDOWN_STEPS = ["3", "2", "1", "GO"] as const;
/** How long each step stays on screen, in seconds. */
export const COUNTDOWN_STEP_DURATION = 0.8;
/** Total length of the count-in, in seconds. */
export const COUNTDOWN_DURATION = COUNTDOWN_STEPS.length * COUNTDOWN_STEP_DURATION;

/** The step to show `elapsed` seconds into the count-in, or null once it's
 * over (the caller's cue to hand control to the player). */
export function countdownLabel(elapsed: number): string | null {
  const step = Math.floor(elapsed / COUNTDOWN_STEP_DURATION);
  return step < COUNTDOWN_STEPS.length ? COUNTDOWN_STEPS[step]! : null;
}
