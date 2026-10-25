/**
 * R586 §6 (plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`): `Sleep` does
 * nothing on al-runner v3 alpha.2 (#5605), so a mutant that makes a Sleep-retry loop run long is a
 * timeout kill on BC and a PASS on v3: a false survive. The rule, fail-closed: a covering pass whose
 * per-test coverage reaches a project `Sleep(` reads `error` / `runner-refused`, and so does every
 * covering pass whose coverage cannot show that it did not.
 *
 * The index is built from the text v3 READS (the instrumented `active/` copy, every mutant arm
 * included, and the test dir), keyed by the absolute path v3 reports, and matched against RAW
 * `--coverage-json` lines: never through the line map, the coverage index or its multi-object and
 * wrapped refusals (those are the safe direction for selection and the unsafe one here).
 *
 * R-762 B: the rule is OFF on a pinned build whose pin and session probe both read `sleep-is-noop`
 * gone (`sleepRuleRetiredFor`, alpha.5 and edge): there the backend never calls the refusals below.
 * The index is still built for every batch (its sizes are pre-committed figures).
 */
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ALSyntaxNode,
  initParser,
  normalizeAlName,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import type { ServerCoverageFile } from "./al-runner-server";
import { type LinkPolicy, walkFiles } from "./walk";

/** One indexed Sleep call: the absolute `/`-separated path v3 reports, and its 1-based line. */
export interface SleepSite {
  readonly file: string;
  readonly line: number;
}

/** Lower-cased absolute path (forward slashes) -> the lines holding a Sleep call. */
export interface SleepIndex {
  readonly byFile: ReadonlyMap<string, ReadonlySet<number>>;
  /** The paths as v3 reports them, for the notes. */
  readonly shown: ReadonlyMap<string, string>;
  /** Count per root, for the pre-committed index size (S1 0, D 3 + 0, ...). */
  readonly sizes: { readonly target: number; readonly test: number };
  /** The two roots, as `sleepFileKey`s of their `realpath` with a trailing `/` (I-1). */
  readonly roots: { readonly target: string; readonly test: string };
}

/**
 * I-1: the index's keys and v3's coverage paths do not join, so "no Sleep hit" would be an empty
 * join, not a measurement. The session refuses. Extends `Error` directly.
 */
export class AlRunnerV3CoverageJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlRunnerV3CoverageJoinError";
  }
}

/**
 * I-1, as narrowed by the delta reviews' F2 and G1 (rulings 2026-10-21).
 *
 * What v3 lists, MEASURED (docs/measurements/README.md, "al-runner v3"): the top-level `coverage`
 * holds the files in the CALLED codeunit's static reach, each with every statement, zero-hit ones
 * included; it is NOT every compiled file. `contract-alpha2/cov.json` (`--codeunit 50652` on the
 * `scripts/r586-probe` project, not the contract probe's "Probe Cut") lists 3 of the 10 compiled
 * files, one of them reached by nothing with all its statements at 0 hits; the Q23 CDO call lists 478 of the 658 compiled files, unreached files included whole.
 *
 * With an EMPTY index (0 + 0) nothing can hide, so the function returns before any comparison.
 * Otherwise:
 * - TEST side, always strict: the called test codeunit's own file is always in its reach, so a
 *   document with no listed path under the test root means our keys and v3's paths are in different
 *   forms. A GLOBAL path-form change (a symlink, a relative form, a case or `..` change on both
 *   folders) is caught here.
 * - TARGET side, only a REAL mismatch: a listed path outside BOTH roots that ends like an indexed
 *   target file (its path relative to the target root), or IS that relative path. A test-app file
 *   with the same relative path is no mismatch (G1). A target file absent from the document is read
 *   as outside the call's reach, so not run in that call (§6 case 2's own reading).
 * RESIDUAL, stated plainly: a path-form change on the TARGET side only, with the endings changed as
 * well (for example a staged copy under mangled names), leaves the indexed file absent with no ending
 * to match, so a covered Sleep in it would read "not reached". It is not measured either way; the
 * always-strict test side catches any change that also moves the test paths.
 * Returns the refusal, or `undefined`. An unavailable document is case 1's business.
 */
