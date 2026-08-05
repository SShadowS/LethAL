import type { PublishOutcome } from "./deployment-verifier";
import type { PublishOutcomeRow } from "./store";

/**
 * The subset of `ResultsStore` (store.ts) this module needs, declared structurally so the ceiling
 * can be exercised — and reasoned about — without a session, a backend or a run row.
 */
export interface PublishOutcomeStore {
  recordPublishOutcome(row: {
    readonly tier: string;
    readonly guardCount: number;
    readonly file: string | undefined;
    readonly outcome: PublishOutcome;
  }): void;
  publishOutcomes(tier: string): readonly PublishOutcomeRow[];
}

/**
 * What one tier's publish history says about its ceiling — a BRACKET, never a constant.
 *
 * R90 measured 2026-08-05 on the campaign's hosted Continia tier, one file per publish: **176 and
 * 229 guards publish; 331 and 660 time out.** A different container, a different reverse proxy, a
 * different NST memory budget puts the ceiling somewhere else entirely, so a hardcoded number
 * would be wrong in BOTH directions — refusing files that publish fine on a fat tier, and letting
 * a thin one burn generate + instrument + compile + publish before failing.
 *
 * Both fields are genuinely optional: a tier with no recorded failure has no `smallestFailure` and
 * therefore refuses nothing, and a tier with no recorded success has no `largestSuccess` to quote
 * back. `{}` — a fresh topology — is the normal starting state, not an error.
 */
export interface PublishCeiling {
  /** Smallest guard count MEASURED to fail on this tier. Only `failed` outcomes count — see
   *  `knownCeiling`. */
  readonly smallestFailure?: number;
  /** Largest guard count measured to publish successfully on this tier. Explanatory only: it
   *  widens the bracket a refusal quotes, and never causes or prevents one. */
  readonly largestSuccess?: number;
  /** `YYYY-MM-DD` of the failure that set `smallestFailure`, so a refusal can date its evidence
   *  instead of asserting a timeless rule. Absent when there is no failure to date. */
  readonly failureObservedOn?: string;
}

/**
 * A file refused BEFORE the cost, because publishing a file this size has already been measured to
 * fail on this tier. Extends `Error` DIRECTLY (CLAUDE.md's typed-error separation rule) — it is
 * not a `DeploymentError` (nothing was deployed) and not a `PublishFailedError` (nothing was
 * published); it is the refusal that exists so neither of those happens a second time.
 */
export class PublishCeilingExceededError extends Error {
  readonly file: string;
  readonly guardCount: number;
  readonly smallestFailure: number;
  readonly largestSuccess: number | undefined;

  constructor(
    message: string,
    info: {
      readonly file: string;
      readonly guardCount: number;
      readonly smallestFailure: number;
      readonly largestSuccess: number | undefined;
    },
  ) {
    super(message);
    this.file = info.file;
    this.guardCount = info.guardCount;
    this.smallestFailure = info.smallestFailure;
    this.largestSuccess = info.largestSuccess;
  }
}

/**
 * Refuses a single FILE whose own deployed guard count is at or above a guard count MEASURED to
 * fail on this tier.
 *
 * Per FILE, not per batch, because `planArtifacts` splits at FILE granularity (see its doc
 * comment): a file that alone exceeds the bracket becomes its own oversized batch, so
 * `--max-guards-per-batch` is powerless against it and the only remaining levers are excluding it
 * or splitting it. A batch whose TOTAL exceeds the bracket while no single file does is exactly
 * what the batch budget exists for, and refusing it would be a false refusal.
 *
 * **With no recorded failure, nothing is ever refused.** A fresh topology must be allowed to
 * discover its own ceiling by failing once — this prevents the SECOND waste, not the first.
 */
export function assertUnderCeiling(input: {
  readonly file: string;
  readonly guardCount: number;
  readonly ceiling: PublishCeiling;
}): void {
  const { smallestFailure, largestSuccess, failureObservedOn } = input.ceiling;
  if (smallestFailure === undefined) return;
  if (input.guardCount < smallestFailure) return;

  // Phrased as MEASUREMENT, never as law: "331 guards timed out on this tier on 2026-08-05; 229
  // published" — a recorded observation of one topology, which the next topology will contradict.
  const dated = failureObservedOn === undefined ? "" : ` on ${failureObservedOn}`;
  const parts = [
    `refusing to publish ${input.file}: it carries ${input.guardCount} guards on its own, and`,
    `${smallestFailure} guards were MEASURED to fail to publish on this tier${dated}.`,
  ];
  if (largestSuccess !== undefined) {
    parts.push(
      `The largest artifact measured to publish successfully on this tier carried ${largestSuccess} guards.`,
    );
  }
  parts.push(
    "That bracket is a recorded observation of THIS topology, not a fixed limit — another",
    "container or proxy has a different one, and one honest failure is how each tier measures",
    "its own. Batches split at file granularity, so --max-guards-per-batch cannot rescue a",
    `single file this size: exclude it with --only <glob>, or split ${input.file} into smaller`,
    "AL objects.",
  );
  throw new PublishCeilingExceededError(parts.join(" "), {
    file: input.file,
    guardCount: input.guardCount,
    smallestFailure,
    // Declared `number | undefined` (required, nullable) rather than optional: a refusal that
    // could not quote a success is a real state, and spelling it out keeps the field readable.
    largestSuccess,
  });
}

