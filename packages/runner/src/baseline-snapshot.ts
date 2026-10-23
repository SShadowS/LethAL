/**
 * R192, second half: a batch's baseline is reused on `--resume` when nothing it measured can have
 * changed.
 *
 * The baseline does four jobs for a batch: it establishes the green set (R55), collects the
 * coverage every mutant is attributed with, measures the durations the mutant budgets are derived
 * from, and proves the published test app is the one the source declares (R56/R139). Every one of
 * those is a function of two things: the INSTRUMENTED SOURCE the batch published, and the TEST APP
 * the server holds. When both are byte-identical to what a prior run measured, re-running the
 * baseline re-measures the same function of the same inputs. Measured 2026-09-02 on a hosted
 * sandbox: 407 tests, 197 to 242 s, on every one of twelve resumes, for a batch that still had
 * mutants to run and could not be skipped by the first half.
 *
 * What is deliberately NOT covered by the two hashes, and is the caveat a reader of a resumed
 * report is given: the environment's DATA. A test that was green at the prior baseline and would
 * be red now because the sandbox changed underneath is not re-detected. That risk already exists
 * inside every run (the baseline runs once, the mutants minutes later), and a resume within the
 * same lineage is not a different kind of risk; it is stated rather than measured away.
 *
 * The batch hash covers the `.al` files of the instrumented artifact directory EXCEPT the three
 * control files LethAL emits at the directory's root (a same-named file elsewhere is hashed), because `MutationSelector.Codeunit.al` embeds the artifact id, which
 * is random per artifact by design (`newArtifactId`), and it carries no target code whose lines a
 * coverage row could name. Two artifacts of one batch therefore hash the same, which is what makes
 * a prior run's fenced line-number coverage apply to this run's artifact.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CONTROL_REGISTER_FILENAME,
  CONTROL_SELECTOR_FILENAME,
  CONTROL_UPGRADE_FILENAME,
} from "@lethal/schemata";
import {
  type PackageUnread,
  type PublishedPackageRead,
  type TestMethodRef,
  type TestVerdict,
  isUnread,
} from "./backend";
import {
  type LinkPolicy,
  ProjectSymlinkRefusedError,
  assertNoUnexcusedLinks,
  walkFiles,
} from "./walk";

const CONTROL_FILES: ReadonlySet<string> = new Set([
  CONTROL_SELECTOR_FILENAME,
  CONTROL_REGISTER_FILENAME,
  CONTROL_UPGRADE_FILENAME,
]);

/** One baseline observation as the orchestrator holds it; the payload a snapshot stores verbatim. */
export interface BaselineObservation {
  readonly ref: TestMethodRef;
  readonly verdict: TestVerdict;
}

export interface BaselineSnapshot {
  readonly runId: number;
  readonly batchIndex: number;
  readonly batchHash: string;
  readonly testAppHash: string;
  readonly baseline: readonly BaselineObservation[];
}

/**
 * SHA-256 over every `.al` file under `dir` (recursively, sorted, path and bytes), skipping the
 * three control files at the root of `dir` only (R691). Deterministic across two artifacts of the same batch, different for any change
 * to any instrumented line.
 *
 * R655: under the R631 rule (`hashTestDir`), so a link refuses by name. Its callers hash
 * LethAL-built trees (a batch dir, al-runner v3's `active/`), which hold no link (measured,
 * `/coord/handoff/R-655/measure.md`); a skipped one would leave AL that alc and al-runner follow
 * out of the hash.
 */
export async function hashAlTree(dir: string): Promise<string> {
  // R691: LethAL writes its control files at the ROOT of this tree only; a same-named file
  // anywhere else is user AL and is hashed.
  return hashWalked(dir, "refuse", true);
}

/**
 * R631: `hashAlTree` over a USER test root. The walk refuses a link (`ProjectSymlinkRefusedError`),
 * and a skipped unexcused link refuses too, whatever `links` is, so the hash never quietly leaves
 * out AL that alc and al-runner would compile. `links` exists only so a test can force a skip.
 */
export async function hashTestDir(dir: string, links: LinkPolicy = "refuse"): Promise<string> {
  // R691: LethAL writes nothing here, so no file is left out.
  return hashWalked(dir, links, false);
}

async function hashWalked(
  dir: string,
  links: LinkPolicy,
  skipRootControl: boolean,
): Promise<string> {
  const walk = await walkFiles(dir, { links });
  assertNoUnexcusedLinks(dir, walk.skippedLinks);
  return hashAlFiles(dir, walk.files, skipRootControl);
}

