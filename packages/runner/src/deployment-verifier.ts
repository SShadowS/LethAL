import type { ActivationConfig, FetchFn } from "./activation";
import { postOData } from "./activation";
import type { CompiledArtifact } from "./artifact";

/**
 * The only shape a generated artifact id, or an id `MutationControl_Identity` reports back, is
 * ever allowed to take: 128 random bits as 32 lowercase hex characters. Enforced on BOTH the
 * expected id and the reported id — see `DeploymentVerifier.verify` — for two independent
 * reasons: (1) the orchestrator still has call sites that hand out non-random placeholder ids
 * like `pending-task6-<runId>-<batchIdx>`; if one of those ever reached `verify()` unchecked, an
 * identical placeholder baked into the artifact would "cheerfully verify against itself" and
 * report a false accept. (2) artifact ids are interpolated into a single-quoted AL string
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
 * Verifies that a fresh Identity request observed code claiming a given artifact id.
 *
 * This is NOT a fence. It does not prove continued ownership, that the artifact cannot
 * subsequently be replaced, that a test runner loaded the same code, or that an activation
 * belongs to the caller. Server-side fencing is Layer 5C.
 */
export class DeploymentVerifier {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly fetchFn: FetchFn = fetch,
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

    let payload: unknown;
    try {
      payload = await postOData(this.cfg, this.fetchFn, "Identity");
    } catch (err) {
      return {
        status: "unavailable",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const rawValue = (payload as { value?: unknown } | null | undefined)?.value;
    const reported = typeof rawValue === "string" ? rawValue : null;

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
}
