/**
 * al-runner's Cobertura coverage, turned into the `CoverageMap` the selector already speaks.
 *
 * al-runner 2.11.0 grew `--coverage`: "statement-level coverage via BC's own StmtHit
 * instrumentation (no rewrite of emitted AL output, the hook lives in Ncl.dll)", written as
 * Cobertura XML. Before it, `AlRunnerBackend.capabilities()` reported `coverage: "none"` and every
 * mutant ran against every green test, so an unreached mutant came back `survived` instead of
 * `no-coverage`. That under-reports rather than lies, but it is half of why [[R183]] holds the
 * backend `authoritative: false`, and it is the whole of the difference between the two frozen
 * gates: `itest:bcdev` 3 / 12 / 4 against `itest:alrunner` 3 / 16 / 0, where those four are
 * `SandboxPricing`'s mutants. Measured before any of this was written, al-runner's own coverage
 * reports that file at `line-rate 0.0000`, so the two backends already agree; only the wiring was
 * missing.
 *
 * ## Multi-object files: still refused, for a different reason than before
 *
 * al-runner 2.11.0 lost every object after a file's first (upstream #3713). That is FIXED on
 * v2.12.0: the second object's lines are reported now, on both transports. But measured on the
 * pinned build v2.12.0-main.c39ad5de (`docs/roadmap/R383.md`), they are reported in the WRONG
 * FRAME. al-runner compiles LethAL's instrumented bundle, finds the source project with the same
 * app id, and labels coverage with the SOURCE path. For the first object in a file the lines are
 * right. For every object after it, a line is reported as (the previous object's closing line in
 * the SOURCE) + (its distance from that line in the INSTRUMENTED text). On `sandbox-multiobject`
 * instrumented lines 33/35/40/45/50 of `Multi B` come back as 16/18/23/28/33, which lie inside
 * `Multi A`. Nothing in the report says which frame a line is in, so LethAL cannot undo it.
 *
 * So a file declaring more than one object still disables coverage for the WHOLE run
 * (`supported: false`, and the CLI guard falls back to `"none"`), and the index skips such a file
 * so nothing can resolve against it. Coarse on purpose: dropping just that file's objects would
 * read their mutants a false `no-coverage`, because `coverageFilter`'s every-green-test fallback is
 * gated to table triggers. Prevalence is low: measured, no file trips this on any gate fixture but
 * `sandbox-multiobject` (which exists to), nor on Continia Document Output (R383.md).
 *
 * What R383 built stays as infrastructure for the day upstream fixes the frame: every row is
 * resolved by POSITION (`resolveFileLine`) to the declaration whose file span holds it, and that
 * object's base line converts it to the object-relative frame BC and the line map use. In a
 * single-object file the base is 1, so this is exactly the old behaviour.
 * `buildAlRunnerCoverageIndex(dir, { admitMultiObjectFiles: true })` turns the admission on, and
 * only tests use it today.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { initParser, objectDeclarationsOf, parseAL } from "@lethal/engine";
import { type ALSyntaxNode, wrapRoot } from "@lethal/engine";
import type { ServerPerTestCoverage } from "./al-runner-server";
import type { CoverageEntry, CoverageMap } from "./backend";
import {
  LineMap,
  type LineMapEntry,
  fileHoldsWrappedObject,
  fileLineMapEntries,
  objectIdentityOf,
  readRenamedMemberNames,
  refusedObjectsOfFile,
  resolveFileLine,
} from "./line-map";

/** One `<line>` of one `<class>`, as al-runner writes it. */
export interface CoberturaLine {
  /** The `filename` attribute of the enclosing `<class>`, verbatim. */
  readonly file: string;
  readonly line: number;
  readonly hits: number;
}

/**
 * Cobertura is parsed with regexes rather than an XML library, and that is a deliberate limit
 * rather than a shortcut worth hiding: the input is one machine-generated file from one known
 * producer, and adding an XML dependency to read it would be the larger risk. The shapes assumed
 * are `<class ... filename="...">` and `<line number="N" hits="M" />`, both of which al-runner
 * writes on one line with double quotes. A producer change breaks this LOUDLY (zero lines parsed
 * from a non-empty file is refused by the caller) rather than silently returning partial coverage,
 * which is the failure mode that matters.
 */
