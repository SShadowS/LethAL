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
 * gated to table triggers. The rule (`refusedAsMultiObject`, R383 r2 ruling): a file is refused
 * unless every object after its first is code-free (a permission set, permission set extension,
 * enum, interface or entitlement). So an enum then a codeunit is refused, the codeunit being a
 * later object with code; a codeunit then permission sets is not. Prevalence, measured (R383.md):
 * on the gate fixtures only `sandbox-multiobject` (which exists to) and `sandbox-coverage-probe`
 * trip this, and no file on DC, System Application, Business Foundation, BaseApp or CDO does.
 *
 * What R383 built stays as infrastructure for the day upstream fixes the frame: every row is
 * resolved by POSITION (`resolveFileLine`) to the declaration whose file span holds it, and that
 * object's base line converts it to the object-relative frame BC and the line map use. In a
 * single-object file the base is 1, so this is exactly the old behaviour.
 * `buildAlRunnerCoverageIndex(dir, { admitMultiObjectFiles: true })` turns the admission on, and
 * only tests use it today.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { evaluateArms, initParser, parseAL } from "@lethal/engine";
import { wrapRoot } from "@lethal/engine";
import type { ServerPerTestCoverage } from "./al-runner-server";
import type { CoverageEntry, CoverageMap } from "./backend";
import {
  LineMap,
  type LineMapEntry,
  activeEntries,
  alRunnerAdmitsWrappedFile,
  batchDisplayPaths,
  duplicateObjectRefusals,
  fileHoldsWrappedObject,
  fileLineMapEntries,
  objectIdentityOf,
  readRenamedMemberNames,
  refusedAsMultiObject,
  refusedObjectsOfFile,
  resolveFileLine,
  undecidedArmsReason,
} from "./line-map";
import { effectiveBuildSymbols } from "./preprocessor-symbols";

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
   * Project-relative paths refused as multi-object (`refusedAsMultiObject`: an object with code
   * after the file's first). Non-empty disables coverage, and such a
   * file is not indexed unless `admitMultiObjectFiles` was passed (R383).
   */
  readonly multiObjectFiles: readonly string[];
  /**
   * R298: project-relative paths (forward slashes) holding a `#if`-wrapped object of a shape
   * al-runner is not measured on (R-300b: `alRunnerAdmitsWrappedFile` false). Refused WHOLE,
   * because coverage here is per file. A refused file is in none of `byFile`, the line map's
   * declared set, or `multiObjectFiles`.
   */
  readonly refusedFiles: readonly string[];
  /**
   * R-300b: the `byFile` keys of ADMITTED wrapped files. On `--server` a statement there whose
   * scope disagrees with its position is dropped, not overruled (I3).
   */
  readonly admittedWrappedFiles: ReadonlySet<string>;
  /** R-307 section 4: the parsed declarations, `type:id` lower-cased: Direction B's `declared`. */
  readonly declared: ReadonlySet<string>;
  /**
   * R-307 section 4: every object of `refusedFiles` (`refusedObjectsOfFile`, so exactly
   * `coverageRefusedObjects` over this bundle) and of `multiObjectFiles` (upstream #3713):
   * Direction B's exemption.
   */
  readonly exempt: ReadonlySet<string>;
  /**
   * Every object this index refuses BY NAME (a wrapped file not admitted, an admitted one whose
   * instrumented text is undecided, a duplicate key), `type:id` lower-cased -> the sentence.
   * Sol run 001 (I): selection reads the ORIGINAL source, so the orchestrator merges this map into
   * its refusal map before scoring; otherwise an undecided re-parse is invisible to selection.
   * Multi-object files are not here: their exemption is not a per-object refusal.
   */
  readonly refusals: ReadonlyMap<string, string>;
  /**
   * Every `.al` path scanned but NOT in `byFile` (lower-cased keys): refused, multi-object and not
   * admitted, or holding no indexed object (R-300b: compiled out, undecided, or every object a
   * duplicate key). A coverage row stops at its own path here instead of
   * falling through to a shorter ending another file owns (R298, R383 r2). An admitted
   * multi-object file is in `byFile`, so it is never here.
   */
  readonly skippedFiles: readonly string[];
  /**
   * R219 run 003: how a reported path whose LAST SEGMENT two or more files own is resolved. Such a
   * path is never matched by suffix (sol run 002: `Sales/Helper.al` against `X/Sales/Helper.al`, or
   * a project path against another file's flat name). It is resolved exactly, in two namespaces:
   * under `projectDir` it is a project-relative path; directly in `batchDir` it is a flat name.
   * Neither, or both to different files, is refused. Absent: no contested segment (indexes built
   * by hand in tests).
   */
  readonly exact?: ExactResolution;
  /** R219: how to quote a reported path to a user (a renamed flat name becomes its project path). */
  readonly displayOf?: (path: string) => string;
}