/** R608: one non-`.al` file of a bound folder, as the proof recorded it. */
export interface OtherFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

/**
 * R608: every NON-`.al` file under `dir` (resources, `.alpackages`, ...) except those `skip` names
 * (root-relative, forward slashes), under the same walk and link refusal as `hashTestDir`.
 * `withSha` hashes each file; without it `sha256` is "" (the cheap re-list).
 */
export async function listOtherFiles(
  dir: string,
  skip: (rel: string) => boolean,
  withSha: boolean,
): Promise<Map<string, OtherFile>> {
  const walk = await walkFiles(dir, { links: "refuse" });
  assertNoUnexcusedLinks(dir, walk.skippedLinks);
  const out = new Map<string, OtherFile>();
  for (const f of walk.files) {
    const rel = f.replaceAll("\\", "/");
    if (rel.toLowerCase().endsWith(".al") || skip(rel)) continue;
    const p = join(dir, f);
    const s = await stat(p);
    out.set(rel, {
      size: s.size,
      mtimeMs: s.mtimeMs,
      sha256: withSha ? hashPackage(new Uint8Array(await readFile(p))) : "",
    });
  }
  return out;
}

/**
 * R608: the first path (added, removed or changed) where `dir` no longer matches `was`, or
 * `undefined`. A file whose size and mtime are unchanged is taken as unchanged; one that moved is
 * re-hashed (the rule `<deps>` already uses).
 * ponytail: a rewrite with the same size inside the same mtime tick is missed; hash every file if a
 * measured case needs it.
 */
export async function otherFilesDrift(
  dir: string,
  skip: (rel: string) => boolean,
  was: ReadonlyMap<string, OtherFile>,
): Promise<string | undefined> {
  const now = await listOtherFiles(dir, skip, false);
  for (const rel of now.keys()) if (!was.has(rel)) return rel;
  for (const [rel, w] of was) {
    const n = now.get(rel);
    if (n === undefined) return rel;
    if (n.size === w.size && n.mtimeMs === w.mtimeMs) continue;
    if (hashPackage(new Uint8Array(await readFile(join(dir, rel)))) !== w.sha256) return rel;
  }
  return undefined;
}

async function hashAlFiles(
  dir: string,
  all: readonly string[],
  skipRootControl: boolean,
): Promise<string> {
  const entries = all
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.toLowerCase().endsWith(".al"))
    .filter((f) => !(skipRootControl && CONTROL_FILES.has(f)))
    .sort();
  const h = createHash("sha256");
  for (const rel of entries) {
    h.update(`${rel}\n`);
    h.update(await readFile(join(dir, rel)));
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * Every `.al` file under `projectDir`, project-relative with the OS separator: exactly the AL that
 * `prepareBatchProject` copies into a batch dir, dot-directories included (see
 * `isToolResourcePath` there). One enumeration for both, so the source hash below cannot drift
 * from what the target build compiles.
 */
export async function targetAlFiles(projectDir: string): Promise<string[]> {
  // R631: a link refuses (alc follows it, so skipping it would measure another build).
  return (await walkFiles(projectDir, { links: "refuse" })).files.filter((rel) =>
    rel.toLowerCase().endsWith(".al"),
  );
}

/**
 * C02-06 decision 8: SHA-256 over the target build's inputs, so `lethal verify` can refuse a run
 * whose installed build was made from other source. Every file `targetAlFiles` names plus
 * `app.json`, as `<forward-slash relative path> NUL <bytes> NUL` in sorted path order, then the
 * sorted preprocessor symbols as one line. A test project nested inside the target is IN, because
 * the target build copies its `.al` too. `app.json` is IN as a compile input: a version-only bump
 * also changes the hash, which costs one `lethal run`.
 *
 * ponytail: resources (`.xlf`, report layouts) and the rest of `lethal.config.json` are not hashed;
 * they do not change AL behaviour under test the way AL does. Add them if a measured case shows
 * otherwise.
 */
export async function hashTargetSource(
  projectDir: string,
  preprocessorSymbols: readonly string[],
): Promise<string> {
  return hashSourceSnapshot(await readTargetSource(projectDir), preprocessorSymbols);
}

/** R205: the target's source could not be read into a snapshot. Names the path and the cause. */
export class SourceSnapshotUnreadableError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `the target's source could not be read at ${path} (${cause instanceof Error ? cause.message : String(cause)}), so LethAL cannot pin the source it measures`,
    );
    this.name = "SourceSnapshotUnreadableError";
  }
}

