import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import { InstalledArtifactError } from "./artifact";
import { killMessageOf, looksLikeAssertionFailure } from "./assertion-screen";
import type { ExecutionBackend, TestMethodRef } from "./backend";
import { hashTargetSource } from "./baseline-snapshot";
import type { BcDevMcpBackend } from "./bcdev-backend";
import { discoverTests } from "./discovery";
import {
  type EquivalenceMark,
  EquivalenceMarksError,
  loadEquivalenceMarks,
} from "./equivalence-marks";
import { type GapRow, tallyGaps } from "./gaps";
import {
  type InstalledArtifactRef,
  type NamedMutantRequest,
  loadInstalledArtifact,
} from "./named-mutants";
import {
  type LeaseSessionConfig,
  type UnmutatedRun as NamedUnmutatedRun,
  type SessionConfig,
  qualifiedTestName,
  runNamedMutants,
} from "./orchestrator";
import type { SessionOutcome } from "./report";
import { identityKeyOf, serializeKey, testKeyOf } from "./selection";
import { DuplicateArtifactRecordError, type ResultsStore } from "./store";
import {
  type CompiledTestApp,
  type PublishedTestApp,
  TestAppError,
  type TestAppRefusal,
} from "./test-app-publish";

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
    "the run's local .app or instrumented files are gone or changed; run lethal run again, then verify",
  "unknown-gap":
    "copy the gap id and its artifactId from one lethal explain gap of the run that published this artifact; an edited or moved block, or other line endings, give a new id, and only the run's last batch stays installed",
  "gap-has-no-survivor":
    "every recorded mutant in this block is killed, not measured or no-coverage; there is nothing to verify as a gap",
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
  // refusal, not batchMutantRows' throw on an old row.
  const { appPath, instrumentedDir, sourceSha256 } = rec;
  if (appPath === null || instrumentedDir === null || sourceSha256 === null) {
    throw new VerifyError(
      "source-predates-verify",
      `run ${rec.runId} did not record its installed files or its source hash. That happens when the run was recorded before lethal verify existed, its source changed during the run, the run stopped before the last batch, or its source tree was unreadable; run lethal run again, then verify`,
    );
  }
  const installed: InstalledArtifactRef = {
    fromRunId: rec.runId,
    batchIndex: rec.batchIndex,
    appPath,
    instrumentedDir,
  };
  return { rec, sourceSha256, installed };
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
  // Two rows for one mutant is corruption. A manifest entry with NO row is not: a run that
  // quarantined or threw partway through its last batch still records the artifact, so its
  // unscored entries are "not measured" and stay out of every gap's members and counts.
  const recorded = new Set(rows.map((r) => r.mutantCode));
  if (recorded.size !== rows.length) {
    throw new Error(
      `verify.ts: run ${rec.runId} batch ${rec.batchIndex} records ${rows.length} row(s) for ${recorded.size} mutant(s): a mutant twice (a corrupt store)`,
    );
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
          ? `; its no-coverage mutants (${t.noCoverageMembers.map((c) => `${rec.batchIndex}/${c}`).join(", ")}) are in lethal explain's noCoverageBlocks and can be named one by one`
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

  const direct = new Set(req.ids.map((i) => `${i.batchIndex}/${i.mutantCode}`));
  const expanded = req.gapIds.flatMap((g) =>
    (tallies.get(g)?.members ?? []).map((mutantCode) => ({
      gapId: g,
      batchIndex: rec.batchIndex,
      mutantCode,
    })),
  );
  const twice = expanded.filter((e) => direct.has(`${e.batchIndex}/${e.mutantCode}`));
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
    const id = `${batchIndex}/${mutantCode}`;
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

  return {
    runId: rec.runId,
    // Carried item 1: stored as typed, so possibly relative. Resolved once, here.
    projectPath: resolve(rec.projectPath),
    artifactSha256: rec.artifactSha256,
    sourceSha256,
    installed,
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
  /** One request per survivor that runs. `[]` only when every target was skipped, and then
   *  `skipped` is non-empty: an empty request is refused, never planned. */
  readonly requests: readonly NamedMutantRequest[];
  readonly newTests: readonly TestMethodRef[];
  readonly skipped: ReadonlyArray<{
    readonly entry: MutantManifestEntry;
    readonly mark: EquivalenceMark;
  }>;
  /** Every target's trusted manifest entry, skipped or not, by mutant code. */
  readonly entries: ReadonlyMap<string, MutantManifestEntry>;
}

/**
 * Decisions 5 and 6. `manifest` is the one `loadInstalledArtifact` matched. Reads the project's
 * CURRENT marks file and the test project's `.al` files; never a server.
 *
 * A survivor a reader marked equivalent is skipped. Every other one runs its source-run covering
 * tests, each matched to the source baseline by `(codeunitId, method)` and required unchanged in
 * the test project, then every new test (not in the source baseline by `testKeyOf`).
 */
export async function planVerify(a: {
  readonly source: VerifySource;
  readonly manifest: MutantManifest;
  readonly sourceBaseline: ReturnType<ResultsStore["baselineTests"]>;
  readonly testDir: string;
}): Promise<VerifyPlan> {
  const { source, manifest, sourceBaseline, testDir } = a;
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
  const marks = (await loadEquivalenceMarks(source.projectPath)) ?? [];
  const markByKey = new Map(marks.map((m) => [m.key, m] as const));
  const skipped: Array<VerifyPlan["skipped"][number]> = [];
  const running: Array<VerifySource["targets"][number]> = [];
  for (const t of source.targets) {
    const entry = entries.get(t.mutantCode);
    if (entry === undefined) throw new Error(`verify.ts: ${t.mutantCode} lost its entry`);
    const mark = markByKey.get(serializeKey(identityKeyOf(entry)));
    if (mark !== undefined) skipped.push({ entry, mark });
    else running.push(t);
  }
  if (running.length === 0) return { requests: [], newTests: [], skipped, entries };

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

  const discovered = await discoverTests(testDir);
  const baselineKeys = new Set(
    sourceBaseline.map((r) =>
      testKeyOf({ codeunitId: r.codeunitId, codeunitName: "", method: r.method }),
    ),
  );
  const newTests = discovered.filter((ref) => !baselineKeys.has(testKeyOf(ref)));

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
  for (const t of running) {
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
      else add(ref);
    }
    for (const ref of newTests) add(ref);
    if (methods.length === 0) noTests.push(`${t.batchIndex}/${t.mutantCode}`);
    requests.push({ mutantId: t.mutantCode, methods });
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
  return { requests, newTests, skipped, entries };
}

/** C02-06 decision 7: the JSON `lethal verify` prints. 2 since C02-09 added two refusal reasons. */
export const VERIFY_SCHEMA_VERSION = 2;
export const VERIFY_VERDICTS = ["killed", "survived", "error", "skipped"] as const;
export const KILLED_BY = ["assertion", "runtime-error", "other"] as const;
export const NEW_TEST_STATES = ["stable", "flaky", "red", "flaky-unknown"] as const;
// Named, not inline, like KilledBy and NewTestState below it: schemas.test.ts's typeLeafPaths walk
// (C02-06 Task 6) resolves a field's domain by the NAME at that property, and an inline
// `(typeof X)[number]` there has no name to resolve.
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];
export type KilledBy = (typeof KILLED_BY)[number];
export type NewTestState = (typeof NEW_TEST_STATES)[number];

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

