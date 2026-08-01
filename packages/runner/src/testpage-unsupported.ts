/**
 * R69 — naming the one refusal a target suite cannot do anything about.
 *
 * WHY THIS EXISTS. R58 made the fenced session (`GuiAllowed=No`, `ClientType=ODataV4`) the default
 * for the BASELINE as well as for the mutants. A test that opens a `TestPage` cannot run there: the
 * platform refuses to build the test service the TestPage is a handle onto. MEASURED 2026-07-31 on
 * Cronus281 (`fixtures/sandbox-probes`, codeunit 79218), and the measurement CORRECTED the row —
 * this is a FAST refusal (87 ms), not the hang R69 was originally filed as:
 *
 *     Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not
 *     supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()
 *
 * Before this, those tests were reported only as "did not pass at baseline". On a real suite that
 * is N unexplained baseline failures — 9 of Continia Document Output's 104 test files declare a
 * `TestPage` — and it sends the reader to debug tests that are entirely correct.
 *
 * HOW IT DIFFERS FROM R35, which is the whole reason it is a separate category rather than another
 * branch of `describeTestPermissionsRefusal`. R35's refusal has a one-line fix in the reader's OWN
 * SOURCE (`TestPermissions = Disabled`). This one has NO target-side fix: the test is fine and the
 * execution path cannot run it. Folding the two together would put a fixable problem under a
 * heading that says nothing can be done, or the reverse — either way the reader acts on a false
 * statement. `unsupportedCoverageNote` therefore lets the ACTIONABLE cause win when a mutant is
 * covered by one of each.
 *
 * WHAT IT IS AND IS NOT. A DIAGNOSIS ATTACHED TO AN EXISTING FAILURE, exactly like R35's. It never
 * decides a verdict, never suppresses a failure, and is never consulted anywhere that could turn a
 * `killed` into a `survived`. The direction stays safe: the affected tests drop out of the green
 * set, and mutants covered only by them are excluded from the score rather than scored wrongly.
 *
 * KNOWN LIMITATION, shared with R35 and filed the same way: this reads platform text. The anchor
 * (`CreateNavTestService`) is a .NET member name rather than English prose, so it should survive
 * localization where R35's English regex does not (R66) — but that is REASONED, not measured, and
 * must not be claimed as a property until a localized server has been probed.
 */

/**
 * BC's TestPage refusal as it appears in a failing test line's `message`.
 *
 * Anchored on `CreateNavTestService` — the mechanism itself, and the token that makes this refusal
 * distinguishable from every other `NotSupportedException`. Matching on "not supported" alone would
 * claim unrelated CLR failures.
 *
 * `[^\n]*` on the left stops at the line start, which matters because `failureMessage` is `message`
 * + "\n" + `stackTrace`: a greedy `.*` would drag stack frames into the quote (the same trap
 * `PERMISSIONS_REFUSAL_RE` documents).
 */
const TESTPAGE_REFUSAL_RE = /[^\n]*\bCreateNavTestService\b[ \t]*\([ \t]*\)/;

/**
 * Names the cause when a baseline test was refused because it opens a `TestPage` on a session type
 * that cannot create a test service.
 *
 * Returns `undefined` when there is nothing to read (`failureText` absent — a legitimate state; a
 * failing test line need not carry a message) or when the text does not carry this refusal. Both
 * are honestly "no diagnosis", never a defaulted one; callers append only when a string comes back.
 */
export function describeTestPageUnsupported(failureText: string | undefined): string | undefined {
  if (failureText === undefined) return undefined;
  const match = TESTPAGE_REFUSAL_RE.exec(failureText);
  if (match === null) return undefined;
  const quoted = match[0]?.trim();
  if (quoted === undefined || quoted === "") return undefined;
  return `${TESTPAGE_DIAGNOSIS} BC's own words: "${quoted}"`;
}

/**
 * The shared explanation, exported so the session-level report and the per-mutant note state the
 * same thing rather than drifting into two accounts of one fact.
 *
 * Deliberately carries NO "declare X and re-run" instruction. There is no such fix, and inventing
 * one would send a reader to edit a test that is already correct.
 */
export const TESTPAGE_DIAGNOSIS =
  "this test opens a TestPage, which the fenced session cannot run: LethAL executes tests in a " +
  "GuiAllowed=No, ClientType=ODataV4 session (R57/R58) and BC refuses to create a test service " +
  "there, immediately (measured at 87 ms — a refusal, not a hang). This is a property of the " +
  "EXECUTION PATH, not of your test: no change to the test or its declarations makes it run here. " +
  "The affected tests are dropped from the green set, so mutants covered only by them are excluded " +
  "from the score rather than scored against tests that never ran.";
