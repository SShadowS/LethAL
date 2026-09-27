# GH-06: tree-sitter vs the AL compiler's syntax tree, one measured run, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r2 (2026-09-27)**, after review `H:/lethal-coord/reviews/GH-06-plan/review-r1.md` and the orchestrator's rulings. Changes from r1: both site lists are filtered by file health BEFORE diffing, and a run with no comparable files is "inconclusive" (C1); context probes compare answers at matched site POSITIONS, with directives excluded by span, and per-file totals are summaries only (C2); an end-to-end positive control with two old grammars is added (Task 4); over-claims are verified per cluster through the filtered planning pipeline, matched by precise site (Task 7); the D3 check asserts both parsers' file counts against the fingerprint; no corpus run happens before the pre-commitment is committed; every commit stages explicit paths and inspects the staged diff.

**Revision r3 (2026-09-27, final)**, after `H:/lethal-coord/reviews/GH-06-plan/review-r2.md`: the CLI argument split is a tested function and leaves the args alone when `--json` is absent; ONE verdict rule with four outcomes and four exit codes, health as a warning that never changes it, an unruled mapping as its own outcome; the control rule is written out (A, else B, else STOP), with no rebuild of v3.2.1; a position-verified cluster that will not minimise becomes an UNRESOLVED roadmap item, never dropped; duplicate context keys fail the run; the harness-level health-filter red-check must be non-vacuous; a negative census match is inspected, not taken as proof.

**Goal:** Finish GitHub issue #6: run the existing grammar cross-check ONCE over the fixtures and the reference corpora under the current grammar (tree-sitter-al 4.3.0), against criteria written down before the run, record the numbers in one findings document, and file a roadmap item for each blind spot that clears the bar.

**Architecture:** Most of the harness already exists and is reused, not rebuilt. `scripts/probe-grammar-crosscheck.ts` parses each file with tree-sitter-al and with the AL compiler's own parser (`Microsoft.Dynamics.Nav.CodeAnalysis`, loaded from the AL extension by `scripts/lib/dump-compiler-kinds.ps1` through `SyntaxTree.ParseObjectText`), maps compiler kinds into tree-sitter kinds through `scripts/lib/al-kind-mapping.ts`, and diffs the sites by file, kind, start and end. This plan fixes five measured defects in that harness, moves its comparison logic into a small tested module, proves the whole chain end to end on two known-bad grammars, commits a pre-commitment, runs it once, and writes up what it finds. No new product feature: the measurement decides whether one is needed.

**Tech Stack:** Bun + TypeScript, `web-tree-sitter` 0.25.10 (through `packages/engine`), PowerShell 7 (`pwsh`) loading `Microsoft.Dynamics.Nav.CodeAnalysis.dll` from `~/.vscode/extensions/ms-dynamics-smb.al-*/bin/`. No .NET project, no NuGet package, no new dependency.

**Spec:** GitHub issue #6 (`gh issue view 6 -R SShadowS/LethAL`; copy in `H:/lethal-coord/tasks/GH-06/task.md`). Prior work: commits `9cfad19` to `b3c441a` (phase 1, "issue-6"), roadmap rows `R214`, `R215`, `R216`, `R217`, and `packages/engine/vendor/README.md` §"The 4.0.1 -> 4.3.0 bump".

## What already exists (read before starting)

Issue #6 phase 1 landed on 2026-09-08/09. It is NOT greenfield:

| file | what it does |
| --- | --- |
| `scripts/probe-grammar-crosscheck.ts` | the harness (CLI, top-level body, not imported by anything) |
| `scripts/lib/al-kind-mapping.ts` | `COMPILER_TO_TREE_SITTER`, `AUDITED_TREE_SITTER_KINDS`, `DELIBERATELY_UNMAPPED`, `CONTEXT_PROBES` |
| `scripts/lib/dump-compiler-kinds.ps1` | the compiler side: every syntax node as `{file, kind, start, end, parent}` JSON |
| `scripts/lib/al-kind-mapping-fixture.al` | validation file, per-kind counts known by construction |
| `scripts/lib/al-kind-mapping-stress.al` | awkward AL, includes a `#if` block (R214) |
| `scripts/lib/al-kind-mapping-linkprobe.al` | a single-entry `DataItemLink`, the v3.2.1 positive control |

The audited families are the six the issue names: comparison, additive, multiplicative, logical, unary, call. Plus two CONTEXT probes (call in statement position, assignment in statement position), which compare the answer `isStatementSlot` gives against the compiler's, because a kind-and-position diff cannot see a parent-shape regression.

Phase 1 found R214 (`#if` arms), R215 (enum `Implementation`, fixed upstream in 4.1.0), R216 (`asserterror` body), R217 (the statement-slot list), and upstream grammar issues #20 to #23, all fixed in the vendored 4.3.0. What it never produced: a single run of the whole corpus set under 4.3.0, against criteria fixed in advance, written up in one place. That is this plan.

**What "zero blind spots" can ever mean here.** The mapping deliberately leaves executable forms out: literals, `in`, `as`/`is`, the conditional expression, member access, array index (`DELIBERATELY_UNMAPPED`). So every "no blind spot" statement in this work, in code output, in the findings and in the issue comment, is scoped: **zero in the six audited families and two context probes, on the comparable files**. Never "zero operator losses".

### Measured while drafting this plan (2026-09-27, compiler parser v18.0.41.45789)

Validation files and fixtures only, never a reference corpus. Run with the alc bin dir passed explicitly (the default is stale, D1):

| target | result |
| --- | --- |
| `al-kind-mapping-fixture.al` | AGREE, 6/2/4/2/2/2 both sides, context 2/2 and 16/16 |
| `al-kind-mapping-linkprobe.al` | AGREE, all zero |
| `al-kind-mapping-stress.al` | DISAGREE only by 1 `multiplicative_expression` inside `#if` (R214, expected) |
| `fixtures/` (68 files) | all six kinds agree (20/703/117/3/12/32); call-in-statement-position 482 vs compiler 491 (global count), assignment 207/207 |

Also measured, and load-bearing for C2: the compiler's `AssignmentStatement` span INCLUDES the trailing `;` and tree-sitter's `assignment_statement` does not (`R := 1;` is 231-238 to the compiler, 231-237 to tree-sitter, on `al-kind-mapping-fixture.al`). So context sites are matched on `file|probe|start`, not on the end offset. Two statement-position sites of one probe cannot share a start, so this loses nothing.

### Defects found in the harness while drafting (fixed in Tasks 1 to 3)

- **D1. Stale compiler path.** `DEFAULT_ALC_BIN` (`probe-grammar-crosscheck.ts:35`) hardcodes `ms-dynamics-smb.al-18.0.2668733`, which is no longer installed on this machine (18.0.2732683 is). The script dies with `not found: ...Microsoft.Dynamics.Nav.CodeAnalysis.dll`. R167's failure again. Fix: reuse `defaultAlToolPaths()` from `packages/runner/src/publisher.ts`, which walks newest first and checks existence.
- **D2. MISSING nodes are invisible.** The harness counts only `rawKind === "ERROR"`. A tree-sitter MISSING node is not named `MISSING`; it carries the type of the token it stands in for. Measured: `if (R > 1 then R := 2;` parses with ZERO `ERROR` nodes and one MISSING node of type `)`. `scripts/probe-grammar-corpus.ts:84-90` has the worse form: it tests `n.rawKind === "MISSING"`, which can never be true, so its `missingNodes` column is always 0. Fix: one `parseHealth()` helper reading `isMissing`, used by both scripts.
- **D3. `.dependencies` is included.** Both parsers recurse into `.dependencies` (`probe-grammar-crosscheck.ts:51-65`, `dump-compiler-kinds.ps1:24-30`), while `corpusEntries()` in `scripts/corpus-fingerprint.ts` excludes it, so the harness measures a different file set than the corpus hash names. `do-rel2/Cloud`: 554 `.al` files, 137 under `.dependencies`; `DC/Cloud`: 1,135, 660 under it. (Not every instrument excludes them: `census-operator-sites.ts:87-90` includes them. That matters for Task 7, which does not use it.) Fix: both parsers read one file list built by `corpusEntries()`, and the harness asserts both parsers' file counts equal the fingerprint's.
- **D4. No corpus identity.** R187 asks every corpus-taking instrument to print `describeFingerprint()` first. This one prints grammar and totals first. Fix: print it.
- **D5. The `#if` split is one-sided.** `guardedKeys` classifies only tree-sitter-only deltas (`:318-325`). A compiler-only site inside a directive is reported as an unexplained blind spot. Fix: tree-sitter `preproc_conditional*` spans per file, containment applied in BOTH directions.

One stated limit is FALSE and is corrected in the ps1 comment and the findings: `dump-compiler-kinds.ps1` says offsets "match tree-sitter's byte offsets only for ASCII source". Measured: web-tree-sitter parsing a JS string reports UTF-16 code-unit offsets (a comment holding `æøå 😀` gave `startIndex` 83, `src.indexOf` 83, byte offset 88), and .NET `TextSpan` is UTF-16 too. Task 1 pins this.

## Global Constraints

