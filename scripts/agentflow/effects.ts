/**
 * The single seam every side effect passes through.
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`. The executor owns every
 * mutation; this is where "owns" stops being a promise in prose and becomes a type.
 *
 * ## Why effects are values rather than calls
 *
 * An `Effect` does nothing when constructed. It carries what it WOULD do, and only
 * {@link EffectRunner.run} performs it. That inversion is what makes the dry-run guarantee
 * testable: a test can build an entire tick's worth of effects and assert the disk, git, GitHub and
 * the containers were never touched, because touching them requires a runner that refused.
 *
 * The alternative, a set of methods that each remember to check a `dryRun` flag, is the shape
 * reviewers rejected in the design: proving "no write anywhere" then means auditing every method
 * rather than one runner, and a method added later is a hole nobody notices. Here a new effect
 * cannot bypass the check, because the only way to perform one is to hand it to the runner.
 *
 * ## Why every effect names an executor action
 *
 * The action names are the same closed vocabulary the HALT allowlist uses. So a halted run refuses
 * an effect for exactly the same reason and through exactly the same list that the kill switch is
 * written in, instead of two parallel notions of "what may happen now" that can drift apart.
 *
 * ## Why reads and writes are distinguished structurally
 *
 * `kind` is not documentation. It is what the dry run keys on. A write in a dry run is never
 * executed; a read always is, because reading is how the tick decides anything at all and a dry run
 * that could not read would report nothing useful.
 */

import { type ExecutorAction, assertPermittedUnderHalt } from "./halt.ts";

export type EffectKind = "read" | "write";

export interface Effect<T> {
  readonly kind: EffectKind;
  /** From the HALT vocabulary, so one list governs both the kill switch and this seam. */
  readonly action: ExecutorAction;
  /** Human-readable, for the ledger and for a dry run's plan. Must not carry a secret. */
  readonly describe: string;
  /**
   * What a dry run should return in place of performing this write. Absent means the caller has
   * not thought about it, and a dry run then refuses rather than inventing a value: a fabricated
   * result is how a dry run starts reporting outcomes it did not produce.
   */
  readonly dryRunResult?: T;
  /** Performs it. Called only by the runner, only once it has decided this is permitted. */
  readonly perform: () => Promise<T>;
}

/** A read. Always performed, including in a dry run. */
export function readEffect<T>(
  action: ExecutorAction,
  describe: string,
  perform: () => Promise<T>,
): Effect<T> {
  return { kind: "read", action, describe, perform };
}

/** A write. Never performed in a dry run; refused entirely when halted unless containment. */
export function writeEffect<T>(
  action: ExecutorAction,
  describe: string,
  perform: () => Promise<T>,
  dryRunResult?: T,
): Effect<T> {
  return {
    kind: "write",
    action,
    describe,
    perform,
    ...(dryRunResult !== undefined ? { dryRunResult } : {}),
  };
}

/** Thrown when an effect is refused. Never swallowed into a default result. */
export class EffectRefusedError extends Error {}

/** One line of what happened, or of what would have happened. */
export interface EffectRecord {
  readonly kind: EffectKind;
  readonly action: ExecutorAction;
  readonly describe: string;
  readonly outcome: "performed" | "skipped-dry-run";
}

export interface EffectRunnerOptions {
  readonly dryRun: boolean;
  /**
   * Re-read per effect rather than captured once. A HALT dropped mid-tick must take effect at the
   * next write, not at the next tick: the window between the two is where the writes a human meant
   * to stop actually happen.
   */
  readonly isHalted: () => boolean;
}

export class EffectRunner {
  private readonly log: EffectRecord[] = [];

  constructor(private readonly opts: EffectRunnerOptions) {}

  /** Everything this runner performed or declined, in order. The ledger's raw material. */
  get records(): readonly EffectRecord[] {
    return this.log;
  }

  /** Only what would have been written, which is what a dry run is asked to show. */
  get plannedWrites(): readonly EffectRecord[] {
    return this.log.filter((r) => r.kind === "write");
  }

  async run<T>(effect: Effect<T>): Promise<T> {
    // HALT first, before the dry-run branch. A halted dry run must still refuse a forbidden action
    // rather than quietly "planning" it, because the plan is what the next non-dry run executes.
    assertPermittedUnderHalt(effect.action, this.opts.isHalted());

    if (this.opts.dryRun && effect.kind === "write") {
      if (!("dryRunResult" in effect)) {
        throw new EffectRefusedError(
          `dry run cannot perform the write "${effect.describe}" (${effect.action}) and it declares no dryRunResult. Give it one, or do not reach this code path in a dry run. Inventing a result would make the dry run report an outcome it did not produce.`,
        );
      }
      this.log.push({
        kind: effect.kind,
        action: effect.action,
        describe: effect.describe,
        outcome: "skipped-dry-run",
      });
      return effect.dryRunResult as T;
    }

    const value = await effect.perform();
    this.log.push({
      kind: effect.kind,
      action: effect.action,
      describe: effect.describe,
      outcome: "performed",
    });
    return value;
  }
}
