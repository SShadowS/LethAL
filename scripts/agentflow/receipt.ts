/**
 * Completion receipts: how a leg proves it ran, since an exit code cannot.
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`, "A leg passes on a
 * receipt, never on an exit code". Pure: validation only, no IO.
 *
 * ## Why an exit code is not evidence
 *
 * Every env-gated itest in this repo calls `process.exit(0)` on its skip path (grep `process.exit(0)` under `packages/runner/itest/`), and `compile-fixtures.ts`
 * exits 0 saying "SKIPPED, not passed" when `alc` is missing (`:87-89`). Every one of those is
 * correct behaviour for a human at a terminal reading the output. To a caller reading `$?`, a
 * skipped gate and a passed gate are the same value, so a merge criterion of "every required leg
 * exited 0" is satisfied by a ladder that never contacted Business Central. One misspelled
 * environment variable is enough. That is empty-vs-empty, this repo's named signature bug, in the
 * place it is least visible. Filed as R223.
 *
 * A receipt inverts it: the leg must make a positive statement about what it did, and the absence
 * of a statement is an error rather than a pass.
 *
 * ## Why a nonce
 *
 * Workers run as the same OS user as the executor, so a file on disk is not evidence of who wrote
 * it or when. Without a challenge, a receipt from a previous green run of the same leg is
 * indistinguishable from a fresh one, and a worker could write its own. So the executor mints a
 * nonce per invocation, hands it to the child, and refuses any receipt that does not echo it. This
 * does not make forgery impossible for a determined process running as the owner. It makes STALE
 * evidence and ACCIDENTAL reuse impossible, which is the failure that actually happens.
 */

import { randomBytes } from "node:crypto";

export type ReceiptStatus = "passed" | "failed" | "skipped";

/** What the executor decides before launching a leg, and hands to the child. */
export interface ReceiptChallenge {
  readonly leg: string;
  /** 32 lowercase hex, fresh per invocation. */
  readonly nonce: string;
  /** The commit the leg is being run against. */
  readonly candidateSha: string;
  /** The container generation in force. A leg run across a generation bump is not evidence. */
  readonly containerGeneration: number;
  /**
   * How many sublegs the caller requires. `itest:alrunner` has four; a receipt reporting one is a
   * partial run being presented as a complete one.
   */
  readonly expectedSublegs: number;
}

/** What the leg writes when it finishes. */
export interface Receipt {
  readonly leg: string;
  readonly nonce: string;
  readonly candidateSha: string;
  readonly containerGeneration: number;
  readonly status: ReceiptStatus;
  /** Names of the sublegs actually executed. */
  readonly sublegs: readonly string[];
  /** Artifact identities observed on the server, keyed by app name. */
  readonly observedArtifacts: Readonly<Record<string, string>>;
  /** Free-text reason, required when `status` is not `passed`. */
  readonly reason?: string;
}

/** Thrown when a receipt cannot be accepted. Never returned as a plausible pass. */
export class ReceiptError extends Error {}

export function mintNonce(): string {
  return randomBytes(16).toString("hex");
}

function requireString(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) {
    throw new ReceiptError(`receipt field "${k}" is missing or not a non-empty string`);
  }
  return v;
}

/**
 * Validate a receipt against the challenge it answers.
 *
 * Throws on anything short of a complete, fresh, matching `passed`. In particular `skipped` throws:
 * for a REQUIRED leg a skip is neither a pass nor a failure of the code, it is an executor error,
 * and reporting it as a soft outcome would put the decision back where the exit code had it.
 */
