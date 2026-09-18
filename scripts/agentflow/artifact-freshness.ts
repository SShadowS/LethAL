/**
 * Is the server running the source we are about to judge?
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`, "Artifact freshness needs
 * an expected identity, not just an observed one". Pure: the caller gathers the three inputs and
 * this decides.
 *
 * ## The failure this exists for
 *
 * R56. A docs-only commit deleted a procedure's body, `fixtures/sandbox-data-tests` stopped
 * compiling, and `itest:tables` kept passing for days, because LethAL publishes the TARGET on every
 * run but treats publishing the TEST APP as the user's own workflow. The server held an older,
 * working build of every test. Nothing diverged, so nothing could notice.
 *
 * The important part is that NOTHING MOVED. Every frozen verdict matched. No prediction logic
 * fires, no control run helps, no baseline comparison sees anything, because the measurement was
 * correct about a build nobody could reproduce.
 *
 * ## Why neither version nor hash alone answers it
 *
 * The version does not, because R56's shape is source changing WITHOUT a bump. Measured on
 * Cronus285: `LethAL Sandbox Data Tests` reports `1.0.0.17`, exactly its `app.json` version, so a
 * version comparison agrees with itself while describing different code.
 *
 * A hash of the local build does not either, because nothing the server reports is comparable to
 * it. BC reports a `PackageId`, a fresh GUID per publish, which says WHICH publish without saying
 * what went into it.
 *
 * So the join has to be recorded rather than derived: when the executor publishes, it writes down
 * the source hash it built from against the `PackageId` BC gave back. Later, "is the server running
 * this source?" becomes a lookup instead of an inference.
 *
 * ## The honest fourth answer
 *
 * An app published by a human has no ledger entry, and the executor cannot vouch for it. That is
 * `unverified-publish`, and it BLOCKS rather than passing. Treating an unknown publish as fine
 * would reopen R56 through the exact door it came in the first time: someone publishing the test
 * app by hand as their own workflow.
 */

/** What candidate source says an app should be, from `compile-fixtures --inventory`. */
export interface ExpectedApp {
  readonly app: string;
  readonly version: string;
  readonly sourceHash: string;
}

/** What the executor recorded when it published. One entry per publish, newest last. */
export interface LedgerEntry {
  readonly app: string;
  readonly sourceHash: string;
  readonly version: string;
  readonly packageId: string;
}

/** What the container reports right now. */
export interface ObservedApp {
  readonly app: string;
  readonly version: string;
  readonly packageId: string;
}

export type Freshness =
  /** The running package was published from exactly this source. */
  | { readonly app: string; readonly verdict: "fresh" }
  /** The running package was published from DIFFERENT source. This is R56. */
  | {
      readonly app: string;
      readonly verdict: "stale";
      readonly runningSourceHash: string;
      readonly expectedSourceHash: string;
    }
  /** Nobody recorded publishing this package, so nothing can vouch for what is in it. */
  | { readonly app: string; readonly verdict: "unverified-publish"; readonly packageId: string }
  /** Candidate source builds it and the server does not have it. */
  | { readonly app: string; readonly verdict: "missing" }
  /** The server has it and candidate source does not build it. */
  | { readonly app: string; readonly verdict: "unexpected" };

/** Only `fresh` lets a gate's result be believed. */
export function isAcceptable(f: Freshness): boolean {
  return f.verdict === "fresh";
}

/**
 * Classify every app named by either side.
 *
 * Both directions are walked on purpose. An app the server has and the source does not build is
 * not automatically harmless: on a container where at most one instrumented target may be
 * installed, a leftover is exactly what trips an attestation mismatch on a run nobody can explain.
 */
export function classifyFreshness(
  expected: readonly ExpectedApp[],
  ledger: readonly LedgerEntry[],
  observed: readonly ObservedApp[],
): readonly Freshness[] {
  const byApp = new Map<string, ExpectedApp>();
  for (const e of expected) byApp.set(e.app, e);
  const seen = new Map<string, ObservedApp>();
  for (const o of observed) seen.set(o.app, o);

  // Last write wins: a package id can only have been produced by one publish, but an app may have
  // been published many times, and the newest record is the one describing what is installed.
  const byPackage = new Map<string, LedgerEntry>();
  for (const l of ledger) byPackage.set(l.packageId, l);

  const out: Freshness[] = [];

  for (const app of [...new Set([...byApp.keys(), ...seen.keys()])].sort()) {
    const want = byApp.get(app);
    const have = seen.get(app);

    if (want === undefined) {
      out.push({ app, verdict: "unexpected" });
      continue;
    }
    if (have === undefined) {
      out.push({ app, verdict: "missing" });
      continue;
    }

    const record = byPackage.get(have.packageId);
    if (record === undefined) {
      out.push({ app, verdict: "unverified-publish", packageId: have.packageId });
      continue;
    }
    if (record.sourceHash !== want.sourceHash) {
      out.push({
        app,
        verdict: "stale",
        runningSourceHash: record.sourceHash,
        expectedSourceHash: want.sourceHash,
      });
      continue;
    }
    out.push({ app, verdict: "fresh" });
  }

  return out;
}

/** One line per problem, for the ledger and for a blocked run's reasons. Empty means every app is fresh. */
export function freshnessProblems(results: readonly Freshness[]): readonly string[] {
  return results
    .filter((f) => !isAcceptable(f))
    .map((f) => {
      switch (f.verdict) {
        case "stale":
          return (
            `${f.app}: the server is running a build made from ${f.runningSourceHash}, but candidate ` +
            `source is ${f.expectedSourceHash}. The gate would measure a build nobody can reproduce (R56).`
          );
        case "unverified-publish":
          return `${f.app}: package ${f.packageId} was not published by this flow, so nothing records what source went into it. Republish it through the executor before gating on it.`;
        case "missing":
          return `${f.app}: candidate source builds it and the server does not have it.`;
        case "unexpected":
          return `${f.app}: the server has it and candidate source does not build it.`;
        default:
          return `${f.app}: unclassified`;
      }
    });
}
