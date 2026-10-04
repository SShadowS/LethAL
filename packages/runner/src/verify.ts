import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { MutantManifest, MutantManifestEntry, SelectorConfig } from "@lethal/schemata";
import { InstalledArtifactError } from "./artifact";
import { killMessageOf, looksLikeAssertionFailure } from "./assertion-screen";
import type { CoverageMode, ExecutionBackend, TestMethodRef } from "./backend";
import { hashTargetSource } from "./baseline-snapshot";
import type { BcDevMcpBackend } from "./bcdev-backend";
import {
  DependencyUnreadableError,
  dependencyFingerprint,
  publishedPackageReader,
  readAppJsonInputs,
  targetOf,
} from "./digest-inputs";
import { discoverTests } from "./discovery";
import {
  type EquivalenceMark,
  EquivalenceMarksError,
  loadEquivalenceMarks,
  marksSchemeWarning,
  marksSymbolsWarning,
  marksUnderOtherScheme,
  marksUnderOtherSymbols,
} from "./equivalence-marks";
import { createEmitter } from "./events";
import { type GapRow, tallyGaps } from "./gaps";
import { type AlSource, coverageRefusedObjects } from "./line-map";
import {
  type InstalledArtifactRef,
  type NamedMutantRequest,
  loadInstalledArtifact,
  predatesR360Detail,
  prunedDetail,
} from "./named-mutants";
import {
  type LeaseSessionConfig,
  type NamedMutantsConfig,
  type UnmutatedRun as NamedUnmutatedRun,
  type SessionConfig,
  qualifiedTestName,
  runNamedMutants,
} from "./orchestrator";
import { effectiveBuildSymbols, sameBuildSymbols } from "./preprocessor-symbols";
import { type SessionOutcome, mutantRef } from "./report";
import { identityKeyOf, serializeKey, testKeyOf } from "./selection";
import { DuplicateArtifactRecordError, type ResultsStore } from "./store";
import {
  type CompiledTestApp,
  type PublishedTestApp,
  TestAppError,
  type TestAppRefusal,
} from "./test-app-publish";
import {
  type NewTestCause,
  TEST_DIGEST_SCHEME,
  explainNewTests,
  isCurrentDigest,
  parseDigestParts,
  testDigestKey,
  testDigestsOfModel,
} from "./test-digest";
import { buildTestAppModel, readTestAppSources, scanTestPageModel } from "./testpage-scan";
import { TESTPAGE_REFUSED_DIAGNOSIS } from "./testpage-unsupported";
import {
  type ReachFilterOffReason,
  type ReachFilterState,
  type ReachResult,
  type ReachState,
  narrowVerifyRequests,
  reachStateOf,
} from "./verify-reach";

/** C02-06 decision 7: every reason `lethal verify` can refuse for, before it measures anything. */
export const VERIFY_REFUSALS = [
  "malformed-request",
  "unknown-artifact",
  "batch-not-installed",
  "wrong-batch",
  "unknown-mutant",
  "not-a-survivor",
  // C02-09: a gap id the installed artifact has no block for, and a block with no survivor.
  "unknown-gap",
  "gap-has-no-survivor",
  "carried",
  "source-predates-verify",
  "source-changed",
  "covering-test-unmatched",
  "no-tests-to-run",
  "unsupported-config",
  "project-unreadable",
  "equivalence-marks-unreadable",
  // InstalledArtifactError
  "stale-artifact",
  "artifact-files-unusable",
  "artifact-identity-unavailable",
  // TestAppError
  "test-app-manifest-unreadable",
  "test-app-symbols-unreadable",
  "test-app-compile-failed",
  "test-app-version-below-resident",
  "test-app-publish-failed",
  "test-app-resident-unreadable",
  // R354: the source run was measured under another coverage mode, or an unrecorded one.
  "coverage-mode-changed",
  // R-371: more tests are new or edited than --max-new-tests allows.
  "too-many-new-tests",
  // R-371: a non-Microsoft dependency's package on the server could not be read and hashed.
  "dependency-unreadable",
] as const;

export type VerifyRefusal = (typeof VERIFY_REFUSALS)[number];

/** A refusal before any measurement. Extends Error directly, never another typed error. */
export class VerifyError extends Error {
  constructor(
    readonly reason: VerifyRefusal,
    readonly detail: string,
  ) {
    super(`verify refused (${reason}): ${detail}`);
    this.name = "VerifyError";
  }
}

/**
 * Carried item 2: what each `InstalledArtifactError` reason refuses as. A `Record` over the error's
 * own reason union, so a reason added there fails the typecheck here until it is mapped.
 */
export const INSTALLED_ARTIFACT_REFUSALS: Readonly<
  Record<InstalledArtifactError["reason"], VerifyRefusal>
> = {
  // loadInstalledArtifact: the trusted record lacks a manifest hash or app id (an older row).
  "no-record": "source-predates-verify",
  "local-copy-unreadable": "artifact-files-unusable",
  "local-copy-differs": "artifact-files-unusable",
  "manifest-differs": "artifact-files-unusable",
  "payload-differs": "artifact-files-unusable",
  "payload-too-large": "artifact-files-unusable",
  replaced: "artifact-files-unusable",
  mismatch: "stale-artifact",
  unavailable: "artifact-identity-unavailable",
  // The backend cannot attach to an installed artifact: only bcdev can, and verify is bcdev only.
  unsupported: "unsupported-config",
};

/**
 * Carried item 2: what each `TestAppRefusal` refuses as. The two that leave the container marked
 * for a recycle are not refusals: they quarantine (exit 3). Exhaustive by type, like the above.
 */
export const TEST_APP_REFUSALS: Readonly<Record<TestAppRefusal, VerifyRefusal | "quarantined">> = {
  "manifest-unreadable": "test-app-manifest-unreadable",
  "symbols-unreadable": "test-app-symbols-unreadable",
  "compile-failed": "test-app-compile-failed",
  unsupported: "unsupported-config",
  "resident-unreadable": "test-app-resident-unreadable",
  "version-below-resident": "test-app-version-below-resident",
  "publish-failed": "test-app-publish-failed",
  "publish-indeterminate": "quarantined",
  "publish-anomalous": "quarantined",
};

const REFUSAL_HINTS: Partial<Record<VerifyRefusal, string>> = {
  "stale-artifact":
    "the server holds another build now; run lethal run again, then verify with its artifact id",
  "artifact-files-unusable":
    "the run's installed files in the store are pruned, over a limit or changed; run lethal run again, then verify",
  "unknown-gap":
    "copy the gap id and its artifactId from one lethal explain gap of the run that published this artifact; an edited or moved block, or other line endings, give a new id, and only the run's last batch stays installed",
  "gap-has-no-survivor":
    "every recorded mutant in this block is killed, not measured or no-coverage; there is nothing to verify as a gap",
  "dependency-unreadable":
    "check the dev credentials with lethal doctor, and that every non-Microsoft dependency of the test app is installed on the server",
};

/**
 * Carried item 2: every typed error verify catches, as a refusal or a quarantine. `undefined` for
 * anything else, which the caller rethrows (exit 1): a bug is never dressed up as a refusal.
 */
export function verifyRefusalOf(
  err: unknown,
):
  | { readonly kind: "refused"; readonly reason: VerifyRefusal; readonly detail: string }
  | { readonly kind: "quarantined"; readonly detail: string }
  | undefined {
  const refused = (reason: VerifyRefusal, detail: string) => {
    const hint = REFUSAL_HINTS[reason];
    return {
      kind: "refused" as const,
      reason,
      detail: hint === undefined ? detail : `${detail}; ${hint}`,
    };
  };
  if (err instanceof VerifyError) return refused(err.reason, err.detail);
  // NOT NamedMutantError: verify refuses every user-reachable cause of one upstream, so one that
  // reaches here means verify built a bad call. A bug, rethrown (exit 1), never a refusal.
  if (err instanceof EquivalenceMarksError) {
    return refused("equivalence-marks-unreadable", err.message);
  }
  if (err instanceof DependencyUnreadableError) {
    return refused("dependency-unreadable", err.message);
  }
  if (err instanceof InstalledArtifactError) {
    return refused(INSTALLED_ARTIFACT_REFUSALS[err.reason], err.message);
  }
  if (err instanceof TestAppError) {
    const to = TEST_APP_REFUSALS[err.reason];
    return to === "quarantined"
      ? { kind: "quarantined", detail: err.message }
      : refused(to, err.message);
  }
  return undefined;
}

export interface VerifyRequest {
  readonly artifactId: string;
  readonly ids: ReadonlyArray<{ readonly batchIndex: number; readonly mutantCode: string }>;
  /** C02-09: gap ids, each replaced by its survivors by `expandGapIds` before anything resolves. */
  readonly gapIds: readonly string[];
}

const ARTIFACT_ID = /^[0-9a-f]{32}$/;
const SURVIVOR_ID = /^(0|[1-9]\d*)\/(M\d{4,})$/;
const GAP_ID = /^G[0-9a-f]{12}$/;

/**
 * Decisions 1 and 2. The artifact is 32 lowercase hex. Each `--survivors` value is a comma list of
 * `<batchIndex>/<mutantCode>` ids or gap ids (C02-09), and repeated flags add to one list. An empty
 * list, a malformed id or the same id twice is refused, never dropped or merged.
 */
export function parseVerifyRequest(artifact: string, survivors: readonly string[]): VerifyRequest {
  if (!ARTIFACT_ID.test(artifact)) {
    throw new VerifyError(
      "malformed-request",
      `--artifact "${artifact}" is not a 32-character lowercase hex artifact id`,
    );
  }
  const raw = survivors.flatMap((v) => v.split(",")).map((s) => s.trim());
  if (raw.length === 0) {
    throw new VerifyError("malformed-request", "--survivors names no mutant and no gap");
  }
  const bad = raw.filter((s) => !SURVIVOR_ID.test(s) && !GAP_ID.test(s));
  if (bad.length > 0) {
    throw new VerifyError(
      "malformed-request",
      `not a <batchIndex>/<mutantCode> id (for example 0/M0004) or a gap id (for example G0123456789ab): ${bad.map((s) => `"${s}"`).join(", ")}`,
    );
  }
  const repeated = [...new Set(raw.filter((s, i) => raw.indexOf(s) !== i))];
  if (repeated.length > 0) {
    throw new VerifyError("malformed-request", `named more than once: ${repeated.join(", ")}`);
  }
  const ids = raw
    .filter((s) => SURVIVOR_ID.test(s))
    .map((s) => {
      const [batch, code] = s.split("/");
      if (batch === undefined || code === undefined) throw new Error(`verify.ts: unparsed id ${s}`);
      return { batchIndex: Number(batch), mutantCode: code };
    });
  return { artifactId: artifact, ids, gapIds: raw.filter((s) => GAP_ID.test(s)) };
}

