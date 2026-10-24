/**
 * al-runner's per-test coverage (`perTestCoverage`), turned into the `CoverageMap` the selector
 * already speaks. al-runner v3 writes it with `--coverage-json`. The rules below were measured on
 * the .NET al-runner (v2), which R654 retired.
 *
 * ## Multi-object files (R383, R407, R602)
 *
 * The retired v2 reported every object after a file's first in the WRONG FRAME. v3 does not: it
 * reports every statement in its own file's frame, per object (R602, measured on two builds, with
 * a per-mutant differential against `--mode none`: 0 lost kills). So the index ALWAYS indexes a
 * multi-object file (`refusedAsMultiObject`, R383 r2: an object with code after the file's first).
 * Every row is resolved by POSITION (`resolveFileLine`) to the declaration whose file span holds
 * it, and that object's base line converts it to the object-relative frame BC and the line map
 * use. In a single-object file the base is 1. R407's backstops stay: a label outside the index's
 * own bundle (`assertAdmittedLabel`), or a scope its position contradicts, stops the session with
 * `AlRunnerCoverageFrameError`.
 */
import { readFile } from "node:fs/promises";
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
import { walkFiles } from "./walk";

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
   * Project-relative paths of multi-object files (`refusedAsMultiObject`: an object with code
   * after the file's first). Informational: since R602 each is indexed.
   */
  readonly multiObjectFiles: readonly string[];
  /**
   * R298: project-relative paths (forward slashes) holding a `#if`-wrapped object of a shape
   * al-runner is not measured on (R-300b: `alRunnerAdmitsWrappedFile` false). Refused WHOLE,
   * because coverage here is per file. A refused file is in none of `byFile`, the line map's
   * declared set.
   */
  readonly refusedFiles: readonly string[];
  /**
   * R-300b: the `byFile` keys of ADMITTED wrapped files. A statement there whose scope disagrees
   * with its position throws `AlRunnerCoverageFrameError`, it is not overruled (I3, R602 D).
   */
  readonly admittedWrappedFiles: ReadonlySet<string>;
  /** R-307 section 4: the parsed declarations, `type:id` lower-cased: Direction B's `declared`. */
  readonly declared: ReadonlySet<string>;
  /**
   * R-307 section 4: every object of `refusedFiles` (`refusedObjectsOfFile`, so exactly
   * `coverageRefusedObjects` over this bundle): Direction B's exemption.
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
  /**
   * R219: `byFile` key -> how to quote that file to a user (its project path). Keyed by the
   * RESOLVED key, so a warning names the file the coverage was credited to (R-219c M1), never a
   * guess from the reported label's basename. Absent: quote the label (indexes built by hand).
   */
  readonly shownByKey?: ReadonlyMap<string, string>;
  /**
   * R407: present when the index holds at least one multi-object file. `keys` are
   * those files' `byFile` keys; `dir` is the directory this index was built from (the deployed
   * `active` bundle); `labelBase` is what a relative label resolves against. Every coverage label
   * resolving to such a key must name a file inside `dir`, or `AlRunnerCoverageFrameError` is
   * thrown (`assertAdmittedLabel`).
   */
  readonly frameAdmission?: {
    readonly dir: string;
    readonly keys: ReadonlySet<string>;
    readonly labelBase: string;
  };
}

/**
 * R407, R602: coverage for a multi-object file or an admitted wrapped file came back in a shape
 * R602's measurement did not see (a label outside the bundle, or a procedure name its position
 * contradicts). Stops the session: a wrong frame would credit mutants to the wrong tests with
 * nothing to show for it. Extends `Error` directly.
 */