export function validateReceipt(challenge: ReceiptChallenge, raw: unknown): Receipt {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReceiptError(`receipt for leg "${challenge.leg}" is not an object`);
  }
  const o = raw as Record<string, unknown>;

  const leg = requireString(o, "leg");
  if (leg !== challenge.leg) {
    throw new ReceiptError(`receipt is for leg "${leg}", expected "${challenge.leg}"`);
  }

  // Checked before anything else about content: a stale receipt that happens to describe a green
  // run is the most convincing wrong evidence available.
  const nonce = requireString(o, "nonce");
  if (nonce !== challenge.nonce) {
    throw new ReceiptError(
      `receipt for leg "${leg}" echoes nonce ${nonce}, expected ${challenge.nonce}. A receipt from an earlier run is not evidence about this one.`,
    );
  }

  const candidateSha = requireString(o, "candidateSha");
  if (candidateSha !== challenge.candidateSha) {
    throw new ReceiptError(
      `receipt for leg "${leg}" names ${candidateSha}, expected ${challenge.candidateSha}`,
    );
  }

  const containerGeneration = o.containerGeneration;
  if (typeof containerGeneration !== "number" || !Number.isInteger(containerGeneration)) {
    throw new ReceiptError(`receipt for leg "${leg}" has no integer containerGeneration`);
  }
  if (containerGeneration !== challenge.containerGeneration) {
    throw new ReceiptError(
      `receipt for leg "${leg}" was produced under container generation ${containerGeneration}, ` +
        `expected ${challenge.containerGeneration}. The container was reset mid-run.`,
    );
  }

  const status = o.status;
  if (status !== "passed" && status !== "failed" && status !== "skipped") {
    throw new ReceiptError(`receipt for leg "${leg}" has status ${String(status)}`);
  }
  if (status === "skipped") {
    throw new ReceiptError(
      `leg "${leg}" reported SKIPPED. For a required leg that is an executor error, not a pass: the env var is unset or the environment is missing. See R223.`,
    );
  }
  if (status === "failed") {
    const reason = typeof o.reason === "string" ? o.reason : "(no reason given)";
    throw new ReceiptError(`leg "${leg}" failed: ${reason}`);
  }

  const sublegs = o.sublegs;
  if (!Array.isArray(sublegs) || sublegs.some((s) => typeof s !== "string")) {
    throw new ReceiptError(`receipt for leg "${leg}" has no sublegs array`);
  }
  if (sublegs.length !== challenge.expectedSublegs) {
    throw new ReceiptError(
      `leg "${leg}" ran ${sublegs.length} subleg(s), expected ${challenge.expectedSublegs}. A partial run is not a pass.`,
    );
  }
  if (new Set(sublegs).size !== sublegs.length) {
    throw new ReceiptError(`leg "${leg}" reports a duplicate subleg`);
  }

  const observedArtifacts = o.observedArtifacts;
  if (
    typeof observedArtifacts !== "object" ||
    observedArtifacts === null ||
    Array.isArray(observedArtifacts) ||
    Object.values(observedArtifacts).some((v) => typeof v !== "string")
  ) {
    throw new ReceiptError(`receipt for leg "${leg}" has no observedArtifacts map`);
  }

  const reason = typeof o.reason === "string" ? o.reason : undefined;
  return {
    leg,
    nonce,
    candidateSha,
    containerGeneration,
    status,
    sublegs: sublegs as string[],
    observedArtifacts: observedArtifacts as Record<string, string>,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * Compare what candidate source builds against what the server is actually running.
 *
 * Recording the published artifact's hash proves its IDENTITY, never its FRESHNESS: two equal
 * hashes on both sides of a comparison are equally consistent with nothing having been rebuilt. So
 * the expected side must be derived from candidate source (a retained build, not the deleted
 * scratch `.app` that `compile-fixtures.ts`'s `rmSync(out` cleanup produces today) and compared against what the
 * container reports.
 *
 * This is the only thing standing between the flow and R56, where a docs-only commit deleted a
 * procedure's body and `itest:tables` stayed green for days. In that failure NOTHING moves, so no
 * prediction logic fires and no verdict comparison helps.
 */
export function verifyArtifactFreshness(
  expected: Readonly<Record<string, string>>,
  observed: Readonly<Record<string, string>>,
): readonly string[] {
  const problems: string[] = [];
  const names = new Set([...Object.keys(expected), ...Object.keys(observed)]);
  for (const name of [...names].sort()) {
    const e = expected[name];
    const o = observed[name];
    if (e === undefined) {
      problems.push(`${name}: published but not built from candidate source`);
      continue;
    }
    if (o === undefined) {
      problems.push(`${name}: built from candidate source but not observed on the server`);
      continue;
    }
    if (e !== o) problems.push(`${name}: built ${e}, server is running ${o} (stale build)`);
  }
  return problems;
}