/** R219 run 003: see `AlRunnerCoverageIndex.exact`. Paths are resolved, `/`-separated, lower-cased. */
export interface ExactResolution {
  readonly batchDir: string;
  readonly projectDir?: string;
  /** Last segments (lower-cased) that the keys of two or more files end in. */
  readonly contested: ReadonlySet<string>;
  /** Lower-cased flat name -> the file's flat `byFile` key. */
  readonly byFlatName: ReadonlyMap<string, string>;
  /** Lower-cased project-relative path -> the file's flat `byFile` key. */
  readonly byProjectPath: ReadonlyMap<string, string>;
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
 * (`fileHoldsWrappedObject`, and since R-300b not `alRunnerAdmitsWrappedFile`), so the guard and
 * the index cannot drift. Such a file's objects are
 * dropped from the index, so trusting coverage would read every one of them `no-coverage`.
 * `supported` still answers the multi-object question alone, as before: R298 keeps coverage on for
 * a wrapped file and refuses its objects in selection, by name. The CLI is stricter and falls back
 * to no coverage when EITHER list is non-empty (`withAlRunnerCoverageGuard`, cli.ts). A file can be
 * in both lists.
 */
export async function alRunnerCoverageSupport(
  projectDir: string,
  /** R205: the session's source snapshot; when given, its `.al` keys are parsed, not the disk. */
  snapshot?: ReadonlyMap<string, Buffer>,
): Promise<{
  supported: boolean;
  multiObjectFiles: readonly string[];
  wrappedObjectFiles: readonly string[];
}> {
  await initParser();
  const rels = (
    snapshot !== undefined ? [...snapshot.keys()] : await readdir(projectDir, { recursive: true })
  )
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();
  const multi: string[] = [];
  const wrapped: string[] = [];
  for (const rel of rels) {
    const text =
      snapshot?.get(rel)?.toString("utf8") ?? (await readFile(join(projectDir, rel), "utf8"));
    const root = wrapRoot(parseAL(text));
    // R-300b: an admitted wrapped file is scored, so it does not turn coverage off.
    if (fileHoldsWrappedObject(root) && !alRunnerAdmitsWrappedFile(root)) {
      wrapped.push(normalizeSlashes(rel));
    }
    // R383 r2: the same predicate as the index skip below. An enum then a codeunit puts the
    // codeunit second, and al-runner reports a later object in the wrong frame whatever the first.
    if (refusedAsMultiObject(root)) multi.push(normalizeSlashes(rel));
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
 *
 * R-300b: `symbols` is the session's EFFECTIVE build symbol set (`effectiveBuildSymbols`), under
 * which each file's arms are evaluated (`evaluateArms`), the same set generation used. A
 * declaration in a compiled-out arm is not indexed and not declared; an `undecided` file is not
 * indexed (it has no mutant). An admitted wrapped file (`alRunnerAdmitsWrappedFile`) is indexed
 * with base line 1, so `resolveFileLine` reads al-runner's FILE line as the object line (H1).
 * Then a key still declared in more than one indexed file is removed, refused by name
 * (`duplicateObjectRefusals`) and exempt (C1). Every file left with no entry is in `skippedFiles`.
 */
export async function buildAlRunnerCoverageIndex(
  instrumentedDir: string,
  options: {
    readonly admitMultiObjectFiles?: boolean;
    readonly symbols?: readonly string[];
    /**
     * R219 run 003: the project al-runner may label coverage under (it discovers the source
     * project beside the test app, measured on c39ad5de). Without it, a source-path label for a
     * contested file name is refused.
     */
    readonly sourceProjectDir?: string;
  } = {},
): Promise<AlRunnerCoverageIndex> {
  await initParser();
  // ponytail: absent `symbols` means the bundle's own app.json symbols only (unit tests). The
  // backend always passes the session's set and refuses a coverage deploy without one.
  const symbols =
    options.symbols ??
    (await effectiveBuildSymbols(instrumentedDir, [], undefined, { kind: "bcdev" }));
  const rels = (await readdir(instrumentedDir, { recursive: true }))
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();
  // R219: a file the batch renamed is QUOTED by its project path. And it is KEYED by both names:
  // al-runner labels coverage with whichever path it knows for this app id, measured on c39ad5de
  // on both transports as the project SOURCE path (`proj/Sales/Helper.Codeunit.al`) or a batch's
  // own flat path (`batch/Helper.Codeunit.8de4e0ea.al`), never a bare duplicate basename.
  const display = await batchDisplayPaths(instrumentedDir);
  const shown = (rel: string): string => normalizeSlashes(display(rel));
  const keysOf = (rel: string): string[] => {
    const flat = normalizeFileKey(rel);
    const project = normalizeFileKey(display(rel));
    return project === flat ? [flat] : [flat, project];
  };
  const exact = exactResolutionOf(rels, keysOf, display, instrumentedDir, options.sourceProjectDir);

  const byFile = new Map<string, readonly LineMapEntry[]>();
  const multiObjectFiles: string[] = [];
  const refusedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const entries: LineMapEntry[] = [];
  const declared = new Set<string>();
  const exempt = new Set<string>();
  const refusals = new Map<string, string>();
  const admittedWrappedFiles = new Set<string>();
  /** Files that pass every per-file rule, before the duplicate-key pass. */
  const candidates: { file: string; keys: string[]; entries: LineMapEntry[] }[] = [];

  for (const rel of rels) {
    const source = await readFile(join(instrumentedDir, rel), "utf8");
    const root = wrapRoot(parseAL(source));
    const admitted = alRunnerAdmitsWrappedFile(root);
    if (fileHoldsWrappedObject(root) && !admitted) {
      const file = shown(rel);
      refusedFiles.push(file);
      skippedFiles.push(...keysOf(rel));
      for (const [key, reason] of refusedObjectsOfFile(root, file, "al-runner")) {
        exempt.add(key);
        refusals.set(key, reason);
        console.warn(`[lethal] ${reason}`);
      }
      continue;
    }
    let fileEntries = fileLineMapEntries(root, objectIdentityOf);
    if (admitted) {
      // R-300b: only a wrapped file can hold a declaration in an inactive arm, so arms are read
      // only here; a plain file is indexed as before, even if its instrumented text re-parses
      // undecided (R303's emitted ERROR nodes do).
      const arms = evaluateArms(root, source, symbols);
      if (arms.kind === "undecided") {
        const file = shown(rel);
        refusedFiles.push(file);
        skippedFiles.push(...keysOf(rel));
        for (const e of fileEntries) {
          const key = `${e.objectType.toLowerCase()}:${e.objectId}`;
          const reason = undecidedArmsReason(e.objectType, e.objectId, file, arms.reason);
          exempt.add(key);
          refusals.set(key, reason);
          console.warn(`[lethal] ${reason}`);
        }
        continue;
      }
      // The one object carries the line map's `refused` mark; it is dropped here, and its base
      // is 1 (it is the file's only object), so al-runner's FILE line is the object line (H1).
      fileEntries = activeEntries(fileEntries, arms).map(({ refused: _refused, ...e }) => e);
    }
    if (refusedAsMultiObject(root)) {
      // Forward slashes so the warning reads the same on every platform: `readdir` hands back
      // `src\X.al` on Windows, and this string is quoted to a user who has to find the file.
      multiObjectFiles.push(shown(rel));
      for (const e of fileEntries) exempt.add(`${e.objectType.toLowerCase()}:${e.objectId}`);
      // Not indexed, so nothing can resolve against a file al-runner reports in the wrong frame.
      if (options.admitMultiObjectFiles !== true) {
        skippedFiles.push(...keysOf(rel));
        continue;
      }
    }
    candidates.push({
      file: shown(rel),
      keys: keysOf(rel),
      entries: fileEntries,
    });
    if (admitted) for (const k of keysOf(rel)) admittedWrappedFiles.add(k);
  }

  // LOWER-CASED to match `line-map.ts`'s own `keyOf`. Getting this wrong does not throw: the
  // `LineMap` constructor skips an object it thinks is undeclared, and `lookup` then returns
  // undefined for every line of it, so every entry silently loses its `procedure` and coverage
  // degrades to object-level without a word. Caught by the tests asserting a NAME.
  const keyOfEntry = (e: LineMapEntry) => `${e.objectType.toLowerCase()}:${e.objectId}`;
  // R-300b (C1): the `LineMap` keeps one entry per key, so a key in two files would name one
  // file's hits from the other's procedures.
  const duplicates = duplicateObjectRefusals(
    candidates.map((c) => ({ path: c.file, keys: c.entries.map(keyOfEntry) })),
  );
  for (const [key, reason] of duplicates) {
    exempt.add(key);
    refusals.set(key, reason);
    console.warn(`[lethal] ${reason}`);
  }
  for (const c of candidates) {
    const kept = c.entries.filter((e) => !duplicates.has(keyOfEntry(e)));
    if (kept.length === 0) {
      for (const k of c.keys) {
        skippedFiles.push(k);
        admittedWrappedFiles.delete(k);
      }
      continue;
    }
    for (const k of c.keys) byFile.set(k, kept);
    for (const e of kept) declared.add(keyOfEntry(e));
    entries.push(...kept);
  }
  skippedFiles.sort();

  return {
    byFile,
    lineMap: new LineMap(entries, declared, await readRenamedMemberNames(instrumentedDir)),
    multiObjectFiles,
    refusedFiles,
    admittedWrappedFiles,
    declared,
    exempt,
    refusals,
    skippedFiles,
    ...(exact !== undefined ? { exact } : {}),
    displayOf: (path) => normalizeSlashes(display(path)),
  };
}

/** A directory as `ExactResolution` compares it: absolute, `/`-separated, lower-cased, no trailing `/`. */
function dirKey(dir: string): string {
  return normalizeFileKey(resolve(dir)).replace(/\/+$/, "");
}

/**
 * R219 run 003. Refuses two files whose keys collide once lower-cased (sol run 002:
 * `Sales/Helper.al` and `sales/Helper.al` on a case-sensitive file system, where one alias would
 * silently replace the other), then returns the exact maps when any last segment is contested.
 */
function exactResolutionOf(
  rels: readonly string[],
  keysOf: (rel: string) => string[],
  display: (rel: string) => string,
  batchDir: string,
  projectDir: string | undefined,
): ExactResolution | undefined {
  const owner = new Map<string, string>();
  const ownersOfSegment = new Map<string, Set<string>>();
  for (const rel of rels) {
    for (const key of keysOf(rel)) {
      const other = owner.get(key);
      if (other !== undefined && other !== rel) {
        throw new Error(
          `cannot index al-runner coverage: "${normalizeSlashes(display(other))}" and "${normalizeSlashes(display(rel))}" both answer to "${key}" once case is ignored, so a coverage path naming one could be credited to the other (R219). Rename one of the files.`,
        );
      }
      owner.set(key, rel);
      const segment = key.split("/").pop() ?? key;
      const owners = ownersOfSegment.get(segment) ?? new Set<string>();
      owners.add(rel);
      ownersOfSegment.set(segment, owners);
    }
  }
  const contested = new Set(
    [...ownersOfSegment].filter(([, owners]) => owners.size > 1).map(([segment]) => segment),
  );
  if (contested.size === 0) return undefined;
  return {
    batchDir: dirKey(batchDir),
    ...(projectDir !== undefined ? { projectDir: dirKey(projectDir) } : {}),
    contested,
    byFlatName: new Map(rels.map((rel) => [normalizeFileKey(rel), normalizeFileKey(rel)])),
    byProjectPath: new Map(
      rels.map((rel) => [normalizeFileKey(display(rel)), normalizeFileKey(rel)]),
    ),
  };
}

/**
 * R219 run 003: a reported path whose last segment is contested, resolved exactly (see
 * `AlRunnerCoverageIndex.exact`). Returns the file's flat key; throws when the path names no
 * file, or two different ones.
 */
function resolveContested(file: string, exact: ExactResolution): string {
  // The one-shot transport reports paths relative to al-runner's cwd, which is LethAL's own
  // (measured on c39ad5de: `../../tmp/.../batch/X.al`); `--server` reports them absolute.
  const abs = dirKey(file);
  const { projectDir } = exact;
  const inProject =
    projectDir !== undefined && abs.startsWith(`${projectDir}/`)
      ? exact.byProjectPath.get(abs.slice(projectDir.length + 1))
      : undefined;
  const inBatch =
    dirname(abs) === exact.batchDir ? exact.byFlatName.get(abs.split("/").pop() ?? "") : undefined;
  if (inProject !== undefined && inBatch !== undefined && inProject !== inBatch) {
    throw new Error(
      `al-runner reported coverage for "${file}", which names one file as a project path and another as a batch file name (R219). Refusing rather than crediting either. Rename one of the files, or run with "alRunner.coverage": "none".`,
    );
  }
  const hit = inProject ?? inBatch;
  if (hit === undefined) {
    throw new Error(
      `al-runner reported coverage for "${file}", but two or more files of this batch end in that name (renamed by their folder, R219), and the path is neither inside the project (${projectDir ?? "not known"}) nor directly in the batch (${exact.batchDir}). Refusing rather than dropping that coverage or crediting it to the wrong file. Rename one of the files, or run with "alRunner.coverage": "none".`,
    );
  }
  return hit;
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
 * indexed): that would attribute the refused object's lines to a different object. R383 r2: the
 * same holds for EVERY skipped file (`skippedFiles`), a non-admitted multi-object one included.
 */
function objectsForFile(
  file: string,
  index: AlRunnerCoverageIndex,
  skipped: ReadonlySet<string>,
): readonly LineMapEntry[] | undefined {
  return indexedFile(file, index, skipped)?.entries;
}

/** `objectsForFile`, with the matched `byFile` key (R-300b: the I3 rule reads it). */
function indexedFile(
  file: string,
  index: AlRunnerCoverageIndex,
  skipped: ReadonlySet<string>,
): { readonly key: string; readonly entries: readonly LineMapEntry[] } | undefined {
  const cands = fileKeyCandidates(file);
  // R219 run 003: a contested last segment is resolved exactly, never by the longest suffix.
  const { exact } = index;
  if (exact?.contested.has(cands.at(-1) ?? "") === true) {
    const key = resolveContested(file, exact);
    if (skipped.has(key)) return undefined;
    const hit = index.byFile.get(key);
    return hit !== undefined ? { key, entries: hit } : undefined;
  }
  for (const cand of cands) {
    if (skipped.has(cand)) return undefined;
    const hit = index.byFile.get(cand);
    if (hit !== undefined) return { key: cand, entries: hit };
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
  const skipped = new Set(index.skippedFiles);
  for (const ln of lines) {
    if (ln.hits <= 0) continue;
    const objects = objectsForFile(ln.file, index, skipped);
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
 *
 * R-300b (I3): in an ADMITTED `#if`-wrapped file (`admittedWrappedFiles`) step 3's disagreement
 * DROPS the statement, with a named warning, instead of letting the position win: the probe
 * measured the server naming the compiled arm, so a disagreement there means the frame is not the
 * one measured.
 */
export function alRunnerCoverageFromServer(
  entry: ServerPerTestCoverage,
  index: AlRunnerCoverageIndex,
): CoverageMap {
  const entries: CoverageEntry[] = [];
  const seen = new Set<string>();
  const skipped = new Set(index.skippedFiles);
  // `lookup` scans an object's spans, so it is memoised per object line: a large object reports the
  // same few lines many times.
  const named = new Map<string, string | undefined>();
  for (const file of entry.coverage ?? []) {
    const found = indexedFile(file.file, index, skipped);
    if (found === undefined) continue;
    const objects = found.entries;
    // R219: a renamed batch file is quoted by its project path.
    const shownFile = index.displayOf?.(file.file) ?? file.file;
    // R-300b (I3): in an admitted wrapped file a disagreement drops the line instead.
    const strict = index.admittedWrappedFiles.has(found.key);
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
            if (strict && st.scope?.toLowerCase() !== byPosition.toLowerCase()) {
              console.warn(
                `[lethal] al-runner --server named the covered statement at ${shownFile}:${st.line} "${st.scope ?? ""}", but that line is inside "${byPosition}", in a #if-wrapped file; the line is dropped (R300).`,
              );
              continue;
            }
            if (st.scope?.toLowerCase() !== byPosition.toLowerCase()) {
              console.warn(
                `[lethal] al-runner --server named the covered statement at ${shownFile}:${st.line} "${st.scope ?? ""}", but that line is inside "${byPosition}"; the position wins (R383).`,
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
