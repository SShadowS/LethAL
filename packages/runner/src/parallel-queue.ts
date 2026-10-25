/**
 * R766 (b): the parallel mutant queue for the al-runner-v3 backend (`--workers N`), and its stop rule.
 *
 * Why the shapes below:
 * - The queue hands out PROCEDURE SCOPES (`procedureScopeOf`), never single mutants. The R197 kill
 *   ledger orders a mutant's tests by the kills seen so far in its scope, so all mutants of one scope run
 *   in manifest order on one lane and each reads exactly the ledger it reads at N = 1. Which lane takes
 *   which scope is timing; the verdicts are not.
 * - A finished mutant is not recorded at once. It waits until every mutant before it (manifest order)
 *   is recorded (`OrderedCommit`), so the records, the `mutant-scored` events and the store rows come in
 *   manifest order, as at N = 1. This is what lets a stop discard a mutant that FINISHED early but is
 *   later in the manifest than the one that stopped the session.
 * - The stop rule. The first latch (`batchBlind`, `entriesRefused`) or the first session-stopping throw
 *   closes the queue. Kept: the mutants that finished before it and come before the stopping mutant in
 *   manifest order, and the stopping mutant itself where N = 1 records it. Discarded, never recorded and
 *   never emitted: every other mutant, in flight or finished. The session then ends with an error that
 *   names the cause and the discarded mutants; it never reads green.
 */
import type { ExecutionBackend } from "./backend";

/** `--workers` above this is refused by name. */
export const MAX_V3_WORKERS = 8;

/** The owner side of a backend that can run lanes (`AlRunnerV3Backend`), found by shape. */
export interface V3ParallelOwner {
  lanes(n: number): ExecutionBackend[];
  laneMayStart(k: number): boolean;
  parallelRefusal(): string | undefined;
}

export function asParallelOwner(b: ExecutionBackend): V3ParallelOwner | undefined {
  const o = b as Partial<V3ParallelOwner>;
  return typeof o.lanes === "function" &&
    typeof o.laneMayStart === "function" &&
    typeof o.parallelRefusal === "function"
    ? (b as ExecutionBackend & V3ParallelOwner)
    : undefined;
}

/**
 * What a batch's baseline sees once lanes exist: the per-mutant calls (activate, run, ...) go to lane 0,
 * everything else to the owner. The baseline is lane 0's N = 1 baseline; lanes 1.. start after it.
 */
export function splitBackend(owner: ExecutionBackend, lane0: ExecutionBackend): ExecutionBackend {
  return {
    get killsMustReproduce() {
      return lane0.killsMustReproduce === true;
    },
    get inRunStopIsBudget() {
      return lane0.inRunStopIsBudget === true;
    },
    get inRunStopMs() {
      return lane0.inRunStopMs;
    },
    capabilities: () => owner.capabilities(),
    status: () => owner.status(),
    deploy: (dir) => owner.deploy(dir),
    compileCheck: (dir) => owner.compileCheck(dir),
    activate: (id) => lane0.activate(id),
    run: (ref, opts) => lane0.run(ref, opts),
    baselinePhase: (on) => owner.baselinePhase?.(on),
    noteReusedBaseline: (baseline) => owner.noteReusedBaseline?.(baseline),
    dependencyPackageDirs: () => owner.dependencyPackageDirs?.() ?? [],
    dependencyArtifactAppsDir: () => owner.dependencyArtifactAppsDir?.(),
    useCoveringBudgets: (id, budgets) => lane0.useCoveringBudgets?.(id, budgets),
    sendKillPair: (id, ref) => lane0.sendKillPair?.(id, ref) ?? Promise.resolve(),
    survivorNote: (covering) => lane0.survivorNote?.(covering),
  };
}

/** The first latch of the batch and the mutant behind it, or `undefined`. */
export type Latch = () => { readonly mutantId: string; readonly why: string } | undefined;

/** What the per-mutant loop of one lane talks to. */
export interface LaneSink {
  /** True once the queue is closed: the loop stops taking mutants. */
  readonly closed: boolean;
  /** The lane starts work on a mutant. */
  begin(mutantId: string): void;
  /**
   * The lane finished a mutant. `commit` writes its record; `stop` is the error the loop throws right
   * after (a session-stopping throw that follows the record). Synchronous: the keep-or-discard check
   * and the record happen with no await between them.
   */
  finish(mutantId: string, commit: () => void, stop?: Error): void;
  /** The loop ended the shard after this mutant because the session latched unsafe (N = 1's `break`). */
  unsafeBreak(mutantId: string): void;
}

