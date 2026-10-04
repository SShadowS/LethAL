/**
 * R-425: reading R-384's reach-filter state back out of a `lethal verify` JSON document. Pure: it
 * takes the parsed JSON and imports nothing at runtime, so a reader can use it without loading the
 * runner.
 *
 * The one rule: a missing field is UNKNOWN, never "off". Before verify schema v5 the report did not
 * record the filter at all (`predates-v5`, even if a field happens to be there); from v5 on, a
 * missing `reachFilter` means verify stopped before deciding it (`not-decided`). Narrowing is never
 * inferred from `testsRun`: a v4 report from before R-384 could never narrow and one from after it
 * could, and the JSON cannot tell them apart.
 */

/** The version that first records `reachFilter` and `results[].reachNarrowed`. */
export const FIRST_REACH_RECORDING_VERSION = 5;

/** Copies of verify-reach.ts's `REACH_FILTER_STATES` and `REACH_FILTER_OFF_REASONS`, kept here so
 *  this module has no runtime import; verify-read.test.ts pins them equal. */
export const READ_REACH_FILTER_STATES = ["on", "off"] as const;
export const READ_REACH_FILTER_OFF_REASONS = [
  "no-reach-filter",
  "coverage-mode-none",
  "coverage-mode-procedure",
  "coverage-mode-line",
  "coverage-mode-al-runner",
] as const;

export type ReachFilterReading =
  | { readonly state: "on" }
  | { readonly state: "off"; readonly reason: string }
  | { readonly state: "unknown"; readonly why: "predates-v5" | "not-decided" };

export type ReachNarrowing = "narrowed" | "not-narrowed" | "unknown";

function recordOf(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`verify-read.ts: ${what} is not an object`);
  }
  return v as Record<string, unknown>;
}

/** Whether R-384's reach filter ran, and when not, why; or that the document cannot say. */
export function reachFilterOf(doc: unknown): ReachFilterReading {
  const d = recordOf(doc, "the verify document");
  const version = d.verifySchemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("verify-read.ts: the document has no integer verifySchemaVersion");
  }
  if (version < FIRST_REACH_RECORDING_VERSION) return { state: "unknown", why: "predates-v5" };
  if (d.reachFilter === undefined) return { state: "unknown", why: "not-decided" };
  const f = recordOf(d.reachFilter, "reachFilter");
  if (f.state === "on") {
    if (f.reason !== undefined) {
      throw new Error("verify-read.ts: reachFilter is on but carries a reason");
    }
    return { state: "on" };
  }
  if (f.state === "off") {
    const reason = f.reason;
    if (
      typeof reason !== "string" ||
      !(READ_REACH_FILTER_OFF_REASONS as readonly string[]).includes(reason)
    ) {
      throw new Error(
        `verify-read.ts: reachFilter is off without a known reason (${JSON.stringify(reason)})`,
      );
    }
    return { state: "off", reason };
  }
  throw new Error(`verify-read.ts: reachFilter.state ${JSON.stringify(f.state)} is not on or off`);
}

/** Whether the filter left a new test out of this row's request, or that the document cannot say. */
export function reachNarrowingOf(doc: unknown, row: unknown): ReachNarrowing {
  if (reachFilterOf(doc).state === "unknown") return "unknown";
  const n = recordOf(row, "the result row").reachNarrowed;
  if (n === undefined) return "unknown";
  if (typeof n !== "boolean") {
    throw new Error(`verify-read.ts: reachNarrowed ${JSON.stringify(n)} is not a boolean`);
  }
  return n ? "narrowed" : "not-narrowed";
}

/**
 * The new tests the filter left out of this row's request, or `undefined` unless the row reads
 * `narrowed`. Derived, not stored: each unfiltered request is the covering tests plus every new
 * test, and the filter drops only new tests, so the list is `newTests[].test` minus `testsRun`.
 */
export function droppedNewTestsOf(doc: unknown, row: unknown): string[] | undefined {
  if (reachNarrowingOf(doc, row) !== "narrowed") return undefined;
  const testsRun = recordOf(row, "the result row").testsRun;
  if (!Array.isArray(testsRun)) {
    throw new Error("verify-read.ts: a narrowed row has no testsRun");
  }
  const newTests = recordOf(doc, "the verify document").newTests;
  if (!Array.isArray(newTests)) throw new Error("verify-read.ts: the document has no newTests");
  const sent = new Set(testsRun);
  return newTests
    .map((t) => recordOf(t, "a newTests entry").test)
    .filter((t): t is string => {
      if (typeof t !== "string") throw new Error("verify-read.ts: a newTests entry has no test");
      return !sent.has(t);
    });
}