/**
 * The target build's inputs read ONCE: every `targetAlFiles` path plus `app.json`, keyed by the
 * path as `targetAlFiles` spells it. `runSession` hashes this snapshot AND hands it to
 * `generateMutationSet` to parse, so the recorded hash is of the bytes generation consumed, not of
 * a separate read that an edit could land between.
 *
 * R205: a read failure throws `SourceSnapshotUnreadableError`, except a missing `app.json`, which
 * leaves the key out (readers then treat it as absent, never as "read the disk"). `readFileFn` is
 * the file read, a parameter so a test can fail one read deterministically on every platform.
 */
export async function readTargetSource(
  projectDir: string,
  readFileFn: (path: string) => Promise<Buffer> = (p) => readFile(p),
): Promise<ReadonlyMap<string, Buffer>> {
  const read = async <T>(path: string, f: () => Promise<T>) => {
    try {
      return await f();
    } catch (err) {
      // R631: a refused link is its own named refusal, not an unreadable file.
      if (err instanceof ProjectSymlinkRefusedError) throw err;
      throw new SourceSnapshotUnreadableError(path, err);
    }
  };
  const snapshot = new Map<string, Buffer>();
  for (const rel of await read(projectDir, () => targetAlFiles(projectDir))) {
    const path = join(projectDir, rel);
    snapshot.set(rel, await read(path, () => readFileFn(path)));
  }
  const appJson = join(projectDir, "app.json");
  const manifest = await read(appJson, () =>
    readFileFn(appJson).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    }),
  );
  if (manifest !== undefined) snapshot.set("app.json", manifest);
  return snapshot;
}

/** `hashTargetSource` over a snapshot `readTargetSource` took. */
export function hashSourceSnapshot(
  snapshot: ReadonlyMap<string, Buffer>,
  preprocessorSymbols: readonly string[],
): string {
  const files = [...snapshot.entries()]
    .map(([rel, bytes]) => [rel.replaceAll("\\", "/"), bytes] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash("sha256");
  for (const [rel, bytes] of files) {
    h.update(`${rel}\0`);
    h.update(bytes);
    h.update("\0");
  }
  h.update(`preprocessorSymbols\0${JSON.stringify([...preprocessorSymbols].sort())}\n`);
  return h.digest("hex");
}

/**
 * R274: the ONE decode of a snapshot file to the text generation parses and `lethal explain
 * --project` renders. Buffer's decode keeps a UTF-8 BOM (`TextDecoder` and `Bun.file().text()`
 * strip it), so every offset a report records lines up with this text.
 */
export function decodeSource(bytes: Buffer): string {
  return bytes.toString("utf8");
}

/** SHA-256 of a published package's bytes, the test app as the SERVER holds it. */
export function hashPackage(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The test app's identity for the snapshot key. The published package when the backend can read
 * it (bcdev), else the test project's own `.al` tree (al-runner compiles the test bundle itself, so
 * the source IS what runs). `undefined` when neither can be established, which means "do not
 * reuse": an unknown test app is not an unchanged one. R630: a failed package read is returned AS
 * ITSELF (`{ unread }`), so a refusal can name its cause; it is never a hash.
 */
export async function testAppHashFor(
  fetchPackage: (() => Promise<PublishedPackageRead>) | undefined,
  testDir: string,
  /** R631: only a test forces `"skip"`; a skipped link still makes the answer `undefined`. */
  links: LinkPolicy = "refuse",
): Promise<string | PackageUnread | undefined> {
  if (fetchPackage !== undefined) {
    const bytes = await fetchPackage();
    if (bytes instanceof Uint8Array) return `package:${hashPackage(bytes)}`;
    // R630 review I1: explicit, before the fall-through below. The read failed, which is not the
    // same as "no package concept", and must never become the source tree's hash.
    if (isUnread(bytes)) return bytes;
    // `undefined`: the backend cannot form the request (env-tool path). Fall through to source.
  }
  try {
    return `source:${await hashTestDir(testDir, links)}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether a stored snapshot may stand in for this batch's baseline. Both hashes must match; a
 * snapshot from any earlier run in the same database qualifies, since the hashes are the identity
 * and the run id is provenance.
 */
export function snapshotApplies(
  snapshot: BaselineSnapshot | null,
  batchHash: string,
  testAppHash: string | undefined,
): snapshot is BaselineSnapshot {
  if (snapshot === null || testAppHash === undefined) return false;
  return snapshot.batchHash === batchHash && snapshot.testAppHash === testAppHash;
}
