/**
 * How a live gate proves it ran, to a caller that cannot see its terminal.
 *
 * R223: every env-gated itest here calls `process.exit(0)` when it skips, and `compile-fixtures`
 * does the same when `alc` is missing. That is correct for a human reading the output, and it
 * means an exit code cannot distinguish a gate that passed from one that never contacted Business
 * Central. A caller reading `$?` sees the same value either way, so "every required leg exited 0"
 * is satisfied by a ladder that did nothing. One misspelled environment variable is enough. That
 * is empty-vs-empty, this repo's signature bug, in the place it is least visible.
 *
 * A receipt inverts it. The leg makes a POSITIVE statement about what it did, and the absence of a
 * statement is an error rather than a pass.
 *
 * ## Nothing changes for a human
 *
 * A receipt is written only when the caller issued a challenge, by setting all four of
 * `LETHAL_GATE_NONCE`, `LETHAL_GATE_SHA`, `LETHAL_GATE_GENERATION` and `LETHAL_GATE_RECEIPT`.
 * Running `bun run itest:tables` by hand sets none of them, writes nothing, and behaves exactly as
 * it did before.
 *
 * A PARTIAL set throws rather than falling back to "no challenge". A caller that set three of four
 * has a bug, and silently treating it as a manual run would hand back the very exit-code-only
 * result the receipt exists to replace.
 *
 * ## Why a challenged skip also exits non-zero
 *
 * Belt and braces, for the two kinds of caller. A caller reading the receipt learns `skipped`. A
 * caller reading the exit code learns non-zero. Before this, the second learned `0`. The exit code
 * stays `0` for an unchallenged skip, because that is a human asking a question and getting an
 * answer.
 */

import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** What the caller demands the leg attest to. All four arrive together or not at all. */
export interface GateChallenge {
  readonly nonce: string;
  readonly candidateSha: string;
  readonly containerGeneration: number;
  readonly receiptPath: string;
}

/** Thrown for a malformed challenge. Never downgraded to "no challenge". */
export class GateChallengeError extends Error {}

const KEYS = [
  "LETHAL_GATE_NONCE",
  "LETHAL_GATE_SHA",
  "LETHAL_GATE_GENERATION",
  "LETHAL_GATE_RECEIPT",
] as const;

/** The challenge, or `undefined` when this is an ordinary manual run. */
export function readChallenge(env: NodeJS.ProcessEnv = process.env): GateChallenge | undefined {
  const present = KEYS.filter((k) => {
    const v = env[k];
    return v !== undefined && v !== "";
  });
  if (present.length === 0) return undefined;
  if (present.length !== KEYS.length) {
    const missing = KEYS.filter((k) => !present.includes(k));
    throw new GateChallengeError(
      `a gate receipt was half-requested: ${present.join(", ")} set, ${missing.join(", ")} missing. All four are required together. Treating this as an unchallenged run would hand back the exit-code-only result a receipt exists to replace.`,
    );
  }
  const generation = Number(env.LETHAL_GATE_GENERATION);
  if (!Number.isInteger(generation)) {
    throw new GateChallengeError(
      `LETHAL_GATE_GENERATION=${JSON.stringify(env.LETHAL_GATE_GENERATION)} is not an integer`,
    );
  }
  return {
    nonce: String(env.LETHAL_GATE_NONCE),
    candidateSha: String(env.LETHAL_GATE_SHA),
    containerGeneration: generation,
    receiptPath: String(env.LETHAL_GATE_RECEIPT),
  };
}

export interface ReceiptBody {
  readonly status: "passed" | "failed" | "skipped";
  /** Names of the sublegs actually executed. A four-leg gate reporting one is a partial run. */
  readonly sublegs: readonly string[];
  /**
   * Artifact identities this leg observed on the server, keyed by app name.
   *
   * `reported: false` is an honest empty rather than `{}`. An empty map would read as "nothing was
   * published", which is a different claim and the one that hides R56.
   */
  readonly artifacts:
    | { readonly reported: false }
    | { readonly reported: true; readonly ids: Readonly<Record<string, string>> };
  readonly reason?: string;
}

/**
 * Writes the receipt, atomically.
 *
 * Temp file then rename, because a receipt half-written by a killed process must not be a receipt
 * that parses. A partial JSON file would be rejected by the validator, but a truncated one that
 * happens to close its braces would not, and the failure mode there is a leg reporting fewer
 * sublegs than it ran.
 */
export async function writeReceipt(
  challenge: GateChallenge,
  leg: string,
  body: ReceiptBody,
): Promise<void> {
  const payload = {
    leg,
    nonce: challenge.nonce,
    candidateSha: challenge.candidateSha,
    containerGeneration: challenge.containerGeneration,
    status: body.status,
    sublegs: body.sublegs,
    observedArtifacts: body.artifacts.reported ? body.artifacts.ids : {},
    artifactsReported: body.artifacts.reported,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  };
  const tmp = join(dirname(challenge.receiptPath), `.receipt-${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, challenge.receiptPath);
}

/**
 * Report a skip and exit.
 *
 * Exit 1 when challenged, 0 when not. The caller that asked for a receipt is told twice, and the
 * human who just ran the command without the env var gets today's behaviour.
 */
export async function emitSkippedAndExit(leg: string, reason: string): Promise<never> {
  const challenge = readChallenge();
  if (challenge === undefined) process.exit(0);
  await writeReceipt(challenge, leg, {
    status: "skipped",
    sublegs: [],
    artifacts: { reported: false },
    reason,
  });
  console.error(
    `${leg}: SKIPPED while a receipt was demanded. A required leg that skipped is an executor error, not a pass (R223).`,
  );
  process.exit(1);
}

/** Report a pass. Does nothing when unchallenged. */
export async function emitPassed(leg: string, body: Omit<ReceiptBody, "status">): Promise<void> {
  const challenge = readChallenge();
  if (challenge === undefined) return;
  await writeReceipt(challenge, leg, { ...body, status: "passed" });
}

/** Report a failure. Does nothing when unchallenged; the caller still exits non-zero itself. */
export async function emitFailed(leg: string, reason: string): Promise<void> {
  const challenge = readChallenge();
  if (challenge === undefined) return;
  // Best effort: a gate that failed AND cannot write its receipt must not lose the original error
  // behind a filesystem one.
  try {
    await writeReceipt(challenge, leg, {
      status: "failed",
      sublegs: [],
      artifacts: { reported: false },
      reason,
    });
  } catch {
    console.error(`${leg}: could not write the failure receipt`);
  }
}