export interface VerifySource {
  readonly runId: number;
  readonly projectPath: string;
  readonly artifactSha256: string;
  readonly sourceSha256: string;
  readonly installed: InstalledArtifactRef;
  /** R325: the identity scheme the source run's manifest keys were made under. A reader mark is
   *  applied only when it was made under the same one. */
  readonly identityScheme: number;
  /** R214: the source run's effective build symbols, or null when not recorded (then no mark
   *  applies). */
  readonly buildSymbols: readonly string[] | null;
  /** R354: the coverage mode the source run measured under; `null` for a run from before R354. */
  readonly coverageMode: CoverageMode | null;
  readonly targets: ReadonlyArray<{
    readonly batchIndex: number;
    readonly mutantCode: string;
    readonly coveringTests: readonly string[];
  }>;
}

// Which reason a refusal carries when ids fail for different reasons. The detail names them all.
const PER_ID_ORDER: readonly VerifyRefusal[] = [
  "wrong-batch",
  "unknown-mutant",
  "source-predates-verify",
  "carried",
  "not-a-survivor",
];

/**
 * Decision 3. Resolves the request inside the NAMED artifact only, never by recency. Store only:
 * never touches a file or a server. A per-id refusal names every offending id, not only the first.
 */
/**
 * The store's record of one artifact id, or `unknown-artifact` when there is none or the store
 * holds it twice. `lethal verify` reads the source run's project path from it before any config.
 */
export function artifactRecordOf(
  store: ResultsStore,
  artifactId: string,
): NonNullable<ReturnType<ResultsStore["artifactRecordById"]>> {
  let rec: ReturnType<ResultsStore["artifactRecordById"]>;
  try {
    rec = store.artifactRecordById(artifactId);
  } catch (e) {
    if (e instanceof DuplicateArtifactRecordError) {
      throw new VerifyError(
        "unknown-artifact",
        `the store records this id twice, so it cannot name one source (a corrupt store): ${e.message}`,
      );
    }
    throw e;
  }
  if (rec === null) {
    throw new VerifyError(
      "unknown-artifact",
      `the store records no artifact ${artifactId}; copy the id from the run's report (artifacts[].artifactId)`,
    );
  }
  return rec;
}

/**
 * The artifact's record, refused unless it is still the installed batch and the run recorded its
 * installed files and source hash. Store only. Shared by `expandGapIds` and `resolveVerifySource`.
 */
function installedOf(store: ResultsStore, artifactId: string) {
  const rec = artifactRecordOf(store, artifactId);
  if (rec.batchIndex !== rec.highestBatchIndex) {
    throw new VerifyError(
      "batch-not-installed",
      `artifact ${artifactId} is batch ${rec.batchIndex} of run ${rec.runId}, but batch ${rec.highestBatchIndex} was published after it and replaced it on the server`,
    );
  }
  // Checked BEFORE reading any mutant row: a store from before C02-06 must get this typed
  // refusal, not batchMutantRows' throw on an old row. R360: the installed files are the stored
  // bundle, so a row without its payload digest predates R360 (no path fallback), and a pruned
  // row names the run that replaced it. `loadInstalledArtifact` refuses both again, typed.
  const { sourceSha256 } = rec;
  if (rec.payloadSha256 === null) {
    throw new VerifyError("source-predates-verify", predatesR360Detail(rec.runId, rec.batchIndex));
  }
  if (rec.bundlePrunedBy !== null) {
    throw new VerifyError(
      "artifact-files-unusable",
      prunedDetail(rec.runId, rec.batchIndex, rec.bundlePrunedBy, rec.resourceKey),
    );
  }
  if (sourceSha256 === null) {
    throw new VerifyError(
      "source-predates-verify",
      `run ${rec.runId} did not record its source hash. That happens when the run was recorded before lethal verify existed, its source changed during the run, the run stopped before the last batch, or its source tree was unreadable; run lethal run again, then verify`,
    );
  }
  // R360: labels for messages only; the bytes come from the store.
  const installed: InstalledArtifactRef = {
    fromRunId: rec.runId,
    batchIndex: rec.batchIndex,
    appPath: rec.appPath ?? "(not recorded)",
    instrumentedDir: rec.instrumentedDir ?? "(not recorded)",
  };
  return { rec, sourceSha256, installed };
}

/**
 * R261. The selector, control and table ids the INSTALLED build was compiled with, read from its
 * hash-checked manifest (`writeInstrumentedProject` writes them there). Never the config's: a
 * source run given `--selector-id` overrides was built with those, and only they validate against
 * the app.json that made the overrides necessary. A trusted manifest always holds them (they
 * predate the manifest hash), so a missing or malformed set is refused, never defaulted.
 */
export async function installedSelectorIds(
  store: ResultsStore,
  artifactId: string,
): Promise<SelectorConfig> {
  const { manifest } = await loadInstalledArtifact(store, installedOf(store, artifactId).installed);
  const ids = (manifest as { selectorIds?: Partial<SelectorConfig> }).selectorIds;
  const valid = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
  if (ids === undefined || !valid(ids.selectorId) || !valid(ids.controlId) || !valid(ids.tableId)) {
    throw new VerifyError(
      "artifact-files-unusable",
      `artifact ${artifactId}'s manifest records no valid selector ids (${JSON.stringify(ids)}), so the ids the installed build was made with are unknown; run lethal run again, then verify`,
    );
  }
  return { selectorId: ids.selectorId, controlId: ids.controlId, tableId: ids.tableId };
}

/**
 * C02-09. Replaces each gap id by its survivors, `<batchIndex>/<mutantCode>` in `tallyGaps` order,
 * appended after the request's own ids. Reads the NAMED artifact's hash-checked manifest and this
 * run's store rows, never another run and never a server. Refuses every offending gap id at once.
 */
export async function expandGapIds(
  store: ResultsStore,
  req: VerifyRequest,
): Promise<VerifyRequest> {
  // Nothing to expand: no manifest read, so mutant ids keep working against any artifact.
  if (req.gapIds.length === 0) return req;
  const { rec, installed } = installedOf(store, req.artifactId);
  // ponytail: runVerify loads the manifest again later; one extra local hash of the .app. Pass it
  // through if it ever shows in timings.
  const { manifest } = await loadInstalledArtifact(store, installed);
  if (manifest.mutants.some((m) => m.gapId === undefined)) {
    throw new VerifyError(
      "source-predates-verify",
      `artifact ${req.artifactId}'s manifest was written before gap ids existed, so ${req.gapIds.join(", ")} cannot be expanded against it; name its mutants as <batchIndex>/<mutantCode> ids, or run lethal run again`,
    );
  }
  const entries = new Map(manifest.mutants.map((m) => [m.mutantId, m] as const));
  const rows = store.batchMutantRows(rec.runId, rec.batchIndex);
  const gapRows: GapRow[] = rows.map((r) => {
    const entry = entries.get(r.mutantCode);
    const gapId = entry?.gapId;
    if (entry === undefined || gapId === undefined) {
      throw new Error(
        `verify.ts: run ${rec.runId} batch ${rec.batchIndex} records ${r.mutantCode}, which artifact ${req.artifactId}'s manifest does not hold (a corrupt store)`,
      );
    }
    return {
      mutantCode: r.mutantCode,
      verdict: r.verdict,
      gapId,
      batchIndex: rec.batchIndex,
      // The report row's `line` is the same `startLine`, so explain orders members the same way.
      line: entry.startLine,
    };
  });
  // Two rows for one mutant is corruption. A manifest entry with NO row is "not measured" only
  // when the run did not finish: a run that quarantined or threw partway through its last batch
  // still records the artifact but never reaches `finishRun`, so `finished_at` stays NULL. On a
  // FINISHED run every manifest entry was scored, so a missing row is a lost row (a corrupt store),
  // and treating it as not measured would silently drop a survivor.
  const recorded = new Set(rows.map((r) => r.mutantCode));
  if (recorded.size !== rows.length) {
    throw new Error(
      `verify.ts: run ${rec.runId} batch ${rec.batchIndex} records ${rows.length} row(s) for ${recorded.size} mutant(s): a mutant twice (a corrupt store)`,
    );
  }
  const run = store.getRun(rec.runId);
  if (run === null) {
    throw new Error(
      `verify.ts: artifact ${req.artifactId} names run ${rec.runId}, which the store does not hold (a corrupt store)`,
    );
  }
  if (run.finished) {
    const missing = manifest.mutants.filter((m) => !recorded.has(m.mutantId));
    if (missing.length > 0) {
      throw new Error(
        `verify.ts: run ${rec.runId} finished, but batch ${rec.batchIndex} records no row for ${missing.map((m) => m.mutantId).join(", ")} of artifact ${req.artifactId}'s manifest (a corrupt store)`,
      );
    }
  }
  const tallies = tallyGaps(gapRows);
  const known = new Set(manifest.mutants.map((m) => m.gapId));

  const unknown = req.gapIds.filter((g) => !known.has(g));
  if (unknown.length > 0 || req.gapIds.some((g) => (tallies.get(g)?.members.length ?? 0) === 0)) {
    const empty = req.gapIds.flatMap((g) => {
      if (!known.has(g)) return [];
      const t = tallies.get(g) ?? {
        members: [],
        noCoverageMembers: [],
        killed: 0,
        noCoverage: 0,
        other: 0,
      };
      if (t.members.length > 0) return [];
      const unmeasured = manifest.mutants.filter(
        (m) => m.gapId === g && !recorded.has(m.mutantId),
      ).length;
      const noCov =
        t.noCoverage > 0
          ? `; its no-coverage mutants (${t.noCoverageMembers.map((c) => mutantRef(rec.batchIndex, c)).join(", ")}) are in lethal explain's noCoverageBlocks and can be named one by one`
          : "";
      return [
        `${g} (gap-has-no-survivor: survived 0, killed ${t.killed}, no-coverage ${t.noCoverage}, other ${t.other}${unmeasured > 0 ? `, not measured ${unmeasured}` : ""}${noCov})`,
      ];
    });
    const parts = [
      ...unknown.map(
        (g) => `${g} (unknown-gap: no block of artifact ${req.artifactId} has this gap id)`,
      ),
      ...empty,
    ];
    throw new VerifyError(
      unknown.length > 0 ? "unknown-gap" : "gap-has-no-survivor",
      parts.join("; "),
    );
  }

  const direct = new Set(req.ids.map((i) => mutantRef(i.batchIndex, i.mutantCode)));
  const expanded = req.gapIds.flatMap((g) =>
    (tallies.get(g)?.members ?? []).map((mutantCode) => ({
      gapId: g,
      batchIndex: rec.batchIndex,
      mutantCode,
    })),
  );
  const twice = expanded.filter((e) => direct.has(mutantRef(e.batchIndex, e.mutantCode)));
  if (twice.length > 0) {
    throw new VerifyError(
      "malformed-request",
      `named both directly and through its gap: ${twice.map((e) => `${e.batchIndex}/${e.mutantCode} and ${e.gapId}`).join(", ")}`,
    );
  }
  return {
    artifactId: req.artifactId,
    ids: [
      ...req.ids,
      ...expanded.map(({ batchIndex, mutantCode }) => ({ batchIndex, mutantCode })),
    ],
    gapIds: [],
  };
}

