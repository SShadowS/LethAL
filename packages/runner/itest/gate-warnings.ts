/**
 * R736: every live gate that calls `runSession` collects the run's `warning` events and checks the
 * SORTED, DE-DUPLICATED set of warning CODES against a committed expectation (`GATE_WARNINGS` in
 * `gate-expected.ts`). Codes only: messages carry ids and versions and are never compared.
 *
 * The gate never writes the expectation (R332's rule). To fill one in: run the gate with
 * `LETHAL_ITEST_OBSERVE_WARNINGS=1`, explain each code, pre-commit the set, then add it to
 * `GATE_WARNINGS` by hand. An observe run asserts nothing about warnings and always ends as a
 * non-pass (exit 3, a failed receipt), exactly as a baseline record run does.
 */
import type { EventSubscriber } from "../src/events";
import { GATE_WARNINGS } from "./gate-expected";

export const OBSERVE_WARNINGS_ENV = "LETHAL_ITEST_OBSERVE_WARNINGS";

/** Thrown when the observed codes differ from the committed set. */
export class GateWarningsMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateWarningsMismatchError";
  }
}

/** Thrown when a gate leg has no committed warning set. */
export class GateWarningsUnrecordedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateWarningsUnrecordedError";
  }
}

/** Thrown at the end of an observe run: never a pass. The gate exits 3. */
export class WarningsObservedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarningsObservedError";
  }
}

/** True when observe mode is on. Any value other than unset, empty or "1" throws. */
export function observeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OBSERVE_WARNINGS_ENV];
  if (raw === undefined || raw === "") return false;
  if (raw === "1") return true;
  throw new Error(
    `${OBSERVE_WARNINGS_ENV}=${JSON.stringify(raw)} is not valid. Set it to 1, or unset it.`,
  );
}

export interface WarningCollector {
  readonly subscriber: EventSubscriber;
  /** Sorted, unique codes seen so far. */
  codes(): string[];
  /** One example message per code. */
  examples(): Readonly<Record<string, string>>;
}

export function collectWarnings(): WarningCollector {
  observeRequested(); // refuse a bad value before the run, not after
  const first = new Map<string, string>();
  return {
    subscriber: (event) => {
      if (event.type === "warning" && !first.has(event.code)) first.set(event.code, event.message);
    },
    codes: () => [...first.keys()].sort(),
    examples: () => Object.fromEntries(first),
  };
}

export function assertGateWarnings(
  gate: string,
  leg: string,
  observed: readonly string[],
  expected: readonly string[] | undefined,
): void {
  const key = `${gate}/${leg}`;
  if (expected === undefined) {
    throw new GateWarningsUnrecordedError(
      `${key}: no committed warning set (GATE_WARNINGS["${key}"] in gate-expected.ts). Observed ${JSON.stringify(observed)}. Record it by hand: run the gate with ${OBSERVE_WARNINGS_ENV}=1, explain each code, pre-commit the set, then add it to GATE_WARNINGS. The gate never records it itself.`,
    );
  }
  const obs = new Set(observed);
  const exp = new Set(expected);
  const extra = [...obs].filter((c) => !exp.has(c)).sort();
  const missing = [...exp].filter((c) => !obs.has(c)).sort();
  if (extra.length === 0 && missing.length === 0) return;
  throw new GateWarningsMismatchError(
    `${key}: warning codes differ from the committed set. Extra: ${JSON.stringify(extra)}. Missing: ${JSON.stringify(missing)}. Observed: ${JSON.stringify([...obs].sort())}.`,
  );
}

/** Observe mode: print the line and one example per code. Asserts nothing. */
export function printObserved(gate: string, leg: string, w: WarningCollector): void {
  console.log(`[gate-warnings] ${gate}/${leg}: ${JSON.stringify(w.codes())}`);
  for (const [code, message] of Object.entries(w.examples())) {
    console.log(`[gate-warnings]   ${code}: ${message}`);
  }
}

/** Call after each runSession: assert the leg's set, or print it in observe mode. */
export function checkGateWarnings(
  gate: string,
  leg: string,
  w: WarningCollector,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (observeRequested(env)) {
    printObserved(gate, leg, w);
    return;
  }
  assertGateWarnings(gate, leg, w.codes(), GATE_WARNINGS[`${gate}/${leg}`]);
}

/** Call after each runSession of a leg whose set is not pinned yet: prints in observe mode only. */
export function observeGateWarnings(
  gate: string,
  leg: string,
  w: WarningCollector,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (observeRequested(env)) printObserved(gate, leg, w);
}

/**
 * The gate's last step. An observe run throws (the gate's catch exits 3 with a failed receipt);
 * otherwise `emitPass` writes the pass receipt.
 */
export async function finishGate(
  emitPass: () => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (observeRequested(env)) {
    throw new WarningsObservedError(
      `observe run (${OBSERVE_WARNINGS_ENV}=1): warning sets printed, none asserted. This is never a pass. Add the explained sets to GATE_WARNINGS and re-run without the variable.`,
    );
  }
  await emitPass();
}

/** The exit code a gate's catch uses for this error, or `otherwise`. */
export function nonPassExit(err: unknown, otherwise: number): number {
  return err instanceof WarningsObservedError ? 3 : otherwise;
}