/** One unmutated run of one new test (decision 11). Any non-pass outcome that ran is `fail`. */
export interface UnmutatedRun {
  readonly outcome: "pass" | "fail" | "not-run";
  readonly fresh: boolean;
  readonly sessionId?: number;
  readonly testRunsBefore?: number;
}

export interface NewTestResult {
  /** Qualified `Codeunit.Method`. */
  readonly test: string;
  readonly codeunitId: number;
  readonly state: NewTestState;
  /** `[baseline, rerun]`. */
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
}

export interface VerifyOutput {
  readonly verifySchemaVersion: number;
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
  return {
    outcome: r.outcome === "pass" || r.outcome === "not-run" ? r.outcome : "fail",
    fresh: r.fresh,
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.testRunsBefore !== undefined ? { testRunsBefore: r.testRunsBefore } : {}),
  };
}

/** Decision 11: red, stable, flaky, or flaky-unknown for anything not attributable. */
function newTestResultOf(
  ref: TestMethodRef,
  baseline: NamedUnmutatedRun,
  rerun: NamedUnmutatedRun,
): NewTestResult {
  const b = unmutatedRunOf(baseline);
  const r = unmutatedRunOf(rerun);
  const state: NewTestState =
    b.fresh && b.outcome === "fail"
      ? "red"
      : b.fresh && b.outcome === "pass" && r.fresh && r.outcome === "pass"
        ? "stable"
        : b.fresh && b.outcome === "pass" && r.fresh && r.outcome === "fail"
          ? "flaky"
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
  const header = () => ({
    verifySchemaVersion: VERIFY_SCHEMA_VERSION,
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
    await assertSourceUnchanged(source, deps.preprocessorSymbols, args.testDir);
    const { artifact, manifest } = await loadInstalledArtifact(store, source.installed);
    const plan = await planVerify({
      source,
      manifest,
      sourceBaseline: store.baselineTests(source.runId),
      testDir: args.testDir,
    });
    const skippedBy = new Map(plan.skipped.map((s) => [s.entry.mutantId, s] as const));

    let res: Awaited<ReturnType<typeof runNamedMutants>> | undefined;
    if (plan.requests.length > 0) {
      // Before any lease: a compile failure costs no lease, no run row and no server call.
      const tc = now();
      const compiled: CompiledTestApp = await backend.compileTestApp(args.testDir, artifact);
      compileMs = now() - tc;
      verifyRunId = store.createRun({
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
        inLease: async (fence) => {
          const tp = now();
          published = await backend.publishTestApp(fence, compiled);
          publishMs = now() - tp;
        },
      });
    }

    // Decision 11: every new test's two unmutated runs, from this call's own answers.
    const newKeys = new Set(plan.newTests.map(testKeyOf));
    const ran = res;
    const newTests =
      ran === undefined
        ? []
        : plan.newTests.map((ref) => {
            const key = testKeyOf(ref);
            const b = ran.baseline.find((x) => testKeyOf(x.ref) === key);
            const r = ran.rerun.find((x) => testKeyOf(x.ref) === key);
            if (b === undefined || r === undefined) {
              throw new Error(`verify.ts: runNamedMutants did not answer new test ${key}`);
            }
            return newTestResultOf(ref, b, r);
          });

    const outcomeBy = new Map((ran?.outcomes ?? []).map((o) => [o.mutant.mutantId, o] as const));
    const requestBy = new Map(plan.requests.map((r) => [r.mutantId, r] as const));
    const results = source.targets.map((t): VerifyResult => {
      const entry = plan.entries.get(t.mutantCode);
      if (entry === undefined) throw new Error(`verify.ts: ${t.mutantCode} has no entry`);
      const base = {
        id: `${t.batchIndex}/${t.mutantCode}`,
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
      const o = outcomeBy.get(t.mutantCode);
      const request = requestBy.get(t.mutantCode);
      if (o === undefined || request === undefined) {
        throw new Error(`verify.ts: ${t.mutantCode} was requested but got no outcome`);
      }
      return { ...base, ...measuredResultOf(o, request.methods, newKeys, published) };
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
      timings: timings(),
    };
  } catch (err) {
    const out = refusalOutput(err, timings());
    if (out === undefined) throw err;
    return { ...header(), ...out };
  }
}

/**
 * The output for a typed refusal or quarantine caught before anything was measured: `results: []`
 * always. `undefined` for any other error, which the caller rethrows (exit 1).
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