export function resolveVerifySource(store: ResultsStore, req: VerifyRequest): VerifySource {
  // parseVerifyRequest refuses this too; a caller building the request directly must not get a
  // source with no targets, which planVerify could only answer as "every target was skipped".
  if (req.ids.length === 0) {
    throw new VerifyError("malformed-request", "the request names no mutant");
  }
  const { rec, sourceSha256, installed } = installedOf(store, req.artifactId);

  const rows = new Map<string, ReturnType<ResultsStore["batchMutantRows"]>[number]>();
  for (const r of store.batchMutantRows(rec.runId, rec.batchIndex)) {
    if (rows.has(r.mutantCode)) {
      throw new Error(
        `verify.ts: run ${rec.runId} batch ${rec.batchIndex} records mutant ${r.mutantCode} twice`,
      );
    }
    rows.set(r.mutantCode, r);
  }

  const offending: Array<{ id: string; reason: VerifyRefusal; why: string }> = [];
  const targets: Array<VerifySource["targets"][number]> = [];
  for (const { batchIndex, mutantCode } of req.ids) {
    const id = mutantRef(batchIndex, mutantCode);
    const refuse = (reason: VerifyRefusal, why: string) => {
      offending.push({ id, reason, why });
    };
    if (batchIndex !== rec.batchIndex) {
      refuse(
        "wrong-batch",
        `artifact ${req.artifactId} is batch ${rec.batchIndex}, not ${batchIndex}`,
      );
      continue;
    }
    const row = rows.get(mutantCode);
    if (row === undefined) {
      refuse("unknown-mutant", `batch ${batchIndex} of run ${rec.runId} has no ${mutantCode}`);
    } else if (row.carried === null) {
      refuse("source-predates-verify", "recorded before the carried column existed");
    } else if (row.carried) {
      refuse("carried", "carried by --resume from an earlier run, not measured by this artifact");
    } else if (row.verdict === "known-survivor") {
      refuse(
        "not-a-survivor",
        "known-survivor was skipped, not measured; re-run without --skip-known-survivors",
      );
    } else if (row.verdict !== "survived" && row.verdict !== "no-coverage") {
      refuse("not-a-survivor", `its verdict is ${row.verdict}`);
    } else {
      targets.push({ batchIndex, mutantCode, coveringTests: row.coveringTests });
    }
  }
  const first = PER_ID_ORDER.find((reason) => offending.some((o) => o.reason === reason));
  if (first !== undefined) {
    throw new VerifyError(
      first,
      offending.map((o) => `${o.id} (${o.reason}: ${o.why})`).join("; "),
    );
  }

  const run = store.getRun(rec.runId);
  if (run === null) {
    throw new Error(
      `verify.ts: artifact ${req.artifactId} names run ${rec.runId}, which the store does not hold (a corrupt store)`,
    );
  }
  return {
    runId: rec.runId,
    // Carried item 1: stored as typed, so possibly relative. Resolved once, here.
    projectPath: resolve(rec.projectPath),
    artifactSha256: rec.artifactSha256,
    sourceSha256,
    installed,
    identityScheme: run.identityScheme,
    buildSymbols: run.buildSymbols,
    coverageMode: run.coverageMode,
    targets,
  };
}

/**
 * Carried item 1: a missing project directory or app.json is a `project-unreadable` refusal, not
 * an ENOENT from the hash or a plain error from the backend build. `lethal verify` runs it before
 * it builds anything; `assertSourceUnchanged` runs it again before hashing.
 */
export async function assertProjectReadable(projectPath: string): Promise<void> {
  for (const [path, want] of [
    [projectPath, "directory"],
    [join(projectPath, "app.json"), "file"],
  ] as const) {
    const st = await stat(path).catch(() => undefined);
    if (st === undefined || (want === "directory" ? !st.isDirectory() : !st.isFile())) {
      throw new VerifyError(
        "project-unreadable",
        `${path} is missing or not a ${want}: the source run's project path is stored as it was typed and resolved against the current directory; run verify from where lethal run ran, or run lethal run again`,
      );
    }
  }
}

/**
 * Decision 8. Recomputes the target's source hash with the SAME function and preprocessor symbols
 * the source run recorded it with. Reads the project's files; never a server.
 */
export async function assertSourceUnchanged(
  source: VerifySource,
  preprocessorSymbols: readonly string[],
  /** The test project, only to say so when it lies inside the target (carried item 3). */
  testDir?: string,
): Promise<void> {
  await assertProjectReadable(source.projectPath);
  const now = await hashTargetSource(source.projectPath, preprocessorSymbols);
  if (now !== source.sourceSha256) {
    // Carried item 3: one whole-source hash cannot say WHICH file changed, so this says the one
    // thing it can: a nested test project is part of the hash, and a test edit alone refuses.
    const tests = testDir === undefined ? undefined : resolve(testDir);
    const rel = tests === undefined ? undefined : relative(source.projectPath, tests);
    const nested =
      tests !== undefined &&
      rel !== undefined &&
      rel !== "" &&
      !rel.startsWith("..") &&
      !isAbsolute(rel)
        ? ` The test project ${tests} lies inside the target project, so its .al files are part of the target's source hash: editing or adding a test there refuses too, even when no target file changed. Move the test project beside the target, or run lethal run again after editing tests.`
        : "";
    throw new VerifyError(
      "source-changed",
      `the installed build was made from other source than ${source.projectPath} holds now (a .al file, app.json or a preprocessor symbol changed; a version-only bump counts too); run lethal run again, then verify with its artifact id.${nested}`,
    );
  }
}

export interface VerifyPlan {
  /** One request per survivor that runs. `[]` only when every target was skipped or all-refused,
   *  and then `skipped` or `allRefused` is non-empty: an empty request is refused, never planned. */
  readonly requests: readonly NamedMutantRequest[];
  readonly newTests: readonly TestMethodRef[];
  readonly skipped: ReadonlyArray<{
    readonly entry: MutantManifestEntry;
    readonly mark: EquivalenceMark;
  }>;
  /** Every target's trusted manifest entry, skipped or not, by mutant code. */
  readonly entries: ReadonlyMap<string, MutantManifestEntry>;
  /** R-236c: every discovered test with a reachable call that may open a TestPage, by
   *  `testKeyOf`. None of them is planned. */
  readonly testPageRefused: ReadonlyMap<string, { readonly test: string; readonly reason: string }>;
  /** R-236c: mutant code to the qualified names of the requested methods refused for it. */
  readonly notRun: ReadonlyMap<string, readonly string[]>;
  /** R-236c: mutant codes with no method left once the refused ones are taken out. */
  readonly allRefused: ReadonlySet<string>;
  /** R325: marks made under an identity scheme other than the source run's, and (R214) under other
   *  build symbols than its build. None is applied. */
  readonly marksUnderOtherScheme: readonly EquivalenceMark[];
  /** R-384: per requested mutant code, its source covering tests that run, in request order. The
   *  reach filter never removes one of these. */
  readonly covering: ReadonlyMap<string, readonly TestMethodRef[]>;
  /** R-384: the cap's numbers, for check 2 after the filter and the state line. Its `s` is S,
   *  fixed here before any filtering, never recomputed. */
  readonly cap: CapNumbers;
}

/** R-384 The cap: what every too-many-new-tests text is built from. */
export interface CapNumbers {
  readonly runId: number;
  /** N: new tests, TestPage-refused ones excluded. */
  readonly n: number;
  /** S: `running.length` in `planVerify`, fixed before any filtering (review 3). */
  readonly s: number;
  readonly max: number;
  /** Built only when a check refuses: `explainNewTests` is not free. */
  readonly editClasses: () => { readonly classes: string; readonly helpers: string };
}

/**
 * Decisions 5 and 6. `manifest` is the one `loadInstalledArtifact` matched. Reads the project's
 * CURRENT marks file and the test project's `.al` files; never a server.
 *
 * A survivor a reader marked equivalent is skipped. Every other one runs its source-run covering
 * tests, each matched to the source baseline by `(codeunitId, method)` and required unchanged in
 * the test project, then every new test: not in the source baseline by `testKeyOf`, OR edited
 * since the source run (R-278/R258: its source digest differs from the one the run recorded).
 */
