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
  /** Fix round 1: the operator escape — see `clearPublishCeiling`. */
  deletePublishOutcomes(tier: string, file: string | undefined): number;
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
 *
 * Fix round 1: the message names THREE levers, not two. `--only` and splitting the file both
 * assume the measurement is right; the third assumes it is wrong. It has to be there, because the
 * ceiling is a ratchet — any throw out of `deployer.publish()` records a `failed` row, including a
 * transient Bun spawn `ENOENT` (R65 measured one), and a file once refused can never publish and so
 * can never produce the counter-evidence that would widen the bracket again. A refusal that does
 * not say how to undo a bogus measurement leaves sqlite surgery as the only way out.
 */
export function assertUnderCeiling(input: {
  readonly file: string;
  readonly guardCount: number;
  readonly ceiling: PublishCeiling;
  /**
   * The exact `lethal clear-ceiling ...` invocation that would drop this tier's recorded failures,
   * when the caller knows enough to render one (`clearCeilingCommand` below). Optional so the pure
   * refusal rule stays testable without a project dir or a tier identity; when absent the message
   * still NAMES the command, it just cannot pre-fill the arguments.
   */
  readonly clearCommand?: string;
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
    "AL objects. If the recorded failure was TRANSIENT rather than a size limit (a spawn failure,",
    "a restarting server, a network blip — anything that made the publish call throw), discard the",
    // Both branches contain the literal command name, so a reader always learns the third lever
    // exists; only the pre-filled arguments depend on the caller knowing the tier and project.
    input.clearCommand === undefined
      ? "measurement with `lethal clear-ceiling` and measure again."
      : `measurement and measure again: ${input.clearCommand}`,
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

/** What `clearPublishCeiling` destroyed, and what the ceiling was on either side of it. */
export interface ClearedCeiling {
  readonly removed: readonly PublishOutcomeRow[];
  readonly before: PublishCeiling;
  readonly after: PublishCeiling;
}

/**
 * Fix round 1 — the operator escape, mirroring `clearQuarantine` (cli.ts): an exported function
 * that takes an already-constructed store, so the actual clearing logic is unit-testable without
 * touching a real operator database, plus a thin CLI wrapper that resolves the paths.
 *
 * **Why this has to exist.** `knownCeiling` takes the MINIMUM over `failed` rows, so the bracket
 * is a ratchet that only ever tightens, and a file once refused can never publish and therefore
 * can never generate the counter-evidence that would widen it again. `publishOk` goes false on ANY
 * throw out of `deployer.publish()` (`bcdev-backend.ts`) — a Bun spawn `ENOENT` is a measured
 * instance (R65) — so one transient failure permanently refuses every file that size. That is the
 * SAME hazard `knownCeiling` deliberately excludes `indeterminate` for; the exclusion closed one
 * door in, and a transient spawn failure walks through the other.
 *
 * **Per tier, with an optional per-FILE narrowing, and the blanket clear is the default.** Three
 * reasons, in order of weight:
 *  1. The real-world trigger for clearing is usually that the TOPOLOGY changed — the container was
 *     recycled, the proxy reconfigured — in which case every prior measurement on that tier is
 *     stale, not just one. That is the same workflow `clear-quarantine` serves ("recycle the tier,
 *     then clear"), and a file-only command could not express it.
 *  2. Rows from a MULTI-FILE artifact carry no file at all (`file` is NULL — see `soleFileOf`), so
 *     a file-only command could never reach them: a poisoned ceiling recorded by a multi-file
 *     batch would be permanently unclearable, reintroducing the exact defect this closes.
 *  3. Evidence loss is answered by making it VISIBLE, not by forbidding it. This returns every row
 *     it removed and the ceiling before and after, and the CLI prints all of it — you cannot
 *     destroy a measurement here without being shown what you destroyed.
 *
 * `file` narrows to rows recorded against that exact file, for the surgical case where the
 * operator knows which measurement is bogus and wants to keep the rest of a tier's history.
 */
export function clearPublishCeiling(
  store: PublishOutcomeStore,
  tier: string,
  file: string | undefined,
): ClearedCeiling {
  if (tier.length === 0) {
    throw new Error('clearPublishCeiling: tier must be a non-empty tier identity, got ""');
  }
  const before = knownCeiling(store, tier);
  // Read BEFORE deleting: the report names the rows themselves, not just how many there were.
  const candidates = store.publishOutcomes(tier);
  const removed = file === undefined ? candidates : candidates.filter((r) => r.file === file);
  const deleted = store.deletePublishOutcomes(tier, file);
  // Fail loudly rather than reporting a plausible number: if the DELETE and the SELECT disagree,
  // the rows this claims to have destroyed are not the rows that were destroyed, and an operator
  // deciding whether they lost a real measurement would be reading fiction.
  if (deleted !== removed.length) {
    const scope = file === undefined ? "" : ` file ${file}`;
    throw new Error(
      `clearPublishCeiling: deleted ${deleted} row(s) for tier ${tier}${scope} but identified ` +
        `${removed.length} to report — refusing to report a set that does not match what was removed`,
    );
  }
  return { removed, before, after: knownCeiling(store, tier) };
}

/**
 * The exact `lethal clear-ceiling` invocation for one refusal, so the message a user reads at the
 * moment they are blocked is copy-pasteable rather than a command name to go look up. Lives here,
 * next to the refusal that quotes it, so the command's shape has ONE definition.
 *
 * Fix round 2: `dbPath` is REQUIRED and `--db` is emitted UNCONDITIONALLY — never "only when it
 * differs from the default". The failure it prevents is quiet: a session run with `--db X` records
 * the measurement in X, while the command would resolve to `<project>/lethal.sqlite`, so if a stale
 * default database happens to exist beside the explicit one the operator clears the WRONG file,
 * sees a report of a successful-looking clear, and is refused identically on the next run. A
 * conditional would work only as long as the comparison stayed in step with `parseCliConfig`'s
 * defaulting; emitting it always removes the comparison, and with it the thing that could drift.
 */
export function clearCeilingCommand(args: {
  readonly projectDir: string;
  readonly dbPath: string;
  readonly server: string;
  readonly serverInstance: string;
  readonly file?: string;
}): string {
  const quoted = (s: string) => `"${s}"`;
  const fileArg = args.file === undefined ? "" : ` --file ${quoted(args.file)}`;
  return (
    `lethal clear-ceiling --project ${quoted(args.projectDir)} --db ${quoted(args.dbPath)} ` +
    `--server ${quoted(args.server)} --instance ${quoted(args.serverInstance)}${fileArg}`
  );
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

/**
 * R108: the WARNING for a batch whose TOTAL crosses the bracket while no single file does.
 *
 * `assertUnderCeiling` refuses per FILE, deliberately: batches split at file granularity, so a
 * file that alone exceeds the ceiling cannot be rescued by any flag. But the ceiling is a property
 * of what gets PUBLISHED, and a batch publishes several files at once — so N files each
 * comfortably under the bracket can sum past it and time out, with nothing said beforehand.
 *
 * **This must NEVER refuse, and that is the whole design.** `--max-guards-per-batch` is exactly the
 * lever for a batch total, so refusing here would be the false-refusal direction R90 was careful to
 * avoid: the user has a fix, and the tool should not pre-empt it. R90's own complaint was "nobody
 * can discover the ceiling before paying for it", and for the multi-file batch shape that stayed
 * true after R90 shipped. A warning closes exactly that and nothing more.
 *
 * Returns `undefined` when there is nothing to say: no measured failure on this tier (a fresh
 * topology refuses and warns about nothing), or a total under the bracket.
 */
export function batchCeilingWarning(input: {
  readonly batchIndex: number;
  /** The batch's SUMMED deployed guard count, across every file in it. */
  readonly guardCount: number;
  readonly fileCount: number;
  readonly ceiling: PublishCeiling;
  /** The run's `--max-guards-per-batch`, when one is set — quoted so the lever names its own
   *  current value rather than asking the reader to go and look it up. */
  readonly maxGuardsPerBatch?: number;
}): string | undefined {
  const { smallestFailure, largestSuccess, failureObservedOn } = input.ceiling;
  if (smallestFailure === undefined) return undefined;
  if (input.guardCount < smallestFailure) return undefined;

  const dated = failureObservedOn === undefined ? "" : ` on ${failureObservedOn}`;
  const parts = [
    `[lethal] batch ${input.batchIndex} carries ${input.guardCount} guards across`,
    `${input.fileCount} file(s), and ${smallestFailure} guards were MEASURED to fail to publish on`,
    `this tier${dated}.`,
  ];
  if (largestSuccess !== undefined) {
    parts.push(`The largest measured to publish successfully carried ${largestSuccess}.`);
  }
  parts.push(
    "No single file crosses that on its own, so this is NOT refused — a batch total is exactly",
    "what --max-guards-per-batch is for, and refusing would take a decision that is yours.",
    input.maxGuardsPerBatch === undefined
      ? "If this batch fails to publish, set --max-guards-per-batch below the bracket and rerun."
      : `If this batch fails to publish, lower --max-guards-per-batch (currently ${input.maxGuardsPerBatch}) below the bracket and rerun.`,
  );
  return parts.join(" ");
}
