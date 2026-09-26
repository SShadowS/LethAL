import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import { InstalledArtifactError } from "./artifact";
import type { TestMethodRef } from "./backend";
import { hashTargetSource } from "./baseline-snapshot";
import { discoverTests } from "./discovery";
import { type EquivalenceMark, loadEquivalenceMarks } from "./equivalence-marks";
import {
  type InstalledArtifactRef,
  NamedMutantError,
  type NamedMutantRequest,
} from "./named-mutants";
import { identityKeyOf, serializeKey, testKeyOf } from "./selection";
import { DuplicateArtifactRecordError, type ResultsStore } from "./store";
import { TestAppError, type TestAppRefusal } from "./test-app-publish";

/** C02-06 decision 7: every reason `lethal verify` can refuse for, before it measures anything. */
export const VERIFY_REFUSALS = [
  "malformed-request",
  "unknown-artifact",
  "batch-not-installed",
  "wrong-batch",
  "unknown-mutant",
  "not-a-survivor",
  "carried",
  "source-predates-verify",
  "source-changed",
  "covering-test-unmatched",
  "no-tests-to-run",
  "unsupported-config",
  "project-unreadable",
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
  if (err instanceof VerifyError)
    return { kind: "refused", reason: err.reason, detail: err.detail };
  if (err instanceof NamedMutantError) return refused("malformed-request", err.message);
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
}

const ARTIFACT_ID = /^[0-9a-f]{32}$/;
const SURVIVOR_ID = /^(0|[1-9]\d*)\/(M\d{4,})$/;

/**
 * Decisions 1 and 2. The artifact is 32 lowercase hex. Each `--survivors` value is a comma list of
 * `<batchIndex>/<mutantCode>` ids, and repeated flags add to one list. An empty list, a malformed
 * id or the same id twice is refused, never dropped or merged.
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
    throw new VerifyError("malformed-request", "--survivors names no mutant");
  }
  const bad = raw.filter((s) => !SURVIVOR_ID.test(s));
  if (bad.length > 0) {
    throw new VerifyError(
      "malformed-request",
      `not a <batchIndex>/<mutantCode> id (for example 0/M0004): ${bad.map((s) => `"${s}"`).join(", ")}`,
    );
  }
  const repeated = [...new Set(raw.filter((s, i) => raw.indexOf(s) !== i))];
  if (repeated.length > 0) {
    throw new VerifyError("malformed-request", `named more than once: ${repeated.join(", ")}`);
  }
  const ids = raw.map((s) => {
    const [batch, code] = s.split("/");
    if (batch === undefined || code === undefined) throw new Error(`verify.ts: unparsed id ${s}`);
    return { batchIndex: Number(batch), mutantCode: code };
  });
  return { artifactId: artifact, ids };
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
export function resolveVerifySource(store: ResultsStore, req: VerifyRequest): VerifySource {
  // parseVerifyRequest refuses this too; a caller building the request directly must not get a
  // source with no targets, which planVerify could only answer as "every target was skipped".
  if (req.ids.length === 0) {
    throw new VerifyError("malformed-request", "the request names no mutant");
  }
  let rec: ReturnType<ResultsStore["artifactRecordById"]>;
  try {
    rec = store.artifactRecordById(req.artifactId);
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
      `the store records no artifact ${req.artifactId}; copy the id from the run's report (artifacts[].artifactId)`,
    );
  }
  if (rec.batchIndex !== rec.highestBatchIndex) {
    throw new VerifyError(
      "batch-not-installed",
      `artifact ${req.artifactId} is batch ${rec.batchIndex} of run ${rec.runId}, but batch ${rec.highestBatchIndex} was published after it and replaced it on the server`,
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
    installed: { fromRunId: rec.runId, batchIndex: rec.batchIndex, appPath, instrumentedDir },
    targets,
  };
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
  // Carried item 1: a missing project or app.json is a refusal, not an ENOENT from the hash.
  for (const [path, want] of [
    [source.projectPath, "directory"],
    [join(source.projectPath, "app.json"), "file"],
  ] as const) {
    const st = await stat(path).catch(() => undefined);
    if (st === undefined || (want === "directory" ? !st.isDirectory() : !st.isFile())) {
      throw new VerifyError(
        "project-unreadable",
        `${path} is missing or not a ${want}: the source run's project path is stored as it was typed and resolved against the current directory; run verify from where lethal run ran, or run lethal run again`,
      );
    }
  }
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