export function parseCobertura(xml: string): readonly CoberturaLine[] {
  const out: CoberturaLine[] = [];
  const classRe = /<class\b[^>]*\bfilename="([^"]*)"[^>]*>([\s\S]*?)<\/class>/g;
  const lineRe = /<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g;
  for (const cls of xml.matchAll(classRe)) {
    const file = cls[1];
    const body = cls[2];
    if (file === undefined || body === undefined) continue;
    for (const ln of body.matchAll(lineRe)) {
      const num = Number.parseInt(ln[1] ?? "", 10);
      const hits = Number.parseInt(ln[2] ?? "", 10);
      if (Number.isNaN(num) || Number.isNaN(hits)) continue;
      out.push({ file, line: num, hits });
    }
  }
  return out;
}

/**
 * Every object a file declares, in source order, `#if`-wrapped ones included (R298). The arms of
 * one wrapped object are ONE object: each compile builds exactly one arm, so a two-arm wrapper
 * declaring the same `(type, id)` twice must not be reported as a multi-object file. Counted by
 * `(type, id)`, never by node.
 */
function objectsOf(root: ALSyntaxNode): Array<{ objectType: string; objectId: number }> {
  const found: Array<{ objectType: string; objectId: number }> = [];
  const seen = new Set<string>();
  for (const decl of objectDeclarationsOf(root)) {
    const id = objectIdentityOf(decl);
    if (id === null) continue;
    const key = `${id.objectType}:${id.objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(id);
  }
  return found;
}

/**
 * What one instrumented bundle can tell us about its own files: which object each declares, and a
 * line map to place a covered line inside a procedure.
 */
export interface AlRunnerCoverageIndex {
  /**
   * Lower-cased absolute-ish path suffix -> every indexed object that file declares, in file order,
   * with the base line each is numbered from (R383: a file may hold several).
   */
  readonly byFile: ReadonlyMap<string, readonly LineMapEntry[]>;
  readonly lineMap: LineMap;
  /**
   * Project-relative paths declaring more than one object. Non-empty disables coverage, and such a
   * file is not indexed unless `admitMultiObjectFiles` was passed (R383).
   */
  readonly multiObjectFiles: readonly string[];
  /**
   * R298: project-relative paths (forward slashes) holding a `#if`-wrapped object. Refused WHOLE,
   * because coverage here is per file: every object in one reads `no-coverage` until R300 measures
   * how al-runner numbers a compiled arm. A refused file is in none of `byFile`, the line map's
   * declared set, or `multiObjectFiles`.
   */
  readonly refusedFiles: readonly string[];
}

/**
 * Whether al-runner's coverage can be TRUSTED for this project, answered from the SOURCE tree
 * before a session starts.
 *
 * The caller has to ask, rather than the backend deciding for itself, because
 * `BackendCapabilities.coverage` is read at the top of `runSession` and the instrumented bundle
 * does not exist yet at that point. Answering late is not an option either: if capabilities
 * promise coverage and the verdicts then carry none, `coverageFilter` reports every mutant
 * `no-coverage`, which is the worst of the three possible answers.
 *
 * Scanning the SOURCE is sound because instrumentation is one output file per input file, so a
 * file's objects are the same on both sides. See this module's header for why a multi-object file
 * disqualifies the whole run rather than just its own objects (R383: al-runner's frame for every
 * object after a file's first, measured on v2.12.0-main.c39ad5de).
 *
 * R387: `wrappedObjectFiles` uses the SAME rule the index uses to refuse a file
 * (`fileHoldsWrappedObject`), so the guard and the index cannot drift. Such a file's objects are
 * dropped from the index, so trusting coverage would read every one of them `no-coverage`.
 * `supported` still answers the multi-object question alone, as before: R298 keeps coverage on for
 * a wrapped file and refuses its objects in selection, by name. The CLI is stricter and falls back
 * to no coverage when EITHER list is non-empty (`withAlRunnerCoverageGuard`, cli.ts). A file can be
 * in both lists.
 */
export async function alRunnerCoverageSupport(projectDir: string): Promise<{
  supported: boolean;
  multiObjectFiles: readonly string[];
  wrappedObjectFiles: readonly string[];
}> {
  await initParser();
  const rels = (await readdir(projectDir, { recursive: true }))
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();
  const multi: string[] = [];
  const wrapped: string[] = [];
  for (const rel of rels) {
    const root = wrapRoot(parseAL(await readFile(join(projectDir, rel), "utf8")));
    if (fileHoldsWrappedObject(root)) wrapped.push(normalizeSlashes(rel));
    if (objectsOf(root).length > 1) multi.push(normalizeSlashes(rel));
  }
  return {
    supported: multi.length === 0,
    multiObjectFiles: multi,
    wrappedObjectFiles: wrapped,
  };
}

/**
 * Builds the index from the instrumented bundle al-runner was handed.
 *
 * `declared` for the `LineMap` is every object found in that directory, which is sound HERE for a
 * reason worth stating: al-runner compiles the directory, so the text parsed is the text it ran,
 * and resolution is keyed by the FILE PATH Cobertura reports rather than by an opaque id that
 * could collide with a copied dependency source. That is the R29 hazard `line-map.ts` guards
 * against on the hub path, and it does not arise when the coverage row names the file.
 *
 * A multi-object file is NAMED and, by default, not indexed (R383, this module's header).
 * `admitMultiObjectFiles` indexes every object of it, resolved by position; only tests pass it
 * until upstream reports every object in the instrumented frame.
 */
export async function buildAlRunnerCoverageIndex(
  instrumentedDir: string,
  options: { readonly admitMultiObjectFiles?: boolean } = {},
): Promise<AlRunnerCoverageIndex> {
  await initParser();
  const rels = (await readdir(instrumentedDir, { recursive: true }))
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();

  const byFile = new Map<string, readonly LineMapEntry[]>();
  const multiObjectFiles: string[] = [];
  const refusedFiles: string[] = [];
  const entries: LineMapEntry[] = [];
  const declared = new Set<string>();

  for (const rel of rels) {
    const source = await readFile(join(instrumentedDir, rel), "utf8");
    const root = wrapRoot(parseAL(source));
    if (fileHoldsWrappedObject(root)) {
      const file = normalizeSlashes(rel);
      refusedFiles.push(file);
      for (const reason of refusedObjectsOfFile(root, file).values()) {
        console.warn(`[lethal] ${reason}`);
      }
      continue;
    }
    if (objectsOf(root).length > 1) {
      // Forward slashes so the warning reads the same on every platform: `readdir` hands back
      // `src\X.al` on Windows, and this string is quoted to a user who has to find the file.
      multiObjectFiles.push(normalizeSlashes(rel));
      // Not indexed, so nothing can resolve against a file al-runner reports in the wrong frame.
      if (options.admitMultiObjectFiles !== true) continue;
    }
    const fileEntries = fileLineMapEntries(root, objectIdentityOf);
    if (fileEntries.length === 0) continue;
    byFile.set(normalizeFileKey(rel), fileEntries);
    for (const e of fileEntries) {
      // LOWER-CASED to match `line-map.ts`'s own `keyOf`. Getting this wrong does not throw: the
      // `LineMap` constructor skips an object it thinks is undeclared, and `lookup` then returns
      // undefined for every line of it, so every entry silently loses its `procedure` and coverage
      // degrades to object-level without a word. Caught by the tests below asserting a NAME.
      declared.add(`${e.objectType.toLowerCase()}:${e.objectId}`);
    }
    entries.push(...fileEntries);
  }

  return {
    byFile,
    lineMap: new LineMap(entries, declared, await readRenamedMemberNames(instrumentedDir)),
    multiObjectFiles,
    refusedFiles,
  };
}

/**
 * Cobertura reports whatever path al-runner was given, which has been observed both
 * project-relative (`fixtures/sandbox-app/src/X.al`) and absolute
 * (`C:/.../instrumented/active/src/X.al`) depending on how the bundle was named on the command
 * line. Matching on the normalised TAIL rather than the whole string is what makes the lookup
 * survive that, and it is why the key is built from the path's own separators rather than by
 * resolving against a base directory that may not be the one al-runner printed.
 */
/** Forward slashes, so a path quoted to a user reads the same on every platform. */
function normalizeSlashes(path: string): string {
  return path.split("\\").join("/");
}

export function normalizeFileKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function fileKeyCandidates(coberturaPath: string): string[] {
  const norm = normalizeFileKey(coberturaPath);
  const parts = norm.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join("/"));
  return out;
}

