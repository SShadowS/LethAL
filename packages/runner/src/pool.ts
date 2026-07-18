/**
 * Round-robin so that a run of expensive items lands on different workers
 * rather than all in one contiguous block. Deterministic: verdicts must not
 * depend on how work was distributed.
 */
export function shardEvenly<T>(items: readonly T[], workers: number): T[][] {
  const n = Math.max(1, workers);
  const shards: T[][] = Array.from({ length: n }, () => []);
  for (const [i, item] of items.entries()) {
    const target = shards[i % n];
    if (target !== undefined) target.push(item);
  }
  return shards;
}

/**
 * Bounds genuinely expensive operations (transpile/compile) independently of
 * worker count. Worker count says how many mutants are in flight; it must not
 * silently become compile concurrency, because `alc` is CPU-bound.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly permits: number) {
    if (permits < 1) {
      throw new Error(`Semaphore requires permits >= 1, got ${permits}`);
    }
  }

  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // `while`, not `if`: a release can wake a waiter (via `next()` in the
    // `finally` below) and resolve its promise, but that waiter doesn't
    // actually run again until the next microtask tick. If a fresh caller's
    // `run()` arrives synchronously in between — sees the same
    // `active >= permits` snapshot the released slot was meant for — an
    // `if` would let BOTH the woken waiter and the fresh caller proceed past
    // the gate, pushing `active` one over `permits`. Re-checking in a loop
    // means a caller that wakes up always re-validates against the current
    // `active` count before incrementing it.
    while (this.active >= this.permits) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next !== undefined) next();
    }
  }
}