/**
 * Records ONE publish attempt's outcome against a tier.
 *
 * The stored value is the outcome CATEGORY (`decidePublishOutcome`'s four values), never a
 * boolean. That distinction is load-bearing rather than cosmetic: `deployment-verifier.ts`'s
 * `decidePublishOutcome` can only reach `"failed"` when the publish call itself threw, and R90's
 * documented reproduction is an external tool that EXITS 0 while its JSON body reports
 * `{"success": false, "message": "The operation timed out."}`. On the very tier this ceiling
 * exists for, that failure therefore arrives as `"indeterminate"` (env-tool.ts has no `success`
 * handling — filed as R107). A boolean would record nothing for it, leaving the store unable to
 * tell "no failure has happened here" from "a failure happened and we could not see it"; the
 * category leaves the row behind, tagged for what it was, and the R107 fix will show up in this
 * same table as a mode flip `indeterminate` -> `failed`.
 */
export function recordPublishOutcome(
  store: PublishOutcomeStore,
  tier: string,
  guardCount: number,
  outcome: PublishOutcome,
  file: string | undefined,
): void {
  // Fail loudly on a caller-contract violation (CLAUDE.md): an empty tier key would file the row
  // under a name no `knownCeiling` call ever reads, and a gate that records into a hole is this
  // project's signature bug wearing a green tick.
  if (tier.length === 0) {
    throw new Error('recordPublishOutcome: tier must be a non-empty tier identity, got ""');
  }
  if (!Number.isInteger(guardCount) || guardCount < 0) {
    throw new Error(
      `recordPublishOutcome: guardCount must be a non-negative integer, got ${String(guardCount)}`,
    );
  }
  store.recordPublishOutcome({ tier, guardCount, file, outcome });
}

/**
 * The measured bracket for one tier.
 *
 * `smallestFailure` counts **only `failed` rows** — a publish that demonstrably did not happen.
 * `indeterminate` and `anomalous` are deliberately excluded: their causes (verification endpoint
 * unreachable, LethAL Control absent, the server mid-restart, an identity puzzle) are
 * SIZE-INDEPENDENT, so a single such row at a small guard count would permanently refuse files
 * that publish perfectly well — the false-refusal direction. They are still stored, and
 * `publishOutcomes` still returns them, so the blindness is measurable rather than invisible.
 *
 * `largestSuccess` counts only `accepted` rows, for the mirror-image reason: `indeterminate` means
 * we could not confirm the deployment is ours, which is not evidence that a file that size
 * publishes.
 */
export function knownCeiling(store: PublishOutcomeStore, tier: string): PublishCeiling {
  let smallestFailure: number | undefined;
  let failureObservedOn: string | undefined;
  let largestSuccess: number | undefined;
  for (const row of store.publishOutcomes(tier)) {
    if (
      row.outcome === "failed" &&
      (smallestFailure === undefined || row.guardCount < smallestFailure)
    ) {
      smallestFailure = row.guardCount;
      failureObservedOn = row.recordedAt.slice(0, 10);
    }
    if (
      row.outcome === "accepted" &&
      (largestSuccess === undefined || row.guardCount > largestSuccess)
    ) {
      largestSuccess = row.guardCount;
    }
  }
  return {
    ...(smallestFailure !== undefined ? { smallestFailure } : {}),
    ...(largestSuccess !== undefined ? { largestSuccess } : {}),
    ...(failureObservedOn !== undefined ? { failureObservedOn } : {}),
  };
}

/**
 * Deployed guards per file, largest first — the per-file counts `assertUnderCeiling` is applied
 * to, and the ordering `--dry-run` prints. Fed from a `MutantManifest`'s entries (the DEPLOYED
 * mutants, post-§3.2 dedup), never from raw specs: R92 measured 176 sites -> 148 deployed on real
 * code, and conflating the two broke a real pre-commitment.
 *
 * Descending so the worst offender is the one a refusal names when a batch holds several files
 * over the bracket — deterministic, and the most actionable of them.
 */
export function guardsPerFile(
  mutants: readonly { readonly file: string }[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const m of mutants) counts.set(m.file, (counts.get(m.file) ?? 0) + 1);
  return new Map([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