/**
 * The objects a reported file declares, matched on the LONGEST path ending first. R298: a refused
 * file is left out of `byFile`, so its hits must STOP at its own ending rather than fall through to
 * a shorter ending another file owns (`src/Foo.Codeunit.al` refused, a root `Foo.Codeunit.al`
 * indexed): that would attribute the refused object's lines to a different object.
 */
function objectsForFile(
  file: string,
  index: AlRunnerCoverageIndex,
  refused: ReadonlySet<string>,
): readonly LineMapEntry[] | undefined {
  for (const cand of fileKeyCandidates(file)) {
    if (refused.has(cand)) return undefined;
    const hit = index.byFile.get(cand);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Turns one test's Cobertura output into a `CoverageMap`.
 *
 * Only lines with `hits > 0` become entries: a reported-but-unhit line is evidence the file was
 * COMPILED, never that the test reached it, and treating it as coverage is precisely the
 * manufactured-coverage failure [[R63]] records.
 *
 * `procedure` is attached when the line map can place the line and omitted when it cannot. That
 * omission is load-bearing rather than lossy: `CoverageEntry` documents an absent `procedure` as
 * object-level evidence, which feeds `byObject` and lets a trigger mutant's FALLBACK 1 answer,
 * whereas a blank-but-present one would collide with the key a trigger mutant builds.
 *
 * R383: the `<line number>` is FILE-relative (measured on v2.12.0), so it is resolved by position
 * (`resolveFileLine`) to an object and an OBJECT-relative line, and the entry carries that object
 * line, the frame the line map and BC use. A line in no indexed object gives no entry at all.
 */
export function alRunnerCoverageFrom(
  lines: readonly CoberturaLine[],
  index: AlRunnerCoverageIndex,
): CoverageMap {
  const entries: CoverageEntry[] = [];
  const seen = new Set<string>();
  const refused = new Set(index.refusedFiles.map(normalizeFileKey));
  for (const ln of lines) {
    if (ln.hits <= 0) continue;
    const objects = objectsForFile(ln.file, index, refused);
    // A coverage row for something this bundle does not declare — the test app, Base Application,
    // a dependency — is skipped rather than an error, the same rule `LineMap` states for the
    // hub path. Cobertura serialises every file it instrumented, and most are legitimately not
    // ours.
    if (objects === undefined) continue;
    const at = resolveFileLine(objects, ln.line);
    if (at === undefined) continue;
    const procedure = index.lineMap.lookup(at.objectType, at.objectId, at.objectLine);
    const key = `${at.objectType}:${at.objectId}:${procedure ?? ""}:${at.objectLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      objectType: at.objectType,
      objectId: at.objectId,
      ...(procedure !== undefined ? { procedure } : {}),
      line: at.objectLine,
    });
  }
  return { granularity: "line", entries };
}

/**
 * The same mapping, from `--server`'s `perTestCoverage` instead of Cobertura.
 *
 * Each statement carries `scope`, the procedure the server itself attributes it to, and a
 * FILE-relative `line` (measured on v2.12.0, R383). The OBJECT always comes from the line's
 * position (`resolveFileLine`), never from `scope`, so two same-named procedures in two objects of
 * one file cannot be confused. The PROCEDURE is chosen in this order (R383 plan r3, Design 3), and
 * no statement with hits is dropped by it:
 *
 * 1. R318: inside a renamed split member, `renamedMemberAt` decides alone. An own arm name is
 *    re-keyed to the member's coverage name (the server names the COMPILED arm: `r3` build `[]`
 *    `Choose`, `r4` `Beta`); any other scope is kept, as some other member's statement (review M2).
 * 2. A line `lookup` leaves unnamed on purpose (a trigger, a line two declarations share, R318's
 *    `r10` `OtherOnly`): `scope` is kept, exactly as before, so trigger coverage keeps its
 *    object-level evidence.
 * 3. Otherwise `lookup` names a procedure. A matching `scope` (case-insensitive) agrees; a
 *    different one is overruled by POSITION, with one warning naming the file, line, both names.
 *
 * In a single-object file steps 1 and 2 give the pre-R383 output exactly; step 3 differs only where
 * the server and the span disagree, which no measured shape does.
 */
export function alRunnerCoverageFromServer(
  entry: ServerPerTestCoverage,
  index: AlRunnerCoverageIndex,
): CoverageMap {
  const entries: CoverageEntry[] = [];
  const seen = new Set<string>();
  const refused = new Set(index.refusedFiles.map(normalizeFileKey));
  // `lookup` scans an object's spans, so it is memoised per object line: a large object reports the
  // same few lines many times.
  const named = new Map<string, string | undefined>();
  for (const file of entry.coverage ?? []) {
    const objects = objectsForFile(file.file, index, refused);
    if (objects === undefined) continue;
    for (const st of file.statements ?? []) {
      // Same rule as the Cobertura path: a reported-but-unhit statement is evidence the file was
      // COMPILED, never that this test reached it. Treating it as coverage is [[R63]]'s
      // manufactured coverage.
      if ((st.hits ?? 0) <= 0) continue;
      const at = placeStatement(objects, st.line);
      if (at === undefined) continue;
      let procedure = st.scope;
      if (at.objectLine !== undefined) {
        const { objectType, objectId, objectLine } = at;
        const renamed = index.lineMap.renamedMemberAt(objectType, objectId, objectLine, st.scope);
        if (renamed !== undefined) {
          procedure = renamed;
        } else if (!index.lineMap.inRenamedSpan(objectType, objectId, objectLine)) {
          const memo = `${objectType}:${objectId}:${objectLine}`;
          if (!named.has(memo)) {
            named.set(memo, index.lineMap.lookup(objectType, objectId, objectLine));
          }
          const byPosition = named.get(memo);
          if (byPosition !== undefined) {
            if (st.scope?.toLowerCase() !== byPosition.toLowerCase()) {
              console.warn(
                `[lethal] al-runner --server named the covered statement at ${file.file}:${st.line} "${st.scope ?? ""}", but that line is inside "${byPosition}"; the position wins (R383).`,
              );
            }
            procedure = byPosition;
          }
        }
      }
      const key = `${at.objectType}:${at.objectId}:${procedure ?? ""}:${at.objectLine ?? -1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        objectType: at.objectType,
        objectId: at.objectId,
        ...(procedure !== undefined && procedure !== "" ? { procedure } : {}),
        ...(at.objectLine !== undefined ? { line: at.objectLine } : {}),
      });
    }
  }
  return { granularity: "line", entries };
}

/**
 * A `--server` statement's object, by its FILE line. A statement with no line can be placed only
 * in a file holding one indexed object, which is the pre-R383 behaviour; in a multi-object file it
 * has no position, so it is skipped rather than guessed.
 */
function placeStatement(
  objects: readonly LineMapEntry[],
  line: number | undefined,
): { objectType: string; objectId: number; objectLine?: number } | undefined {
  if (line !== undefined) return resolveFileLine(objects, line);
  const only = objects.length === 1 ? objects[0] : undefined;
  return only === undefined ? undefined : { objectType: only.objectType, objectId: only.objectId };
}