export function sleepJoinRefusal(doc: V3CoverageRead, index: SleepIndex): string | undefined {
  if (doc.kind === "unavailable") return undefined;
  if (index.sizes.target + index.sizes.test === 0) return undefined;
  const listed = doc.coverage.map((f) => ({ key: sleepFileKey(f.file), file: f.file }));
  const sample = listed
    .slice(0, 3)
    .map((l) => l.file)
    .join(", ");
  const why = (what: string) =>
    `al-runner-v3-coverage-join-refused: ${what} (${listed.length} listed, e.g. ${sample || "none"}); reading that as "no Sleep hit" would be an empty join, so the session stops (R586 §6, I-1)`;
  if (!listed.some((l) => l.key.startsWith(index.roots.test))) {
    return why(`no path in v3's coverage document sits under the test root ${index.roots.test}`);
  }
  const targetRels = [...index.byFile.keys()]
    .filter((k) => k.startsWith(index.roots.target))
    .map((k) => k.slice(index.roots.target.length));
  for (const l of listed) {
    // G1: a file under either root joined; a test-app file may share a target file's relative path.
    if (l.key.startsWith(index.roots.target) || l.key.startsWith(index.roots.test)) continue;
    // G1: a bare relative label (`probesleeper.codeunit.al`) has no leading `/`.
    const rel = targetRels.find((r) => l.key === r || l.key.endsWith(`/${r}`));
    if (rel !== undefined) {
      return why(
        `v3 lists ${l.file}, which ends like the indexed target file ${index.roots.target}${rel} but sits under another prefix`,
      );
    }
  }
  return undefined;
}

/** The key both sides are compared by: `/`-separated and lower-cased. */
export function sleepFileKey(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

/**
 * The 1-based lines of every `Sleep(...)` CALL in `source`: a call whose callee is the bare
 * identifier `Sleep` (any case, any argument). `X.Sleep(...)` (a method on a variable) and text in
 * comments or strings are not calls of it. A project procedure named `Sleep` matches too, which
 * only errs toward refusing.
 */
export function sleepCallLines(source: string): number[] {
  const lines = new Set<number>();
  visit(wrapRoot(parseAL(source)), (n: ALSyntaxNode) => {
    if (n.rawKind !== "call_expression" && n.rawKind !== "call_statement") return;
    const f = n.childForFieldName("function");
    if (f === null || f.rawKind !== "identifier") return;
    if (normalizeAlName(f.text) === "sleep") lines.add(n.startPosition.row + 1);
  });
  return [...lines].sort((a, b) => a - b);
}

/** R631: the deployed batch (LethAL-built) skips links; the user's test dir refuses one. */
async function alFilesUnder(dir: string, links: LinkPolicy): Promise<string[]> {
  return (await walkFiles(dir, { links })).files.filter((e) => e.toLowerCase().endsWith(".al"));
}

/**
 * The index of `targetDir` (the deployed `active/`) and `testDir`, under their `realpath` (I-1:
 * the backend sends v3 the same real paths, so a symlinked root cannot split the two forms).
 */
export async function buildSleepIndex(targetDirIn: string, testDirIn: string): Promise<SleepIndex> {
  await initParser();
  const targetDir = await realpath(targetDirIn);
  const testDir = await realpath(testDirIn);
  const byFile = new Map<string, Set<number>>();
  const shown = new Map<string, string>();
  const sizes = { target: 0, test: 0 };
  const rootKey = (d: string) => `${sleepFileKey(resolve(d)).replace(/\/+$/, "")}/`;
  const roots = { target: rootKey(targetDir), test: rootKey(testDir) };
  for (const [root, which] of [
    [targetDir, "target"],
    [testDir, "test"],
  ] as const) {
    for (const rel of await alFilesUnder(root, which === "test" ? "refuse" : "skip")) {
      const abs = resolve(join(root, rel)).replaceAll("\\", "/");
      const lines = sleepCallLines(await readFile(join(root, rel), "utf8"));
      if (lines.length === 0) continue;
      const key = sleepFileKey(abs);
      byFile.set(key, new Set(lines));
      shown.set(key, abs);
      sizes[which] += lines.length;
    }
  }
  return { byFile, shown, sizes, roots };
}

/** One test's statements as `perTestCoverage` lists them. */
export interface V3PerTestCoverage {
  readonly test: string;
  readonly coverage: readonly ServerCoverageFile[];
}

/** A whole `--coverage-json` document, or why there is none. */
export type V3CoverageRead =
  | {
      readonly kind: "doc";
      readonly coverage: readonly ServerCoverageFile[];
      readonly perTestCoverage: readonly V3PerTestCoverage[];
    }
  | { readonly kind: "unavailable"; readonly why: string };

/** Strict decode: a document with any field of the wrong shape is unavailable, never partial. */
export function decodeV3Coverage(text: string | undefined): V3CoverageRead {
  if (text === undefined) return { kind: "unavailable", why: "no coverage file was written" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "unavailable", why: "the coverage file is not JSON" };
  }
  const files = (v: unknown): ServerCoverageFile[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out: ServerCoverageFile[] = [];
    for (const f of v) {
      if (typeof f !== "object" || f === null) return undefined;
      const { file, statements } = f as { file?: unknown; statements?: unknown };
      if (typeof file !== "string" || !Array.isArray(statements)) return undefined;
      for (const s of statements) {
        const { line, hits } = (s ?? {}) as { line?: unknown; hits?: unknown };
        if (typeof line !== "number" || typeof hits !== "number") return undefined;
      }
      out.push(f as ServerCoverageFile);
    }
    return out;
  };
  const doc = (raw ?? {}) as { coverage?: unknown; perTestCoverage?: unknown };
  const coverage = files(doc.coverage);
  if (coverage === undefined || !Array.isArray(doc.perTestCoverage)) {
    return { kind: "unavailable", why: "the coverage file has no valid coverage/perTestCoverage" };
  }
  const perTestCoverage: V3PerTestCoverage[] = [];
  for (const e of doc.perTestCoverage) {
    const { test, coverage: c } = (e ?? {}) as { test?: unknown; coverage?: unknown };
    const parsed = files(c);
    if (typeof test !== "string" || parsed === undefined) {
      return { kind: "unavailable", why: "a perTestCoverage entry is malformed" };
    }
    perTestCoverage.push({ test, coverage: parsed });
  }
  return { kind: "doc", coverage, perTestCoverage };
}