export async function planVerify(a: {
  readonly source: VerifySource;
  readonly manifest: MutantManifest;
  readonly sourceBaseline: ReturnType<ResultsStore["baselineTests"]>;
  /** R-278: the source run's recorded test digests (`store.testDigests`); `null` for a run that
   *  predates them, which is refused. */
  readonly sourceTestDigests: Readonly<Record<string, string>> | null;
  /** R-371: the parts those digests are made of (`store.testDigestParts`); only explains a
   *  too-many-new-tests refusal. */
  readonly sourceTestDigestParts?: unknown;
  readonly testDir: string;
  /** R-371: this verify's dependency fingerprint (`verifyDependencyFingerprint`), or a function
   *  that reads it. A function is called only after every refusal that reads no package (the
   *  digest-scheme check included), so `source-predates-verify` wins over `dependency-unreadable`
   *  and costs no download. */
  readonly dependencies: string | (() => Promise<string>);
  /** R-371: the cap: refuse above `maxNewTests x (S + 2)` extra test runs (R-384 counts runs, not
   *  tests). Default `DEFAULT_MAX_NEW_TESTS`. */
  readonly maxNewTests?: number;
  /** R403: the test app's derived symbol set (`effectiveBuildSymbols(testDir, ...)`), under which
   *  discovery evaluates the test files' arms. Absent means `[]`. */
  readonly testBuildSymbols?: readonly string[];
  /** R-384: verify's coverage mode (`backend.capabilities().coverage`), which with
   *  `noReachFilter` decides whether the reach filter is on, and so which cap check runs here. */
  readonly coverage: CoverageMode;
  /** R-384: `--no-reach-filter`. */
  readonly noReachFilter?: boolean;
}): Promise<VerifyPlan> {
  const { source, manifest, sourceBaseline, sourceTestDigests, testDir } = a;
  const maxNewTests = a.maxNewTests ?? DEFAULT_MAX_NEW_TESTS;
  // An empty target list would return the same `requests: []` as "every target was skipped", and
  // only the second is a real answer. A skipped-all plan always has a non-empty `skipped`.
  if (source.targets.length === 0) {
    throw new VerifyError("malformed-request", `run ${source.runId}: the source names no mutant`);
  }

  const byId = new Map(manifest.mutants.map((m) => [m.mutantId, m] as const));
  const entries = new Map<string, MutantManifestEntry>();
  for (const t of source.targets) {
    const entry = byId.get(t.mutantCode);
    if (entry === undefined) {
      throw new Error(
        `verify.ts: run ${source.runId} records ${t.mutantCode}, but artifact ${manifest.artifactId}'s manifest has no such mutant`,
      );
    }
    entries.set(t.mutantCode, entry);
  }

  // Decision 6. A missing file is no marks; a malformed or unreadable one throws.
  // R325: a mark made under another identity scheme may name another mutant; it is not applied.
  const marks = (await loadEquivalenceMarks(source.projectPath)) ?? [];
  // R214: likewise a mark made under other preprocessor symbols than the source run's build.
  const staleMarks = marks.filter(
    (m) =>
      m.identityScheme !== source.identityScheme ||
      source.buildSymbols === null ||
      !sameBuildSymbols(m.preprocessorSymbols ?? [], source.buildSymbols),
  );
  const markByKey = new Map(
    marks.filter((m) => !staleMarks.includes(m)).map((m) => [m.key, m] as const),
  );
  const skipped: Array<VerifyPlan["skipped"][number]> = [];
  const running: Array<VerifySource["targets"][number]> = [];
  for (const t of source.targets) {
    const entry = entries.get(t.mutantCode);
    if (entry === undefined) throw new Error(`verify.ts: ${t.mutantCode} lost its entry`);
    const mark = markByKey.get(serializeKey(identityKeyOf(entry)));
    if (mark !== undefined) skipped.push({ entry, mark });
    else running.push(t);
  }
  if (running.length === 0) {
    return {
      requests: [],
      newTests: [],
      skipped,
      entries,
      testPageRefused: new Map(),
      notRun: new Map(),
      allRefused: new Set(),
      marksUnderOtherScheme: staleMarks,
      covering: new Map(),
      cap: {
        runId: source.runId,
        n: 0,
        s: 0,
        max: maxNewTests,
        editClasses: () => ({ classes: "", helpers: "" }),
      },
    };
  }

  if (sourceBaseline.length === 0) {
    throw new VerifyError(
      "source-predates-verify",
      `run ${source.runId} recorded no baseline tests, so no test can be told apart as new; run lethal run again, then verify`,
    );
  }
  const unnamed = sourceBaseline.filter((r) => r.codeunitName === null);
  if (unnamed.length > 0) {
    throw new VerifyError(
      "source-predates-verify",
      `run ${source.runId} recorded baseline tests without a codeunit name (before lethal verify existed): ${unnamed.map((r) => `${r.codeunitId}::${r.method}`).join(", ")}; run lethal run again, then verify`,
    );
  }

  // R-278: "treat every test as edited" would be safe but would run the whole suite against every
  // survivor, twice unmutated; refusing costs nothing and says what to do.
  if (sourceTestDigests === null) {
    throw new VerifyError(
      "source-predates-verify",
      `run ${source.runId} recorded no test digests, either because it predates them or because its test source could not be digested (see that run's test-digests-unavailable warning), so an edited test cannot be told from an unchanged one; run lethal run again, then verify`,
    );
  }

  // R-371 (external review r1 #5): a source run records a digest for every test or for none, so
  // an empty map or one that misses a baseline test is not a run this build recorded.
  const undigested = sourceBaseline.filter(
    (r) =>
      sourceTestDigests[testDigestKey({ codeunitId: r.codeunitId, method: r.method })] ===
      undefined,
  );
  if (Object.keys(sourceTestDigests).length === 0 || undigested.length > 0) {
    throw new VerifyError(
      "source-predates-verify",
      `run ${source.runId} recorded test digests for ${Object.keys(sourceTestDigests).length} test(s) but none for ${undigested.length} of its ${sourceBaseline.length} baseline test(s)${
        undigested.length > 0
          ? ` (${undigested
              .slice(0, 5)
              .map((r) => `${r.codeunitId}::${r.method}`)
              .join(", ")})`
          : ""
      }, so an edited test cannot be told from an unchanged one; run lethal run again, then verify`,
    );
  }

  // R-371: a digest of another scheme covers other things, so no comparison with it means
  // anything. The test is on the values, not a column: every digest of one run has one scheme.
  if (Object.values(sourceTestDigests).some((d) => !isCurrentDigest(d))) {
    throw new VerifyError(
      "source-predates-verify",
      `run ${source.runId} recorded its test digests under R-278's scheme, which covers each test's own method only. This build's digests (scheme ${TEST_DIGEST_SCHEME}, R-371) also cover every helper, handler, subscriber and dependency a test reaches, so an unchanged test would not compare equal. This refusal happens once per source run; run lethal run again, then verify`,
    );
  }

  // R403: the parser before discovery, which parses each test file that holds a `[Test]`.
  await initParser();
  // R403: verify keeps the FILTERED list. It does not run a pre-published test-app package: it
  // compiles the test app itself from `testDir` under the derived set (config symbols via alc's
  // /define, plus the test app.json's own) and publishes exactly that build, after this plan. The
  // suite it runs is therefore known from source, as on al-runner, so §3(c)'s no-evidence rule
  // does not apply. A compiled-out test is not in that build, so it is never new and never rerun.
  const discovered = (await discoverTests(testDir, { buildSymbols: a.testBuildSymbols ?? [] }))
    .filtered;
  const baselineKeys = new Set(
    sourceBaseline.map((r) =>
      testKeyOf({ codeunitId: r.codeunitId, codeunitName: "", method: r.method }),
    ),
  );
  // R-236c: verify runs fenced, so a test with a reachable call that may open a TestPage is never
  // planned. Throws TestPageScanError on unreadable reachable source, before anything is published.
  // Intended: it is rethrown raw (exit 1), not mapped to a verify refusal, so it fails loudly and
  // VERIFY_REFUSALS keeps its value set. (The parser was initialised before discovery, R403.)
  // R-371: ONE parse serves the scan and the digests.
  const model = buildTestAppModel(await readTestAppSources(testDir));
  const refusedWhy = scanTestPageModel(model, discovered);
  const inputs = {
    dependencies: typeof a.dependencies === "string" ? a.dependencies : await a.dependencies(),
    buildInputs: (await readAppJsonInputs(testDir)).buildInputs,
  };
  const digestsNow = testDigestsOfModel(model, discovered, inputs).digests;
  const recorded = new Map(Object.entries(sourceTestDigests));
  // A test the source run recorded no digest for is new: `undefined` is never "unchanged".
  const isNew = (ref: TestMethodRef) => {
    const was = recorded.get(testDigestKey(ref));
    return (
      !baselineKeys.has(testKeyOf(ref)) ||
      was === undefined ||
      was !== digestsNow[testDigestKey(ref)]
    );
  };
  const testPageRefused = new Map(
    discovered.flatMap((ref) => {
      const reason = refusedWhy.get(testKeyOf(ref));
      return reason === undefined
        ? []
        : [[testKeyOf(ref), { test: qualifiedTestName(ref), reason }] as const];
    }),
  );
  const isRefused = (ref: TestMethodRef) => testPageRefused.has(testKeyOf(ref));
  const newTests = discovered.filter((ref) => isNew(ref) && !isRefused(ref));
  const refusedNew = discovered.filter((ref) => isNew(ref) && isRefused(ref));
  // R-384 The cap (R4): EXTRA TEST RUNS against a budget, S fixed here, before any filtering.
  // Built only when a check refuses, so a passing run pays no `explainNewTests`.
  const cap: CapNumbers = {
    runId: source.runId,
    n: newTests.length,
    s: running.length,
    max: maxNewTests,
    editClasses: () =>
      editClassesOf(
        explainNewTests(
          model,
          inputs,
          newTests.map((ref) => ({
            ref,
            recorded: baselineKeys.has(testKeyOf(ref)) && recorded.has(testDigestKey(ref)),
          })),
          parseDigestParts(a.sourceTestDigestParts ?? null),
        ),
      ),
  };
  const reachState = reachStateOf(a.coverage, a.noReachFilter !== true);
  const budget = cap.max * (cap.s + 2);
  if (!reachState.on && cap.s * cap.n + 2 * cap.n > budget) {
    throw new VerifyError("too-many-new-tests", capOffDetail(cap, reachState.why));
  }
  if (reachState.on && 2 * cap.n > budget) {
    throw new VerifyError("too-many-new-tests", capCheckOneDetail(cap));
  }

  // Decision 5, ruling 10: a covering NAME picks exactly one source baseline row, and the test
  // project must still hold that row's (codeunitId, method) under the same codeunit name.
  const matchCovering = (name: string): TestMethodRef | string => {
    const rows = sourceBaseline.filter((r) => `${r.codeunitName}.${r.method}` === name);
    const [only] = rows;
    if (only === undefined || rows.length > 1) {
      return `${name} matches ${rows.length} source baseline test(s)${rows.length > 1 ? ` (${rows.map((r) => `codeunit ${r.codeunitId}`).join(", ")})` : ""}, not exactly one`;
    }
    const now = discovered.find(
      (ref) => ref.codeunitId === only.codeunitId && ref.method === only.method,
    );
    if (now !== undefined && now.codeunitName === only.codeunitName) return now;
    const sameName = discovered.filter((ref) => `${ref.codeunitName}.${ref.method}` === name);
    const found =
      now !== undefined
        ? `codeunit ${now.codeunitId} is now named "${now.codeunitName}"`
        : sameName.length > 0
          ? `the test project has it only as ${sameName.map((r) => `codeunit ${r.codeunitId}`).join(", ")}`
          : "the test project no longer has it";
    return `${name} was codeunit ${only.codeunitId} method ${only.method} in the source run; ${found}`;
  };

  const unmatched: string[] = [];
  const noTests: string[] = [];
  const requests: NamedMutantRequest[] = [];
  const notRun = new Map<string, readonly string[]>();
  const allRefused = new Set<string>();
  const covering = new Map<string, readonly TestMethodRef[]>();
  for (const t of running) {
    const notRunHere: string[] = [];
    const seen = new Set<string>();
    const methods: TestMethodRef[] = [];
    const add = (ref: TestMethodRef) => {
      if (!seen.has(testKeyOf(ref))) {
        seen.add(testKeyOf(ref));
        methods.push(ref);
      }
    };
    for (const name of t.coveringTests) {
      const ref = matchCovering(name);
      if (typeof ref === "string") unmatched.push(`${t.batchIndex}/${t.mutantCode}: ${ref}`);
      else if (isRefused(ref)) notRunHere.push(qualifiedTestName(ref));
      else add(ref);
    }
    const coveringHere = [...methods];
    for (const ref of newTests) add(ref);
    notRunHere.push(...refusedNew.map(qualifiedTestName));
    if (notRunHere.length > 0) notRun.set(t.mutantCode, notRunHere);
    if (methods.length === 0) {
      // Every test that reaches it was refused: a structured result, not an empty refusal.
      if (notRunHere.length > 0) allRefused.add(t.mutantCode);
      else noTests.push(mutantRef(t.batchIndex, t.mutantCode));
      continue;
    }
    requests.push({ mutantId: t.mutantCode, methods });
    covering.set(t.mutantCode, coveringHere);
  }
  if (unmatched.length > 0) {
    throw new VerifyError(
      "covering-test-unmatched",
      `a covering test cannot be matched to the same codeunit id and method, so it is not run in its place: ${unmatched.join("; ")}`,
    );
  }
  if (noTests.length > 0) {
    throw new VerifyError(
      "no-tests-to-run",
      `no covering test and no new test for: ${noTests.join(", ")}; add a test that reaches the mutated code`,
    );
  }
  return {
    requests,
    newTests,
    skipped,
    entries,
    testPageRefused,
    notRun,
    allRefused,
    marksUnderOtherScheme: staleMarks,
    covering,
    cap,
  };
}

