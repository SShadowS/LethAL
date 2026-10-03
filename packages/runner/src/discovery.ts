import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateArms,
  hasDirectiveLine,
  maskAlNonCode,
  parseAL,
  startsInInactiveArm,
  wrapRoot,
} from "@lethal/engine";
import type { TestMethodRef } from "./backend";

const CODEUNIT_HEADER_GLOBAL = /codeunit\s+(\d+)\s+("([^"]+)"|(\w+))/gi;
const SUBTYPE_TEST = /Subtype\s*=\s*Test\s*;/i;
const TEST_METHOD = /\[Test\]\s*(?:\[[^\]]*\]\s*)*procedure\s+("([^"]+)"|(\w+))\s*\(/gi;

/**
 * R79: blank out everything the AL compiler does not read as code — comments AND string
 * literals — preserving every offset, so the sectioning regexes below see only code.
 *
 * Without this, PROSE of the shape `codeunit 50100 "Sales Post"` (ordinary AL commenting) opened
 * a bogus codeunit section; the rest of the file fell into it; it had no `Subtype = Test;`; and
 * every `[Test]` from that point on VANISHED. Silently: baseline green, empty `unsupportedTests`,
 * and the mutants those tests covered reported `no-coverage`. Measured on
 * `fixtures/sandbox-data-tests` — 22 `[Test]` in source, 21 discovered.
 *
 * Anchoring the header to line start would have fixed the comment case only; a string literal
 * carries the same shape mid-line. Masking fixes the class, and it fixes the other direction too:
 * a commented-out `Subtype = Test;` no longer promotes a helper codeunit into a test suite.
 *
 * R80: the state machine itself now lives in `@lethal/engine` (`maskAlNonCode`), shared with
 * schemata's `stripAlComments`, which had grown a second copy of it. Discovery keeps the
 * blank-string-contents policy — that is the half this bug turned on — while attribution keeps
 * the other; the flag records the difference instead of two lexers drifting apart.
 */
function maskNonCode(source: string): string {
  return maskAlNonCode(source, { blankStringContents: true });
}

/**
 * R79's second net. Every `[Test]` in a file must land inside some codeunit section, or a test
 * has been dropped by the parse rather than by a rule.
 *
 * The one LEGITIMATE way a discovered count comes out below the file's `[Test]` count is a
 * codeunit whose section carries no `Subtype = Test;` — a helper or handler codeunit, which BC
 * would refuse to run as a test anyway. Those `[Test]`s are still ATTRIBUTED to a section, so
 * they are counted here and the guard stays silent.
 *
 * What it catches is the other shape: a codeunit header `CODEUNIT_HEADER_GLOBAL` failed to match
 * at all, leaving its tests in no section — today that is a silent, total loss of that file's
 * suite, the same direction as the bug this guard was written alongside.
 */
function assertEveryTestAttributed(rel: string, masked: string, sections: readonly string[]): void {
  const countTests = (text: string): number => Array.from(text.matchAll(TEST_METHOD)).length;
  const inFile = countTests(masked);
  const attributed = sections.reduce((sum, section) => sum + countTests(section), 0);
  if (inFile === attributed) return;
  throw new Error(
    `Test discovery lost ${inFile - attributed} of ${inFile} [Test] procedures in "${rel}": they lie outside every codeunit section, so no codeunit id could be attributed to them. That means a codeunit header in this file did not parse. Refusing rather than reporting a smaller suite, which would silently turn the mutants those tests cover into no-coverage.`,
  );
}

export interface DiscoverOptions {
  /**
   * R45: glob patterns naming which test FILES may contribute tests, matched against the
   * test-dir-relative path with forward slashes. Absent (or empty) means the whole suite.
   *
   * This narrows the BASELINE, which is where a real project's run time goes: measured on
   * Continia Document Output, baseline was 744.8s of a 953.8s run (78%), executing all 1,246
   * discovered tests for a run scoped by `--only` to a single codeunit. `--only` selects mutants,
   * not tests, so it does not touch that phase at all.
   *
   * UNLIKE `--only`, this narrowing can change VERDICTS in the unsafe direction: excluding the
   * test that would have killed a mutant turns that mutant into a survivor, and a false survivor
   * is the worst output this tool produces (R29). It is a deliberate speed/accuracy trade the
   * caller opts into, so it is recorded as a report caveat rather than treated as free.
   */
  readonly only?: readonly string[];
}

