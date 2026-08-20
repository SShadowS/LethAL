import type { ActivationConfig, FetchFn } from "./activation";

/**
 * The permissions module. Two halves, one subject:
 *
 * 1. `runPermissionCanary` / `permissionCanaryWarnings` — ROADMAP R26's per-session canary, a
 *    PRECONDITION CHECK on the server this session is running against.
 * 2. `describeTestPermissionsRefusal` — the diagnosis attached when a TARGET suite's own test is
 *    refused by BC's permission system, which is the condition operators actually hit.
 *
 * WHAT THE CANARY ASKS NOW, AND WHY IT CHANGED. It was built on a diagnosis that direct measurement
 * has since DISPROVED. The belief was that Microsoft's Permissions Mock (codeunit 131006, toggled
 * by `Test Runner - Mgt` 130454's `PlatformBeforeTestRun` -> `StartStopPermissionMock`) strips a
 * test body's permissions specifically on LethAL's FENCED path (`RunMutant` ->
 * `Test Suite Mgt.RunAllTests`), so a project could score differently on two servers depending on
 * whether that Microsoft app was installed. It does not.
 *
 * MEASURED A/B on ONE property (2026-07-26): two probe codeunits identical except for
 * `TestPermissions`, same app, same tables, same server, mock running in BOTH arms — omitted (i.e.
 * Restrictive, the AL default) is REFUSED, `TestPermissions = Disabled` SUCCEEDS. The invocation
 * path is not the variable; the declaration on the test codeunit is. `continia test run` reaches
 * the same 130454 runner with the mock started, exactly as `RunMutant` does, and refuses a
 * Restrictive codeunit there too. So the canary now asks the honest, WEAKER question:
 *
 *     CAN A CORRECTLY-DECLARED TEST CODEUNIT (`TestPermissions = Disabled`) WRITE A TABLE OF ITS
 *     OWN APP ON THIS SERVER?
 *
 * Expected answer `"not-mocked"` on every server we have. It is worth asking because it is what
 * would catch Microsoft changing the rule so that even a `Disabled` codeunit is stripped — the one
 * future in which fenced runs start losing kills for a reason no target-side declaration can fix.
 * It is NOT a scoring caveat any more, and the warning lines say so.
 *
 * The server-side probe (`extensions/lethal-control`: table 91008 "LC Permission Probe", codeunit
 * 91010 "LC Permission Canary", carried out on codeunit 91009 "LC Permission Canary State") runs
 * through the SAME `LC Run Method` / `Test Suite Mgt.RunAllTests` mechanism `RunMutant` uses — a
 * canary travelling a different path than the thing it characterises measures nothing. Codeunit
 * 91010 declares `TestPermissions = Disabled` (without it the canary measures its OWN declaration
 * and reports `"mocked"` on every server), and the probe table deliberately has NO
 * `InherentPermissions`, unlike every one of its siblings (with it, the write could never fail and
 * the light could never turn red). Read both AL doc comments before touching either object.
 *
 * "Same path" has to be true all the way down to the write itself, and that is not free: the first
 * live proof (Cronus282, control app 1.0.0.3) came back `observed:false` because the probe's
 * `Insert` sat inside a `[TryFunction]`, which BC refuses under `RunTests` with a contract error
 * that the `[TryFunction]` does not even catch — so the canary measured its own call shape and
 * never reached permissions at all. The AL side now uses a plain, unwrapped `Insert` and records
 * in two stages around it. If a `detail` ever surfaces "not allowed inside the call to 'RunTests'"
 * again, that is the AL side having drifted back off the path, not a property of the server.
 *
 * This module is the client half. It is modelled directly on `al-runner-canary.ts` (R7/R8), whose
 * shape it follows on purpose, including its hardest-won lesson: a verdict printed once at session
 * start scrolls past on a long run, so the result is persisted on `SessionReport` and repeated by
 * `renderConsole` after the score.
 *
 * INCONCLUSIVE IS NOT "NOT MOCKED". Every way the measurement can fail to happen at all — an older
 * control app with no such action published (HTTP 404), a transport failure, a body that does not
 * parse, a response missing the fields the contract guarantees, the canary test never recording an
 * observation — resolves to `"inconclusive"` WITH the reason attached, never to `"not-mocked"`.
 * Collapsing "we could not tell" into "everything is fine" is this project's signature bug
 * (empty-vs-empty reads as a match), and it is exactly the bug a canary is most likely to grow.
 * Correspondingly, nothing here ever aborts a session: `runPermissionCanary` does not throw.
 */