/** R-371: `--max-new-tests`' default: above every measured p90 edit (the plan's table). */
export const DEFAULT_MAX_NEW_TESTS = 50;

/** R-371: the words the too-many-new-tests refusal uses for each cause. */
const CAUSE_WORDS: Readonly<Record<NewTestCause, string>> = {
  added: "added or renamed tests",
  test: "the test's own method edited",
  procedure: "a procedure it reaches edited",
  object:
    "an object it reaches edited outside its procedures (header, properties, globals, triggers)",
  subscriber:
    "a subscriber codeunit edited (every subscriber is in every test's digest, so every test is new)",
  fallback:
    "a test-app edit, for a test whose reach has an edge the walk cannot follow (it covers the whole test-app source)",
  dependency: "a dependency changed",
  build: "an app.json build input changed",
  reach: "which procedures it reaches changed",
  unknown: "the source run recorded no parts to compare against",
};

/** R-371: the edit classes and changed procedures a too-many-new-tests refusal names. */
function editClassesOf(e: {
  readonly causes: ReadonlyMap<NewTestCause, number>;
  readonly changedProcs: readonly string[];
}): { readonly classes: string; readonly helpers: string } {
  const classes = [...e.causes]
    .sort((x, y) => y[1] - x[1])
    .map(([c, k]) => `${c}: ${k} test(s), ${CAUSE_WORDS[c]}`)
    .join("; ");
  const shown = e.changedProcs.slice(0, 5);
  const more =
    e.changedProcs.length > shown.length ? ` and ${e.changedProcs.length - shown.length} more` : "";
  const helpers = shown.length > 0 ? ` Changed procedures: ${shown.join(", ")}${more}.` : "";
  return { classes, helpers };
}

/** R-384: the budget sentence every cap text shares. */
function budgetSentence(c: CapNumbers): string {
  return `The budget is --max-new-tests ${c.max} x (${c.s} survivor(s) + 2) = ${c.max * (c.s + 2)} extra test runs.`;
}

/** R-384 The cap, filter off: refuse iff S·N + 2N > B, which is today's N > max. */
function capOffDetail(c: CapNumbers, why: string): string {
  const { classes, helpers } = c.editClasses();
  return `${c.n} tests are new or edited since run ${c.runId}. The coverage filter is off (${why}), so they need ${c.s * c.n + 2 * c.n} extra test runs (${2 * c.n} unmutated, ${c.s * c.n} against ${c.s} survivor(s)). ${budgetSentence(c)} Edit classes: ${classes}.${helpers} To run them all, pass --max-new-tests ${c.n}; or run lethal run again so this source is the recorded one`;
}

/** R-384 The cap, filter on, check 1 (before any lease): the filter cannot lower 2N. */
function capCheckOneDetail(c: CapNumbers): string {
  const { classes, helpers } = c.editClasses();
  return `${c.n} tests are new or edited since run ${c.runId}. Each runs twice unmutated, ${2 * c.n} extra test runs, and the coverage filter cannot lower that; without the filter they would need ${c.s * c.n + 2 * c.n}. ${budgetSentence(c)} Edit classes: ${classes}.${helpers} To run them all, pass --max-new-tests ${c.n}; or run lethal run again so this source is the recorded one`;
}

/**
 * R-384 The cap, filter on, check 2 (inside `narrow`, after the baseline, before the first
 * mutant): E = 2N + P extra test runs against the same budget. `undefined` when E fits.
 */
export function capCheckTwoDetail(
  c: CapNumbers,
  joins: number,
  failClosed: number,
): string | undefined {
  const e = 2 * c.n + joins;
  if (e <= c.max * (c.s + 2)) return undefined;
  const { classes, helpers } = c.editClasses();
  return `${c.n} tests are new or edited since run ${c.runId}. After the coverage filter they need ${e} extra test runs (${2 * c.n} unmutated, ${joins} against ${c.s} survivor(s); ${failClosed} test(s) joined every survivor because their coverage could not be used); without the filter they would need ${c.s * c.n + 2 * c.n}. ${budgetSentence(c)} The unmutated runs had already run when this was found. Edit classes: ${classes}.${helpers} To run them all, pass --max-new-tests ${Math.ceil(e / (c.s + 2))}; or run lethal run again so this source is the recorded one`;
}

/**
 * R-371: this verify's dependency fingerprint, over the test project's app.json (the test app
 * verify compiles and publishes) and the packages the server holds for its non-Microsoft
 * dependencies, read one at a time through the same /packages read as R-372. Throws
 * `DependencyUnreadableError` (refused as `dependency-unreadable`) when one cannot be read.
 */
export async function verifyDependencyFingerprint(
  backend: Pick<ExecutionBackend, "fetchPublishedAppPackage">,
  testDir: string,
  projectPath: string,
): Promise<string> {
  const fetchPackage = backend.fetchPublishedAppPackage?.bind(backend);
  return dependencyFingerprint(
    await readAppJsonInputs(testDir),
    fetchPackage === undefined ? async () => null : publishedPackageReader(fetchPackage),
    await targetOf(projectPath),
  );
}

/** C02-06 decision 7: the JSON `lethal verify` prints. 2 since C02-09 added two refusal reasons.
 *  3 since R354 added the refusal reason `coverage-mode-changed`: a new value, so it bumps (R233);
 *  v2 is frozen. 4 since R-371 added `too-many-new-tests` and `dependency-unreadable`; v3 is
 *  frozen. 5 since R-425 added `reachFilter` and `results[].reachNarrowed`. Adding a field does
 *  not usually bump, but their ABSENCE means "not decided" only from v5 on, while in an older
 *  report it means the report predates the record; the version is the one thing that tells the
 *  two apart, so it bumps. v4 is frozen. */
export const VERIFY_SCHEMA_VERSION = 5;
export const VERIFY_VERDICTS = ["killed", "survived", "error", "skipped"] as const;
export const KILLED_BY = ["assertion", "runtime-error", "other"] as const;
export const NEW_TEST_STATES = [
  "stable",
  "flaky",
  "red",
  "flaky-unknown",
  "infra-error",
  "not-rerun",
] as const;
/** R262: an unmutated run's outcome exactly as the backend answered it, plus `not-run`. */
export const UNMUTATED_OUTCOMES = [
  "pass",
  "fail",
  "skip",
  "timeout",
  "deadline-exceeded",
  "error",
  "not-run",
] as const;
// Named, not inline, like KilledBy and NewTestState below it: schemas.test.ts's typeLeafPaths walk
// (C02-06 Task 6) resolves a field's domain by the NAME at that property, and an inline
// `(typeof X)[number]` there has no name to resolve.
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];
export type KilledBy = (typeof KILLED_BY)[number];
export type NewTestState = (typeof NEW_TEST_STATES)[number];
export type UnmutatedOutcome = (typeof UNMUTATED_OUTCOMES)[number];

/**
 * Decision 7's exit codes. 3 and 4 mean what `run`'s `QUARANTINED_EXIT_CODE` and
 * `NOTHING_SCORED_EXIT_CODE` mean; they are repeated here because verify.ts must not import cli.ts.
 */
export const VERIFY_EXIT = {
  ok: 0,
  quarantined: 3,
  nothingMeasured: 4,
  notAllKilled: 5,
  refused: 6,
} as const;

/** One unmutated run of one new test (decision 11). The outcome is the backend's own (R262). */
export interface UnmutatedRun {
  readonly outcome: UnmutatedOutcome;
  readonly fresh: boolean;
  readonly sessionId?: number;
  readonly testRunsBefore?: number;
}

export interface NewTestResult {
  /** Qualified `Codeunit.Method`. */
  readonly test: string;
  readonly codeunitId: number;
  readonly state: NewTestState;
  /** `[baseline, rerun]`; `[baseline]` alone when `state` is `not-rerun` (R-427: the reach
   *  filter sent the test to no survivor, so its stability is unknown, never `stable`). */
  readonly runs: readonly UnmutatedRun[];
  /** The first failing run's text. */
  readonly failure?: string;
}