/** The session-stopping error of a parallel run; `cause` is the first cause, `discarded` the mutant codes. */
export class ParallelStopError extends Error {
  constructor(
    readonly workers: number,
    readonly causeText: string,
    readonly discarded: readonly string[],
    readonly alsoSeen: readonly string[],
    cause?: unknown,
  ) {
    super(
      `al-runner-v3 --workers ${workers}: the session stopped: ${causeText}. ${
        discarded.length === 0
          ? "No mutant was discarded."
          : `${discarded.length} mutant(s) were in flight or finished after the stop and are NOT scored (their results are discarded, never recorded): ${discarded.join(", ")}.`
      }${alsoSeen.length > 0 ? ` Also seen: ${alsoSeen.join(" | ")}.` : ""} Only mutants that finished before the stop and come before the stopping one in manifest order are kept. Which stop comes first can depend on timing; --workers 1 runs in manifest order.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "ParallelStopError";
  }
}

interface StopInfo {
  /** Manifest index of the mutant behind the stop; -1 when it is not a mutant of this batch. */
  readonly selfIdx: number;
  /** The stopping mutant itself is recorded (as N = 1 does for a latch or a post-record throw). */
  readonly selfKept: boolean;
  readonly cause: string;
  readonly error?: Error;
  /** A stop that N = 1 also reaches without an error (the safety `break`): the session returns normally. */
  readonly benign?: boolean;
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

/** Records in manifest order, and the stop rule over them. */
export class OrderedCommit {
  private readonly index = new Map<string, number>();
  private readonly codes: readonly string[];
  /** Finished and waiting for its turn; `null` = nothing to record (an uncovered mutant). */
  private readonly pending = new Map<number, (() => void) | null>();
  private next = 0;
  private readonly started = new Set<number>();
  private readonly committed = new Set<number>();
  private stopInfo: StopInfo | undefined;
  private selfDone = false;
  private readonly also: string[] = [];

  constructor(
    codes: readonly string[],
    private readonly latch: Latch,
    private readonly workers: number,
  ) {
    this.codes = codes;
    for (const [i, c] of codes.entries()) this.index.set(c, i);
  }

  get closed(): boolean {
    return this.stopInfo !== undefined;
  }

  /** Mutants committed so far, by manifest index (for tests). */
  get committedCodes(): readonly string[] {
    return [...this.committed].sort((a, b) => a - b).map((i) => this.codes[i] ?? "?");
  }

  private idx(code: string): number {
    const i = this.index.get(code);
    if (i === undefined) throw new Error(`parallel queue: ${code} is not a mutant of this batch`);
    return i;
  }

  /** A mutant with nothing to run or record (uncovered, already recorded above). */
  markDone(code: string): void {
    this.pending.set(this.idx(code), null);
    this.flush();
  }

  /** One lane's face of the commit, and the mutant that lane is working on (for a throw). */
  laneSink(): { readonly sink: LaneSink; readonly current: () => string | undefined } {
    const owner = this;
    let current: string | undefined;
    const sink: LaneSink = {
      get closed() {
        return owner.closed;
      },
      begin: (code) => {
        this.started.add(this.idx(code));
        current = code;
      },
      finish: (code, commit, stop) => this.finish(code, commit, stop),
      unsafeBreak: (code) => this.unsafeBreak(code),
    };
    return { sink, current: () => current };
  }

  private flush(): void {
    if (this.stopInfo !== undefined) return;
    while (this.pending.has(this.next)) {
      const c = this.pending.get(this.next);
      this.pending.delete(this.next);
      if (c) {
        c();
        this.committed.add(this.next);
      }
      this.next += 1;
    }
  }

  private closeWith(info: StopInfo): void {
    if (this.stopInfo !== undefined) {
      this.also.push(info.cause);
      return;
    }
    this.stopInfo = info;
    // Kept: finished before the stop, and before the stopping mutant in manifest order.
    for (const i of [...this.pending.keys()].sort((a, b) => a - b)) {
      const c = this.pending.get(i);
      if (i < info.selfIdx || (i === info.selfIdx && info.selfKept)) {
        if (c) {
          c();
          this.committed.add(i);
        }
        if (i === info.selfIdx) this.selfDone = true;
      }
      this.pending.delete(i);
    }
  }

  private finish(code: string, commit: () => void, stop: Error | undefined): void {
    const i = this.idx(code);
    if (this.stopInfo === undefined) {
      const l = this.latch();
      if (l !== undefined) {
        this.latchStop(l, stop);
      } else if (stop !== undefined) {
        this.closeWith({ selfIdx: i, selfKept: true, cause: messageOf(stop), error: stop });
      } else {
        this.pending.set(i, commit);
        this.flush();
        return;
      }
    }
    const s = this.stopInfo;
    if (s !== undefined && i === s.selfIdx && s.selfKept && !this.selfDone) {
      this.selfDone = true;
      commit();
      this.committed.add(i);
    }
    // Any other mutant that finishes after the stop is discarded: it is never recorded.
  }

  private unsafeBreak(code: string): void {
    this.closeWith({
      selfIdx: this.idx(code),
      selfKept: true,
      cause: "the session latched unsafe",
      benign: true,
    });
  }

  /** A lane's loop threw while working on `code` (or on its unit's first mutant when none began). */
  fail(code: string | undefined, err: unknown): void {
    const s = this.stopInfo;
    if (s !== undefined) {
      if (s.error !== err) this.also.push(messageOf(err));
      return;
    }
    // A latch already set is the cause (the ruling names it), even if its mutant then throws.
    const l = this.latch();
    if (l !== undefined) {
      this.latchStop(l, err);
      return;
    }
    this.closeWith({
      selfIdx: code === undefined ? 0 : this.idx(code),
      selfKept: false,
      cause: messageOf(err),
      ...(err instanceof Error ? { error: err } : {}),
    });
  }

  private latchStop(l: { readonly mutantId: string; readonly why: string }, err?: unknown): void {
    const li = this.index.get(l.mutantId) ?? -1;
    this.closeWith({
      selfIdx: li,
      selfKept: li >= 0,
      cause: `the batch latched on ${l.mutantId}: ${l.why}`,
      ...(err instanceof Error ? { error: err } : {}),
    });
    // The error that follows is named once: `fail()` skips an error equal to the stop's own.
    if (err !== undefined) this.also.push(messageOf(err));
  }

  /** After every lane ended: nothing, or the stop as an error. */
  conclude(): void {
    const s = this.stopInfo;
    if (s === undefined) {
      this.flush();
      // A mutant that never reached finish/markDone would block every later record and read green.
      if (this.next !== this.codes.length) {
        const missing = this.codes.filter((_, i) => i >= this.next && !this.committed.has(i));
        throw new Error(
          `al-runner-v3 --workers ${this.workers}: ${missing.length} mutant(s) were never finished or recorded: ${missing.join(", ")}; refusing to read the session as complete (R766)`,
        );
      }
      return;
    }
    if (s.benign === true) return;
    const discarded = [...this.started]
      .filter((i) => !this.committed.has(i))
      .sort((a, b) => a - b)
      .map((i) => this.codes[i] ?? "?");
    throw new ParallelStopError(this.workers, s.cause, discarded, this.also, s.error);
  }
}

/**
 * Pulls whole units (procedure scopes) from one index closure; each unit is handed out exactly once.
 * Lane 0 always starts; a later lane starts only if `mayStart(k)` (the memory hold). All lanes are
 * awaited with `allSettled`, then the stop (if any) is thrown.
 * R785: with `pace`, `lanes` is an UPPER bound. After each finished unit (never at queue start, when no
 * cost is known) ONE more lane starts if the queued live units x lane 0's wall per live mutant is longer
 * than lane 0's warm-up. Only WHEN a lane starts changes; the queue order and the commit do not.
 * ponytail: `mayStart` is asked once per lane at launch; daemons start lazily, so the real memory
 * rises later. A staggered start (lane k after lane k-1's first request) if the hold proves too late.
 */
export async function runScopeQueue<M extends { readonly mutantId: string }>(o: {
  readonly units: readonly (readonly M[])[];
  readonly lanes: number;
  readonly mayStart: (k: number) => boolean;
  readonly commit: OrderedCommit;
  readonly isUnsafe: () => boolean;
  readonly runUnit: (lane: number, unit: readonly M[], sink: LaneSink) => Promise<void>;
  /** R785: when set, `lanes` is an upper bound and extra lanes start by `LanePace`'s rule. */
  readonly pace?: LanePace<M>;
}): Promise<{
  readonly started: number;
  readonly warmupMs: number;
  readonly reason: LaneReason;
}> {
  const pace = o.pace;
  const weights = o.units.map((u) => pace?.weight(u) ?? 0);
  let nextUnit = 0;
  let queuedW = weights.reduce((a, b) => a + b, 0);
  const take = (): readonly M[] | undefined => {
    if (o.commit.closed || o.isUnsafe() || nextUnit >= o.units.length) return undefined;
    queuedW -= weights[nextUnit] ?? 0;
    return o.units[nextUnit++];
  };
  const runners: Promise<void>[] = [];
  // Lane 0's finished live units: wall ms and live mutants. Its daemon was warmed before the queue,
  // so its units carry no warm-up (a later lane's first unit would).
  let costMs = 0;
  let costW = 0;
  let nextLane = 1;
  let started = 0;
  // Why the last evaluation started nothing more (the notice says it).
  let reason: LaneReason = o.lanes <= 1 ? "cap" : "unmeasured";
  // A real block (cost, memory, closed) stays the reason when the queue then drains.
  const because = (r: LaneReason): void => {
    if (reason !== "cost" && reason !== "memory" && reason !== "closed") reason = r;
  };
  /** R785: at most one extra lane per call, only while the queued live work is longer than one warm-up. */
  const evaluate = (): void => {
    if (pace === undefined) return;
    if (nextLane >= o.lanes) {
      reason = reason === "memory" ? reason : "cap";
      return;
    }
    if (o.commit.closed || o.isUnsafe()) {
      because("closed");
      return;
    }
    const warm = pace.warmupMs();
    if (costW === 0 || warm <= 0) {
      because("unmeasured");
      return;
    }
    if (queuedW <= 0) {
      because("drained");
      return;
    }
    if (queuedW * (costMs / costW) <= warm) {
      because("cost");
      return;
    }
    const k = nextLane++;
    if (!o.mayStart(k)) {
      nextLane = o.lanes; // the memory hold: stay at the lanes running
      reason = "memory";
    } else launch(k);
  };
  const launch = (k: number): void => {
    started += 1;
    const { sink, current } = o.commit.laneSink();
    runners.push(
      (async () => {
        for (let unit = take(); unit !== undefined; unit = take()) {
          const t0 = pace?.now() ?? 0;
          const w = pace?.weight(unit) ?? 0;
          const epoch0 = pace?.epoch?.();
          try {
            await o.runUnit(k, unit, sink);
          } catch (err) {
            o.commit.fail(current() ?? unit[0]?.mutantId, err);
            throw err;
          }
          // A unit that restarted lane 0's daemon carries a warm-up: it does not measure the work.
          if (pace !== undefined && k === 0 && w > 0 && pace.epoch?.() === epoch0) {
            costMs += pace.now() - t0;
            costW += w;
          }
          evaluate();
        }
      })(),
    );
  };
  launch(0);
  if (pace === undefined) {
    for (let k = 1; k < o.lanes; k++) if (o.mayStart(k)) launch(k);
  }
  // Lanes may start while others run: wait until no runner is left unawaited.
  const settled: PromiseSettledResult<void>[] = [];
  while (settled.length < runners.length) {
    settled.push(...(await Promise.allSettled(runners.slice(settled.length))));
  }
  o.commit.conclude();
  for (const s of settled) if (s.status === "rejected") throw s.reason;
  if (pace === undefined) reason = "cap";
  return { started, warmupMs: pace?.warmupMs() ?? 0, reason };
}

/** R785: why no more lanes started. */
export type LaneReason = "cap" | "memory" | "cost" | "drained" | "closed" | "unmeasured";

/** R785: the one-line notice text (without the code prefix). */
export function lanesNotice(
  started: number,
  asked: number,
  cap: number,
  reason: LaneReason,
  warmupMs: number,
): string {
  const why: Record<LaneReason, string> = {
    cap:
      cap < asked
        ? `memory allowed only ${cap} lanes and all of them started`
        : "all asked lanes started: queued live work stayed longer than one warm-up",
    memory: "the memory hold refused the next lane",
    cost: "the queued live work was not longer than one warm-up",
    drained: "the queue had no live work left",
    closed: "the queue closed (a stop or an unsafe session)",
    unmeasured: "no lane 0 live unit finished with a measured warm-up to give a cost",
  };
  return `${started} of ${asked} lanes started: ${why[reason]} (lane 0's warm-up ${(warmupMs / 1000).toFixed(1)} s)`;
}

/** R785: what `runScopeQueue` needs to decide when an extra lane pays. */
export interface LanePace<M> {
  /** Lane 0's own measured warm-up in ms; 0 while it is not measured (then no extra lane starts). */
  readonly warmupMs: () => number;
  /** Live calls a unit still needs: a prefetched mutant counts 0. */
  readonly weight: (unit: readonly M[]) => number;
  readonly now: () => number;
  /** Lane 0's daemon-start count: a unit during which it changes carried a warm-up and gives no cost. */
  readonly epoch?: () => number;
}
