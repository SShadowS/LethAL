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
import { normalizeAlName, parseAL, visit, wrapRoot } from "@lethal/engine";
import { OPENING_METHODS } from "./testpage-scan";

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
 * R909: Linux BC reports the same refusal as a plain CLR exception with NO .NET frame:
 *
 *     Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not supported.
 *     <Object>(CodeUnit <id>).<Proc> line <K> - <App> by <Publisher> version <v>;Test Runner - Mgt(...)...
 *
 * That message alone is NOT a page refusal (any CLR code can throw it), so it is named only when the
 * TOP AL frame resolves, in source LethAL has, to a page-opening call. A frame in code LethAL has no
 * source for (a dependency) stays unnamed. Like the Windows case this is a note, never a verdict.
 */
const LINUX_CLR_MESSAGE =
  "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not supported.";
/** `Name(Kind id).Proc line K`; `Proc` may be `OnRun(Trigger)`. Only the first frame is read. */
const TOP_FRAME = /^(.*?)\(([A-Za-z]+) (\d+)\)\.(.+?) line (\d+)\b/;
/** BC's line is relative to the procedure's first line and runs one or two off (measured, R-908). */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 1;
/** Opening calls on any receiver (the reader's own list, plus `RunModal`); `Run` only on `Page`. */
const LINUX_OPENERS = new Set([...OPENING_METHODS, "runmodal"]);

/** The source texts of the files that declare object `kind` `id`: the test app's and the target's. */
export type FrameSourceLookup = (kind: string, id: number) => readonly string[];

/** A lookup over `texts`. A cheap text filter picks the files to parse; only those are parsed. */
export function frameSourceLookup(texts: readonly string[]): FrameSourceLookup {
  return (kind, id) =>
    texts.filter((t) => new RegExp(`^[ \\t]*${kind}[ \\t]+${id}\\b`, "im").test(t));
}

/** Each opening call's row inside the procedure or trigger `proc`, minus the row of its name. */
function openingCallOffsets(source: string, kind: string, id: number, proc: string): number[] {
  const wantTrigger = proc.endsWith("(Trigger)");
  const want = normalizeAlName(wantTrigger ? proc.slice(0, -"(Trigger)".length) : proc);
  const out: number[] = [];
  const root = wrapRoot(parseAL(source));
  visit(root, (obj) => {
    if (obj.rawKind !== `${kind.toLowerCase()}_declaration`) return;
    if (Number(obj.namedChildren.find((c) => c.rawKind === "integer")?.text) !== id) return;
    visit(obj, (m) => {
      if (m.rawKind !== (wantTrigger ? "trigger_declaration" : "procedure")) return;
      const name = m.namedChildren.find(
        (c) => c.rawKind === "identifier" || c.rawKind === "quoted_identifier",
      );
      if (name === undefined || normalizeAlName(name.text.replace(/^"|"$/g, "")) !== want) return;
      visit(m, (c) => {
        if (c.rawKind !== "call_expression") return;
        const fn = c.childForFieldName("function");
        if (fn === null || fn.rawKind !== "member_expression") return;
        const [recv, member] = fn.namedChildren;
        const method = normalizeAlName(member?.text ?? "");
        const opens =
          LINUX_OPENERS.has(method) ||
          (method === "run" && normalizeAlName(recv?.text ?? "") === "page");
        if (opens) out.push(c.startPosition.row - name.startPosition.row);
      });
    });
  });
  return out;
}

/**
 * R909: names Linux BC's page-open failure, or returns `undefined`. Needs the exact CLR message on
 * line one AND a top AL frame whose procedure (or trigger) has a page-opening call within
 * K-2..K+1 lines of its first line, read from the parse. No source for the frame: `undefined`.
 */
export function describeLinuxPageRefusal(
  failureText: string | undefined,
  lookup: FrameSourceLookup | undefined,
): string | undefined {
  if (failureText === undefined || lookup === undefined) return undefined;
  const [first, second] = failureText.split("\n");
  if (first?.trim() !== LINUX_CLR_MESSAGE || second === undefined) return undefined;
  const frame = (second.split(";")[0] ?? "").trim();
  const [, , kind, idText, proc, lineText] = TOP_FRAME.exec(frame) ?? [];
  if (kind === undefined || idText === undefined || proc === undefined || lineText === undefined)
    return undefined;
  const id = Number(idText);
  const k = Number(lineText);
  for (const text of lookup(kind, id)) {
    const hit = openingCallOffsets(text, kind, id, proc).some(
      (o) => o >= k - WINDOW_BEFORE && o <= k + WINDOW_AFTER,
    );
    if (hit)
      return `${TESTPAGE_DIAGNOSIS} BC's own words: "${LINUX_CLR_MESSAGE}" Top frame: ${frame.split(" - ")[0]}`;
  }
  return undefined;
}

/** Windows text first (it needs no source), then the Linux shape; the one both call sites use. */
export function describeTestPageRefusal(
  failureText: string | undefined,
  lookup: FrameSourceLookup | undefined,
): string | undefined {
  return describeTestPageUnsupported(failureText) ?? describeLinuxPageRefusal(failureText, lookup);
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

/**
 * R-236c: the failure text of a test LethAL refused BEFORE sending, because it has a reachable call
 * that may open a TestPage. An exact prefix, like the stale-test-app sentinel, so classification
 * reads the VERDICT: a resumed baseline recorded before this existed keeps BC's own refusal. It
 * must never contain the text `describeTestPageUnsupported` or the permission regexes match.
 */
export const TESTPAGE_NOT_RUN_PREFIX =
  "not run: LethAL refused this test before sending it, because it has a reachable call that may open a TestPage";

export function testPageNotRunMessage(reason: string): string {
  return `${TESTPAGE_NOT_RUN_PREFIX} (${reason}).`;
}

export function isTestPageNotRunMessage(text: string | undefined): boolean {
  return text?.startsWith(TESTPAGE_NOT_RUN_PREFIX) ?? false;
}

export const TESTPAGE_REFUSED_DIAGNOSIS =
  "LethAL did not send these tests. Each one has a reachable call that may open a TestPage, found " +
  "by reading the test source before the run: the test, or a procedure it can call in the test app, " +
  "calls OpenView, OpenEdit, OpenNew or Trap on a TestPage, or calls one of those names on a " +
  "receiver the scanner cannot resolve, or makes a call inside a `with` statement it cannot resolve. " +
  "This is a safety-first static policy: conditions are not evaluated, so a call behind " +
  "`if GuiAllowed then`, which would not run here, is refused too. The session LethAL runs tests " +
  "in (GuiAllowed=No, ClientType=ODataV4) cannot run a TestPage, and sending one got at best BC's refusal and at worst a lost reply that left the BC " +
  "server unable to answer until restarted (R236). These tests are not in the green set, so a " +
  "mutant only they would reach is reported no-coverage: no test LethAL RAN reaches it, which is " +
  "not the same as no test in your suite, and a guarded test may have lost a kill. Each test's " +
  "failure text names the call path it was refused for. Not detected, and sent as before: a page " +
  "opened by the code under test and handled through a handler function, a helper outside the " +
  "test app or in a non-codeunit object, a call through Codeunit.Run, an event subscriber or " +
  "interface dispatch, and a bare zero-argument call written without parentheses in expression " +
  "position (for example `B := Helper;`).";
