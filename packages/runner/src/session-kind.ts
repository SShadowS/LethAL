/**
 * PR-307 (R1168): which tests can change with the SESSION KIND (a client session, `GuiAllowed` true, or a headless one,
 * `GuiAllowed` false), and the `ciSessionKind` setting that says which kind the user's own CI runs. Labels only: no verdict
 * path reads any of it.
 *
 * - H (every backend): a discovered test whose `[Test]` attribute run binds `HandlerFunctions(...)`. Across `#if` arms the
 *   handlers are a union, so a compiled-out arm's handlers count (safe: it labels more, never fewer).
 * - T (al-runner-v3 only): the TestPage scan refuses the test. On bcdev such a test is already refused and labelled.
 * - U (al-runner-v3 only): the scan could not read the test. Counted as sensitive, never silently as safe.
 */
import { normalizeAlName } from "@lethal/engine";
import type { TestMethodRef } from "./backend";
import { testKeyOf } from "./selection";
import { type TestAppModel, analyzeTestPageModel } from "./testpage-scan";

export const SESSION_KINDS = ["client", "headless"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export type SessionKindReason = "handlers" | "testpage" | "unreadable";

export interface SessionKindSensitiveTest {
  /** `Codeunit.method`. */
  readonly test: string;
  readonly reasons: readonly SessionKindReason[];
  /** The scan's own text, present when `reasons` holds `unreadable`. */
  readonly scanError?: string;
}

/** An unset setting with at least one sensitive test: refused before anything runs. */
export class SessionKindUnsetError extends Error {
  constructor(
    readonly sensitive: readonly SessionKindSensitiveTest[],
    readonly configPath: string | undefined,
  ) {
    const examples = sensitive
      .slice(0, 5)
      .map((s) => `${s.test} (${s.reasons.join(", ")})`)
      .join("; ");
    super(
      `session-kind-unset: "ciSessionKind" is not set, and ${sensitive.length} test(s) in this run can give a different result in a client session than in a headless one (for example: ${examples}). Say which kind your CI runs: add "ciSessionKind": "client" (or "headless") to ${configPath ?? "lethal.config.json"} (PR-307).`,
    );
    this.name = "SessionKindUnsetError";
  }
}

/** The one validation of the config's `ciSessionKind`: absent is `undefined`; any other bad value is refused by name. */
export function validateCiSessionKind(
  raw: unknown,
  where = "lethal.config.json",
): SessionKind | undefined {
  if (raw === undefined) return undefined;
  if (raw === "client" || raw === "headless") return raw;
  throw new Error(
    `invalid-ci-session-kind: ${where} "ciSessionKind" must be "client" or "headless", got ${JSON.stringify(raw)} (PR-307).`,
  );
}

/** What the backend's session is: bcdev is headless (an ODataV4 call); al-runner-v3 runs a client unless `noClient`. */
export function backendSessionKind(backend: {
  readonly bcdev: boolean;
  readonly noClient?: boolean;
}): SessionKind {
  return backend.bcdev || backend.noClient === true ? "headless" : "client";
}

/** H: the discovered test's own declarations bind a handler. */
function bindsHandlers(model: TestAppModel, t: TestMethodRef): boolean {
  const name = normalizeAlName(t.method);
  return model.units
    .filter((u) => u.id === t.codeunitId)
    .some((u) => u.procs.some((p) => p.name === name && p.params === 0 && p.handlers.length > 0));
}

/** The sensitive tests among `tests` (the run's FINAL list), in list order. */
export function sessionKindSensitiveTests(
  model: TestAppModel,
  tests: readonly TestMethodRef[],
  /** True on al-runner-v3 (T and U apply); false on bcdev (H only). */
  withTestPageScan: boolean,
): SessionKindSensitiveTest[] {
  const scan = withTestPageScan ? analyzeTestPageModel(model, tests) : undefined;
  const out: SessionKindSensitiveTest[] = [];
  for (const t of tests) {
    const key = testKeyOf(t);
    const reasons: SessionKindReason[] = [];
    if (bindsHandlers(model, t)) reasons.push("handlers");
    if (scan?.refused.has(key)) reasons.push("testpage");
    const errs = scan?.errorsByTest.get(key);
    if (errs !== undefined && errs.length > 0) reasons.push("unreadable");
    if (reasons.length === 0) continue;
    out.push({
      test: `${t.codeunitName}.${t.method}`,
      reasons,
      ...(errs !== undefined && errs.length > 0 ? { scanError: errs.join("; ") } : {}),
    });
  }
  return out;
}