/**
 * Which test files a `--tests-only` pattern set admits, with the "matches nothing" refusal.
 *
 * Refusing matters more here than for `--only`: a pattern that silently matched no test file
 * would discover zero tests, and every mutant would then land as `no-coverage` (or, on a
 * coverage-less backend, be scored against nothing at all) — a confident-looking run over an
 * empty suite.
 */
function admittedTestFiles(
  relPaths: readonly string[],
  only: readonly string[],
): ReadonlySet<string> | undefined {
  if (only.length === 0) return undefined;
  const admitted = new Set<string>();
  const unmatched: string[] = [];
  for (const pattern of only) {
    const glob = new Bun.Glob(pattern);
    let matchedAny = false;
    for (const rel of relPaths) {
      if (glob.match(rel.replaceAll("\\", "/"))) {
        admitted.add(rel);
        matchedAny = true;
      }
    }
    if (!matchedAny) unmatched.push(pattern);
  }
  if (unmatched.length > 0) {
    throw new Error(
      `--tests-only matched no test file for ${unmatched.length === 1 ? "pattern" : "patterns"} ${unmatched.map((p) => `"${p}"`).join(", ")}. Patterns are matched against test-dir-relative paths using forward slashes (e.g. "Src/Documents/**"). Refusing rather than running with an empty test suite, which would report every mutant as no-coverage.`,
    );
  }
  return admitted;
}

/**
 * Every `[Test]` one AL SOURCE STRING declares, attributed to its codeunit.
 *
 * Split out of `discoverTests` for R139 check 2, which asks the same question of AL that came back
 * from the SERVER (inside the published app package) rather than off disk. Sharing this function
 * is the point: comparing a local list built by this parser against a remote list built by a second
 * one would report differences that are parser disagreements, and "your published app is missing a
 * test" is the wrong thing to say when the truth is "two regexes disagree".
 */
export function testsInAlSource(rel: string, source: string): TestMethodRef[] {
  return testsWithOffsets(rel, source).map((t) => t.ref);
}

/** `testsInAlSource`, with each test's `[Test]` attribute offset in `source` (UTF-16 code units,
 *  the unit the parser's offsets are in; the mask keeps every offset). */
function testsWithOffsets(
  rel: string,
  source: string,
): Array<{ readonly ref: TestMethodRef; readonly offset: number }> {
  const refs: Array<{ readonly ref: TestMethodRef; readonly offset: number }> = [];
  // R79: section on CODE only. Prose of the shape `codeunit 50100 "Sales Post"` used to open a
  // bogus section and swallow every [Test] below it, without a word anywhere.
  const masked = maskNonCode(source);

  // Find all codeunit headers in the file
  const codeunitMatches = Array.from(masked.matchAll(CODEUNIT_HEADER_GLOBAL));
  const sections: string[] = [];

  for (let i = 0; i < codeunitMatches.length; i++) {
    const headerMatch = codeunitMatches[i];
    if (!headerMatch || headerMatch.index === undefined) continue;

    const codeunitId = Number(headerMatch[1]);
    const codeunitName = headerMatch[3] ?? headerMatch[4] ?? "";

    // Determine section boundaries: from this header to the next (or end of file)
    const sectionStart = headerMatch.index;
    const nextMatch = codeunitMatches[i + 1];
    const sectionEnd = nextMatch?.index ?? masked.length;

    const section = masked.substring(sectionStart, sectionEnd);
    sections.push(section);

    // Check if this codeunit section has Subtype = Test
    if (!SUBTYPE_TEST.test(section)) continue;

    // Find test methods in this section only
    for (const m of section.matchAll(TEST_METHOD)) {
      refs.push({
        ref: { codeunitId, codeunitName, method: m[2] ?? m[3] ?? "", file: rel },
        offset: sectionStart + m.index,
      });
    }
  }

  assertEveryTestAttributed(rel, masked, sections);
  return refs;
}

/** R403 phase B: the id of every codeunit `source` declares (on code only, every arm read). The
 *  `--tests-only` scope for the compiled-membership check maps a compiled codeunit to its file
 *  through these, BEFORE arm filtering, so a codeunit whose tests are all compiled out of the
 *  local build is still in scope. */
function declaredCodeunitIds(source: string): number[] {
  return Array.from(maskNonCode(source).matchAll(CODEUNIT_HEADER_GLOBAL), (m) => Number(m[1]));
}

/** An `#if` or `#endif` line (`#elif` / `#else` stay inside the same region). */
const REGION_LINE = /^﻿?[ \t]*#[ \t]*(if|endif)\b/gim;

