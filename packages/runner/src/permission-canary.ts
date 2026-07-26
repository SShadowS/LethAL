import type { ActivationConfig, FetchFn } from "./activation";

/**
 * ROADMAP R26 — a per-session canary that MEASURES, on the server this session is actually
 * running against, whether the fenced test path strips a test body's permissions.
 *
 * WHAT IT CLOSES. Microsoft's Permissions Mock (codeunit 131006, toggled by `Test Runner - Mgt`
 * 130454's `PlatformBeforeTestRun` -> `StartStopPermissionMock`) strips permissions from a test
 * body — but only on LethAL's FENCED path (`RunMutant` -> `Test Suite Mgt.RunAllTests`), and only
 * when that Microsoft app happens to be installed. The dev-service path used for baseline and
 * coverage runs is unaffected. Both consequences are measured, not theorised:
 *
 * - A test that writes to its own app's tables fails INSIDE THE FENCE ONLY, so its mutant lands
 *   `error cause=unstable` and is silently UNSCORED rather than killed.
 * - Because it hinges on whether an app is installed, the same project can score differently on
 *   two servers today, with nothing in the report saying which world it ran in.
 *
 * The server-side probe (`extensions/lethal-control`: table 71008 "LC Permission Probe", codeunit
 * 71010 "LC Permission Canary", carried out on codeunit 71009 "LC Permission Canary State") runs
 * through the SAME `LC Run Method` / `Test Suite Mgt.RunAllTests` mechanism `RunMutant` uses — a
 * canary travelling a different path than the thing it characterises measures nothing. The probe
 * table deliberately has NO `InherentPermissions`, unlike every one of its siblings; see that
 * table's own doc comment before touching it.
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
 * `"mocked"` — the fenced path strips permissions here (the probe's write flag is off AND its
 * insert was refused). `"not-mocked"` — it does not (read, write, and a real insert all succeeded).
 * `"inconclusive"` — the measurement did not happen, or came back self-contradictory; `detail`
 * always says which.
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
 * The server owns the verdict decision (`ControlApi.Codeunit.al`'s `BuildCanaryResult`) — this
 * does NOT recompute it from the observation, which would be a second copy of the mapping free to
 * drift from the first. What it DOES enforce is internal consistency: a conclusive verdict must
 * arrive with `observed: true` and all three observation booleans present. A response claiming
 * `"not-mocked"` while reporting nothing observed is a protocol violation, and reporting it as a
 * clean result would be precisely the "empty result reads as a good one" failure this module
 * exists to prevent — so it is demoted to inconclusive with the offending payload attached.
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
  if (
    observed !== true ||
    typeof readPermission !== "boolean" ||
    typeof writePermission !== "boolean" ||
    typeof insertSucceeded !== "boolean"
  ) {
    return inconclusive(
      `permission canary reported "${verdict}" without a complete observation (observed/readPermission/writePermission/insertSucceeded): ${JSON.stringify(json)}`,
    );
  }

  return {
    verdict,
    readPermission,
    writePermission,
    insertSucceeded,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Turns a canary result into the `console.warn` lines a session prints — and, via
 * `renderConsole`, repeats after the score.
 *
 * Says something for EVERY verdict, including `"not-mocked"`. A report that goes quiet when the
 * mock is absent leaves a reader unable to tell "measured, and this server is clean" from "nobody
 * looked", which is the same ambiguity the canary was built to remove.
 */
export function permissionCanaryWarnings(result: PermissionCanaryResult): string[] {
  if (result.verdict === "mocked") {
    const confirmed =
      "[lethal] permission canary CONFIRMED on this run (R26): Microsoft's Permissions Mock is " +
      "active on the fenced test path — a test body here runs WITHOUT permission to write its " +
      "own app's tables. Any test that writes to a table lacking InherentPermissions fails " +
      "inside the fence only, so its mutant is recorded `error cause=unstable` and is SILENTLY " +
      "UNSCORED rather than killed. Scores from this server are not comparable with scores " +
      "from one where the canary reports not-mocked";
    const refusal =
      result.detail !== undefined ? ` (probe insert was refused: ${result.detail})` : "";
    return [`${confirmed}${refusal}`];
  }
  if (result.verdict === "not-mocked") {
    return [
      "[lethal] permission canary (R26): the fenced test path does NOT strip permissions on this " +
        "server — the probe table reported read and write permission and a real insert succeeded " +
        "inside a test body. Mutants killable only by a test that writes to its own app's tables " +
        "are scored normally here.",
    ];
  }
  const undetermined =
    "[lethal] permission canary could not determine (R26) whether the fenced test path strips a " +
    "test body's permissions on this server";
  const consequence =
    'This is NOT the same as "not mocked": if the mock IS active, mutants killable only by a ' +
    "test that writes to its own app's tables are recorded `error cause=unstable` and silently " +
    "unscored. Treat this session's score as uncharacterised.";
  return [`${undetermined} (${result.detail ?? "no detail"}). ${consequence}`];
}