export interface VerifyResult {
  /** `<batchIndex>/<mutantCode>`. */
  readonly id: string;
  readonly batchIndex: number;
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly procedureName: string;
  /** C02-09: the manifest entry's gap id, named directly or through a gap. Absent only when the
   *  installed manifest predates gap ids. */
  readonly gapId?: string;
  readonly verdict: VerifyVerdict;
  /** Qualified names sent to `runNamedMutants`. */
  readonly testsRun?: readonly string[];
  /** R-236c: qualified names of requested methods not sent, each with a reachable call that may
   *  open a TestPage. */
  readonly notRun?: readonly string[];
  /** Decision 13: requested methods without a valid green unmutated run. */
  readonly invalidBaseline?: readonly string[];
  readonly killingTest?: {
    readonly codeunitId: number;
    readonly codeunitName: string;
    readonly method: string;
  };
  /** Decision 14: by `testKeyOf`, never by method name. */
  readonly killedByNewTest?: boolean;
  readonly killedBy?: KilledBy;
  readonly killingTestFailure?: string;
  readonly failureNote?: string;
  readonly skipped?: {
    readonly reason: "reader-marked-equivalent";
    readonly mark: { readonly key: string; readonly reason: string };
  };
  /** R-425: true when R-384's reach filter left at least one new test out of this survivor's
   *  request; false when it did not, or the filter was off. Absent when the filter never decided
   *  for this row: skipped, every test TestPage-refused, or the session stopped before the filter
   *  ran. The tests left out are `newTests[].test` minus `testsRun`. */
  readonly reachNarrowed?: boolean;
}

/** R-425: R-384's reach-filter state, as the JSON records it. */
export interface VerifyReachFilter {
  readonly state: ReachFilterState;
  /** Present exactly when `state` is "off". */
  readonly reason?: ReachFilterOffReason;
}

/** R-425: the JSON form of a decided `ReachState`. `why` is stderr's and is not repeated. */
export function verifyReachFilterOf(s: ReachState): VerifyReachFilter {
  return s.on ? { state: "on" } : { state: "off", reason: s.reason };
}

export interface VerifyOutput {
  readonly verifySchemaVersion: number;
  /** R-425: whether R-384's reach filter ran, and when not, why. Present whenever verify got past
   *  the `coverage-mode-changed` check, later refusals included; absent when it stopped before
   *  deciding. */
  readonly reachFilter?: VerifyReachFilter;
  /** `exitCode === 0`. */
  readonly ok: boolean;
  readonly exitCode: number;
  readonly source?: {
    readonly runId: number;
    readonly batchIndex: number;
    readonly artifactId: string;
    readonly artifactSha256: string;
    readonly sourceSha256: string;
    /** Carried item 1: the source run's project path, resolved. */
    readonly projectPath: string;
  };
  readonly verifyRunId?: number;
  /** The SERVER's read-back identity of the published test app, never the local compile's. */
  readonly testApp?: {
    readonly name: string;
    readonly version: string;
    readonly sha256: string;
    readonly compiledAgainst: { readonly artifactId: string; readonly sha256: string };
  };
  readonly newTests: readonly NewTestResult[];
  readonly results: readonly VerifyResult[];
  readonly counts: {
    readonly killed: number;
    readonly survived: number;
    readonly error: number;
    readonly skipped: number;
  };
  readonly quarantined?: string;
  readonly refused?: { readonly reason: VerifyRefusal; readonly detail: string };
  /** R-236c: every discovered test not sent because it has a reachable call that may open a
   *  TestPage. Absent when none was refused. */
  readonly testPageRefused?: { readonly tests: readonly string[]; readonly diagnosis: string };
  readonly timings: {
    readonly totalMs: number;
    readonly compileMs?: number;
    readonly publishMs?: number;
  };
}

// The first callstack frame's shape, measured in examples/credit-limit/demo.report.json:
// `<Object>(CodeUnit <id>).<Method> line <n> - <App> by <Publisher> version <v>`.
const CALLSTACK_FRAME = / line \d+ - .+ by .+ version \S+$/;

/**
 * Ruling 1: what raised the killing failure, from its text. Reported, never gating. `assertion`:
 * R121's `Assert.` prefix, or BC's own `asserterror` expectation failing. `runtime-error`: the first
 * callstack frame is in another app than the test app. `other`: everything else, a bare `Error(...)`
 * in the test and a text with no parseable frame included.
 */
export function killedByOf(text: string | undefined, testAppName: string): KilledBy {
  const t = text ?? "";
  if (looksLikeAssertionFailure(killMessageOf(t)) || t.includes("NavNCLAssertErrorException")) {
    return "assertion";
  }
  const frame = t.split("\n")[1]?.split(";")[0]?.trim();
  if (
    frame !== undefined &&
    CALLSTACK_FRAME.test(frame) &&
    !frame.includes(` - ${testAppName} by `)
  ) {
    return "runtime-error";
  }
  return "other";
}

/** Decision 7's exit code, precedence 3, 6, 4, 5, 0. `killedBy` plays no part. */
export function verifyExitCode(o: {
  readonly quarantined?: string;
  readonly refused?: unknown;
  readonly results: readonly Pick<VerifyResult, "verdict">[];
  readonly newTests: readonly Pick<NewTestResult, "state">[];
}): number {
  if (o.quarantined !== undefined) return VERIFY_EXIT.quarantined;
  if (o.refused !== undefined) return VERIFY_EXIT.refused;
  const measured = o.results.filter((r) => r.verdict !== "skipped");
  if (measured.length > 0 && measured.every((r) => r.verdict === "error")) {
    return VERIFY_EXIT.nothingMeasured;
  }
  if (
    measured.some((r) => r.verdict !== "killed") ||
    o.newTests.some((t) => t.state !== "stable")
  ) {
    return VERIFY_EXIT.notAllKilled;
  }
  return VERIFY_EXIT.ok;
}

function unmutatedRunOf(r: NamedUnmutatedRun): UnmutatedRun {
  // Fails loudly if the backend's outcome union grows without this list (R262).
  if (!(UNMUTATED_OUTCOMES as readonly string[]).includes(r.outcome)) {
    throw new Error(
      `verify.ts: unmutated run of ${testKeyOf(r.ref)} has unknown outcome ${r.outcome}`,
    );
  }
  return {
    outcome: r.outcome,
    fresh: r.fresh,
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.testRunsBefore !== undefined ? { testRunsBefore: r.testRunsBefore } : {}),
  };
}

/** The test's own failure on the unmutated build. `timeout` is runner-confirmed (backend.ts). */
const TEST_FAILED: ReadonlySet<UnmutatedOutcome> = new Set(["fail", "timeout", "skip"]);
/** R262: the CALL failed; nothing is known about the test. */
const INFRA_FAILED: ReadonlySet<UnmutatedOutcome> = new Set(["error", "deadline-exceeded"]);

/**
 * Decision 11 plus R262, first match wins: red, stable, flaky, infra-error when either run's
 * call failed (fresh or not), and flaky-unknown for anything else not attributable.
 */
function newTestResultOf(
  ref: TestMethodRef,
  baseline: NamedUnmutatedRun,
  rerun: NamedUnmutatedRun,
): NewTestResult {
  const b = unmutatedRunOf(baseline);
  const r = unmutatedRunOf(rerun);
  const state: NewTestState =
    b.fresh && TEST_FAILED.has(b.outcome)
      ? "red"
      : b.fresh && b.outcome === "pass" && r.fresh && r.outcome === "pass"
        ? "stable"
        : b.fresh && b.outcome === "pass" && r.fresh && TEST_FAILED.has(r.outcome)
          ? "flaky"
          : INFRA_FAILED.has(b.outcome) || INFRA_FAILED.has(r.outcome)
            ? "infra-error"
            : "flaky-unknown";
  const failed = [baseline, rerun].find((x) => x.outcome !== "pass" && x.outcome !== "not-run");
  return {
    test: qualifiedTestName(ref),
    codeunitId: ref.codeunitId,
    state,
    runs: [b, r],
    ...(failed !== undefined ? { failure: failed.failureMessage ?? failed.outcome } : {}),
  };
}

/**
 * R-427: a new test the reach filter sent to no survivor ran its baseline only. Only a filterable
 * test can be unsent, and that needs a fresh green baseline, so anything else is a bug.
 */
function notRerunResultOf(ref: TestMethodRef, baseline: NamedUnmutatedRun): NewTestResult {
  const b = unmutatedRunOf(baseline);
  if (!(b.fresh && b.outcome === "pass")) {
    throw new Error(
      `verify.ts: new test ${testKeyOf(ref)} was not rerun, but its baseline was not a fresh pass (${b.outcome}, fresh ${b.fresh}); only a test with a fresh green baseline can be sent to no survivor (a bug)`,
    );
  }
  return {
    test: qualifiedTestName(ref),
    codeunitId: ref.codeunitId,
    state: "not-rerun",
    runs: [b],
  };
}

export interface VerifyDeps {
  readonly store: ResultsStore;
  readonly backend: ExecutionBackend & Pick<BcDevMcpBackend, "compileTestApp" | "publishTestApp">;
  readonly lease: LeaseSessionConfig;
  readonly resourceServer: string;
  readonly resourceServerInstance: string;
  /** The config's preprocessor symbols: the source hash is recomputed with them (decision 8). */
  readonly preprocessorSymbols: readonly string[];
  readonly quarantineDir?: string;
  readonly emit?: SessionConfig["emit"];
  readonly now?: () => number;
  /** Seam for tests; defaults to runNamedMutants. */
  readonly runNamed?: typeof runNamedMutants;
  /** R-384: where verify's reach-filter state lines go. Default: stderr. Never stdout, which holds
   *  the JSON only. */
  readonly log?: (line: string) => void;
}

const NO_COUNTS = { killed: 0, survived: 0, error: 0, skipped: 0 } as const;

/**
 * C02-06: prove, on the build the source run left installed, that the named survivors are killed
 * by the test project as it is now. Every refusal comes before anything is measured; the test app
 * is compiled before the lease and published once, inside its fence; every requested method needs
 * a fresh green unmutated run, and every new test a second one after the mutants. Never finishes
 * its run row (decision 4).
 */