/**
 * R403 phase B: whether a `[Test]` at `offset` lies between an `#if` and its `#endif`, in ANY
 * arm. That is the test whose membership depends on the build's symbols, which is what the
 * `test-symbols-unverified` caveat names when no compiled package can say which build was
 * published. Read on the masked source, so a directive inside a comment does not count; an
 * unbalanced file counts every test as conditional (the caveat errs toward naming a file).
 */
function conditionalTestOffsets(source: string, offsets: readonly number[]): boolean[] {
  const marks = Array.from(maskNonCode(source).matchAll(REGION_LINE), (m) => ({
    at: m.index,
    open: (m[1] ?? "").toLowerCase() === "if",
  }));
  let depth = 0;
  for (const m of marks) {
    depth += m.open ? 1 : -1;
    if (depth < 0) return offsets.map(() => true);
  }
  if (depth !== 0) return offsets.map(() => true);
  return offsets.map((offset) => {
    let d = 0;
    for (const m of marks) {
      if (m.at >= offset) break;
      d += m.open ? 1 : -1;
    }
    return d > 0;
  });
}

/** R403: one file's arms under `buildSymbols`. `filtered` keeps undecided files' tests. */
function armsOfFile(
  rel: string,
  source: string,
  found: ReadonlyArray<{ readonly ref: TestMethodRef; readonly offset: number }>,
  buildSymbols: readonly string[],
): { filtered: TestMethodRef[]; excluded: TestExclusion[]; directive: boolean } {
  const directive = hasDirectiveLine(source);
  // A file with no directive line compiles every test it declares; skipping its parse keeps
  // `lethal verify` at one parse per test file (R-371).
  if (found.length === 0 || !directive) {
    return { filtered: found.map((t) => t.ref), excluded: [], directive };
  }
  const filtered: TestMethodRef[] = [];
  const excluded: TestExclusion[] = [];
  // Offsets: `evaluateArms` returns offsets into the RAW source, in UTF-16 code units (the native
  // parser's unit). `testsWithOffsets` matches on the masked source, which keeps every offset
  // (R403 fixed `maskAlNonCode` for characters outside the BMP), so the two compare directly.
  const arms = evaluateArms(wrapRoot(parseAL(source)), source, buildSymbols);
  for (const { ref, offset } of found) {
    if (arms.kind === "undecided") {
      filtered.push(ref);
      excluded.push({
        test: ref,
        file: rel,
        reason: "preproc-undecided-kept",
        detail: arms.reason,
      });
    } else if (startsInInactiveArm(arms.inactive, offset)) {
      excluded.push({ test: ref, file: rel, reason: "compiled-out" });
    } else {
      filtered.push(ref);
    }
  }
  return { filtered, excluded, directive };
}

/**
 * R403 phase B: `testsInAlSource` with the arm filter applied under `buildSymbols`, exactly as
 * arm-aware discovery applies it (undecided files keep every test). R139's source-to-source
 * comparison runs this over the PUBLISHED package's source when the session runs the filtered
 * suite, so both sides are filtered alike. The caller must have called `initParser()`.
 */
export function armFilteredTestsInAlSource(
  rel: string,
  source: string,
  buildSymbols: readonly string[],
): TestMethodRef[] {
  return armsOfFile(rel, source, testsWithOffsets(rel, source), buildSymbols).filtered;
}

/** R403: options for arm-aware discovery. `buildSymbols` is the TEST app's derived symbol set
 *  (`effectiveBuildSymbols(testDir, ...)`: the config's symbols, the test `app.json`'s, and on
 *  al-runner its measured predefined ones). A file's own `#define` / `#undef` are applied per file
 *  by `evaluateArms`. The caller must have called `initParser()`: each file with a `[Test]` is
 *  parsed, and an uninitialised parser throws. */
export interface ArmAwareDiscoverOptions extends DiscoverOptions {
  readonly buildSymbols: readonly string[];
}

/** R403: why a discovered `[Test]` is recorded. `compiled-out`: its attribute starts in an arm the
 *  build compiles out, so it is not in the filtered list. `preproc-undecided-kept`: its file's arms
 *  could not be evaluated exactly as alc does (`evaluateArms` returned `undecided`), so it is KEPT
 *  in the filtered list, as before R403, and recorded. */
export type TestExclusionReason = "compiled-out" | "preproc-undecided-kept";