export class AlRunnerCoverageFrameError extends Error {
  constructor(message: string) {
    super(
      `${message} (R407, R602). Run with "alRunnerV3.coverage": "none" to measure without coverage.`,
    );
    this.name = "AlRunnerCoverageFrameError";
  }
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
 * file's objects are the same on both sides.
 *
 * R387: `wrappedObjectFiles` uses the SAME rule the index uses to refuse a file
 * (`fileHoldsWrappedObject`, and since R-300b not `alRunnerAdmitsWrappedFile`), so the guard and
 * the index cannot drift. Such a file's objects are dropped from the index, so trusting coverage
 * would read every one of them `no-coverage`: the CLI falls back to no coverage when this list is
 * non-empty (`v3CoverageMode`, cli.ts). R602: a multi-object file is no longer listed (the index
 * places it); one that also holds a wrapper is, because `alRunnerAdmitsWrappedFile` is false for it.
 */
export async function alRunnerCoverageSupport(
  projectDir: string,
  /** R205: the session's source snapshot; when given, its `.al` keys are parsed, not the disk. */
  snapshot?: ReadonlyMap<string, Buffer>,
): Promise<{ wrappedObjectFiles: readonly string[] }> {
  await initParser();
  const rels = (
    snapshot !== undefined
      ? [...snapshot.keys()]
      : (await walkFiles(projectDir, { links: "refuse" })).files
  )
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();
  const wrapped: string[] = [];
  for (const rel of rels) {
    const text =
      snapshot?.get(rel)?.toString("utf8") ?? (await readFile(join(projectDir, rel), "utf8"));
    const root = wrapRoot(parseAL(text));
    // R-300b: an admitted wrapped file is scored, so it does not turn coverage off.
    if (fileHoldsWrappedObject(root) && !alRunnerAdmitsWrappedFile(root)) {
      wrapped.push(normalizeSlashes(rel));
    }
  }
  return { wrappedObjectFiles: wrapped };
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
 * A multi-object file is NAMED (`multiObjectFiles`) and indexed, every object of it resolved by
 * position (R602, this module's header).
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
    readonly symbols?: readonly string[];
    /**
     * R219 run 003: the project al-runner may label coverage under (it discovers the source
     * project beside the test app, measured on c39ad5de). Without it, a source-path label for a
     * contested file name is refused.
     */
    readonly sourceProjectDir?: string;
    /**
     * R407: what a RELATIVE coverage label of an admitted multi-object file is resolved against:
     * al-runner's cwd. The one-shot transport sets none, so that is LethAL's own, the default.
     */
    readonly labelBase?: string;
  } = {},
): Promise<AlRunnerCoverageIndex> {
  await initParser();
  // ponytail: absent `symbols` means the bundle's own app.json symbols only (unit tests). The
  // backend always passes the session's set and refuses a coverage deploy without one.
  const symbols =
    options.symbols ??
    (await effectiveBuildSymbols(instrumentedDir, [], undefined, { kind: "bcdev" }));
  const rels = (await walkFiles(instrumentedDir, { links: "skip" })).files.filter((e) =>
    e.toLowerCase().endsWith(".al"),
  );
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
  const shownByKey = new Map<string, string>();
  const multiObjectFiles: string[] = [];
  const refusedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const entries: LineMapEntry[] = [];
  const declared = new Set<string>();
  const exempt = new Set<string>();
  const refusals = new Map<string, string>();
  const admittedWrappedFiles = new Set<string>();
  const admittedMultiObjectKeys = new Set<string>();
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
      for (const [key, reason] of refusedObjectsOfFile(root, file, "al-runner-index")) {
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
      for (const k of keysOf(rel)) admittedMultiObjectKeys.add(k);
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
    for (const k of c.keys) {
      byFile.set(k, kept);
      shownByKey.set(k, c.file);
    }
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
    shownByKey,
    ...(admittedMultiObjectKeys.size > 0
      ? {
          frameAdmission: {
            dir: instrumentedDir,
            keys: admittedMultiObjectKeys,
            labelBase: options.labelBase ?? process.cwd(),
          },
        }
      : {}),
  };
}

/**
 * R407: a label that resolved to an ADMITTED multi-object file must name a file inside the index's
 * own bundle. A one-shot label is relative to al-runner's cwd, which is LethAL's own (the transport
 * sets none); a `--server` label is absolute. A source-path or batch-sibling label is the R383
 * defect's signature, so it throws rather than being credited by its trailing segments.
 */
function assertAdmittedLabel(label: string, key: string, index: AlRunnerCoverageIndex): void {
  const admission = index.frameAdmission;
  if (admission === undefined || !admission.keys.has(key)) return;
  if (labelInsideDir(label, admission.dir, admission.labelBase)) return;
  throw new AlRunnerCoverageFrameError(
    `al-runner labelled coverage for the multi-object file ${index.shownByKey?.get(key) ?? key} as "${label}", which is outside the bundle it was handed (${admission.dir}). R602 measured v3 labelling a multi-object file's coverage inside the bundle, but this run does not look like the measured one: refusing rather than placing those lines`,
  );
}

/** A directory as `ExactResolution` compares it: absolute, `/`-separated, lower-cased, no trailing `/`. */
function dirKey(dir: string): string {
  return normalizeFileKey(resolve(dir)).replace(/\/+$/, "");
}

/**
 * R407: whether a coverage label names a file INSIDE `dir`. A relative label is resolved against
 * `base` (the spawn's cwd: one-shot Cobertura labels are cwd-relative, `--server` labels absolute).
 * Compared with a trailing `/` after `dirKey`, so `active` never matches `active-old`, and with no
 * trailing-segment matching, so a source or batch label ending in the same name is outside.
 */
export function labelInsideDir(label: string, dir: string, base: string = process.cwd()): boolean {
  return dirKey(resolve(base, label.replace(/\\/g, "/"))).startsWith(`${dirKey(dir)}/`);
}

/**
 * R219 run 003. Refuses two files whose keys collide once lower-cased (sol run 002:
 * `Sales/Helper.al` and `sales/Helper.al` on a case-sensitive file system, where one alias would
 * silently replace the other), then returns the exact maps when the batch renamed a file and any
 * last segment is contested.
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
  // Only a batch that renamed a file has two namespaces to confuse. LethAL writes every batch flat,
  // so a batch without renames has unique names; a hand-built nested one keeps R298's longest
  // ending, which stops at a skipped file's own path.
  if (contested.size === 0 || rels.every((rel) => display(rel) === rel)) return undefined;
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
      `al-runner reported coverage for "${file}", which names one file as a project path and another as a batch file name (R219). Refusing rather than crediting either. Rename one of the files, or run with "alRunnerV3.coverage": "none".`,
    );
  }
  const hit = inProject ?? inBatch;
  if (hit === undefined) {
    throw new Error(
      `al-runner reported coverage for "${file}", but two or more files of this batch end in that name (renamed by their folder, R219), and the path is neither inside the project (${projectDir ?? "not known"}) nor directly in the batch (${exact.batchDir}). Refusing rather than dropping that coverage or crediting it to the wrong file. Rename one of the files, or run with "alRunnerV3.coverage": "none".`,
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
 * Returned with the matched `byFile` key (R-300b's I3 rule and R407's label check read it).
 */
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
 * One test's coverage, as `perTestCoverage` (v3's `--coverage-json`, the `--server` shape the
 * retired .NET al-runner also wrote), into a `CoverageMap`. R654 removed the one-shot Cobertura
 * reader (`parseCobertura`, `alRunnerCoverageFrom`), which only v2 used.
 *
 * A row for something this bundle does not declare (the test app, Base Application, a
 * dependency) is skipped rather than an error, the same rule `LineMap` states for the hub path.
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
 * THROWS `AlRunnerCoverageFrameError` instead of letting the position win (R602 D; it dropped the
 * line with a warning before): the server was measured naming the compiled arm, with no scope
 * disagreement on any fixture line, so a disagreement there means the frame is not the one measured.
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
    assertAdmittedLabel(file.file, found.key, index);
    const objects = found.entries;
    // R407: in an admitted multi-object file a scope its position contradicts throws (below).
    const admittedMulti = index.frameAdmission?.keys.has(found.key) === true;
    // R219: quoted by the project path of the file it RESOLVED to (R-219c M1).
    const shownFile = index.shownByKey?.get(found.key) ?? file.file;
    // R-300b (I3): in an admitted wrapped file a disagreement drops the line instead.
    const strict = index.admittedWrappedFiles.has(found.key);
    for (const st of file.statements ?? []) {
      // A reported-but-unhit statement is evidence the file was COMPILED, never that this test
      // reached it. Treating it as coverage is [[R63]]'s manufactured coverage.
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
              // R602 (D): v3's frame was measured clean on admitted wrapped files (0 scope
              // mismatches), so a disagreement means this run is not the measured one: stop.
              throw new AlRunnerCoverageFrameError(
                `al-runner named the covered statement at ${shownFile}:${st.line} "${st.scope ?? ""}", but that line is inside "${byPosition}", in an admitted #if-wrapped file. R602 measured v3's frame for such a file with no disagreement, but this run does not look like the measured one: refusing rather than dropping the line or letting either name win`,
              );
            }
            if (admittedMulti && st.scope?.toLowerCase() !== byPosition.toLowerCase()) {
              throw new AlRunnerCoverageFrameError(
                `al-runner named the covered statement at ${shownFile}:${st.line} "${st.scope ?? ""}", but that line is inside "${byPosition}", in a multi-object file. R602 measured v3's frame for such a file with no disagreement, but this run does not look like the measured one: refusing rather than letting either name win`,
              );
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