export async function runVerify(
  args: {
    readonly artifact: string;
    readonly survivors: readonly string[];
    readonly testDir: string;
    /** R-371: `--max-new-tests`; default `DEFAULT_MAX_NEW_TESTS`. */
    readonly maxNewTests?: number;
    /** R-384: `--no-reach-filter`: every new test runs against every survivor, as before. */
    readonly noReachFilter?: boolean;
  },
  deps: VerifyDeps,
): Promise<VerifyOutput> {
  const now = deps.now ?? Date.now;
  const started = now();
  const { store, backend } = deps;
  let source: VerifySource | undefined;
  let artifactId: string | undefined;
  let verifyRunId: number | undefined;
  let compileMs: number | undefined;
  let publishMs: number | undefined;
  let published: PublishedTestApp | undefined;
  // R-425: set once, right after the coverage-mode-changed check; undefined means "not decided".
  let decided: ReachState | undefined;
  const header = () => ({
    verifySchemaVersion: VERIFY_SCHEMA_VERSION,
    ...(decided !== undefined ? { reachFilter: verifyReachFilterOf(decided) } : {}),
    ...(source !== undefined && artifactId !== undefined
      ? {
          source: {
            runId: source.runId,
            batchIndex: source.installed.batchIndex,
            // Carried item 5: the source has no id of its own; the request named it.
            artifactId,
            artifactSha256: source.artifactSha256,
            sourceSha256: source.sourceSha256,
            projectPath: source.projectPath,
          },
        }
      : {}),
    ...(verifyRunId !== undefined ? { verifyRunId } : {}),
    ...(published !== undefined
      ? {
          testApp: {
            name: published.name,
            version: published.version,
            sha256: published.sha256,
            compiledAgainst: published.compiledAgainst,
          },
        }
      : {}),
  });
  const timings = () => ({
    totalMs: now() - started,
    ...(compileMs !== undefined ? { compileMs } : {}),
    ...(publishMs !== undefined ? { publishMs } : {}),
  });

  try {
    const req = parseVerifyRequest(args.artifact, args.survivors);
    artifactId = req.artifactId;
    source = resolveVerifySource(store, await expandGapIds(store, req));
    // R354: verify's logic DEPENDS on the source run's coverage facts: a target must be a survived
    // or no-coverage source verdict (`resolveVerifySource`), and each request runs the source's
    // covering tests (`planVerify`). Both were attributed under the source's coverage mode, so
    // under another mode, or an unrecorded one, verify REFUSES rather than warns. First, before
    // any file is read, so the refusal costs nothing.
    const coverageMode = backend.capabilities().coverage;
    if (source.coverageMode !== coverageMode) {
      throw new VerifyError(
        "coverage-mode-changed",
        `run ${source.runId} was measured under ${
          source.coverageMode === null
            ? "an unrecorded coverage mode (the run predates R354)"
            : `coverage mode ${source.coverageMode}`
        }, but verify measures under coverage mode ${coverageMode}. Its survived and no-coverage verdicts and its covering-test lists were attributed under that mode, so they do not say which tests reach a mutant under this one (R354). Run lethal run again under this configuration, then verify with its artifact id.`,
      );
    }
    // R-384: rule 1. Off, verify sends exactly what it sent before: no `narrow` at all. R-425:
    // decided here, so every later refusal records it too.
    const reachState = reachStateOf(coverageMode, args.noReachFilter !== true);
    decided = reachState;
    // R214: a run recorded before its build symbols were cannot tie its keys to one build. Never
    // read as `[]`.
    if (source.buildSymbols === null) {
      throw new VerifyError(
        "source-predates-verify",
        `run ${source.runId} recorded no build symbols (before R214), so its keys cannot be tied to one build; run lethal run again, then verify`,
      );
    }
    await assertSourceUnchanged(source, deps.preprocessorSymbols, args.testDir);
    const { artifact, manifest } = await loadInstalledArtifact(store, source.installed);
    const { projectPath } = source;
    const plan = await planVerify({
      source,
      manifest,
      sourceBaseline: store.baselineTests(source.runId),
      sourceTestDigests: store.testDigests(source.runId),
      sourceTestDigestParts: store.testDigestParts(source.runId),
      testDir: args.testDir,
      dependencies: () => verifyDependencyFingerprint(backend, args.testDir, projectPath),
      ...(args.maxNewTests !== undefined ? { maxNewTests: args.maxNewTests } : {}),
      // R-384: the filter state decides which cap check runs before the lease.
      coverage: coverageMode,
      ...(args.noReachFilter !== undefined ? { noReachFilter: args.noReachFilter } : {}),
      // R403: verify runs on bcdev only, so alc's set: the config's symbols plus the test app.json's.
      testBuildSymbols: await effectiveBuildSymbols(
        args.testDir,
        deps.preprocessorSymbols,
        undefined,
        { kind: "bcdev" },
      ),
    });
    const skippedBy = new Map(plan.skipped.map((s) => [s.entry.mutantId, s] as const));
    const marksWarning = marksSchemeWarning(
      marksUnderOtherScheme(plan.marksUnderOtherScheme, source.identityScheme),
      source.identityScheme,
    );
    if (marksWarning !== undefined && deps.emit !== undefined) {
      createEmitter(deps.emit)({
        type: "warning",
        code: "equivalence-marks-identity-scheme",
        message: marksWarning,
      });
    }
    const symbolsWarning = marksSymbolsWarning(
      marksUnderOtherSymbols(plan.marksUnderOtherScheme, source.buildSymbols),
      source.buildSymbols,
    );
    if (symbolsWarning !== undefined && deps.emit !== undefined) {
      createEmitter(deps.emit)({
        type: "warning",
        code: "equivalence-marks-build-symbols",
        message: symbolsWarning,
      });
    }

    let res: Awaited<ReturnType<typeof runNamedMutants>> | undefined;
    const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    let reach: ReachResult | undefined;
    const planned = source;
    if (plan.requests.length > 0 && !reachState.on) {
      log(
        `[lethal] verify: reach filter off (${reachState.why}): every new test runs against every survivor.`,
      );
    }
    const narrow: NamedMutantsConfig["narrow"] = reachState.on
      ? (baseline, ctx) => {
          if (ctx.coverage !== coverageMode) {
            throw new Error(
              `verify.ts: the baseline was measured under coverage mode ${ctx.coverage}, but verify planned under ${coverageMode}`,
            );
          }
          const r = narrowVerifyRequests({
            mode: ctx.coverage,
            enabled: true,
            survivors: plan.requests.map((q) => {
              const e = plan.entries.get(q.mutantId);
              if (e === undefined) throw new Error(`verify.ts: ${q.mutantId} has no entry`);
              return e;
            }),
            coveringKeys: plan.covering,
            newTests: plan.newTests,
            baseline,
            refusedObjects: refusedObjectsOfSources(ctx.alSources),
          });
          // The cap, check 2: no mutant is in flight yet, and runNamedMutants releases the lease
          // on the way out, so the refusal is safe here.
          const over = capCheckTwoDetail(plan.cap, r.joins, r.failClosedTests.length);
          if (over !== undefined) throw new VerifyError("too-many-new-tests", over);
          reach = r;
          reportReach(r, plan, planned, log, deps.emit);
          // R-427: a new test sent to no survivor is not rerun.
          return { methods: r.methods, unreached: r.unreached, notRerun: r.unsent };
        }
      : undefined;
    if (plan.requests.length > 0) {
      // Before any lease: a compile failure costs no lease, no run row and no server call.
      const tc = now();
      const compiled: CompiledTestApp = await backend.compileTestApp(args.testDir, artifact);
      compileMs = now() - tc;
      verifyRunId = store.createRun({
        // R325: the rows this run records carry the SOURCE run's manifest keys.
        identityScheme: source.identityScheme,
        // R214: the rows carry the SOURCE run's keys, so they carry its build too.
        buildSymbols: source.buildSymbols,
        // R354: verify's OWN mode, the one this run measures under; equal to the source's here.
        coverageMode,
        // R247: the test app this run measures against, the one it is about to publish. The
        // publish is accepted only when the server's package hashes to it, so it is the key a later
        // bcdev session would compute (`package:` + that hash).
        testAppHash: `package:${compiled.sha256}`,
        projectPath: source.projectPath,
        backend: "lethal-verify",
        appVersion: "0.0.0.0",
      });
      res = await (deps.runNamed ?? runNamedMutants)({
        backend,
        store,
        runId: verifyRunId,
        installed: source.installed,
        requests: plan.requests,
        lease: deps.lease,
        resourceServer: deps.resourceServer,
        resourceServerInstance: deps.resourceServerInstance,
        ...(deps.quarantineDir !== undefined ? { quarantineDir: deps.quarantineDir } : {}),
        ...(deps.emit !== undefined ? { emit: deps.emit } : {}),
        requireEveryMethodGreen: true,
        rerunOnUnmutated: plan.newTests,
        // R-236c: nothing refused is planned; this is the guard if one ever were.
        testPageRefused: new Map([...plan.testPageRefused].map(([k, v]) => [k, v.reason])),
        inLease: async (fence) => {
          const tp = now();
          published = await backend.publishTestApp(fence, compiled);
          publishMs = now() - tp;
        },
        ...(narrow !== undefined ? { narrow } : {}),
      });
    }

    // Decision 11: every new test's two unmutated runs, from this call's own answers.
    const newKeys = new Set(plan.newTests.map(testKeyOf));
    const ran = res;
    // R-427: the tests runNamedMutants did not rerun must be exactly the ones the reach filter
    // sent to no survivor, as `unreached` is cross-checked below, so a backend that ignores
    // `notRerun` cannot report a test it never skipped, nor skip one the filter sent.
    if (ran !== undefined) {
      const skipped = new Set(ran.notRerun ?? []);
      const unsent = reach?.unsent ?? new Set<string>();
      for (const k of unsent) {
        if (!skipped.has(k)) {
          throw new Error(
            `verify.ts: the reach filter sent ${k} to no survivor, but runNamedMutants did not skip its rerun`,
          );
        }
      }
      for (const k of skipped) {
        if (!unsent.has(k)) {
          throw new Error(
            `verify.ts: runNamedMutants skipped the rerun of ${k}, but the reach filter did not leave it unsent`,
          );
        }
      }
    }
    const newTests =
      ran === undefined
        ? []
        : plan.newTests.map((ref) => {
            const key = testKeyOf(ref);
            const b = ran.baseline.find((x) => testKeyOf(x.ref) === key);
            const r = ran.rerun.find((x) => testKeyOf(x.ref) === key);
            const notRerun = (ran.notRerun ?? []).includes(key);
            if (b !== undefined && r !== undefined && notRerun) {
              throw new Error(
                `verify.ts: runNamedMutants answered new test ${key} both rerun and not rerun`,
              );
            }
            if (b !== undefined && notRerun) return notRerunResultOf(ref, b);
            if (b === undefined || r === undefined) {
              throw new Error(`verify.ts: runNamedMutants did not answer new test ${key}`);
            }
            return newTestResultOf(ref, b, r);
          });

    // R-425: off, nothing can be narrowed; on, the filter's own answer, and nothing when it never
    // ran (the session latched unsafe before `select`, so the row keeps the unfiltered request).
    const narrowedOf = (id: string): { reachNarrowed?: boolean } =>
      !reachState.on
        ? { reachNarrowed: false }
        : reach !== undefined
          ? { reachNarrowed: reach.narrowed.has(id) }
          : {};
    const outcomeBy = new Map((ran?.outcomes ?? []).map((o) => [o.mutant.mutantId, o] as const));
    const requestBy = new Map(plan.requests.map((r) => [r.mutantId, r] as const));
    const results = source.targets.map((t): VerifyResult => {
      const entry = plan.entries.get(t.mutantCode);
      if (entry === undefined) throw new Error(`verify.ts: ${t.mutantCode} has no entry`);
      const base = {
        id: mutantRef(t.batchIndex, t.mutantCode),
        batchIndex: t.batchIndex,
        mutantCode: t.mutantCode,
        file: entry.file,
        line: entry.startLine,
        operatorName: entry.operatorName,
        procedureName: entry.procedureName,
        ...(entry.gapId !== undefined ? { gapId: entry.gapId } : {}),
      };
      const skip = skippedBy.get(t.mutantCode);
      if (skip !== undefined) {
        return {
          ...base,
          verdict: "skipped",
          skipped: {
            reason: "reader-marked-equivalent",
            mark: { key: skip.mark.key, reason: skip.mark.reason },
          },
        };
      }
      if (plan.allRefused.has(t.mutantCode)) {
        return {
          ...base,
          verdict: "error",
          testsRun: [],
          notRun: plan.notRun.get(t.mutantCode) ?? [],
          failureNote:
            "TestPage refused, not run: every test that reaches this mutant has a reachable call that may open a TestPage, so none was sent (R-236c)",
        };
      }
      const notRun = plan.notRun.get(t.mutantCode);
      // R-384 (ruled R2): a survivor no new test reaches, with no covering test, is sent nothing and
      // stays `survived`. No new verdict.
      if (ran?.unreached?.includes(t.mutantCode) === true) {
        if (reach === undefined || !reach.unreached.has(t.mutantCode)) {
          throw new Error(
            `verify.ts: runNamedMutants answered ${t.mutantCode} unreached, but the reach filter did not leave it without tests`,
          );
        }
        return {
          ...base,
          verdict: "survived",
          testsRun: [],
          ...(notRun !== undefined ? { notRun } : {}),
          ...narrowedOf(t.mutantCode),
          failureNote: `no new test reaches it: the coverage of the ${reach.filterable} new test(s) that could be read shows none of them running ${memberOf(entry)}, so nothing was run (R-384)`,
        };
      }
      const o = outcomeBy.get(t.mutantCode);
      const request = requestBy.get(t.mutantCode);
      if (o === undefined || request === undefined) {
        throw new Error(`verify.ts: ${t.mutantCode} was requested but got no outcome`);
      }
      // R-384: the methods actually sent, after the reach filter when it ran.
      const sent = reach?.methods.get(t.mutantCode) ?? request.methods;
      return {
        ...base,
        ...measuredResultOf(o, sent, newKeys, published),
        ...(notRun !== undefined ? { notRun } : {}),
        ...narrowedOf(t.mutantCode),
      };
    });

    const quarantined = ran?.quarantined;
    const exitCode = verifyExitCode({
      ...(quarantined !== undefined ? { quarantined } : {}),
      results,
      newTests,
    });
    return {
      ...header(),
      ok: exitCode === VERIFY_EXIT.ok,
      exitCode,
      newTests,
      results,
      counts: {
        killed: results.filter((r) => r.verdict === "killed").length,
        survived: results.filter((r) => r.verdict === "survived").length,
        error: results.filter((r) => r.verdict === "error").length,
        skipped: results.filter((r) => r.verdict === "skipped").length,
      },
      ...(quarantined !== undefined ? { quarantined } : {}),
      ...(plan.testPageRefused.size > 0
        ? {
            testPageRefused: {
              tests: [...plan.testPageRefused.values()].map((v) => v.test).sort(),
              diagnosis: TESTPAGE_REFUSED_DIAGNOSIS,
            },
          }
        : {}),
      timings: timings(),
    };
  } catch (err) {
    const out = refusalOutput(err, timings());
    if (out === undefined) throw err;
    return { ...header(), ...out };
  }
}