/**
 * `"mocked"` — this server strips a CORRECTLY-DECLARED test codeunit (`TestPermissions = Disabled`)
 * anyway: the probe's write flag is off AND its insert was refused. No server we have answers this;
 * it is the precondition-violated case. `"not-mocked"` — it does not (read, write, and a real
 * insert all succeeded), the expected answer. `"inconclusive"` — the measurement did not happen, or
 * came back self-contradictory; `detail` always says which.
 *
 * The verdict NAMES are historical (they date from the disproved fenced-path-vs-mock diagnosis) and
 * are deliberately unchanged: they are on the wire in `ControlApi.Codeunit.al`'s JSON, so renaming
 * them would silently desync a runner from a published control app. What they MEAN is above.
 */
export type PermissionCanaryVerdict = "mocked" | "not-mocked" | "inconclusive";

export interface PermissionCanaryResult {
  readonly verdict: PermissionCanaryVerdict;
  /**
   * The raw observation, present ONLY when the server actually took one (`observed: true` on the
   * wire). Absent on every inconclusive-because-nothing-was-measured path — deliberately absent
   * rather than defaulted to `false`, since `read=false, write=false, insert=false` is
   * indistinguishable from a genuine `"mocked"` observation.
   */
  readonly readPermission?: boolean;
  readonly writePermission?: boolean;
  readonly insertSucceeded?: boolean;
  /**
   * The ATTRIBUTION context, measured server-side OUTSIDE the fence before the test ran, so it does
   * not depend on the test having worked and is present on every conclusive verdict (and on any
   * inconclusive one the server itself produced).
   *
   * `baselineWritePermission` is what stops a `"mocked"` verdict being unfalsifiable: the probe
   * table has no `InherentPermissions`, so ANY reason this session lacks write on it yields a
   * refused insert. If write is already absent outside the fence, the in-fence refusal says nothing
   * about the mock — the calling user simply does not hold the extension's permission set (the 5C-A
   * finding the sibling tables carry `InherentPermissions = RIMD` to work around), and the server
   * reports `"inconclusive"` rather than a permanently-red `"mocked"`.
   *
   * `mockInstalled` answers the question a `"mocked"` verdict actually claims: is codeunit 131006
   * ("Permissions Mock") even on this server? Read the same way `Test Runner - Mgt`'s own
   * `StartStopPermissionMock` reads it.
   */
  readonly baselineReadPermission?: boolean;
  readonly baselineWritePermission?: boolean;
  readonly mockInstalled?: boolean;
  /** The refused-insert error text (on `"mocked"`), or why the verdict is inconclusive. */
  readonly detail?: string;
}

/**
 * Thrown by `PermissionCanaryClient` when the `LethALControl_PermissionCanary` action cannot be
 * answered at all — unreachable, non-2xx (an older control app that does not publish this action
 * answers 404 here), or a 2xx whose body is not the double-encoded OData scalar the contract
 * promises. `runPermissionCanary` catches it and reports `"inconclusive"` with the message as
 * `detail`; it is a distinct class so a future caller that wants to branch on transport failure
 * can, without string-matching.
 *
 * Extends `Error` DIRECTLY, never another typed error in this repo (CLAUDE.md) — the
 * `AlcCompileError` / `ArtifactPrepareError` / `DeploymentError` separation exists precisely so an
 * `instanceof` check can never accidentally widen.
 */
export class PermissionCanaryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionCanaryUnavailableError";
  }
}

/**
 * The one seam `runPermissionCanary` depends on: something that produces the action's own parsed
 * JSON object (the string inside OData's scalar `value`, parsed twice), or throws. Structural, so
 * a unit test drives every verdict — including malformed and missing-field responses — against a
 * plain object literal with no HTTP anywhere.
 */
export interface PermissionCanaryProbe {
  probe(): Promise<Record<string, unknown>>;
}

/**
 * The canary drives a full `Test Suite Mgt.RunAllTests` cycle server-side, which on a cold service
 * tier is far slower than the control-plane calls `ActivationConfig.timeoutMs` is sized for.
 * `cfg.timeoutMs` is therefore deliberately NOT used here: a 30s activation timeout aborting a
 * healthy 45s canary would report `"inconclusive"` on a server that is working perfectly, and an
 * inconclusive verdict is the one answer an operator cannot act on.
 */
