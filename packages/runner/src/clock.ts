/**
 * PR-252: the clock for every DURATION and DEADLINE in the runner. Monotonic (`performance.now()`),
 * so a wall-clock step (NTP, VM resume) cannot lengthen, shorten or negate a measured interval or
 * fire a deadline early. Whole milliseconds, like the older `transportClock` (run-mutant-transport.ts).
 * It also excludes time the machine spent suspended (Linux CLOCK_MONOTONIC): the right behaviour.
 * On Windows `performance.now()` may count sleep, so no suspend is detected there and durations
 * include it (harmless; al-runner v3 refuses Windows anyway).
 * One monotonic clock: `transportClock` (run-mutant-transport.ts) reads `clock.mono` too.
 *
 * `Date.now()` stays for TIMESTAMPS: moments written to a store, report or event, or compared with
 * other processes' times (file mtimes, version minting). Never subtract two of those.
 *
 * Test seam: `clock.mono` may be replaced and must be restored.
 */
export const clock = { mono: (): number => Math.floor(performance.now()) };

export const monoNow = (): number => clock.mono();

/** PR-252: the wall-minus-monotonic gap must grow by MORE than this between two samples to count as a suspend. */
export const SUSPEND_THRESHOLD_MS = 30_000;

/** The `run-suspended` warning text; the TIMING fold reads N back with `SUSPEND_SECONDS`. */
export const suspendMessage = (seconds: number, atIso: string): string =>
  `[lethal] the machine was suspended (or its clock stepped) for ${seconds} s at ${atIso}; durations and deadlines exclude it (monotonic clock)`;
export const SUSPEND_SECONDS = /clock stepped\) for (\d+) s at /;

/**
 * PR-252: samples `wall - monotonic`. A suspend stops the monotonic clock and not the wall clock, so the
 * gap grows by the suspended time. Growth above the threshold is returned once; a smaller step, or a
 * backward one, moves the baseline and returns nothing. Sampled at each event (the caller's choice),
 * so a suspend is reported at the next event after it. `wall` and `mono` are test seams.
 * Limits: a forward time-sync step above the threshold fires it too (it cannot be told from a
 * suspend), and two suspends with no event between them read as one.
 */
export function createSuspendWatch(
  wall: () => number = () => Date.now(),
  mono: () => number = monoNow,
): { sample(): { readonly ms: number; readonly atWallMs: number } | undefined } {
  let gap = wall() - mono();
  return {
    sample() {
      const atWallMs = wall();
      const now = atWallMs - mono();
      const grew = now - gap;
      gap = now;
      return grew > SUSPEND_THRESHOLD_MS ? { ms: grew, atWallMs } : undefined;
    },
  };
}