export interface TestExclusion {
  readonly test: TestMethodRef;
  readonly file: string;
  readonly reason: TestExclusionReason;
  /** `preproc-undecided-kept` only: `evaluateArms`'s reason code (never source text). */
  readonly detail?: string;
}

/**
 * R403: both lists, because the choice between them depends on evidence not known at discovery
 * time (plan §7): on al-runner the filtered list is the suite al-runner compiles; on bcdev only the
 * published package's compiled membership can say which build is published (R-403 phase B).
 */
export interface ArmAwareDiscovery {
  /** The symbol set the arms were evaluated under, as passed. */
  readonly buildSymbols: readonly string[];
  /** Every discovered test whose `[Test]` is not compiled out under `buildSymbols`. */
  readonly filtered: TestMethodRef[];
  /** Every discovered test, every arm read: exactly what `discoverTests` returned before R403. */
  readonly unfiltered: TestMethodRef[];
  /** Every `compiled-out` test and every `preproc-undecided-kept` one, in discovery order. */
  readonly excluded: readonly TestExclusion[];
  /** Whether any test file discovery read (within `only`) holds a directive line. When none
   *  does, no symbol set can change the suite, so the resume fingerprint omits the test set. */
  readonly anyDirective: boolean;
  /**
   * R403 phase B: with `--tests-only`, the id of every codeunit declared in an admitted file, every
   * arm read (BEFORE arm filtering). The compiled-membership check compares only the compiled
   * codeunits in this set. Absent when nothing narrowed the suite: every compiled codeunit is in
   * scope.
   */
  readonly inScopeCodeunits?: ReadonlySet<number>;
  /** R403 phase B: every file in scope with a `[Test]` between an `#if` and its `#endif` (any arm),
   *  or in a file whose arms are undecided, sorted. What `test-symbols-unverified` names. */
  readonly conditionalTestFiles: readonly string[];
}

/**
 * Every `[Test]` in the test project. Without `buildSymbols` it reads every `#if` arm and returns
 * the list (the pre-R403 shape, kept for every caller that has no symbol set). With `buildSymbols`
 * it also evaluates each file's arms and returns both lists (`ArmAwareDiscovery`).
 */
export async function discoverTests(
  testDir: string,
  options?: DiscoverOptions,
): Promise<TestMethodRef[]>;
export async function discoverTests(
  testDir: string,
  options: ArmAwareDiscoverOptions,
): Promise<ArmAwareDiscovery>;
export async function discoverTests(
  testDir: string,
  options: DiscoverOptions | ArmAwareDiscoverOptions = {},
): Promise<TestMethodRef[] | ArmAwareDiscovery> {
  const buildSymbols = "buildSymbols" in options ? options.buildSymbols : undefined;
  const unfiltered: TestMethodRef[] = [];
  const filtered: TestMethodRef[] = [];
  const excluded: TestExclusion[] = [];
  let anyDirective = false;
  const conditionalTestFiles: string[] = [];
  const entries = await readdir(testDir, { recursive: true });
  const alFiles = entries.filter((e) => e.toLowerCase().endsWith(".al")).sort();
  const admitted = admittedTestFiles(alFiles, options.only ?? []);
  const inScopeCodeunits = admitted !== undefined ? new Set<number>() : undefined;
  for (const rel of alFiles) {
    if (admitted !== undefined && !admitted.has(rel)) continue;
    const source = await readFile(join(testDir, rel), "utf8");
    const found = testsWithOffsets(rel, source);
    unfiltered.push(...found.map((t) => t.ref));
    if (buildSymbols === undefined) continue;
    if (inScopeCodeunits !== undefined) {
      for (const id of declaredCodeunitIds(source)) inScopeCodeunits.add(id);
    }
    const arms = armsOfFile(rel, source, found, buildSymbols);
    anyDirective ||= arms.directive;
    filtered.push(...arms.filtered);
    excluded.push(...arms.excluded);
    if (
      arms.directive &&
      found.length > 0 &&
      (arms.excluded.length > 0 ||
        conditionalTestOffsets(
          source,
          found.map((t) => t.offset),
        ).some((c) => c))
    ) {
      conditionalTestFiles.push(rel);
    }
  }
  if (buildSymbols === undefined) return unfiltered;
  return {
    buildSymbols,
    filtered,
    unfiltered,
    excluded,
    anyDirective,
    ...(inScopeCodeunits !== undefined ? { inScopeCodeunits } : {}),
    conditionalTestFiles,
  };
}