const PERMISSION_CANARY_TIMEOUT_MS = 120_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * POSTs `LethALControl_PermissionCanary`. Request-shaping (Basic auth, `company`/`tenant` query
 * params, manual `AbortController` timeout — `AbortSignal.timeout()` is unreliable in this
 * Bun/Windows environment, see activation.ts) mirrors `postLeaseAction` in lease.ts and
 * `RunMutantTransport`; it is not shared with `postOData` for the same reason those aren't — that
 * helper's non-2xx classification belongs to `MutationControl`, and mapping a 404 here to anything
 * other than "the action is not published" would be wrong.
 */
export class PermissionCanaryClient implements PermissionCanaryProbe {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async probe(): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_PermissionCanary?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PERMISSION_CANARY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: controller.signal,
      });
    } catch (err) {
      throw new PermissionCanaryUnavailableError(
        `LethALControl_PermissionCanary unreachable: ${String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // A 404 here is the expected shape of "an older LethAL Control is published" — named
      // explicitly so the inconclusive line an operator reads points at the actual fix
      // (republish the control app) instead of at a generic HTTP failure.
      const hint =
        res.status === 404
          ? " — the published LethAL Control app has no PermissionCanary action (it predates ROADMAP R26); republish it to measure this"
          : "";
      throw new PermissionCanaryUnavailableError(
        `LethALControl_PermissionCanary failed: HTTP ${res.status}${hint}`,
      );
    }
    let envelope: unknown;
    try {
      envelope = await res.json();
    } catch {
      throw new PermissionCanaryUnavailableError(
        "LethALControl_PermissionCanary 2xx body is not JSON",
      );
    }
    const value = isRecord(envelope) ? envelope.value : undefined;
    if (typeof value !== "string") {
      throw new PermissionCanaryUnavailableError(
        'LethALControl_PermissionCanary returned no string "value"',
      );
    }
    let inner: unknown;
    try {
      inner = JSON.parse(value);
    } catch {
      throw new PermissionCanaryUnavailableError(
        `LethALControl_PermissionCanary "value" is not JSON: ${value}`,
      );
    }
    if (!isRecord(inner)) {
      throw new PermissionCanaryUnavailableError(
        'LethALControl_PermissionCanary parsed "value" is not a JSON object',
      );
    }
    return inner;
  }
}

function inconclusive(detail: string): PermissionCanaryResult {
  return { verdict: "inconclusive", detail };
}

/**
 * Runs the canary once and maps the response to a verdict. NEVER throws, and never returns
 * `"not-mocked"` for anything it did not positively measure.
 *
 * The server owns the verdict DECISION (`ControlApi.Codeunit.al`'s `BuildCanaryResult`) — this does
 * not re-derive a verdict from the observation, and it never converts one verdict into the other.
 * What it enforces, in two layers, is that the payload actually SUPPORTS the verdict it asserts;
 * every failure demotes to `"inconclusive"`, nothing else:
 *
 * 1. COMPLETENESS — a conclusive verdict must arrive with `observed: true`, all three in-fence
 *    observation booleans, and the attribution context (`baselineRead/WritePermission`,
 *    `mockInstalled`). A claim reporting nothing observed is a protocol violation, and reading it
 *    as a clean result is the "empty result reads as a good one" failure this module exists to
 *    prevent. (An older control app that predates the attribution keys fails here too, and
 *    correctly: it cannot substantiate the claim it is making.)
 * 2. COHERENCE — the values must be the ones that verdict is defined by. Without this, a payload
 *    saying `{verdict:"not-mocked", readPermission:false, writePermission:false,
 *    insertSucceeded:false, detail:"Sorry, the current permissions prevented the action."}` sailed
 *    through and printed "reported read and write permission and a real insert succeeded", dropping
 *    the refusal on the floor — a reviewer ran exactly that. So `"not-mocked"` must carry
 *    read && write && insert, `"mocked"` must carry a refused write, an insert that did not
 *    complete, and an installed mock, and both must sit on a baseline that could write at all.
 *
 * This is a re-check of the server's CLAIM, not a second copy of its mapping: it asserts only the
 * conjunctions `BuildCanaryResult` already gates each verdict on. If the AL rule ever legitimately
 * loosens, this starts demoting to inconclusive — loud, safe, and covered by tests, rather than
 * silently disagreeing.
 */
export async function runPermissionCanary(
  probe: PermissionCanaryProbe,
): Promise<PermissionCanaryResult> {
  let json: Record<string, unknown>;
  try {
    json = await probe.probe();
  } catch (err) {
    return inconclusive(
      `permission canary could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const verdict = json.verdict;
  if (verdict !== "mocked" && verdict !== "not-mocked" && verdict !== "inconclusive") {
    return inconclusive(
      `permission canary returned an unrecognized verdict ${JSON.stringify(verdict)}: ${JSON.stringify(json)}`,
    );
  }
  const detail = typeof json.detail === "string" && json.detail !== "" ? json.detail : undefined;

  if (verdict === "inconclusive") {
    return inconclusive(
      detail ?? `permission canary reported inconclusive with no detail: ${JSON.stringify(json)}`,
    );
  }

  const observed = json.observed;
  const readPermission = json.readPermission;
  const writePermission = json.writePermission;
  const insertSucceeded = json.insertSucceeded;
  const baselineReadPermission = json.baselineReadPermission;
  const baselineWritePermission = json.baselineWritePermission;
  const mockInstalled = json.mockInstalled;
  if (
    observed !== true ||
    typeof readPermission !== "boolean" ||
    typeof writePermission !== "boolean" ||
    typeof insertSucceeded !== "boolean" ||
    typeof baselineReadPermission !== "boolean" ||
    typeof baselineWritePermission !== "boolean" ||
    typeof mockInstalled !== "boolean"
  ) {
    return inconclusive(
      `permission canary reported "${verdict}" without a complete observation (observed/readPermission/writePermission/insertSucceeded/baselineReadPermission/baselineWritePermission/mockInstalled): ${JSON.stringify(json)}`,
    );
  }

  // COHERENCE (see this function's doc comment). Only ever demotes to "inconclusive" — a payload
  // whose values contradict its own verdict is not evidence for the OTHER verdict either.
  const incoherence = describeIncoherence(verdict, {
    readPermission,
    writePermission,
    insertSucceeded,
    baselineWritePermission,
    mockInstalled,
  });
  if (incoherence !== undefined) {
    return inconclusive(
      `permission canary reported "${verdict}" on a payload that does not support it (${incoherence}): ${JSON.stringify(json)}`,
    );
  }

  return {
    verdict,
    readPermission,
    writePermission,
    insertSucceeded,
    baselineReadPermission,
    baselineWritePermission,
    mockInstalled,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Names the FIRST way a conclusive payload contradicts its own verdict, or `undefined` when it is
 * coherent. Returns a reason string rather than a bare boolean so the demotion says what was wrong
 * — an inconclusive verdict whose detail does not identify the contradiction is one nobody can act
 * on, and this particular contradiction means either the server or this client is buggy, which an
 * operator needs to be able to tell.
 */
function describeIncoherence(
  verdict: "mocked" | "not-mocked",
  o: {
    readPermission: boolean;
    writePermission: boolean;
    insertSucceeded: boolean;
    baselineWritePermission: boolean;
    mockInstalled: boolean;
  },
): string | undefined {
  // Both verdicts are only meaningful on a session that could write the probe OUTSIDE the fence;
  // the server gates on this first, so a conclusive verdict without it is self-contradictory.
  if (!o.baselineWritePermission) {
    return "the out-of-fence baseline reports no write permission, so nothing measured inside the fence can be attributed to the test path";
  }

  if (verdict === "not-mocked") {
    if (!(o.readPermission && o.writePermission && o.insertSucceeded)) {
      return `"not-mocked" requires read, write and a completed insert, got read=${o.readPermission} write=${o.writePermission} insert=${o.insertSucceeded}`;
    }
    return undefined;
  }
  if (o.insertSucceeded) {
    return '"mocked" requires an insert that did NOT complete, but the payload reports insertSucceeded=true';
  }
  if (o.writePermission) {
    return '"mocked" requires a refused write flag, but the payload reports writePermission=true';
  }
  if (!o.mockInstalled) {
    return '"mocked" names codeunit 131006 as the cause, but the payload reports mockInstalled=false';
  }

  return undefined;
}

/**
 * Turns a canary result into the `console.warn` lines a session prints — and, via
 * `renderConsole`, repeats after the score.
 *
 * Says something for EVERY verdict, including `"not-mocked"`. A report that goes quiet on the
 * expected answer leaves a reader unable to tell "measured, and this server is fine" from "nobody
 * looked", which is the same ambiguity the canary was built to remove.
 *
 * The lines describe the question the canary actually answers — can a correctly-declared test
 * codeunit write its own app's tables here — NOT the disproved fenced-path story they used to tell.
 * They must not claim a target suite's scores are uncharacterised: whether a TARGET test can write
 * is decided by that codeunit's own `TestPermissions`, which this canary cannot see and which
 * `describeTestPermissionsRefusal` names when it actually bites.
 */
export function permissionCanaryWarnings(result: PermissionCanaryResult): string[] {
  if (result.verdict === "mocked") {
    const confirmed =
      "[lethal] permission canary PRECONDITION VIOLATED on this run (R26): this server strips " +
      "write permission from a test codeunit that correctly declares `TestPermissions = Disabled` " +
      "— the probe reported no write permission inside its body AND its insert was refused, while " +
      "the same session CAN write the same table outside the fence, and Microsoft's Permissions " +
      "Mock (codeunit 131006) is installed here. This is NOT the ordinary case (a target test " +
      "codeunit that OMITS the property is refused everywhere, and LethAL names that separately): " +
      "it means the platform rule itself has changed, so tests that write may fail here for " +
      "reasons no target-side declaration can fix, and their mutants land `error cause=unstable` " +
      "and go SILENTLY UNSCORED. Treat this session's score as uncharacterised";
    const refusal =
      result.detail !== undefined ? ` (probe insert was refused: ${result.detail})` : "";
    return [`${confirmed}${refusal}`];
  }
  if (result.verdict === "not-mocked") {
    const clean =
      "[lethal] permission canary (R26): a correctly-declared test codeunit " +
      "(`TestPermissions = Disabled`) CAN write its own app's tables on this server — the probe " +
      "reported read and write permission and a real insert succeeded inside a test body. This is " +
      "the expected answer and confirms the precondition only; it says nothing about any " +
      "particular target suite, whose own `TestPermissions` declaration decides whether ITS tests " +
      "may write.";
    // Worth saying out loud: the mock app being installed while writes still succeed is exactly
    // what the A/B measurement predicts, and it forestalls the reflex of blaming codeunit 131006
    // for a refusal that a missing `TestPermissions = Disabled` actually caused.
    const installed =
      result.mockInstalled === true
        ? " (codeunit 131006 IS installed here and is not the reason any test fails to write — the test codeunit's own TestPermissions is)"
        : "";
    return [`${clean}${installed}`];
  }
  const undetermined =
    "[lethal] permission canary could not determine (R26) whether a correctly-declared test " +
    "codeunit (`TestPermissions = Disabled`) can write its own app's tables on this server";
  const consequence =
    'This is NOT the same as "not mocked": the precondition every fenced run assumes is simply ' +
    "unverified here. If it is in fact violated, tests that write fail for reasons no target-side " +
    "declaration can fix and their mutants are recorded `error cause=unstable` and silently " +
    "unscored. Treat this session's score as uncharacterised.";
  return [`${undetermined} (${result.detail ?? "no detail"}). ${consequence}`];
}

/**
 * BC's permission refusal, as it appears in a failing test line's `message`. MEASURED shape:
 *
 *     Sorry, the current permissions prevented the action. (TableData 79300 Data Main Insert: LethAL Sandbox Data Tests)
 *
 * Anchored on the stable middle clause, so the leading "Sorry, " and the trailing parenthetical
 * (which names the table, the operation and the suite, and is the most useful part to quote) are
 * both optional. `[^.\n]*` on the left stops the match at the previous sentence or line, which
 * matters because `failureMessage` is `message` + "\n" + `stackTrace` — a greedy `.*` would drag a
 * stack frame into the quote.
 */
const PERMISSIONS_REFUSAL_RE =
  /[^.\n]*\bcurrent permissions prevented the action\b\.?(?:[ \t]*\([^)\n]*\))?/i;

/**
 * R66: the same refusal in ANY language, matched on the part BC does not translate.
 *
 * MEASURED on Cronus281 through the fenced path, one session, only `GlobalLanguage` differing
 * (`fixtures/sandbox-probes/src/LangRefusalProbe.Codeunit.al`):
 *
 *     1033  Sorry, the current permissions prevented the action. (TableData 79201 Rec XRec Probe Insert: LethAL Sandbox Probes)
 *     1030  De aktuelle rettigheder forhindrede handlingen.      (TableData 79201 Rec XRec Probe Insert: LethAL Sandbox Probes)
 *
 * The prose translates; the parenthetical is byte-identical, because its tokens are AL keywords
 * and object names rather than prose. That also settled the row's premise — no localized SERVER is
 * needed, BC selects message resources by SESSION language, and the DK containers already carry
 * the resources.
 *
 * MATCHED STRICTLY, and the strictness is the point. `TableData`, a numeric id, a name, one of the
 * five AL permission operations, then `: <suite>` — all of it, or no match. A looser matcher (the
 * bare word `TableData`, say) would tell a user to declare a property they already have, sending
 * them to change working code. A miss costs a diagnosis; a false hit costs trust, so the direction
 * is chosen deliberately.
 *
 * Case-SENSITIVE, unlike the English clause above: these are AL keywords, and BC emits them in one
 * casing. If some locale ever lowercases them the result is a miss, which is the safe direction.
 *
 * `[^\n]*` on the left takes the message line and stops there — `failureMessage` is `message` plus
 * a newline plus `stackTrace`, and quoting a stack frame back at the reader as if BC had said it is
 * exactly the sloppiness the English regex's own left-anchor exists to prevent.
 */
const PERMISSIONS_REFUSAL_STRUCTURAL_RE =
  /[^\n]*\(TableData\s+\d+\s+[^():\n]*?\s(?:Read|Insert|Modify|Delete|Execute):\s[^)\n]+\)/;

/**
 * Names the cause when a TARGET suite's test is refused by BC's permission system — the half of
 * ROADMAP R26 that operators actually hit, and the one the canary cannot answer for them.
 *
 * WHY THIS EXISTS. MEASURED A/B (2026-07-26, see this module's header): a test codeunit that omits
 * `TestPermissions` runs Restrictive (the AL default) and is stripped of write permission on its
 * own app's tables; one that declares `TestPermissions = Disabled` is not. That is true on every
 * path that goes through `Test Runner - Mgt` 130454 — LethAL's fenced `RunMutant` and
 * `continia test run` alike — so it is a property of the target's own declaration, not of LethAL.
 * Before this, such a test failed under the mutant AND at baseline confirmation, and the mutant was
 * recorded `error cause=unstable` with a bare "fails at baseline confirmation" note: a
 * deterministic, fully explicable, one-line-fixable condition reported to the user as flakiness.
 *
 * WHAT IT IS AND IS NOT. It is a DIAGNOSIS ATTACHED TO AN EXISTING FAILURE, nothing more. It never
 * decides a verdict, never suppresses a failure, and is never consulted on a path that could turn
 * a `killed` into a `survived` or vice versa — a test refused under the mutant that PASSES at
 * baseline is still a kill, and this function is not asked. It hedges ("most likely") because a
 * message can carry that text for another reason, and it QUOTES BC verbatim rather than replacing
 * it, so a reader who disagrees with the diagnosis still has the platform's own words.
 *
 * Returns `undefined` when there is nothing to read (`failureText` absent — a legitimate state, a
 * failing test line need not carry a message) or when the text does not carry the refusal. Both are
 * honestly "no diagnosis", not a defaulted one; callers append only when a string comes back.
 */
export function describeTestPermissionsRefusal(
  failureText: string | undefined,
): string | undefined {
  if (failureText === undefined) return undefined;
  // English first, so the quote keeps the shape it has always had on an English server; the
  // structural matcher (R66) is what carries every other language, and matches the English text
  // too — trying it second changes nothing about an English run.
  const match =
    PERMISSIONS_REFUSAL_RE.exec(failureText) ?? PERMISSIONS_REFUSAL_STRUCTURAL_RE.exec(failureText);
  if (match === null) return undefined;
  const quoted = match[0]?.trim();
  if (quoted === undefined || quoted === "") return undefined;
  const diagnosis =
    "this is BC refusing the write, not a flaky test: the test codeunit most likely omits " +
    "`TestPermissions = Disabled` — AL defaults to Restrictive, which strips a test body of " +
    "write permission on its own app's tables on every path through `Test Runner - Mgt` 130454 " +
    "(LethAL's fenced RunMutant and `continia test run` alike). Declare " +
    "`TestPermissions = Disabled;` on the test codeunit and re-run. BC's own words:";
  return `${diagnosis} "${quoted}"`;
}