- Plain English, short sentences, no em dashes anywhere (code comments, docs, roadmap rows, commit messages).
- No live BC container, no billed environment, no `LETHAL_ITEST_*` gate. Everything runs offline: tree-sitter in Bun, the compiler parser in `pwsh`. `ParseObjectText` is syntax only: no symbols, no `.alpackages`, no project.
- **No reference-corpus run of any kind before Task 5 (the pre-commitment) is committed.** Validation files, the fixtures and hand-made scratch directories are allowed earlier. Reference corpora: `do-rel2`, `do-lethal`, `DC`, `BusinessCentral.Sentinel`, `BC.History`.
- This repo is PUBLIC. Commit ONLY counts, file paths, node kinds, offsets and hand-written minimal AL. Never commit text copied from a reference corpus (`BC.History` is Microsoft source). ALL harness output (`.txt`, `--json`) and any census output stay in the session scratchpad, never under `U:/Git/LethAL`.
- **Staging:** `git add` explicit file paths only, never a glob or a directory. Before every commit run `git diff --cached --stat` and `git diff --cached` and check that only the named files are staged and that no corpus text is in the diff. Other sessions commit here concurrently.
- The harness stays a script, kept after this work (the vendor README uses it for grammar bumps), and is NOT a gate: not in the build, not in `bun test`, not in any itest. Only `scripts/lib/grammar-crosscheck.ts` (pure functions) gets a unit test.
- The mapping in `al-kind-mapping.ts` is NOT widened (no literal family, ruling Q1).
- No `!` non-null assertions; `exactOptionalPropertyTypes` spread pattern for optional props.
- A module something imports must not run on import (R186, `scripts/importable-scripts.test.ts`). The new lib module has no top-level body.
- Build loop order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- Red-check every fix: revert it, see the specific test go red, restore.
- Roadmap: one file per item, `docs/roadmap/R<nnn>.md`, frontmatter `id`, `title`, `status`, `section`, `order`. Run `ls docs/roadmap/` IMMEDIATELY before writing each file (R279 is the highest at drafting). Regenerate with `bun scripts/roadmap-index.ts`; never hand-edit `ROADMAP.md`.

## Review Focus

1. **A file one parser cannot read cleanly.** Expected: its sites are removed from BOTH lists before the diff, it is listed by name as a health WARNING, and it lowers the comparable-file count. It never produces a delta and never changes the verdict. Pinned by Task 1's `restrictToComparable` and `verdict` tests and by Task 2 Step 7's non-vacuous harness check.
2. **Every file unhealthy.** Expected: verdict `inconclusive`, exit code 2, never "agree". Pinned by Task 1's `verdict` test and Task 2 Step 7.
3. **A lost context site and an extra one in the same file.** Expected: two deltas at two positions, not "agrees". Pinned by Task 1's cancellation test.
4. **A MISSING node with no ERROR node.** Expected: the file is unhealthy. Pinned by Task 1's `parseHealth` test on `if (R > 1 then`.
5. **Non-ASCII source (Danish letters, emoji in comments).** Expected: offsets agree between the parsers. Pinned by Task 1's UTF-16 offset test.
6. **The harness run without `--json`.** Expected: the target is the first positional argument either way. Pinned by Task 1's `splitArgs` tests and Task 2 Step 5 (review r2 found the r2 split dropped argument 0).
7. **A compiler mapping gap.** Expected: verdict `unruled-mapping`, exit 3, never "agree", even when every site matches. Pinned by Task 1's `verdict` test and Task 2 Step 5's harness check.

---

## File structure

- Create `scripts/lib/grammar-crosscheck.ts`: pure logic (`Site`, `siteKey`, `contextKey`, `restrictToComparable`, `assertUniqueKeys`, `diffSites`, `verdict`, `EXIT_CODE`, `splitArgs`, `parseHealth`). No CLI body.
- Create `scripts/lib/grammar-crosscheck.test.ts`: the unit test on hand-made pairs.
- Modify `scripts/probe-grammar-crosscheck.ts`: use the module, fix D1 to D5, positional context, `--json <out>`.
- Modify `scripts/lib/dump-compiler-kinds.ps1`: `-ListFile` instead of `-Path`, per-file error list, corrected offset comment.
- Modify `scripts/probe-grammar-corpus.ts`: count MISSING through `parseHealth` (D2).
- Create `scripts/lib/al-kind-mapping-continue.al`: hand-written positive control for the compiler-only direction.
- Create `docs/superpowers/specs/2026-09-27-gh06-crosscheck-precommitment.md`: criteria, committed BEFORE any reference-corpus run.
- Create `docs/measurements/2026-09-27-gh06-grammar-crosscheck.md`: the findings.
- Create `docs/roadmap/R<nnn>.md` per blind spot that clears the bar; regenerate `ROADMAP.md`.

---

### Task 1: The comparison logic as a tested module

**Files:**
- Create: `scripts/lib/grammar-crosscheck.ts`
- Test: `scripts/lib/grammar-crosscheck.test.ts`

**Interfaces:**
- Consumes: `initParser`, `parseAL` from `packages/engine/src/ast/parser` (test only; the module imports only the TYPE).
- Produces (used by Tasks 2 to 4):
  - `interface Site { readonly file: string; readonly kind: string; readonly start: number; readonly end: number }`
  - `type Span = readonly [start: number, end: number]`
  - `siteKey(s: Site): string` (file, kind, start, end) for the six kinds
  - `contextKey(s: Site): string` (file, kind, start) for the context probes, where `kind` is the probe name
  - `restrictToComparable(sites: readonly Site[], comparable: ReadonlySet<string>): Site[]`
  - `interface Delta { readonly site: Site; readonly treeSitter: number; readonly compiler: number }`
  - `interface Split { readonly guarded: Delta[]; readonly explained: Delta[]; readonly unexplained: Delta[] }`
  - `interface SiteDiff { readonly onlyCompiler: Split; readonly onlyTreeSitter: Split }`
  - `interface DiffOptions { readonly guardedSpans: ReadonlyMap<string, readonly Span[]>; readonly explained?: ReadonlySet<string>; readonly key?: (s: Site) => string }`
  - `diffSites(ts: readonly Site[], cc: readonly Site[], opts: DiffOptions): SiteDiff`
  - `assertUniqueKeys(sites: readonly Site[], key: (s: Site) => string, side: string): void` (throws on a duplicate)
  - `type Verdict = "agree" | "disagree" | "unruled-mapping" | "inconclusive"`
  - `verdict(input: { comparableFiles: number; diffs: readonly SiteDiff[]; unruledKinds: number }): Verdict`
  - `EXIT_CODE: Readonly<Record<Verdict, number>>` = agree 0, disagree 1, inconclusive 2, unruled-mapping 3
  - `splitArgs(args: readonly string[]): { positional: string[]; jsonOut: string | undefined }`
  - `type TsNode = ReturnType<typeof parseAL>["rootNode"]`
  - `interface ParseHealth { readonly errorNodes: number; readonly missingNodes: number }`
  - `parseHealth(root: TsNode): ParseHealth`

Precedence inside `diffSites`: a delta inside a guarded span is `guarded` (R214) whatever else is true; otherwise a delta whose key is in `explained` is `explained`; otherwise `unexplained`. `explained` is used only for R216: compiler-only context sites at a position where tree-sitter has a node of the probe's kind whose parent is `asserterror_statement`. **The one verdict rule.** The printed last line, the JSON `verdict` and the exit code all come from it; nothing else sets them. Checked in this order:
1. `comparableFiles === 0` gives `inconclusive` (exit 2).
2. `unruledKinds > 0` gives `unruled-mapping` (exit 3). An unresolved mapping gap cannot support a finished audit, whatever the sites say.
3. Any delta in any bucket of any diff (guarded, explained or unexplained) gives `disagree` (exit 1). Agreement is literal; "disagree with nothing unexplained" is a separate reportable fact.
4. Otherwise `agree` (exit 0).

Unhealthy files are a WARNING, printed and written to JSON `warnings`. They never change the verdict: their sites were removed before the diff, and the comparable count shows the cost.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import { initParser, parseAL } from "../../packages/engine/src/ast/parser";
import {
  type Site,
  type Span,
  contextKey,
  siteKey,
  diffSites,
  parseHealth,
  EXIT_CODE,
  assertUniqueKeys,
  restrictToComparable,
  splitArgs,
  verdict,
} from "./grammar-crosscheck";

const v = (
  comparableFiles: number,
  diffs: Parameters<typeof verdict>[0]["diffs"],
  unruledKinds = 0,
) => verdict({ comparableFiles, diffs, unruledKinds });

const site = (file: string, kind: string, start: number, end: number): Site => ({
  file,
  kind,
  start,
  end,
});
const NO_SPANS: ReadonlyMap<string, readonly Span[]> = new Map();