/** Hit indexed lines in `files`, as sites. */
function hitSites(files: readonly ServerCoverageFile[], index: SleepIndex): SleepSite[] {
  const out: SleepSite[] = [];
  for (const f of files) {
    const key = sleepFileKey(f.file);
    const lines = index.byFile.get(key);
    if (lines === undefined) continue;
    for (const s of f.statements ?? []) {
      if ((s.hits ?? 0) > 0 && s.line !== undefined && lines.has(s.line)) {
        out.push({ file: index.shown.get(key) ?? f.file, line: s.line });
      }
    }
  }
  return out;
}

const at = (s: SleepSite) => `${s.file}:${s.line}`;
export const SLEEP_NOTE_TAG = "[v3-sleep-noop]";

/**
 * §6 cases 2 and 4, for the whole CALL (they do not depend on which test asks):
 * - 2: an indexed line in a file v3 listed in its top-level `coverage`, with no statement on it:
 *   v3 is not seeing that line, so no pass proves it was not reached. (A file v3 did not list at
 *   all was not compiled into the call, plan Q23; then nothing on it ran.)
 * - 4: a top-level hit on an indexed line that no per-test entry holds (an OnRun, a subscriber v3
 *   does not attribute).
 * Returns the note, or `undefined`.
 */
export function sleepCallRefusal(doc: V3CoverageRead, index: SleepIndex): string | undefined {
  if (doc.kind === "unavailable") return `${SLEEP_NOTE_TAG} coverage unavailable: ${doc.why}`;
  for (const f of doc.coverage) {
    const key = sleepFileKey(f.file);
    const lines = index.byFile.get(key);
    if (lines === undefined) continue;
    const listed = new Set((f.statements ?? []).map((s) => s.line));
    for (const line of lines) {
      if (!listed.has(line)) {
        return `${SLEEP_NOTE_TAG} indexed Sleep ${index.shown.get(key) ?? f.file}:${line} not in v3's coverage`;
      }
    }
  }
  const owned = new Set(doc.perTestCoverage.flatMap((e) => hitSites(e.coverage, index)).map(at));
  const unowned = hitSites(doc.coverage, index).find((s) => !owned.has(at(s)));
  return unowned === undefined
    ? undefined
    : `${SLEEP_NOTE_TAG} unattributed Sleep hit at ${at(unowned)}: no test's per-test coverage holds it, so any pass of this call may have run it`;
}

/**
 * §6 for ONE covering pass (`testName` is v3's row name): the call-level cases first, then a test
 * with no per-test entry (case 1), then a covered Sleep (case 3). `undefined`: the pass is scored.
 */
export function sleepPassRefusal(
  doc: V3CoverageRead,
  index: SleepIndex,
  testName: string,
): string | undefined {
  const call = sleepCallRefusal(doc, index);
  if (call !== undefined || doc.kind === "unavailable") return call;
  const own = doc.perTestCoverage.filter((e) => e.test === testName);
  if (own.length !== 1) {
    return `${SLEEP_NOTE_TAG} coverage unavailable: ${own.length === 0 ? "no" : String(own.length)} per-test entr${own.length === 0 ? "y" : "ies"} for ${testName}`;
  }
  const hit = hitSites(own[0]?.coverage ?? [], index)[0];
  return hit === undefined
    ? undefined
    : `${SLEEP_NOTE_TAG} covered Sleep at ${at(hit)}: Sleep returns at once on al-runner v3's virtual clock (#5605), so a pass here proves nothing about a wait; not scored`;
}
