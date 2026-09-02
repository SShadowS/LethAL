import type { ActivationConfig, FetchFn } from "./activation";
import type { CompiledArtifact } from "./artifact";
import { bcFetch } from "./bc-fetch";

/**
 * The only shape a generated artifact id, or an id `LethALControl_RegisteredArtifact` reports
 * back, is ever allowed to take: 128 random bits as 32 lowercase hex characters. Enforced on
 * BOTH the expected id and the reported id — see `DeploymentVerifier.verify` — for two
 * independent reasons: (1) the orchestrator once handed out non-random placeholder ids (Task 6
 * replaced `pending-task6-<runId>-<batchIdx>` with `newArtifactId()` in orchestrator.ts); if such
 * a value ever reappears and reaches `verify()` unchecked, an identical placeholder baked into
 * the artifact would "cheerfully verify against itself" and report a false accept — this guard
 * is the tripwire that makes that loud instead. (2) artifact ids are interpolated into a
 * single-quoted AL string
 * literal when generating `Mutation Selector` (`emitMutationSelector` in
 * `@lethal/schemata`/selector.ts); a value containing a quote would produce uncompilable AL, so
 * anything that doesn't match this pattern was never validly generated in the first place.
 */
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{32}$/;

function isValidArtifactId(id: string): boolean {
  return ARTIFACT_ID_PATTERN.test(id);
}

// Cap on how much of a malformed/hostile reported value gets quoted back into a `detail`
// string — a server (or a MITM) returning megabytes of garbage must not be able to flood a log.
const MAX_REPORTED_VALUE_DETAIL_LENGTH = 200;

function describeReportedValue(value: string): string {
  if (value.length === 0) return "(empty string)";
  const truncated =
    value.length > MAX_REPORTED_VALUE_DETAIL_LENGTH
      ? `${value.slice(0, MAX_REPORTED_VALUE_DETAIL_LENGTH)}… [truncated, ${value.length} chars total]`
      : value;
  return JSON.stringify(truncated);
}

export type DeploymentVerification =
  | { readonly status: "accepted" }
  | { readonly status: "mismatch"; readonly reported: string }
  | { readonly status: "unavailable"; readonly detail: string };

export type PublishOutcome = "accepted" | "indeterminate" | "anomalous" | "failed";

/**
 * Identity is mandatory ADDITIONAL evidence. It never grants permission to ignore a failed
 * publish: a failed publish whose identity happens to match is `anomalous`, and the session
 * aborts rather than running tests against a deployment we cannot explain.
 */
export function decidePublishOutcome(
  publishOk: boolean,
  verification: DeploymentVerification,
): PublishOutcome {
  if (publishOk) return verification.status === "accepted" ? "accepted" : "indeterminate";
  return verification.status === "accepted" ? "anomalous" : "failed";
}

/**
 * Verifies that the target's own install/upgrade codeunit self-registered the expected artifact
 * id in the `LC Control State` registry, by reading it back via the `LethALControl_RegisteredArtifact`
 * OData action.
 *
 * This is a cheap PRE-FLIGHT sanity check, run once before a session's mutants, NOT a fence and
 * NOT proof that the *running* binary is ours: it proves only that self-registration by our
 * binary was observed, at the moment of this call. It does not prove continued ownership, that
 * the artifact cannot subsequently be replaced, that a test runner loaded the same code, or that
 * any given test run actually executed against it. The binding, per-run proof that the live
 * binary matches is §G's identity attestation carried on every `RunMutant` call (see
 * `RunMutantTransport`) — this check is a pre-flight, not a substitute for that. Server-side
 * fencing is Layer 5C.
 */
export class DeploymentVerifier {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly fetchFn: FetchFn = bcFetch,
  ) {}

  async verify(expected: CompiledArtifact): Promise<DeploymentVerification> {
    // Reject a malformed expected id LOUDLY (throw) rather than silently running it through the
    // comparison below — a placeholder id happening to equal itself must never read as "verified".
    if (!isValidArtifactId(expected.artifactId)) {
      throw new Error(
        `DeploymentVerifier.verify: expected artifact id ${JSON.stringify(expected.artifactId)} ` +
          `does not match ${ARTIFACT_ID_PATTERN.source} — refusing to compare a malformed id`,
      );
    }

    let reported: string | null;
    try {
      reported = await this.readRegisteredArtifact(expected.appId);
    } catch (err) {
      return {
        status: "unavailable",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // A malformed, empty, or absent reported id means we could not determine what the server is
    // actually running — that's diagnostically different from a well-formed id that genuinely
    // differs from what we expected, so it must not collapse into `mismatch`. This guard is what
    // makes that distinction real: without it, a malformed `reported` would fall through to the
    // `===` comparison below, which can never be true (the expected id was already validated as
    // 32-hex above), so it would silently degrade into `mismatch` — losing the "we couldn't tell
    // what's running" signal that callers need in order to tell "wrong deployment" apart from
    // "no idea what's deployed".
    if (reported === null || !isValidArtifactId(reported)) {
      const detail =
        reported === null
          ? "server did not report an artifact id (missing or non-string `value`)"
          : `server reported ${describeReportedValue(reported)}, which does not match ${ARTIFACT_ID_PATTERN.source}`;
      return { status: "unavailable", detail };
    }

    if (reported === expected.artifactId) {
      return { status: "accepted" };
    }
    return { status: "mismatch", reported };
  }

  /**
   * Shapes and sends the `LethALControl_RegisteredArtifact` POST directly — its OWN request
   * method, deliberately NOT `postOData` (activation.ts), which hardcodes the dead
   * `MutationControl_` action prefix. Mirrors `HarnessVerifier.fetchHarnessInfo` (harness.ts).
   * Returns the raw registry value: `null` when the response is missing/non-2xx/malformed or the
   * OData `value` isn't a string; otherwise the bare string exactly as reported (including "",
   * for "no row registered", and any malformed-but-string value) — `verify()` above is
   * responsible for classifying that value, not this method.
   */
  private async readRegisteredArtifact(targetAppId: string): Promise<string | null> {
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_RegisteredArtifact?${params.toString()}`;

    // AbortSignal.timeout() is unreliable in this Bun/Windows env (see activation.ts) — manual
    // AbortController + setTimeout instead.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ targetAppId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Surfaced as a thrown error (rather than a quiet `null`) so `verify()`'s catch above can
      // carry the HTTP status into `detail` — collapsing this to `null` would make an HTTP 500
      // indistinguishable from "server answered 200 with no `value`".
      throw new Error(`LethALControl_RegisteredArtifact failed: HTTP ${res.status}`);
    }
    const value = ((await res.json().catch(() => ({}))) as { value?: unknown }).value;
    return typeof value === "string" ? value : null;
  }
}