describe("diffSites on hand-made pairs", () => {
  test("identical inputs produce no deltas, and the verdict is agree", () => {
    const s = [site("a.al", "additive_expression", 10, 15)];
    const d = diffSites(s, s, { guardedSpans: NO_SPANS });
    for (const split of [d.onlyCompiler, d.onlyTreeSitter]) {
      expect(split.guarded).toEqual([]);
      expect(split.explained).toEqual([]);
      expect(split.unexplained).toEqual([]);
    }
    expect(v(1, [d])).toBe("agree");
  });

  test("nested same-start chain: `A + B + C` holds two additive nodes starting at A", () => {
    // Phase 1 once keyed on file|kind|start into a Set and printed AGREE here (7c7d7a3).
    const outer = site("a.al", "additive_expression", 0, 9);
    const inner = site("a.al", "additive_expression", 0, 5);
    const d = diffSites([outer, inner], [outer], { guardedSpans: NO_SPANS });
    expect(d.onlyTreeSitter.unexplained).toEqual([{ site: inner, treeSitter: 1, compiler: 0 }]);
    expect(d.onlyCompiler.unexplained).toEqual([]);
    expect(v(1, [d])).toBe("disagree");
  });

  test("multiplicity survives: the same key twice on one side is a delta", () => {
    const x = site("a.al", "call_expression", 3, 8);
    const d = diffSites([x, x], [x], { guardedSpans: NO_SPANS });
    expect(d.onlyTreeSitter.unexplained).toEqual([{ site: x, treeSitter: 2, compiler: 1 }]);
  });

  test("a compiler-only site is a blind spot, a tree-sitter-only site an over-claim", () => {
    const blind = site("a.al", "comparison_expression", 20, 25);
    const over = site("a.al", "call_expression", 40, 44);
    const d = diffSites([over], [blind], { guardedSpans: NO_SPANS });
    expect(d.onlyCompiler.unexplained.map((x) => x.site)).toEqual([blind]);
    expect(d.onlyTreeSitter.unexplained.map((x) => x.site)).toEqual([over]);
  });

  test("a directive span guards BOTH directions, only its own range, only its own file", () => {
    const spans = new Map<string, readonly Span[]>([["a.al", [[100, 200]]]]);
    const tsOnly = site("a.al", "multiplicative_expression", 120, 125);
    const ccOnly = site("a.al", "additive_expression", 150, 155);
    const outsideSpan = site("a.al", "additive_expression", 300, 305);
    const otherFile = site("b.al", "additive_expression", 150, 155);
    const d = diffSites([tsOnly], [ccOnly, outsideSpan, otherFile], { guardedSpans: spans });
    expect(d.onlyTreeSitter.guarded.map((x) => x.site)).toEqual([tsOnly]);
    expect(d.onlyCompiler.guarded.map((x) => x.site)).toEqual([ccOnly]);
    // A file with a directive is NOT set aside whole: a gap outside the span is still a finding.
    expect(d.onlyCompiler.unexplained.map((x) => x.site)).toEqual([outsideSpan, otherFile]);
  });
});

describe("context probes compare POSITIONS, not per-file totals", () => {
  const probe = "call in statement position";
  test("one lost site and one extra site in the same file are two deltas, not agreement", () => {
    // Per-file totals would read 2 vs 2 here. R217 records that cancellation as a real failure.
    const shared = site("a.al", probe, 10, 20);
    const onlyTs = site("a.al", probe, 30, 40);
    const onlyCc = site("a.al", probe, 50, 60);
    const d = diffSites([shared, onlyTs], [shared, onlyCc], {
      guardedSpans: NO_SPANS,
      key: contextKey,
    });
    expect(d.onlyTreeSitter.unexplained.map((x) => x.site)).toEqual([onlyTs]);
    expect(d.onlyCompiler.unexplained.map((x) => x.site)).toEqual([onlyCc]);
    expect(v(1, [d])).toBe("disagree");
  });

  test("context keys ignore the end offset: the compiler's statement span includes the `;`", () => {
    // Measured: `R := 1;` is 231-238 to the compiler, 231-237 to tree-sitter.
    const d = diffSites([site("a.al", probe, 231, 237)], [site("a.al", probe, 231, 238)], {
      guardedSpans: NO_SPANS,
      key: contextKey,
    });
    expect(d.onlyCompiler.unexplained).toEqual([]);
    expect(d.onlyTreeSitter.unexplained).toEqual([]);
  });

  test("only the asserterror POSITION is explained, not a gap that happens to have the same size", () => {
    const inAssertError = site("a.al", probe, 70, 80);
    const unrelated = site("a.al", probe, 90, 95);
    const explained = new Set([contextKey(inAssertError)]);
    const d = diffSites([], [inAssertError, unrelated], {
      guardedSpans: NO_SPANS,
      explained,
      key: contextKey,
    });
    expect(d.onlyCompiler.explained.map((x) => x.site)).toEqual([inAssertError]);
    expect(d.onlyCompiler.unexplained.map((x) => x.site)).toEqual([unrelated]);
  });
});

describe("comparable files and the verdict", () => {
  test("sites in an unhealthy file are removed from BOTH sides before the diff", () => {
    const good = site("good.al", "call_expression", 1, 5);
    const bad = site("bad.al", "call_expression", 1, 5);
    const comparable = new Set(["good.al"]);
    const d = diffSites(restrictToComparable([good, bad], comparable), restrictToComparable([good], comparable), {
      guardedSpans: NO_SPANS,
    });
    expect(d.onlyTreeSitter.unexplained).toEqual([]);
    expect(v(comparable.size, [d])).toBe("agree");
  });

  test("no comparable file is inconclusive, never agree", () => {
    const empty = diffSites([], [], { guardedSpans: NO_SPANS });
    expect(v(0, [empty])).toBe("inconclusive");
    expect(v(0, [empty], 3)).toBe("inconclusive");
  });

  test("an unruled compiler kind is its own verdict, even when every site matches", () => {
    const empty = diffSites([], [], { guardedSpans: NO_SPANS });
    expect(v(5, [empty], 1)).toBe("unruled-mapping");
  });

  test("a guarded-only or explained-only delta is still disagree", () => {
    const x = site("a.al", "call_expression", 1, 5);
    const spans = new Map<string, readonly Span[]>([["a.al", [[0, 10]]]]);
    const guarded = diffSites([x], [], { guardedSpans: spans });
    expect(guarded.onlyTreeSitter.guarded).toHaveLength(1);
    expect(v(1, [guarded])).toBe("disagree");
    const explained = diffSites([], [x], { guardedSpans: NO_SPANS, explained: new Set([siteKey(x)]) });
    expect(explained.onlyCompiler.explained).toHaveLength(1);
    expect(v(1, [explained])).toBe("disagree");
  });

  test("exit codes are distinct per verdict", () => {
    expect(EXIT_CODE).toEqual({ agree: 0, disagree: 1, inconclusive: 2, "unruled-mapping": 3 });
  });
});

describe("duplicate context keys fail loudly", () => {
  test("two sites with one file|probe|start on one side throw, naming the side and key", () => {
    const a = site("a.al", "call in statement position", 10, 20);
    const b = site("a.al", "call in statement position", 10, 25);
    expect(() => assertUniqueKeys([a, b], contextKey, "compiler")).toThrow(
      "compiler: duplicate key a.al|call in statement position|10",
    );
    expect(() => assertUniqueKeys([a], contextKey, "compiler")).not.toThrow();
  });
});

describe("splitArgs: both CLI forms", () => {
  test("without --json the args are unchanged and the target is kept", () => {
    expect(splitArgs(["x.al"])).toEqual({ positional: ["x.al"], jsonOut: undefined });
    expect(splitArgs(["dir", "bin", "g.wasm"])).toEqual({
      positional: ["dir", "bin", "g.wasm"],
      jsonOut: undefined,
    });
  });
  test("with --json the flag and its value are removed wherever they sit", () => {
    expect(splitArgs(["dir", "--json", "o.json"])).toEqual({ positional: ["dir"], jsonOut: "o.json" });
    expect(splitArgs(["--json", "o.json", "dir", "", "g.wasm"])).toEqual({
      positional: ["dir", "", "g.wasm"],
      jsonOut: "o.json",
    });
  });
  test("--json with no value is a usage error, not a silent default", () => {
    expect(() => splitArgs(["dir", "--json"])).toThrow("--json needs a path");
  });
});

