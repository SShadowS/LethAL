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
 * Test seams: `clock.mono` and `clock.boot` may be replaced and must be restored.
 */
import { readFileSync } from "node:fs";

export const clock = {
  mono: (): number => Math.floor(performance.now()),
  /** PR-252 amendment 2: CLOCK_BOOTTIME in ms (it counts suspend); `undefined` where it cannot be read. */
  boot: (): number | undefined => readBootMs(),
};

/** `/proc/uptime`'s first field (seconds since boot, suspend included) in ms, or `undefined`. */
export function readBootMs(
  read: () => string = () => readFileSync("/proc/uptime", "utf8"),
): number | undefined {
  try {
    const s = Number(read().split(/\s+/)[0]);
    return Number.isFinite(s) && s > 0 ? Math.floor(s * 1000) : undefined;
  } catch {
    return undefined;
  }
}

export const monoNow = (): number => clock.mono();

/** PR-252: the wall-minus-monotonic gap must grow by MORE than this between two samples to count as a suspend. */
export const SUSPEND_THRESHOLD_MS = 30_000;

/** The `run-suspended` warning text; the TIMING fold reads N back with `SUSPEND_SECONDS`. */
export const suspendMessage = (seconds: number, atIso: string): string =>
  `[lethal] the machine was suspended (or its clock stepped) for ${seconds} s at ${atIso}; durations and deadlines exclude it (monotonic clock)`;
export const SUSPEND_SECONDS = /clock stepped\) for (\d+) s at /;

/**
 * PR-252: samples `ref - monotonic`. A suspend stops the monotonic clock and not `ref`, so the gap grows
 * by the suspended time. Growth above the threshold is returned once; a smaller step, or a backward one,
 * moves the baseline and returns nothing. Sampled at each event (the caller's choice), so a suspend is
 * reported at the next event after it.
 * Amendment 2: `ref` is CLOCK_BOOTTIME (`clock.boot`) when it can be read at creation, so an NTP step of
 * the wall clock is not a suspend; otherwise the wall clock, where a forward time-sync step above the
 * threshold fires it too. The source is chosen once. A `ref` read that fails mid-run skips that sample.
 * Two suspends with no event between them read as one. `ref`, `mono` and `wall` are test seams.
 */
export function createSuspendWatch(
  ref: () => number | undefined = clock.boot() !== undefined
    ? () => clock.boot()
    : () => Date.now(),
  mono: () => number = monoNow,
  wall: () => number = () => Date.now(),
): { sample(): { readonly ms: number; readonly atWallMs: number } | undefined } {
  const first = ref();
  let gap = first === undefined ? undefined : first - mono();
  return {
    sample() {
      const r = ref();
      if (r === undefined) return undefined;
      const now = r - mono();
      const grew = gap === undefined ? 0 : now - gap;
      gap = now;
      return grew > SUSPEND_THRESHOLD_MS ? { ms: grew, atWallMs: wall() } : undefined;
    },
  };
}
