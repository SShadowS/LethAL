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
 * ## The multi-object defect this module refuses to paper over
 *
 * MEASURED against al-runner 2.11.0, and it is the reason for `multiObjectFiles` below. Given ONE
 * file holding two codeunits and a test that calls only the SECOND:
 *
 * ```text
 *   two objects in Two.Codeunit.al   -> class "Two.Codeunit", line 5 hits 0.  The executed line
 *                                       in the second object is reported NOWHERE.
 *   the same two objects, split      -> First.Codeunit  line 5 hits 0   (correct, never called)
 *   into one file each                  Second.Codeunit line 5 hits 1   (correct, called)
 * ```
 *
 * So al-runner's Cobertura keys a class per FILE and loses every object after the first. Trusting
 * it on such a file would produce a mutant with no coverage entry, and `coverageFilter`'s
 * FALLBACK 2 (every green test) is gated to TABLE TRIGGERS, so an ordinary mutant with no entry is
 * reported `no-coverage`. That is a FALSE no-coverage: strictly worse than the honest
 * over-reporting this replaces, because it hides the mutant instead of running it.
 *
 * Hence the rule: a file declaring more than one object disables coverage for the WHOLE run, which
 * falls back to exactly today's behaviour. Coarse on purpose. The alternative, dropping just that
 * file's objects, produces the false `no-coverage` above for those objects; there is no "unknown"
 * verdict to fall back to per-object. Prevalence is low enough for this to cost little: measured,
 * 0 of 31 files in `fixtures/sandbox-data`, 0 of 2 in `fixtures/sandbox-app`, and 1 of 553 in
 * Continia Document Output's Cloud app.
 *
 * That restriction also settles a question this module would otherwise have to answer. BC numbers
 * coverage lines OBJECT-relative and objects PARTITION a file, which is why `line-map.ts` computes
 * a base line per object. Cobertura's `<line number>` is file-relative. For a file holding exactly
 * one object the two frames COINCIDE (the object's base line is 1), so restricting to
 * single-object files means no frame conversion is needed and none is done. If the upstream defect
 * is ever fixed and multi-object files are admitted, the base line must be applied here.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { initParser, parseAL } from "@lethal/engine";
import { type ALSyntaxNode, wrapRoot } from "@lethal/engine";
import type { CoverageEntry, CoverageMap } from "./backend";
import { LineMap, fileLineMapEntries, objectIdentityOf } from "./line-map";

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

/** Every object header a file declares, in source order. */
function objectsOf(root: ALSyntaxNode): Array<{ objectType: string; objectId: number }> {
  const found: Array<{ objectType: string; objectId: number }> = [];
  for (const child of root.namedChildren) {
    const id = objectIdentityOf(child);
    if (id !== null) found.push(id);
  }
  return found;
}

/**
 * What one instrumented bundle can tell us about its own files: which object each declares, and a
 * line map to place a covered line inside a procedure.
 */
export interface AlRunnerCoverageIndex {
  /** Lower-cased absolute-ish path suffix -> the single object that file declares. */
  readonly byFile: ReadonlyMap<string, { objectType: string; objectId: number }>;
  readonly lineMap: LineMap;
  /** Project-relative paths declaring more than one object. Non-empty disables coverage. */
  readonly multiObjectFiles: readonly string[];
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
 * file's object COUNT is the same on both sides. See this module's header for why a multi-object
 * file disqualifies the whole run rather than just its own objects.
 */
export async function alRunnerCoverageSupport(
  projectDir: string,
): Promise<{ supported: boolean; multiObjectFiles: readonly string[] }> {
  await initParser();
  const rels = (await readdir(projectDir, { recursive: true }))
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();
  const multi: string[] = [];
  for (const rel of rels) {
    const source = await readFile(join(projectDir, rel), "utf8");
    if (objectsOf(wrapRoot(parseAL(source))).length > 1) multi.push(normalizeSlashes(rel));
  }
  return { supported: multi.length === 0, multiObjectFiles: multi };
}

/**
 * Builds the index from the instrumented bundle al-runner was handed.
 *
 * `declared` for the `LineMap` is every object found in that directory, which is sound HERE for a
 * reason worth stating: al-runner compiles the directory, so the text parsed is the text it ran,
 * and resolution is keyed by the FILE PATH Cobertura reports rather than by an opaque id that
 * could collide with a copied dependency source. That is the R29 hazard `line-map.ts` guards
 * against on the hub path, and it does not arise when the coverage row names the file.
 */
export async function buildAlRunnerCoverageIndex(
  instrumentedDir: string,
): Promise<AlRunnerCoverageIndex> {
  await initParser();
  const rels = (await readdir(instrumentedDir, { recursive: true }))
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();

  const byFile = new Map<string, { objectType: string; objectId: number }>();
  const multiObjectFiles: string[] = [];
  const entries = [];
  const declared = new Set<string>();

  for (const rel of rels) {
    const source = await readFile(join(instrumentedDir, rel), "utf8");
    const root = wrapRoot(parseAL(source));
    const objects = objectsOf(root);
    if (objects.length > 1) {
      // Forward slashes so the warning reads the same on every platform: `readdir` hands back
      // `src\X.al` on Windows, and this string is quoted to a user who has to find the file.
      multiObjectFiles.push(normalizeSlashes(rel));
      continue;
    }
    const only = objects[0];
    if (only === undefined) continue;
    byFile.set(normalizeFileKey(rel), only);
    // LOWER-CASED to match `line-map.ts`'s own `keyOf`. Getting this wrong does not throw: the
    // `LineMap` constructor skips an object it thinks is undeclared, and `lookup` then returns
    // undefined for every line of it, so every entry silently loses its `procedure` and coverage
    // degrades to object-level without a word. Caught by the tests below asserting a NAME.
    declared.add(`${only.objectType.toLowerCase()}:${only.objectId}`);
    entries.push(...fileLineMapEntries(root, objectIdentityOf));
  }

  return {
    byFile,
    lineMap: new LineMap(entries, declared),
    multiObjectFiles,
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
 */
export function alRunnerCoverageFrom(
  lines: readonly CoberturaLine[],
  index: AlRunnerCoverageIndex,
): CoverageMap {
  const entries: CoverageEntry[] = [];
  const seen = new Set<string>();
  for (const ln of lines) {
    if (ln.hits <= 0) continue;
    let object: { objectType: string; objectId: number } | undefined;
    for (const cand of fileKeyCandidates(ln.file)) {
      const hit = index.byFile.get(cand);
      if (hit !== undefined) {
        object = hit;
        break;
      }
    }
    // A coverage row for something this bundle does not declare — the test app, Base Application,
    // a dependency — is skipped rather than an error, the same rule `LineMap` states for the
    // hub path. Cobertura serialises every file it instrumented, and most are legitimately not
    // ours.
    if (object === undefined) continue;
    const procedure = index.lineMap.lookup(object.objectType, object.objectId, ln.line);
    const key = `${object.objectType}:${object.objectId}:${procedure ?? ""}:${ln.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      objectType: object.objectType,
      objectId: object.objectId,
      ...(procedure !== undefined ? { procedure } : {}),
      line: ln.line,
    });
  }
  return { granularity: "line", entries };
}