/**
 * The output for a typed refusal or quarantine caught before any mutant was measured: `results: []`
 * always. Every refusal comes before anything runs except R-384's cap check 2, which comes after
 * the unmutated baseline runs and before the first mutant. `undefined` for any other error, which
 * the caller rethrows (exit 1).
 */
export function refusalOutput(
  err: unknown,
  timings: VerifyOutput["timings"],
): VerifyOutput | undefined {
  const r = verifyRefusalOf(err);
  if (r === undefined) return undefined;
  const out =
    r.kind === "quarantined"
      ? { quarantined: r.detail }
      : { refused: { reason: r.reason, detail: r.detail } };
  return {
    verifySchemaVersion: VERIFY_SCHEMA_VERSION,
    ok: false,
    exitCode: verifyExitCode({ ...out, results: [], newTests: [] }),
    newTests: [],
    results: [],
    counts: NO_COUNTS,
    ...out,
    timings,
  };
}

/** R-384: the member a survivor's coverage is looked up by, for its `failureNote`. */
function memberOf(e: MutantManifestEntry): string {
  if (e.procedureName !== "") return e.procedureName;
  if (e.triggerName !== undefined) return e.triggerName;
  return (e.coverageArmNames ?? []).join(" or ");
}

/**
 * R-384 (rule 3): R298's refused objects of the INSTALLED sources, parsed as `lineMapFromSources`
 * parses them. These are the files `attach` built the fenced line map from, so the coverage lines
 * were placed in them; the project on disk may have changed since, the installed build has not.
 * The parser was initialised by `planVerify`.
 */
function refusedObjectsOfSources(sources: readonly AlSource[]): ReadonlyMap<string, string> {
  return coverageRefusedObjects(
    sources.map((s) => ({ path: s.path, root: wrapRoot(parseAL(s.text)) })),
  );
}

/** R-384 rules 7 and 8: the `verify-reach-fail-closed` warnings and the state lines. */
function reportReach(
  r: ReachResult,
  plan: VerifyPlan,
  source: VerifySource,
  log: (line: string) => void,
  emitTo: SessionConfig["emit"],
): void {
  const batchOf = new Map(source.targets.map((t) => [t.mutantCode, t.batchIndex] as const));
  const ids = (codes: Iterable<string>) =>
    [...codes]
      .map((c) => {
        const b = batchOf.get(c);
        if (b === undefined) throw new Error(`verify.ts: ${c} is not a target`);
        return mutantRef(b, c);
      })
      .join(", ");
  const warnings: string[] = [];
  if (r.failClosedTests.length > 0) {
    warnings.push(
      `${r.failClosedTests.length} new test(s) join every survivor because their coverage could not be used: ${r.failClosedTests.map((f) => `${qualifiedTestName(f.ref)} (${f.why})`).join("; ")}`,
    );
  }
  if (r.failClosedSurvivors.length > 0) {
    warnings.push(
      `${r.failClosedSurvivors.length} survivor(s) take every new test because coverage cannot place their code (R175/R298): ${ids(r.failClosedSurvivors.map((s) => s.mutantId))}`,
    );
  }
  if (r.untargeted.length > 0) {
    warnings.push(
      `${r.untargeted.length} table-trigger survivor(s) take all ${r.filterable} new test(s) whose coverage could be read, because none of them touched that table: ${ids(r.untargeted)}`,
    );
  }
  if (emitTo !== undefined) {
    const emit = createEmitter(emitTo);
    for (const message of warnings) {
      emit({ type: "warning", code: "verify-reach-fail-closed", message });
    }
  }
  const n = plan.newTests.length;
  // The survivors' order is the request order, which is the source's target order.
  const noNew = plan.requests.map((q) => q.mutantId).filter((id) => r.noNewTest.has(id));
  log(
    `[lethal] verify: reach filter on (fenced coverage): ${n} new test(s), ${r.failClosedTests.length} joined every survivor because their coverage could not be used; ${r.joins} mutant run(s) instead of ${plan.cap.s * n} without the filter; ${noNew.length} survivor(s) no new test reaches.`,
  );
  if (noNew.length > 0) log(`[lethal] verify: survivors no new test reaches: ${ids(noNew)}`);
}

type MeasuredPart = Omit<
  VerifyResult,
  "id" | "batchIndex" | "mutantCode" | "file" | "line" | "operatorName" | "procedureName" | "gapId"
>;

/** One measured mutant's verdict and its kill proof (decisions 13 and 14). */
function measuredResultOf(
  o: SessionOutcome,
  methods: readonly TestMethodRef[],
  newKeys: ReadonlySet<string>,
  published: PublishedTestApp | undefined,
): MeasuredPart {
  const common = {
    testsRun: methods.map(qualifiedTestName),
    ...(o.invalidBaseline !== undefined
      ? { invalidBaseline: o.invalidBaseline.map(qualifiedTestName) }
      : {}),
    ...(o.failureNote !== undefined ? { failureNote: o.failureNote } : {}),
  };
  if (o.verdict === "survived" || o.verdict === "error") {
    return { ...common, verdict: o.verdict };
  }
  if (o.verdict === "timeout-killed") {
    // A hang, not a failing test: no test failure proves this kill (decision 7: error covers a
    // timeout).
    const note = o.failureNote !== undefined ? `; ${o.failureNote}` : "";
    return {
      ...common,
      verdict: "error",
      failureNote: `timeout-killed: the mutant ran past its time budget, so no test failure proves the kill${note}`,
    };
  }
  if (o.verdict !== "killed") {
    throw new Error(`verify.ts: runNamedMutants answered ${o.mutant.mutantId} ${o.verdict}`);
  }
  const ref = o.killingTestRef;
  if (ref === undefined) {
    throw new Error(`verify.ts: ${o.mutant.mutantId} was killed with no killingTestRef (a bug)`);
  }
  if (published === undefined) {
    throw new Error(`verify.ts: ${o.mutant.mutantId} was killed but no test app was published`);
  }
  return {
    ...common,
    verdict: "killed",
    killingTest: { codeunitId: ref.codeunitId, codeunitName: ref.codeunitName, method: ref.method },
    killedByNewTest: newKeys.has(testKeyOf(ref)),
    killedBy: killedByOf(o.killingTestFailure, published.name),
    ...(o.killingTestFailure !== undefined ? { killingTestFailure: o.killingTestFailure } : {}),
  };
}
