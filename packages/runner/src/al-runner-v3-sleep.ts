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
 */
import { readFile, readdir } from "node:fs/promises";
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

async function alFilesUnder(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true }))
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();
}

/** The index of `targetDir` (the deployed `active/`) and `testDir`, under their absolute paths. */
export async function buildSleepIndex(targetDir: string, testDir: string): Promise<SleepIndex> {
  await initParser();
  const byFile = new Map<string, Set<number>>();
  const shown = new Map<string, string>();
  const sizes = { target: 0, test: 0 };
  for (const [root, which] of [
    [targetDir, "target"],
    [testDir, "test"],
  ] as const) {
    for (const rel of await alFilesUnder(root)) {
      const abs = resolve(join(root, rel)).replaceAll("\\", "/");
      const lines = sleepCallLines(await readFile(join(root, rel), "utf8"));
      if (lines.length === 0) continue;
      const key = sleepFileKey(abs);
      byFile.set(key, new Set(lines));
      shown.set(key, abs);
      sizes[which] += lines.length;
    }
  }
  return { byFile, shown, sizes };
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
    : `${SLEEP_NOTE_TAG} covered Sleep at ${at(hit)}: Sleep does nothing on al-runner v3 (#5605), so a pass here proves nothing about a wait; not scored`;
}