describe("parseHealth and offsets, on the real vendored grammar", () => {
  beforeAll(async () => {
    await initParser();
  });
  const wrap = (body: string): string =>
    `codeunit 50000 X\n{\n    procedure P()\n    var\n        R: Integer;\n    begin\n${body}\n    end;\n}\n`;

  test("clean AL is healthy", () => {
    expect(parseHealth(parseAL(wrap("        R := 1;")).rootNode)).toEqual({
      errorNodes: 0,
      missingNodes: 0,
    });
  });

  test("a MISSING node with no ERROR node is still unhealthy", () => {
    // Measured 2026-09-27: one MISSING `)`, zero ERROR. An ERROR-only check calls this clean.
    const h = parseHealth(parseAL(wrap("        if (R > 1 then R := 2;")).rootNode);
    expect(h.errorNodes).toBe(0);
    expect(h.missingNodes).toBe(1);
  });

  test("offsets are UTF-16 code units, the same unit as .NET TextSpan", () => {
    const src =
      "codeunit 50000 X\n{\n    // æøå 😀\n    procedure P(): Integer\n    begin\n        exit(1 + 2);\n    end;\n}\n";
    let start = -1;
    const walk = (n: ReturnType<typeof parseAL>["rootNode"]): void => {
      if (n.type === "additive_expression") start = n.startIndex;
      for (const c of n.children) if (c !== null) walk(c);
    };
    walk(parseAL(src).rootNode);
    expect(start).toBe(src.indexOf("1 + 2"));
    expect(start).not.toBe(Buffer.byteLength(src.slice(0, src.indexOf("1 + 2"))));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/lib/grammar-crosscheck.test.ts`
Expected: FAIL, `Cannot find module './grammar-crosscheck'`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The comparison half of the issue #6 grammar cross-check (`scripts/probe-grammar-crosscheck.ts`),
 * kept apart from the CLI so it can be unit tested. No top-level body: importing this runs nothing.
 *
 * Scope, stated so no output overstates it: agreement here means agreement on the six audited
 * families and the two context probes, on files BOTH parsers read cleanly. Nothing more.
 */
import type { parseAL } from "../../packages/engine/src/ast/parser";

export interface Site {
  readonly file: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
}
export type Span = readonly [start: number, end: number];
export interface Delta {
  readonly site: Site;
  readonly treeSitter: number;
  readonly compiler: number;
}
export interface Split {
  readonly guarded: Delta[];
  readonly explained: Delta[];
  readonly unexplained: Delta[];
}
export interface SiteDiff {
  readonly onlyCompiler: Split;
  readonly onlyTreeSitter: Split;
}
export interface DiffOptions {
  readonly guardedSpans: ReadonlyMap<string, readonly Span[]>;
  readonly explained?: ReadonlySet<string>;
  readonly key?: (s: Site) => string;
}

/** Includes `end`: `A + B + C` nests two same-kind nodes that share a start (see 7c7d7a3). */
export const siteKey = (s: Site): string => `${s.file}|${s.kind}|${s.start}|${s.end}`;

/**
 * For context probes. No `end`: the compiler's statement span includes the trailing `;` and
 * tree-sitter's does not (measured). Two statement-position sites of one probe never share a start.
 */
export const contextKey = (s: Site): string => `${s.file}|${s.kind}|${s.start}`;

/** Drop every site in a file either parser could not read cleanly, on BOTH sides, before diffing. */
export function restrictToComparable(sites: readonly Site[], comparable: ReadonlySet<string>): Site[] {
  return sites.filter((s) => comparable.has(s.file));
}

/**
 * Multiset difference by key, split by direction. A delta inside a tree-sitter directive span is
 * `guarded` (R214), in either direction; else one whose key is in `explained` is `explained`; else
 * `unexplained`. A directive guards its span only, never the rest of its file.
 */
export function diffSites(ts: readonly Site[], cc: readonly Site[], opts: DiffOptions): SiteDiff {
  const keyOf = opts.key ?? siteKey;
  const counts = new Map<string, { site: Site; ts: number; cc: number }>();
  const bump = (s: Site, side: "ts" | "cc"): void => {
    const k = keyOf(s);
    const row = counts.get(k) ?? { site: s, ts: 0, cc: 0 };
    row[side]++;
    counts.set(k, row);
  };
  for (const s of ts) bump(s, "ts");
  for (const s of cc) bump(s, "cc");
  const inSpan = (s: Site): boolean =>
    (opts.guardedSpans.get(s.file) ?? []).some(([a, b]) => a <= s.start && s.end <= b);
  const out: SiteDiff = {
    onlyCompiler: { guarded: [], explained: [], unexplained: [] },
    onlyTreeSitter: { guarded: [], explained: [], unexplained: [] },
  };
  for (const [k, { site, ts: a, cc: b }] of counts) {
    if (a === b) continue;
    const split = b > a ? out.onlyCompiler : out.onlyTreeSitter;
    const bucket = inSpan(site)
      ? split.guarded
      : opts.explained?.has(k) === true
        ? split.explained
        : split.unexplained;
    bucket.push({ site, treeSitter: a, compiler: b });
  }
  return out;
}

/**
 * Throws when one side has two sites with the same key. Guards `contextKey`'s assumption that two
 * statement-position sites of one probe never share a start. If it ever fails, stop and look.
 */
export function assertUniqueKeys(
  sites: readonly Site[],
  key: (s: Site) => string,
  side: string,
): void {
  const seen = new Set<string>();
  for (const s of sites) {
    const k = key(s);
    if (seen.has(k)) throw new Error(`${side}: duplicate key ${k}`);
    seen.add(k);
  }
}

export type Verdict = "agree" | "disagree" | "unruled-mapping" | "inconclusive";
export const EXIT_CODE: Readonly<Record<Verdict, number>> = {
  agree: 0,
  disagree: 1,
  inconclusive: 2,
  "unruled-mapping": 3,
};

/**
 * The ONE verdict rule. Order matters: no comparable file, then an unruled mapping, then any delta.
 * Parse health is deliberately not an input: it is a warning, reported beside the verdict.
 */
export function verdict(input: {
  readonly comparableFiles: number;
  readonly diffs: readonly SiteDiff[];
  readonly unruledKinds: number;
}): Verdict {
  if (input.comparableFiles === 0) return "inconclusive";
  if (input.unruledKinds > 0) return "unruled-mapping";
  const any = input.diffs.some((d) =>
    [d.onlyCompiler, d.onlyTreeSitter].some(
      (s) => s.guarded.length + s.explained.length + s.unexplained.length > 0,
    ),
  );
  return any ? "disagree" : "agree";
}

/**
 * `--json <out>` may sit anywhere. Without it the args come back UNCHANGED: filtering on index
 * `jsonAt` when it is -1 would drop argument 0, the target (review r2).
 */
export function splitArgs(args: readonly string[]): {
  positional: string[];
  jsonOut: string | undefined;
} {
  const jsonAt = args.indexOf("--json");
  if (jsonAt < 0) return { positional: [...args], jsonOut: undefined };
  const jsonOut = args[jsonAt + 1];
  if (jsonOut === undefined || jsonOut === "") throw new Error("--json needs a path");
  return { positional: args.filter((_, i) => i !== jsonAt && i !== jsonAt + 1), jsonOut };
}

export type TsNode = ReturnType<typeof parseAL>["rootNode"];
export interface ParseHealth {
  readonly errorNodes: number;
  readonly missingNodes: number;
}

/**
 * ERROR and MISSING node counts. A MISSING node is NOT named "MISSING": it carries the type of the
 * token it stands in for (`)`, `}`), so only `isMissing` finds it.
 */
export function parseHealth(root: TsNode): ParseHealth {
  if (!root.hasError) return { errorNodes: 0, missingNodes: 0 };
  let errorNodes = 0;
  let missingNodes = 0;
  const walk = (n: TsNode): void => {
    if (n.type === "ERROR") errorNodes++;
    if (n.isMissing) missingNodes++;
    for (const c of n.children) if (c !== null) walk(c);
  };
  walk(root);
  return { errorNodes, missingNodes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/lib/grammar-crosscheck.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Red-check the load-bearing lines, one at a time, restoring after each**

(a) `siteKey`: drop `|${s.end}`. Expect "nested same-start chain" RED.
(b) `parseHealth`: delete `if (n.isMissing) missingNodes++;`. Expect "a MISSING node with no ERROR node" RED.
(c) `diffSites`: make `inSpan` return `false`. Expect "a directive span guards BOTH directions" RED.
(d) `diffSites`: make `inSpan` ignore the range (`(opts.guardedSpans.get(s.file) ?? []).length > 0`). Expect the same test RED on `outsideSpan`.
(e) `verdict`: delete the `comparableFiles === 0` line. Expect "no comparable file is inconclusive" RED.
(e2) `verdict`: swap the order of its first two checks. Expect the same test RED on its second assertion.
(e3) `verdict`: delete the `unruledKinds` line. Expect "an unruled compiler kind is its own verdict" RED.
(g) `splitArgs`: delete the `if (jsonAt < 0)` line. Expect "without --json the args are unchanged" RED.
(h) `assertUniqueKeys`: delete the `throw`. Expect "duplicate context keys fail loudly" RED.
(f) `contextKey`: add `|${s.end}`. Expect "context keys ignore the end offset" RED.
Record each red output for the commit message. The `mutation-red-checker` subagent may do this.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test scripts/ && bunx biome check scripts/lib/grammar-crosscheck.ts scripts/lib/grammar-crosscheck.test.ts
git add scripts/lib/grammar-crosscheck.ts scripts/lib/grammar-crosscheck.test.ts
git diff --cached --stat
git commit -m "test(issue-6): the cross-check's comparison as a tested module: health filter, positional context, both-way directive spans"
```

`bun test scripts/` also runs `importable-scripts.test.ts`, which must stay green.

---

### Task 2: Wire the harness to the module and fix D1 to D5

**Files:**
- Modify: `scripts/probe-grammar-crosscheck.ts`
- Modify: `scripts/lib/dump-compiler-kinds.ps1`

**Interfaces:**
- Consumes: everything Task 1 produces; `defaultAlToolPaths` from `packages/runner/src/publisher.ts` (returns `{ alcPath, altoolPath } | undefined`); `corpusEntries`, `fingerprintCorpus`, `describeFingerprint` from `scripts/corpus-fingerprint.ts` (guarded by `import.meta.main`, safe to import); `CONTEXT_PROBES` etc. from `./lib/al-kind-mapping`.
- Produces: CLI `bun scripts/probe-grammar-crosscheck.ts <file-or-dir> [alc-bin-dir] [grammar.wasm] [--json <out>]`. Exit codes from `EXIT_CODE`: 0 agree, 1 disagree, 2 inconclusive, 3 unruled-mapping. A usage error prints usage and exits 64. A file-count mismatch or a duplicate context key throws (non-zero, none of the four). The JSON (Tasks 4, 6, 7 read it):

```ts
{
  corpus: string; fingerprint: { files: number; sha256: string } | null; // null for a single file
  grammar: string; parserVersion: string; alcBin: string;
  files: { listed: number; treeSitterParsed: number; compilerParsed: number; comparable: number };
  verdict: "agree" | "disagree" | "unruled-mapping" | "inconclusive"; // from verdict() only
  exitCode: 0 | 1 | 2 | 3;                                              // EXIT_CODE[verdict]
  warnings: string[];                                                   // unhealthy files, one line each
  kindCounts: Record<string, { treeSitter: number; compiler: number }>; // comparable files only
  kinds: SiteDiff;                                                      // Site kinds are tree-sitter kinds
  context: Record<string, { diff: SiteDiff; totals: { treeSitter: number; compiler: number } }>;
  treeSitterUnhealthy: Array<{ file: string; errorNodes: number; missingNodes: number }>;
  compilerParseErrorFiles: string[];
  unmappedKinds: string[];
}
```

Paths, kinds, offsets and counts only. No source text.

- [ ] **Step 1: ps1 takes a file list and names its failing files**

In `dump-compiler-kinds.ps1` replace the parameters and the `$files = ...` block:

```powershell
param(
  [Parameter(Mandatory = $true)][string]$AlcBin,
  # One absolute .al path per line, built by the caller from `corpusEntries()` so both parsers
  # read exactly the files the corpus fingerprint names (.dependencies excluded, R187).
  [Parameter(Mandatory = $true)][string]$ListFile
)
...
$files = @(Get-Content -LiteralPath $ListFile | Where-Object { $_ -ne "" } | ForEach-Object { Get-Item -LiteralPath $_ })
```

Replace the `$parseErrors` integer with `$parseErrorFiles = New-Object System.Collections.Generic.List[string]`: `.Add($f.FullName)` where a null tree or an Error diagnostic was counted (a null tree still `continue`s). Nodes of a file with errors are still emitted: the TypeScript side drops them (C1), so the decision lives in one tested place. Emit `parseErrorFiles = $parseErrorFiles`, `parseErrors = $parseErrorFiles.Count` and `fileCount = $files.Count` in the final object.

Replace the header's offset sentence with: `Offsets are .NET TextSpan positions, i.e. UTF-16 code units, the same unit web-tree-sitter reports for a JS string. Measured equal on non-ASCII text 2026-09-27 (scripts/lib/grammar-crosscheck.test.ts).`

- [ ] **Step 2: File list, compiler path, identity, count assertion (D1, D3, D4)**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultAlToolPaths } from "../packages/runner/src/publisher";
import { corpusEntries, describeFingerprint, fingerprintCorpus } from "./corpus-fingerprint";

const { positional, jsonOut } = splitArgs(process.argv.slice(2)); // from ./lib/grammar-crosscheck
const [target, alcBinRaw, grammarWasm] = positional;
if (target === undefined) {
  console.error(
    "usage: bun scripts/probe-grammar-crosscheck.ts <file-or-dir> [alc-bin-dir] [grammar.wasm] [--json <out>]",
  );
  process.exit(64);
}
// An empty string means "not given", so a control can pass a grammar without a bin dir.
const alcBinArg = alcBinRaw !== undefined && alcBinRaw !== "" ? alcBinRaw : undefined;
// R167: newest installed AL extension that actually has the tools, not a hardcoded version.
const found = alcBinArg === undefined ? await defaultAlToolPaths() : undefined;
const alcBin = alcBinArg ?? (found !== undefined ? dirname(found.alcPath) : undefined);
if (alcBin === undefined) throw new Error("no AL Language extension with alc found; pass [alc-bin-dir]");

const isDir = (await stat(target)).isDirectory();
const fp = isDir ? await fingerprintCorpus(target) : null;
if (fp !== null) console.log(describeFingerprint(target, fp)); // FIRST output line (R187)
const files = isDir ? (await corpusEntries(target)).map((rel) => resolve(join(target, rel))) : [resolve(target)];
const listFile = join(mkdtempSync(join(tmpdir(), "gh06-")), "files.txt");
writeFileSync(listFile, files.join("\n"));
```

Replace the existing `target === undefined` usage check with the one above. Delete `DEFAULT_ALC_BIN` and `alFiles()`. Pass `-ListFile listFile` to the ps1 instead of `-Path`. Print `alc bin: <alcBin>` beside the parser version.

After both sides ran, fail loudly on any count mismatch (a caller-contract violation, never a default):

```ts
const expected = fp?.files ?? 1;
if (files.length !== expected || treeSitterParsed !== expected || compiled.fileCount !== expected) {
  throw new Error(
    `file-count mismatch: fingerprint ${expected}, listed ${files.length}, tree-sitter parsed ${treeSitterParsed}, compiler parsed ${compiled.fileCount}`,
  );
}
```

`treeSitterParsed` is the number of files `treeSitterSites` walked; `compiled.fileCount` comes from the ps1 JSON.

- [ ] **Step 3: Health filter before the diff (C1, D2)**

In `treeSitterSites`, replace the `dirty` flag with `const health = parseHealth(tree.rootNode)` (compute it before `tree.delete()`), and record `{ file, errorNodes, missingNodes }` when their sum is above 0. Then:

```ts
const bad = new Set([...unhealthy.map((u) => u.file), ...compiled.parseErrorFiles.map((f) => resolve(f))]);
const comparable = new Set(files.filter((f) => !bad.has(f)));
const tsKinds = restrictToComparable(ts, comparable);
const ccKinds = restrictToComparable(cc, comparable);
```

Every count printed from here on (kind table, context totals) is over `comparable` only. Print, before the tables: `files: listed N, comparable M (tree-sitter unhealthy A, compiler parse errors B, both C)`.

- [ ] **Step 4: Directive spans both ways (D5) and positional context (C2)**

- Replace `guardedKeys` with `guardedSpans: Map<string, Span[]>`: in the walk, when `n.rawKind.startsWith("preproc_conditional")`, push `[n.startIndex, n.endIndex]` for that file. Keep the existing comment on why the prefix matters. Delete the `nowGuarded` propagation.
- Context sites, tree-sitter side: for each probe, a node of `probe.treeSitterKind` with `isStatementSlot(n)` true becomes `Site { file, kind: probe.name, start, end }`. Separately, every node of `probe.treeSitterKind` whose `parent?.rawKind === "asserterror_statement"` adds `contextKey({ file, kind: probe.name, start, end })` to that probe's `explained` set (R216).
- Context sites, compiler side: a node whose kind is in `probe.compilerKinds` and whose parent matches `probe.compilerParentKind` (when set) becomes `Site { file: resolve(n.file), kind: probe.name, start, end }`. Delete the global `ccContext`/`tsContext` maps.
- Per probe: `diffSites(restrictToComparable(tsCtx, comparable), restrictToComparable(ccCtx, comparable), { guardedSpans, explained, key: contextKey })`.
- Kinds: `diffSites(tsKinds, ccKinds, { guardedSpans })`.
- Print per probe: totals (labelled "summary only, not evidence of agreement"), then `only compiler: guarded G, explained-asserterror E, UNEXPLAINED U` and the same for tree-sitter, listing up to 60 unexplained `file|probe|start`.
- Print for kinds the same three buckets per direction, up to 60 unexplained keys each.
- Before diffing each probe: `assertUniqueKeys(tsCtx, contextKey, "tree-sitter")` and `assertUniqueKeys(ccCtx, contextKey, "compiler")`.
- `const v = verdict({ comparableFiles: comparable.size, diffs: [kinds, ...Object.values(context).map((c) => c.diff)], unruledKinds: unmappedKinds.length })`. Nothing else decides the outcome: delete the old `agreed` expression. Last line, one per verdict: `AGREE on the six audited families and two context probes, over M comparable file(s).` / `DISAGREE, see above.` / `UNRULED MAPPING: N compiler kind(s) neither mapped nor ruled; the audit is not complete.` / `INCONCLUSIVE: no file both parsers read cleanly.` Then `process.exit(EXIT_CODE[v])`, after writing the JSON.
- Warnings: each unhealthy file (either parser) becomes one line `WARNING: <file> excluded (tree-sitter ERROR a MISSING b | compiler parse error)`, printed before the last line and written to JSON `warnings`. They do not change `v`. Keep the existing unruled-kinds listing block.
- If `jsonOut` is set, `await Bun.write(jsonOut, JSON.stringify(report, null, 2))` with the shape above.

- [ ] **Step 5: Validate against the validation files and the fixtures (no reference corpus)**

```bash
bun run typecheck && rm -rf packages/*/dist
S="<session scratchpad>"
for t in scripts/lib/al-kind-mapping-fixture.al scripts/lib/al-kind-mapping-linkprobe.al scripts/lib/al-kind-mapping-stress.al fixtures; do
  bun scripts/probe-grammar-crosscheck.ts "$t" --json "$S/gh06-$(basename $t).json" > "$S/gh06-$(basename $t).txt"; echo "$t exit $?"
done
```

Expected, against the drafting table: `fixture` exit 0; `linkprobe` exit 0; `stress` exit 1 with exactly one delta, kinds `onlyTreeSitter.guarded` = 1 `multiplicative_expression`, everything else empty; `fixtures` first line `corpus: fixtures ... 68 .al file(s)`, `comparable 68`, six kind counts equal to the drafting table, call-probe totals 482 vs 491. Also check each JSON's `verdict` and `exitCode` against the echoed exit: fixture `agree`/0, linkprobe `agree`/0, stress `disagree`/1. Then run the fixture once WITHOUT `--json` (`bun scripts/probe-grammar-crosscheck.ts scripts/lib/al-kind-mapping-fixture.al; echo $?`): expected the same AGREE line and exit 0. That is the harness-level test of the no-`--json` form. If any kind count moves, STOP: the refactor changed what is measured.

Harness check of the `unruled-mapping` branch: write `$S/um/InList.al`, a codeunit whose procedure does `if R in [1, 2] then exit(1);`, temporarily delete `"InListExpression"` from `DELIBERATELY_UNMAPPED`, and run with `--json "$S/um.json"`. Expected: last line `UNRULED MAPPING: 1 ...`, exit 3, JSON `verdict` `unruled-mapping` and `exitCode` 3. Restore the entry and re-run: expected `agree`, exit 0. The fixtures' 9-call gap now appears as positions; record how many are `explained` (asserterror) and how many `unexplained`. Do not triage them yet; they are Task 5's first prediction.

- [ ] **Step 6: Red-check D3 on a hand-made scratch corpus**

```bash
mkdir -p "$S/d3/.dependencies"
printf 'codeunit 50000 A\n{\n    procedure P()\n    begin\n    end;\n}\n' > "$S/d3/A.Codeunit.al"
printf 'codeunit 50001 B\n{\n    procedure P()\n    begin\n    end;\n}\n' > "$S/d3/.dependencies/B.Codeunit.al"
bun scripts/probe-grammar-crosscheck.ts "$S/d3"; echo "exit $?"
```

Expected: first line names 1 file, `comparable 1`, exit 0. Then temporarily build `files` with an unfiltered recursive `readdir` instead of `corpusEntries`, re-run: expected a thrown `file-count mismatch: fingerprint 1, listed 2, tree-sitter parsed 2, compiler parsed 2`. Restore. Record both outputs.

- [ ] **Step 7: Red-check C1 on a hand-made scratch file**

Copy `al-kind-mapping-fixture.al` to `$S/c1/Good.al` and write `$S/c1/Bad.al`: one procedure with the Task 1 MISSING body (`if (R > 1 then R := 2;`), a second procedure with `exit(1 + 2);`. Run with `--json "$S/c1.json"`. Expected: `comparable 1`, one WARNING naming `Bad.al` (1 MISSING), verdict `agree`, exit 0, and `kindCounts.additive_expression` equal to Good.al's alone (2 on each side).

Now remove the `restrictToComparable` calls and re-run. The check is NON-VACUOUS only if this second run's JSON differs: `kindCounts.additive_expression` above 2, or any delta, or a different verdict. Record both JSON excerpts. If the two runs are identical, the scratch input does not exercise the filter: change `Bad.al` (more sites, or a construct where the two parsers recover differently) until they differ. C1 is NOT red-checked until they do; the Task 1 unit test cannot stand in, because it cannot show the harness calls the helper. Restore.

Then the zero-comparable branch at harness level: run on `$S/c1/Bad.al` alone. Expected: `INCONCLUSIVE`, exit 2, JSON `verdict` `inconclusive`.

- [ ] **Step 8: Lint and commit**

```bash
bunx biome check scripts/probe-grammar-crosscheck.ts
git add scripts/probe-grammar-crosscheck.ts scripts/lib/dump-compiler-kinds.ps1
git diff --cached --stat
git commit -m "fix(issue-6): the cross-check finds alc by R167, reads the fingerprinted file list, drops unhealthy files from both sides, compares context by position"
```

---

### Task 3: `probe-grammar-corpus.ts` counts MISSING nodes (D2, second instance)

**Files:**
- Modify: `scripts/probe-grammar-corpus.ts` (the walk around lines 66 to 90)

**Interfaces:**
- Consumes: `parseHealth` from `./lib/grammar-crosscheck`.

- [ ] **Step 1: Replace the unreachable branch**

Keep the parsed tree: `const tree = parseAL(source); root = wrapRoot(tree);`. Delete the `else if (n.rawKind === "MISSING") { missingNodes++; }` branch and set `missingNodes = parseHealth(tree.rootNode).missingNodes` after the walk. Keep `errorNodes`/`worstErrorBytes` as is. Add one comment line: `// A MISSING node carries the missing token's type, never "MISSING"; see parseHealth.`

- [ ] **Step 2: Show it changed something**

Scratch dir `$S/d2` holding one file with the Task 1 MISSING body. Run `bun run scripts/probe-grammar-corpus.ts "$S/d2"` before the change (`git stash` the edit) and after. Expected: missing 0 before, 1 after. Record both in the commit message.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
bun run typecheck && rm -rf packages/*/dist && bunx biome check scripts/probe-grammar-corpus.ts
git add scripts/probe-grammar-corpus.ts
git diff --cached --stat
git commit -m "fix: probe-grammar-corpus counted MISSING nodes by a type name they never have"
```

---

### Task 4: End-to-end positive control on two known-bad grammars

Task 1 tests the diff on invented sites. This task proves the whole chain (tree-sitter enumeration, compiler dump, mapping, health filter, diff) reports a REAL grammar defect as UNEXPLAINED, in each direction. Expected deltas are written into the pre-commitment (Task 5) BEFORE the controls run; this task only prepares the inputs and runs them after Task 5 is committed. It runs no reference corpus.

**Files:**
- Create: `scripts/lib/al-kind-mapping-continue.al` (hand-written)

- [ ] **Step 1: Extract the two old grammars (no build needed)**

The grammar repo checks its wasm in at each tag:

```bash
git -C U:/Git/tree-sitter-al show v3.2.1:tree-sitter-al.wasm > "$S/ts-3.2.1.wasm"
git -C U:/Git/tree-sitter-al show v4.0.1:tree-sitter-al.wasm > "$S/ts-4.0.1.wasm"
```

The vendor README notes the checked-in wasm at a tag is close to, not byte-identical with, a local build. For a control that is enough. Nothing is rebuilt: Task 5's control rule says what happens if one of them does not behave as predicted.

- [ ] **Step 2: Write the compiler-only control file**

`v4.0.1` (upstream #22, fixed in 4.2.0) parsed a call to a procedure named `Continue` as `continue_statement`, with zero error nodes. So under 4.0.1 the compiler sees a call that tree-sitter does not: a compiler-only `call_expression` and a compiler-only statement-position call.

```al
codeunit 50002 "Continue Probe"
{
    procedure Caller(Value: Integer)
    begin
        Continue(Value);
    end;

    local procedure Continue(Value: Integer)
    begin
    end;
}
```

Save as `scripts/lib/al-kind-mapping-continue.al`. Check before Task 5 that the CURRENT grammar agrees on it (it is not a reference corpus): `bun scripts/probe-grammar-crosscheck.ts scripts/lib/al-kind-mapping-continue.al`, expected exit 0 with 1 `call_expression` both sides and call-probe 1/1. If `alc`'s parser reports an error on it (for example if `Continue` is a reserved word for this parser version), record that, pick another way to call it that the compiler accepts, and re-check. Record the file's exact offsets of `Continue(Value)` for the prediction.

- [ ] **Step 3 (after Task 5 is committed): Run the controls**

```bash
bun scripts/probe-grammar-crosscheck.ts scripts/lib/al-kind-mapping-linkprobe.al "" "$S/ts-3.2.1.wasm" --json "$S/gh06-ctl-linkprobe-3.2.1.json" > "$S/gh06-ctl-linkprobe-3.2.1.txt"; echo "exit $?"
bun scripts/probe-grammar-crosscheck.ts scripts/lib/al-kind-mapping-continue.al "" "$S/ts-4.0.1.wasm" --json "$S/gh06-ctl-continue-4.0.1.json" > "$S/gh06-ctl-continue-4.0.1.txt"; echo "exit $?"
bun scripts/probe-grammar-crosscheck.ts scripts/lib/al-kind-mapping-linkprobe.al --json "$S/gh06-ctl-linkprobe-now.json"; echo "exit $?"
bun scripts/probe-grammar-crosscheck.ts scripts/lib/al-kind-mapping-continue.al --json "$S/gh06-ctl-continue-now.json"; echo "exit $?"
```

The second positional argument is the alc bin dir; Task 2's CLI treats an empty string as "not given". Apply the pre-committed control rule (Task 5). Its outcome blocks or releases Task 6 Step 2.

- [ ] **Step 4: Commit the control file**

```bash
git add scripts/lib/al-kind-mapping-continue.al
git diff --cached --stat
git commit -m "test(issue-6): a Continue-call control for the compiler-only direction"
```

---

### Task 5: Pre-commitment, committed before any reference-corpus run and before the controls

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-gh06-crosscheck-precommitment.md`

- [ ] **Step 1: Write the pre-commitment with this content (fill the bracketed values from Tasks 2 and 4)**

```markdown
# Pre-commitment: GH-06, tree-sitter-al 4.3.0 against the AL compiler parser

Written and committed BEFORE the positive controls and the reference-corpus runs. Nothing above
"Measured" is edited after. Plan: docs/superpowers/plans/2026-09-27-GH-06-tree-sitter-vs-compiler-ast.md.
Issue: GitHub #6.

## Instrument
scripts/probe-grammar-crosscheck.ts at commit [Task 2 commit], grammar vendored 4.3.0, compiler
parser as printed (v18.0.41.45789 at drafting), alc bin as printed.

## Scope of every claim below
Agreement or "no blind spot" means: none in the six audited families (comparison, additive,
multiplicative, logical, unary, call) and the two context probes (call and assignment in statement
position), on COMPARABLE files. Literals, `in`, `as`/`is`, the conditional expression, member
access and array index are not audited. A corpus where no file is comparable is INCONCLUSIVE.

## Positive controls (must pass before any corpus result is read)
| grammar | file | predicted |
| --- | --- | --- |
| v3.2.1 (checked-in wasm at tag) | al-kind-mapping-linkprobe.al | control A: comparable 1; kinds onlyTreeSitter.UNEXPLAINED = comparison_expression [218,247] and call_expression [235,247] (as measured by 84b2194); nothing else; verdict disagree. |
| v4.0.1 (checked-in wasm at tag) | al-kind-mapping-continue.al | control B: comparable 1; kinds onlyCompiler.UNEXPLAINED = call_expression [start,end of `Continue(Value)`]; call-probe onlyCompiler.UNEXPLAINED at [start]; nothing else. |
| vendored 4.3.0 | both files | agree, exit 0. |

Control rule, applied mechanically:
- v3.2.1 reads linkprobe cleanly AND matches its row: control A PROVEN.
- linkprobe is unhealthy under v3.2.1 (verdict inconclusive): control A is unusable, and control B
  matching its row ALONE suffices. v3.2.1 is NOT rebuilt.
- v3.2.1 reads linkprobe cleanly but does NOT match its row: control A FAILED. STOP and find why.
- If NEITHER control produces its expected delta: STOP and report the check UNPROVEN. No corpus
  result is read or published.
- Both 4.3.0 rows must be agree, exit 0, in every case.

## Corpus (identity is the hash, printed first by the harness)
| path | files expected |
| --- | ---: |
| fixtures/ | 68 |
| U:/Git/do-rel2/Cloud (reference corpus; do-lethal/Cloud is the SAME hash, not run) | 417 |
| U:/Git/DC/Cloud | 475 |
| U:/Git/BusinessCentral.Sentinel | 67 |
| U:/Git/BC.History/BusinessFoundation | [corpusEntries count] |
| U:/Git/BC.History/System Application | [corpusEntries count] |
| U:/Git/BC.History/BaseApp | [corpusEntries count] |
A hash differing from docs/measurements/README.md for the first three is recorded, not a stop.
(BC.History counts are taken with `bun scripts/corpus-fingerprint.ts <dir>`, which reads no parse
output and is allowed before this commit.)

## Comparison unit
Kinds: per file, the multiset of (kind, start, end) over the six audited tree-sitter kinds, after
mapping compiler kinds through al-kind-mapping.ts. Context: per probe, the multiset of
(file, start) of statement-position sites; per-file and per-corpus totals are summaries only.
Health: tree-sitter ERROR and MISSING nodes, compiler diagnostics of severity Error.

## Rules (decided now, not after reading the output)
- R1 Comparable files: a file where EITHER parser reports an error is removed from BOTH site lists
  before diffing. It is listed under parse health. The comparable count is reported per corpus.
- R2 Directive: a delta inside a tree-sitter preproc_conditional* span is R214, counted, not a
  finding. A span guards itself only, never the rest of its file.
- R3 asserterror: a compiler-only context delta at the start of a tree-sitter node of the probe's
  kind whose parent is asserterror_statement is R216. Matched by position, never by count.
- R4 Unmapped kinds: an unruled compiler *Expression kind makes the verdict unruled-mapping
  (exit 3), never agree. It is a MAPPING gap, ruled in al-kind-mapping.ts with a reason, never a
  grammar finding. The corpus is re-run after a ruling.
- R5 Verdict: agree only when comparable files > 0, no delta in any bucket, and no unruled kind.
  Unhealthy files are warnings and never change it.
Everything else is UNEXPLAINED and is triaged.

## Triage
Group unexplained deltas into CLUSTERS by (direction, kinds or probe, construct). The construct is
named by reading the source locally and is written up ONLY as a hand-written minimal AL file that
reproduces the same delta on both parsers. A position-verified corpus cluster that will NOT minimise
is never dropped: it becomes an UNRESOLVED roadmap item carrying its positions (file, offsets,
kinds), its counts and a stated risk. Clusters over 20 sites: read a stride sample of 20, and
assign every site by a mechanical rule written down with the cluster.

## What earns a roadmap item (one item per cluster)
- OVER-CLAIM (tree-sitter only, kinds or context): at least ONE site in the cluster's hand-written
  reproduction survives the filtered planning pipeline (scripts/census-fixture-mutants.ts:
  targets, generate, validateSpec, isMutableSite, dedupe, carrier), matched to the reproduction's
  site by line AND exact before-text. A NEGATIVE match is not proof: every census line on that
  line is inspected and the reason each does not match is written down. An over-claim cluster
  that will not minimise is an UNRESOLVED item (see Triage) with risk "may deploy". Section correctness-risks. Nothing survives: findings doc
  only, plus an upstream grammar issue if the grammar mis-shapes the construct.
- BLIND SPOT (compiler only, kinds): at least ONE site inside a procedure or trigger body.
  Section product-gaps. Declarative-only: findings doc only.
- CONTEXT (compiler only, context): traced to a container not in SINGLE_STATEMENT_SLOTS. One item
  per container, linking R217. Section product-gaps.
- PARSE HEALTH: a construct that makes tree-sitter report ERROR or MISSING on a file the compiler
  parses without error. One item per construct. Section correctness-risks. (These files are
  excluded from the site diff by R1, so this channel is where their losses are counted.)
- Zero clusters is a valid result, recorded with the scope sentence above. It closes issue #6
  with no new item.

## Predictions
- Controls: as in the table.
- fixtures/: six kinds agree; the 9-position call-probe gap is [Task 2 Step 5: E explained, U
  unexplained]; predicted U = 0. If not, the fixture gap is the first triage item.
- BC.History parts: over-claims only under R2; the R215 and #20 to #23 shapes at ZERO.
- No reference corpus produces an over-claim that survives the filtered pipeline.

## Measured
(filled after the runs, below this line only)
```

- [ ] **Step 2: Commit it on its own**

```bash
git add docs/superpowers/specs/2026-09-27-gh06-crosscheck-precommitment.md
git diff --cached --stat
git commit -m "precommit(issue-6): what counts as a grammar blind spot, and the controls' expected deltas, before any run"
```

---

### Task 6: The runs (controls first, then corpora)

**Files:** none committed. All output to the session scratchpad.

- [ ] **Step 1: Run the positive controls** (Task 4 Step 3) and apply the pre-committed control rule exactly: A proven, or A unusable (linkprobe unhealthy under v3.2.1) and B proven; both 4.3.0 runs agree. Any other outcome: STOP. If neither control produced its delta, report the check UNPROVEN to the orchestrator. v3.2.1 is not rebuilt.

- [ ] **Step 2: Run each corpus, foreground, one at a time**

```bash
run() { bun scripts/probe-grammar-crosscheck.ts "$1" --json "$S/gh06-$2.json" > "$S/gh06-$2.txt" 2>&1; echo "$2 exit $?"; head -3 "$S/gh06-$2.txt"; }
run fixtures fixtures
run U:/Git/do-rel2/Cloud do
run U:/Git/DC/Cloud dc
run U:/Git/BusinessCentral.Sentinel sentinel
run U:/Git/BC.History/BusinessFoundation bcf
run "U:/Git/BC.History/System Application" sysapp
run U:/Git/BC.History/BaseApp baseapp
```

Allow 10 minutes each (`timeout: 600000`). If `spawnSync` overflows its 512 MB buffer on BaseApp, run BaseApp's top-level subfolders one by one and record the split. Exit 1 or 2 is a result; a thrown error (including a file-count mismatch) is a failure to fix before continuing.

- [ ] **Step 3: Unmapped kinds (R4)**

If any run prints `UNRULED compiler expression kinds`, rule each in `DELIBERATELY_UNMAPPED` with a one-line reason in the existing style (refusal or deferral), commit that alone (`git add scripts/lib/al-kind-mapping.ts`, inspect, `fix(issue-6): rule <kinds>`), and re-run the affected corpus.

---

### Task 7: Triage and over-claim verification

**Files:** none committed here (reproductions are committed in Task 9 only if an item cites them).

- [ ] **Step 1: Collect**

From each JSON: `kinds.onlyCompiler.unexplained`, `kinds.onlyTreeSitter.unexplained`, each probe's `diff.onlyCompiler.unexplained` and `diff.onlyTreeSitter.unexplained`, and `treeSitterUnhealthy` files not in `compilerParseErrorFiles`. Group into clusters per the pre-commitment.

- [ ] **Step 2: Reproduce each cluster by hand**

For each cluster, write a minimal AL object in `$S/repro-<n>/` from scratch, in your own words (object ids 50000 to 50099, invented names), with each suspected site on its own line. Never paste corpus text. Run the harness on the file and confirm the same delta class appears. A cluster that will not minimise is NOT dropped: it gets an UNRESOLVED roadmap item in Task 9, carrying its positions (corpus path, file path, offsets, kinds), its counts, what was tried, and its risk (over-claim: "may deploy a mutant at a non-site"; blind spot: "may lose sites"). Positions and kinds only, never the corpus text.

- [ ] **Step 3: Over-claims through the filtered pipeline**

For each over-claim cluster: `bun scripts/census-fixture-mutants.ts "$S/repro-<n>" > "$S/repro-<n>.census.txt"`. That script mirrors `generateMutationSet` in `packages/runner/src/orchestrator.ts` (targets, generate, validateSpec, isMutableSite, dedupe, carrier). A site counts as claimed when a line `<file>:<line> <operator> | <before> => ...` has the reproduction site's line AND its `before` equals the site's exact text in the hand-written file, with no `[DISPLACED]` or `[NOT-CARRIER]` mark. A NEGATIVE result is not proof on its own: the script prints `spec.before.text`, which need not be the exact node the grammar mis-shaped. Read every census line on that line of the reproduction and write down why each does not match (different span, different operator, displaced). Do NOT use `census-operator-sites.ts`: it skips `isMutableSite` (R215's mistake) and includes `.dependencies`. Its output would also carry corpus text.

- [ ] **Step 4: Blind spots: executable or declarative**

For each compiler-only kinds cluster, read the sites locally and record whether each lies inside a procedure or trigger body. Record the rule used if the cluster was sampled.

---

### Task 8: Findings document

**Files:**
- Create: `docs/measurements/2026-09-27-gh06-grammar-crosscheck.md`
- Modify: `docs/superpowers/specs/2026-09-27-gh06-crosscheck-precommitment.md` ("Measured" section only)

- [ ] **Step 1: Write the findings**

Sections, in this order:
1. **Result in one paragraph**, opening with the scope sentence: "On the six audited families and two context probes, over M comparable files of N ..." Then clusters found, items filed, predictions held or not.
2. **Instrument**: commits, grammar 4.3.0, compiler parser version, alc bin, the Task 6 command.
3. **Positive controls**: predicted vs measured, all four.
4. **Corpus table**: path, files, sha256 (first 16), comparable files, tree-sitter unhealthy (ERROR and MISSING separately), compiler parse-error files, verdict.
5. **Per-kind table per corpus**, comparable files only.
6. **Deltas per corpus**: each direction split guarded / explained / unexplained, kinds and each probe.
7. **Clusters**: one subsection each with direction, kinds or probe, count, the hand-written reproduction, the pipeline check result, and the roadmap id or "no item, because ...".
8. **Corrections to earlier claims**: D1 to D5, the false ASCII-only offset limit, and the r1 plan's per-file context idea (why positions replaced it).
9. **What this does not cover**: every `DELIBERATELY_UNMAPPED` deferral by name, and the unhealthy files' sites, which were not compared.

Counts, paths, kinds, offsets and hand-written AL only.

- [ ] **Step 2: Fill the pre-commitment's "Measured" section**: one table, prediction vs measured, pointer to the findings.

- [ ] **Step 3: Commit, inspecting for corpus text**

```bash
git add docs/measurements/2026-09-27-gh06-grammar-crosscheck.md docs/superpowers/specs/2026-09-27-gh06-crosscheck-precommitment.md
git diff --cached --stat
git diff --cached
```

Read the staged diff. Every AL line in it must be from a hand-written reproduction. Then:

```bash
git commit -m "measure(issue-6): tree-sitter-al 4.3.0 vs the AL compiler parser, <M> comparable files"
```

---

### Task 9: Roadmap items, regenerate

**Files:**
- Create: `docs/roadmap/R<nnn>.md` per cluster that earned an item
- Create (optional): `scripts/lib/al-kind-mapping-<name>.al` per reproduction an item cites
- Modify: `ROADMAP.md` (generated only)

- [ ] **Step 1: Next free id, immediately before EACH file**

Run: `ls docs/roadmap/ | sort | tail -3`. Take the next number after the highest.

- [ ] **Step 2: Write each item**

~~~markdown
---
id: "R<nnn>"
title: "<one line: the construct, the direction, the cost>"
section: "<correctness-risks | product-gaps>"
order: <highest order in that section + 1>
status: "open, filed 2026-09-27, measured by the issue #6 cross-check"
---

**Found by the issue #6 cross-check** (`docs/measurements/2026-09-27-gh06-grammar-crosscheck.md`, cluster <n>).

**What happens.** <direction, kind or probe, what the grammar or the predicate does>

**Minimal reproduction** (hand-written, not corpus source; for an UNRESOLVED item, replace this block with the corpus positions, offsets and kinds, what was tried, and the risk):
```al
<the Task 7 Step 2 file>
```

**Measured.** <count per corpus; pipeline check result for an over-claim>

**Reproduce.** `bun scripts/probe-grammar-crosscheck.ts <repro file>`
~~~

- [ ] **Step 3: Regenerate and check**

```bash
bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit with explicit paths**

```bash
git add docs/roadmap/R<nnn>.md ROADMAP.md          # list each new R file by name; add each cited .al by name
git diff --cached --stat
git diff --cached
git commit -m "roadmap: file <ids> from the issue #6 cross-check"
```

Closing GitHub issue #6 happens with the integrated commit, per the coord task. The closing comment links the findings doc, repeats its scope sentence, and lists the new ids (or says none were needed).

---

## Self-review notes

- Review r1, Critical C1: Task 1 (`restrictToComparable`, `verdict`), Task 2 Steps 3 and 7, pre-commitment R1. Critical C2: Task 1 context tests, Task 2 Step 4, pre-commitment "Comparison unit" and R2/R3. Important items: D3 wording and `census-operator-sites.ts` caveat (Defects list, Task 7 Step 3); scope of "zero" (intro, module header, verdict line, pre-commitment, findings section 1); positive control (Task 4, pre-commitment table); pipeline check (Task 7 Step 3); confidentiality and staging (Global Constraints, every commit step, Task 8 Step 3). Minor: D3 red-check asserts both parsers' counts (Task 2 Steps 2 and 6); no reference corpus before Task 5 (Global Constraints, Task 4 ordering).
- Names across tasks: `Site`, `Span`, `Delta`, `Split`, `SiteDiff`, `DiffOptions`, `siteKey`, `contextKey`, `restrictToComparable`, `assertUniqueKeys`, `diffSites`, `Verdict`, `verdict`, `EXIT_CODE`, `splitArgs`, `TsNode`, `ParseHealth`, `parseHealth`, all defined in Task 1.
- Execution order: Tasks 1, 2, 3, then Task 4 Steps 1 and 2, then Task 5 (commit), then Task 4 Steps 3 and 4 with Task 6 Step 1, then Tasks 6 to 9.

## Rulings recorded (from the orchestrator, 2026-09-27)

1. Literals: not added.
2. Positive control: yes, Task 4.
3. Inviting the issue author: an owner decision, not a plan step.
4. The `probe-grammar-corpus.ts` MISSING fix: here, Task 3.
5. The script is kept and is not a gate.

Review r2: CLI split (Task 1 `splitArgs`, Task 2 Steps 2 and 5); control rule A, else B, else STOP UNPROVEN, no rebuild (Task 5, Task 4 Step 3, Task 6 Step 1); one verdict rule with `unruled-mapping` (Task 1, Task 2 Steps 4, 5 and 7, pre-commitment R4 and R5); unminimisable clusters become UNRESOLVED items (pre-commitment Triage, Task 7 Step 2, Task 9); duplicate context keys (Task 1, Task 2 Step 4); non-vacuous harness health-filter red-check (Task 2 Step 7); negative census match inspected (pre-commitment, Task 7 Step 3).

No open questions remain.
