# DO Live Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run LethAL end to end against Continia Document Output on a fresh Continia environment, in four gated rungs, ending with a separate `claude -p` agent reading the real report and trying to kill survivors.

**Architecture:** Tasks 1–4 build the offline tooling the gates need (a compile-only driver, a pure anchors/oracle module, a record-freezing driver, an agent fence hook), each with real tests. Tasks 5–8 execute the four rungs, each gated on a pre-committed file written *before* the run. No rung starts until the one below it passed.

**Tech Stack:** Bun + TypeScript, `bun:test`, tree-sitter-al, `alc.exe` 17, Continia `continia.exe` CLI, BC 28 hosted environment, `claude -p`.

**Spec:** `docs/superpowers/specs/2026-08-03-do-live-campaign-design.md` (`90b7ead`). Read it before starting — this plan implements it and does not restate its reasoning.

## Global Constraints

- **No `!` non-null assertions** — biome `noNonNullAssertion: error`. Destructure, then check `undefined`.
- **`exactOptionalPropertyTypes`** — build optional props with `...(v !== undefined ? { k: v } : {})`.
- **Typed error classes extend `Error` directly, never each other.** `AlcCompileError` (deterministic alc rejection) vs `ArtifactPrepareError` (spawn/IO/hash/manifest). Bisection reads ONLY `AlcCompileError` as "subset does not compile".
- **Build order:** `bun run typecheck` → `rm -rf packages/*/dist` → `bun test`. The dist trap causes ~21 phantom failures otherwise.
- **Lint only what you touched:** `bunx biome check <paths>`. A repo-wide `biome check .` is pre-existing noise.
- **Git bash on Windows, Windows paths.** Never `2>nul` — use `2>/dev/null`.
- **Fail loudly on caller-contract violations.** Throw; never return a plausible empty default. Empty-vs-empty "matches" is this project's signature bug.
- **Every live rung writes its pre-commitment to a file BEFORE the run**, and that file is committed.
- **Never pass `--retry-stranded` during a gated run.**
- **Before every live rung, confirm the environment reports `Running`** — `./CLI/continia.exe env get <envId>`. R34: an environment that idled to `Stopped` makes the run abort at a dead endpoint, and "assumed running" costs a confusing failure every time.
- **Recovery, when a quarantine does happen:** the `recover-tier` skill — `env stop`, `env start`, **wait for `Running`**, `force-reset-lease`, `clear-quarantine`. A restart alone clears neither piece of state: the quarantine record is a local file, the op marker is a row in the environment's database.

## File Structure

| path | responsibility |
|---|---|
| `scripts/campaign/compile-only.ts` | **New.** Validate selector ids, generate the mutation set, write the instrumented project, compile it with `alc` — no publish. Gate-0 item 5. |
| `packages/runner/src/campaign-anchors.ts` | **New.** Pure functions: the four rung-1 anchors, the cardinality assertion, and the independent `notInstrumented` oracle. No I/O. |
| `packages/runner/tests/campaign-anchors.test.ts` | **New.** Unit tests for the above, including the ones that must FAIL on an empty report. |
| `scripts/campaign/freeze.ts` | **New.** Archive a rung's report + per-mutant baseline outside the worktree, reusing `assertMatchesBaseline`. |
| `docs/campaign/2026-08-03-do/` | **New dir.** Committed campaign records: pre-commitments, frozen baselines, archived reports, the run manifest. |
| `fixtures/do-campaign/settings.json` | **New.** `claude -p` settings carrying the rung-3 `PreToolUse` fence hook. |
| `fixtures/do-campaign/fence-hook.ts` | **New.** The fence itself: deny writes outside the worktree, deny `lethal run` without `--only` **and** `--tests-only`. |
| `packages/runner/src/campaign-anchors-run.ts` | **New (review fix C3).** The I/O half of the anchor gate: strict config parsing, cardinality, anchors, the rung-2 reconciliation. |
| `scripts/campaign/anchors.ts` | **New (review fix C3).** The missing driver. Prints every anchor and **exits non-zero if any fails**. |
| `packages/runner/src/campaign-fence.ts` | **New (review fix C2/I4).** The fence's decision logic, pure and `cwd`-injectable, so the probe matrix is a committed test. |
| `packages/runner/tests/campaign-fence.test.ts` | **New (review fix C2/I4).** The 44-case probe matrix, executable. |
| `fixtures/do-campaign/fence-probe-matrix.md` | **New (review fix I4).** The matrix, bypass history and accepted residuals, in git rather than in a gitignored session ledger. |

**As landed — where the code differs from the snippets below.** Tasks 1–4 shipped, then a
whole-branch review changed four of them. The embedded snippets are the plan as written, not the
code as it exists; read the files, and treat these four as the authority:

1. **Task 1 — `checkAnchors(verified, cfg)`.** Its first parameter is now a `CardinalityVerifiedReport`, which only `assertCardinality` can produce (it throws instead of returning one on a mismatch), plus a runtime re-check for callers who cast or mutate. The precondition was a doc comment, and a documented precondition is enforced by whoever reads it. `reconcileNotInstrumented` is new; see Task 7 step 3.
2. **Task 2 — `--control-symbol` is required** and the driver stages it into the package cache itself.
3. **Task 3 — freeze compares BEFORE it archives.** `<rung>.report.json` is written only after `assertMatchesBaseline` returns; a mismatching report goes to `<rung>.mismatch[-n].report.json`. Archiving first left run 2's report beside run 1's baseline.
4. **Task 4 — the rules live in `packages/runner/src/campaign-fence.ts`**, the hook is a stdin/stdout shell over them, and the probe matrix is a committed test plus `fixtures/do-campaign/fence-probe-matrix.md`. The invocation pattern is `(?<![\w-])lethal\b`: `\blethal\b` matched inside `do-lethal`, the agent's own workspace, so the fence denied the agent's ordinary work.

Everything else is existing library code the tasks call: `validateSelectorIdsForProject` (`packages/runner/src/cli.ts`), `generateMutationSet` + `operatorTiers` (`packages/runner/src/orchestrator.ts`), `writeInstrumentedProject` (`packages/schemata/src/project.ts`), `ArtifactCompiler` + `defaultArtifactIo` (`packages/runner/src/artifact.ts`), `resolveAlToolPaths` (`packages/runner/src/cli.ts` — note the spec calls this `resolveToolPaths`; the exported name is `resolveAlToolPaths`), `assertMatchesBaseline` (`packages/runner/itest/baseline-guard.ts`), `normalizeForComparison`/`diffMutants` (`packages/runner/itest/mutant-equality.ts`).

---

### Task 1: The anchors module — rung 1's entire regression payload

This is the task most worth getting right: it is the mechanism this spec revision invented, and the previous two invented mechanisms both broke on first contact with code. It is pure, so it gets real tests.

**Files:**
- Create: `packages/runner/src/campaign-anchors.ts`
- Test: `packages/runner/tests/campaign-anchors.test.ts`

**Interfaces:**
- Consumes: `SessionReport`, `MutantOutcome` from `packages/runner/src/report.ts`. Relevant `MutantOutcome` fields: `mutantCode: string`, `file: string`, `line: number`, `operatorName: string`, `verdict: MutantVerdict`, `guardObserved?: boolean`, `coverageAttribution?: CoverageAttribution`, `failureNote?: string`.
- Produces: `assertCardinality(report, expected, label): void`, `checkAnchors(report, cfg): AnchorResult[]`, `notInstrumentedOracle(files): OracleCount`, and the types `AnchorConfig`, `AnchorResult`, `OracleCount`.

- [ ] **Step 1: Write the failing tests**

Create `packages/runner/tests/campaign-anchors.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  assertCardinality,
  checkAnchors,
  notInstrumentedOracle,
} from "../src/campaign-anchors";
import type { SessionReport } from "../src/report";

/** Minimal report fixture. Only the fields the anchors read are populated. */
function reportWith(
  mutants: readonly Partial<SessionReport["mutants"][number]>[],
  extra: Partial<SessionReport> = {},
): SessionReport {
  const full = mutants.map((m, i) => ({
    mutantCode: m.mutantCode ?? `M${String(i).padStart(4, "0")}`,
    file: m.file ?? "Codeunit 6175297 CDO Send Cust. Statement Mgt.al",
    line: m.line ?? 100,
    operatorName: m.operatorName ?? "lethal.negate-conditional",
    verdict: m.verdict ?? "no-coverage",
    batchIndex: 0,
    durationMs: 0,
    ...(m.guardObserved !== undefined ? { guardObserved: m.guardObserved } : {}),
    ...(m.coverageAttribution !== undefined
      ? { coverageAttribution: m.coverageAttribution }
      : {}),
  }));
  return {
    mutants: full,
    unsupportedTests: [],
    baselineGreen: true,
    baselineTestCount: 56,
    ...extra,
  } as unknown as SessionReport;
}

const CFG = {
  coveredProcedureRanges: [{ name: "SendPeriodStatements", startLine: 90, endLine: 200 }],
  expectedBaselineTests: 56,
};

describe("assertCardinality", () => {
  test("throws when the report holds fewer mutants than pre-committed", () => {
    expect(() => assertCardinality(reportWith([{}, {}]), 176, "rung 1")).toThrow(
      /rung 1.*expected 176.*got 2/,
    );
  });

  test("throws on an EMPTY report — the empty-vs-empty door", () => {
    expect(() => assertCardinality(reportWith([]), 176, "rung 1")).toThrow(/got 0/);
  });

  test("passes on the exact pre-committed count", () => {
    const many = Array.from({ length: 176 }, () => ({}));
    expect(() => assertCardinality(reportWith(many), 176, "rung 1")).not.toThrow();
  });
});

describe("checkAnchors", () => {
  test("anchor 1 fails when the baseline was not fully green", () => {
    const r = checkAnchors(
      reportWith([{ verdict: "killed", line: 100 }], { baselineGreen: false }),
      CFG,
    );
    const a1 = r.find((a) => a.id === "baseline-green");
    expect(a1?.passed).toBe(false);
  });

  test("anchor 2 fails when a COVERED mutant sits outside the covered procedure", () => {
    const r = checkAnchors(
      reportWith([
        { verdict: "killed", line: 100 },
        { verdict: "survived", line: 900 }, // outside SendPeriodStatements
      ]),
      CFG,
    );
    const a2 = r.find((a) => a.id === "coverage-location");
    expect(a2?.passed).toBe(false);
    expect(a2?.detail).toContain("900");
  });

  test("anchor 2 ALLOWS an object-level-attributed covered mutant outside the range", () => {
    const r = checkAnchors(
      reportWith([
        { verdict: "killed", line: 100 },
        { verdict: "survived", line: 900, coverageAttribution: "object" },
      ]),
      CFG,
    );
    expect(r.find((a) => a.id === "coverage-location")?.passed).toBe(true);
  });

  test("anchor 2 ALLOWS a new-operator mutant INSIDE the range to be covered", () => {
    const r = checkAnchors(
      reportWith([
        { verdict: "killed", line: 150, operatorName: "lethal.swap-call-arguments" },
      ]),
      CFG,
    );
    expect(r.find((a) => a.id === "coverage-location")?.passed).toBe(true);
  });

  test("anchor 4 fails when nothing was killed", () => {
    const r = checkAnchors(reportWith([{ verdict: "survived", line: 100 }]), CFG);
    expect(r.find((a) => a.id === "killed-at-least-one")?.passed).toBe(false);
  });

  test("every anchor fails on an EMPTY report rather than passing vacuously", () => {
    const r = checkAnchors(reportWith([]), CFG);
    expect(r.every((a) => a.passed)).toBe(false);
    expect(r.find((a) => a.id === "killed-at-least-one")?.passed).toBe(false);
  });
});

describe("notInstrumentedOracle", () => {
  test("counts by object header kind, independent of LethAL's own accounting", () => {
    const files = [
      { path: "a.al", source: 'codeunit 6175271 "A" { }' },
      { path: "b.al", source: 'page 6175272 "B" { }' },
      { path: "c.al", source: 'tableextension 6175273 "C" extends Customer { }' },
    ];
    const o = notInstrumentedOracle(files);
    expect(o.instrumentable).toBe(1);
    expect(o.notInstrumentable).toBe(2);
    expect(o.byKind.page).toBe(1);
    expect(o.byKind.tableextension).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd U:/Git/LethAL && bun test packages/runner/tests/campaign-anchors.test.ts
```

Expected: FAIL — `Cannot find module '../src/campaign-anchors'`.

- [ ] **Step 3: Write the implementation**

Create `packages/runner/src/campaign-anchors.ts`:

```ts
/**
 * Rung-1's regression payload for the DO live campaign (spec 2026-08-03, §"The regression payload").
 *
 * The 2026-07-28 per-mutant record does not survive on this machine, so a per-identity comparison
 * against it is impossible. These four anchors are what DOES survive — committed prose constants —
 * and each one is falsifiable. They are deliberately weaker than a per-mutant reference and the
 * spec says so.
 *
 * Pure by design: no I/O, no clock. A gate that reads the filesystem is a gate that can pass
 * because a file was missing.
 */
import type { SessionReport } from "./report";

export interface ProcedureRange {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface AnchorConfig {
  /** Procedures whose mutants are ALLOWED to be covered. Anchor 2 is location-based, not
   *  count-based, so a mutant from an operator that shipped after 2026-07-28 landing inside one
   *  of these is fine — which is the whole reason it survives roster growth. */
  readonly coveredProcedureRanges: readonly ProcedureRange[];
  readonly expectedBaselineTests: number;
}

export interface AnchorResult {
  readonly id:
    | "baseline-green"
    | "coverage-location"
    | "killed-at-least-one";
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * Pre-committed mutant count, asserted before any anchor is read.
 *
 * Without this, an empty report satisfies every "for all mutants ..." anchor vacuously — the
 * empty-vs-empty failure this repo is named for. Throws rather than returning a boolean: a
 * caller cannot accidentally ignore a throw.
 */
export function assertCardinality(
  report: SessionReport,
  expected: number,
  label: string,
): void {
  const got = report.mutants.length;
  if (got !== expected) {
    throw new Error(
      `${label}: pre-committed mutant cardinality not met — expected ${expected}, got ${got}. ` +
        `A gate comparing against a report of the wrong size is not measuring what it claims.`,
    );
  }
}

const COVERED_VERDICTS = new Set(["killed", "survived", "timeout-killed"]);

function inAnyRange(line: number, ranges: readonly ProcedureRange[]): boolean {
  return ranges.some((r) => line >= r.startLine && line <= r.endLine);
}

export function checkAnchors(
  report: SessionReport,
  cfg: AnchorConfig,
): readonly AnchorResult[] {
  const results: AnchorResult[] = [];

  // Anchor 1 — the fenced baseline was fully green.
  const green = report.baselineGreen === true;
  results.push({
    id: "baseline-green",
    passed: green,
    detail: green
      ? `baseline green (${cfg.expectedBaselineTests} expected)`
      : `baseline NOT green; unsupportedTests=${report.unsupportedTests.length}`,
  });

  // Anchor 2 — every covered mutant is inside a covered procedure, or carries object-level
  // attribution. This is the R29/R63 false-survivor tripwire on real code.
  const offenders = report.mutants.filter(
    (m) =>
      COVERED_VERDICTS.has(m.verdict) &&
      m.coverageAttribution !== "object" &&
      !inAnyRange(m.line, cfg.coveredProcedureRanges),
  );
  results.push({
    id: "coverage-location",
    passed: offenders.length === 0,
    detail:
      offenders.length === 0
        ? "every covered mutant is inside a covered procedure or object-attributed"
        : `covered mutants outside the covered procedures: ${offenders
            .map((m) => `${m.mutantCode}@${m.line}`)
            .join(", ")}`,
  });

  // Anchor 4 — something was killed. (Anchor 3, M0013's branch, is asserted by the rung-1
  // driver against the gate-0 probe result; it is not derivable from the report alone.)
  const killed = report.mutants.filter(
    (m) => m.verdict === "killed" || m.verdict === "timeout-killed",
  ).length;
  results.push({
    id: "killed-at-least-one",
    passed: killed >= 1,
    detail: `killed=${killed}`,
  });

  return results;
}

export interface OracleCount {
  readonly instrumentable: number;
  readonly notInstrumentable: number;
  readonly byKind: Record<string, number>;
}

const HEADER_RE =
  /^\s*(codeunit|table|tableextension|page|pageextension|report|query|xmlport|enum|enumextension|profile|permissionset|controladdin|interface)\b/im;

/** Only a codeunit or a table can carry the injected selector var (R5). */
const INSTRUMENTABLE = new Set(["codeunit", "table"]);

/**
 * An INDEPENDENT count of instrumentable vs not, by object-header kind.
 *
 * Deliberately not `--dry-run`: that mirrors the session's own accounting (R5, same producer), so
 * comparing the two is a producer against itself and would agree even if both were wrong.
 */
export function notInstrumentedOracle(
  files: readonly { readonly path: string; readonly source: string }[],
): OracleCount {
  const byKind: Record<string, number> = {};
  let instrumentable = 0;
  let notInstrumentable = 0;
  for (const f of files) {
    const m = HEADER_RE.exec(f.source);
    const kind = (m?.[1] ?? "unknown").toLowerCase();
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (INSTRUMENTABLE.has(kind)) instrumentable += 1;
    else notInstrumentable += 1;
  }
  return { instrumentable, notInstrumentable, byKind };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/campaign-anchors.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Red-check the cardinality assertion**

This repo gates on proving a fix is load-bearing. Temporarily change `if (got !== expected)` to `if (got !== expected && got > 0)`, re-run, and confirm **only** the "throws on an EMPTY report" test goes red. Restore. Record both outputs in the commit message.

- [ ] **Step 6: Lint and commit**

```bash
cd U:/Git/LethAL && bunx biome check packages/runner/src/campaign-anchors.ts packages/runner/tests/campaign-anchors.test.ts
git add packages/runner/src/campaign-anchors.ts packages/runner/tests/campaign-anchors.test.ts
git commit -m "feat(campaign): rung-1 anchors, cardinality assertion, independent notInstrumented oracle"
```

---

### Task 2: `compile-only` — the gate-0 item that exercises the selector-id path

Gate 0 item 5 in the spec is explicitly a BUILD item: no single invocation compiles an instrumented project today. `--dry-run` returns at `cli.ts:2058-2060`, before `validateSelectorIdsForProject` at `cli.ts:1704`; a real `lethal run` compiles but cannot stop before publish; there is no `--compile-only` (verified: zero occurrences in `cli.ts`).

**Files:**
- Create: `scripts/campaign/compile-only.ts`
- Test: `packages/runner/tests/compile-only-args.test.ts`

**Interfaces:**
- Consumes: `validateSelectorIdsForProject(projectDir: string, selectorIds: SelectorConfig): Promise<void>` from `packages/runner/src/cli`; `generateMutationSet(projectDir)` and `operatorTiers` from `packages/runner/src/orchestrator`; `writeInstrumentedProject({ targetDir, files, selectorIds, artifactId, targetAppId, operatorTiers })` from `packages/schemata/src/project`; `ArtifactCompiler` (constructor `(cfg: { alcPath, packageCachePath, outputDir }, io: ArtifactIo)`, method `compile(input: { projectDir, artifactId, appId, appVersion, mutantManifest, appManifest })`) and `defaultArtifactIo` from `packages/runner/src/artifact`.
- Produces: `parseCompileOnlyArgs(argv: string[]): CompileOnlyArgs` (exported for test), and a CLI entry under `import.meta.main`.

- [ ] **Step 1: Write the failing test for argument parsing**

Create `packages/runner/tests/compile-only-args.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseCompileOnlyArgs } from "../../../scripts/campaign/compile-only";

describe("parseCompileOnlyArgs", () => {
  test("parses a full invocation", () => {
    const a = parseCompileOnlyArgs([
      "--project", "U:/Git/do-lethal/Cloud",
      "--selector-id", "6175466",
      "--control-id", "6175467",
      "--table-id", "6175468",
      "--alc", "C:/alc/alc.exe",
      "--package-cache", "U:/Git/do-lethal/Cloud/.alpackages",
    ]);
    expect(a.projectDir).toBe("U:/Git/do-lethal/Cloud");
    expect(a.selectorIds).toEqual({
      selectorId: 6175466,
      controlId: 6175467,
      tableId: 6175468,
    });
  });

  test("throws naming the missing flag rather than defaulting", () => {
    expect(() => parseCompileOnlyArgs(["--project", "x"])).toThrow(/--selector-id/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd U:/Git/LethAL && bun test packages/runner/tests/compile-only-args.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the script**

Create `scripts/campaign/compile-only.ts`:

```ts
/**
 * Validate selector ids, generate the mutation set, write the instrumented project, and compile
 * it with `alc` — stopping before any publish.
 *
 * Exists because gate 0 of the DO campaign has to exercise the selector-id path, and nothing
 * shipped does: `--dry-run` returns before `validateSelectorIdsForProject`, and a real `lethal
 * run` cannot stop before publishing. Without this, gate 0 would declare the plumbing sound and
 * hand rung 1 the first execution of the id path.
 *
 *   bun scripts/campaign/compile-only.ts --project <dir> \
 *     --selector-id <n> --control-id <n> --table-id <n> \
 *     --alc <path/to/alc.exe> --package-cache <dir>
 *
 * Exit 0 = validation passed AND alc produced an artifact. Any other exit is a gate-0 failure.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactCompiler, defaultArtifactIo } from "../../packages/runner/src/artifact";
import { validateSelectorIdsForProject } from "../../packages/runner/src/cli";
import { generateMutationSet, operatorTiers } from "../../packages/runner/src/orchestrator";
import { writeInstrumentedProject } from "../../packages/schemata/src/project";

export interface CompileOnlyArgs {
  readonly projectDir: string;
  readonly selectorIds: {
    readonly selectorId: number;
    readonly controlId: number;
    readonly tableId: number;
  };
  readonly alcPath: string;
  readonly packageCachePath: string;
}

function req(map: Map<string, string>, flag: string): string {
  const v = map.get(flag);
  if (v === undefined) throw new Error(`compile-only: missing required flag ${flag}`);
  return v;
}

export function parseCompileOnlyArgs(argv: readonly string[]): CompileOnlyArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k !== undefined && v !== undefined) map.set(k, v);
  }
  return {
    projectDir: req(map, "--project"),
    selectorIds: {
      selectorId: Number(req(map, "--selector-id")),
      controlId: Number(req(map, "--control-id")),
      tableId: Number(req(map, "--table-id")),
    },
    alcPath: req(map, "--alc"),
    packageCachePath: req(map, "--package-cache"),
  };
}

export async function compileOnly(args: CompileOnlyArgs): Promise<void> {
  // 1. The check --dry-run never reaches. Throws naming the offending id and range.
  await validateSelectorIdsForProject(args.projectDir, args.selectorIds);
  console.log(`[compile-only] selector ids validated against ${args.projectDir}/app.json`);

  // 2. Generate + instrument, exactly as a real run does.
  const set = await generateMutationSet(args.projectDir);
  const specCount = set.files.reduce((n, f) => n + f.specs.length, 0);
  console.log(
    `[compile-only] ${set.totalFiles} .al file(s), ${set.files.length} instrumentable, ${specCount} raw spec(s)`,
  );

  const appManifest = JSON.parse(
    await readFile(join(args.projectDir, "app.json"), "utf8"),
  ) as Record<string, unknown>;
  const artifactId = randomBytes(16).toString("hex");
  const target = await mkdtemp(join(tmpdir(), "lethal-compile-only-"));
  const outputDir = await mkdtemp(join(tmpdir(), "lethal-compile-only-out-"));

  try {
    await writeInstrumentedProject({
      targetDir: target,
      files: set.files,
      selectorIds: args.selectorIds,
      artifactId,
      targetAppId: String(appManifest.id),
      operatorTiers,
    });
    const mutantManifest = JSON.parse(
      await readFile(join(target, "mutant-manifest.json"), "utf8"),
    );

    // 3. alc. An AlcCompileError here means the instrumented source does not compile — which is
    //    the thing gate 0 exists to find, including AL0297 if validation were ever bypassed.
    const compiler = new ArtifactCompiler(
      {
        alcPath: args.alcPath,
        packageCachePath: args.packageCachePath,
        outputDir,
      },
      defaultArtifactIo,
    );
    const artifact = await compiler.compile({
      projectDir: target,
      artifactId,
      appId: String(appManifest.id),
      appVersion: String(appManifest.version),
      mutantManifest,
      appManifest,
    });
    console.log(
      `[compile-only] OK — instrumented project compiled, artifact ${artifactId} (${JSON.stringify(
        Object.keys(artifact),
      )})`,
    );
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await compileOnly(parseCompileOnlyArgs(process.argv.slice(2)));
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/compile-only-args.test.ts
```

Expected: PASS.

- [ ] **Step 5: Prove the refusal half against a real fixture, offline**

`fixtures/sandbox-app` declares its own `idRanges`. Run the script with ids OUTSIDE that range and confirm it refuses before any compile:

```bash
cd U:/Git/LethAL && bun scripts/campaign/compile-only.ts \
  --project fixtures/sandbox-app \
  --selector-id 1 --control-id 2 --table-id 3 \
  --alc "$(ls ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/win32/alc.exe | head -1)" \
  --package-cache fixtures/sandbox-app/.alpackages
```

Expected: non-zero exit, error naming the offending id and the declared range. **If it compiles instead, the script is not exercising the path and the task is not done.**

- [ ] **Step 6: Prove the success half against the same fixture**

Re-run with the fixture's own in-range ids (read them from `fixtures/sandbox-app/app.json` and from `DEFAULT_SELECTOR_IDS` in `cli.ts:80-84` if they are in range there).

Expected: exit 0, `[compile-only] OK`.

- [ ] **Step 7: Lint and commit**

```bash
cd U:/Git/LethAL && bunx biome check scripts/campaign/compile-only.ts packages/runner/tests/compile-only-args.test.ts
git add scripts/campaign/compile-only.ts packages/runner/tests/compile-only-args.test.ts
git commit -m "feat(campaign): compile-only driver — the gate-0 item that exercises selector-id validation"
```

---

### Task 3: Record freezing — so this campaign is not the next one's dead anchor

The 2026-07-28 anchor died because its per-mutant record lived in a scratch `--out` and a `mkdtemp` sqlite. This campaign's store and reports live in the worktree, and the stated undo is `git worktree remove`.

**Files:**
- Create: `scripts/campaign/freeze.ts`
- Create: `docs/campaign/2026-08-03-do/README.md`

**Interfaces:**
- Consumes: `assertMatchesBaseline(report: SessionReport, baselinePath: string, label: string): Promise<void>` from `packages/runner/itest/baseline-guard.ts`; `assertCardinality` from Task 1.
- Produces: `freezeRung(reportPath: string, rung: string, expectedCount: number): Promise<void>`.

- [ ] **Step 1: Write `docs/campaign/2026-08-03-do/README.md`**

```markdown
# DO live campaign — committed records (2026-08-03)

Per rung, committed BEFORE the next rung starts:

- `rung<N>.precommit.md` — the expected result, written before the run.
- `rung<N>.report.json` — the run's `--out` report, archived from OUTSIDE the worktree.
- `rung<N>.baseline.json` — run 1's per-mutant verdicts, semantic-identity keyed.
- `manifest.md` — pinned worktree commit, resolved selector ids, alc version, flag set,
  environment id.

The 2026-07-28 DO anchor is unusable because none of this was kept: only aggregates survived, in
prose. `git worktree remove` would have deleted the rest of it here too.
```

- [ ] **Step 2: Write `scripts/campaign/freeze.ts`**

```ts
/**
 * Archive a rung's report and freeze its per-mutant verdicts to a committed file.
 *
 *   bun scripts/campaign/freeze.ts <reportPath> <rung> <expectedMutantCount>
 *
 * `assertMatchesBaseline` (packages/runner/itest/baseline-guard.ts) does the durable half: it
 * records a fresh baseline when none exists and THROWS on any per-mutant difference when one
 * does, keyed on semantic identity (astHash/codeunitName/operatorName), never on mutantCode or
 * file:line — which is the identity a re-batching run can shift.
 *
 * The cardinality assertion runs FIRST and independently, because self-recording an empty report
 * would then compare empty-to-empty on the second run and pass.
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertMatchesBaseline } from "../../packages/runner/itest/baseline-guard";
import { assertCardinality } from "../../packages/runner/src/campaign-anchors";
import type { SessionReport } from "../../packages/runner/src/report";

const RECORDS = "docs/campaign/2026-08-03-do";

export async function freezeRung(
  reportPath: string,
  rung: string,
  expectedCount: number,
): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, "utf8")) as SessionReport;
  assertCardinality(report, expectedCount, `${rung} freeze`);
  await mkdir(RECORDS, { recursive: true });
  await copyFile(reportPath, join(RECORDS, `${rung}.report.json`));
  await assertMatchesBaseline(report, join(RECORDS, `${rung}.baseline.json`), rung);
  console.log(`[freeze] ${rung}: ${report.mutants.length} mutants archived and frozen`);
}

if (import.meta.main) {
  const [reportPath, rung, expected] = process.argv.slice(2);
  if (reportPath === undefined || rung === undefined || expected === undefined) {
    throw new Error("usage: freeze.ts <reportPath> <rung> <expectedMutantCount>");
  }
  await freezeRung(reportPath, rung, Number(expected));
}
```

- [ ] **Step 3: Typecheck, lint, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bunx biome check scripts/campaign/freeze.ts
git add scripts/campaign/freeze.ts docs/campaign/2026-08-03-do/README.md
git commit -m "feat(campaign): freeze per-mutant records outside the worktree before teardown"
```

---

### Task 4: The rung-3 agent fence

The spec marks these fences an unbuilt item. An unenforced fence that is *assumed* enforced is worse than none, so it is built and tested against a deliberately-violating prompt before the real run.

**Files:**
- Create: `fixtures/do-campaign/fence-hook.ts`
- Create: `fixtures/do-campaign/settings.json`

**Interfaces:**
- Consumes: Claude Code `PreToolUse` hook protocol — reads a JSON event on stdin, writes a JSON decision on stdout.
- Produces: a hook that denies (a) any write whose path resolves under `U:/Git/LethAL`, and (b) any `lethal run` Bash command missing `--only` or `--tests-only`.

- [ ] **Step 1: Write the hook**

```ts
/**
 * Rung-3 fence for the DO campaign's `claude -p` agent.
 *
 * Two rules, both from the spec's §Fences:
 *   1. No writes under U:/Git/LethAL — the agent works in the worktree, never in the tool.
 *   2. No `lethal run` without BOTH --only and --tests-only — an unnarrowed run costs days
 *      (R48: 19,832 sites) and can wedge the tier for everyone.
 *
 * Note the tension rule 2 creates, recorded in the spec: --tests-only selects TESTS and CAN
 * change a verdict (R45), so a kill claimed under narrowing may be an artifact. The red-check
 * at rung 3 is what catches that; this hook only bounds cost.
 */
const LETHAL_ROOT = "u:/git/lethal";

interface HookEvent {
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
}

function deny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

const raw = await Bun.stdin.text();
const event = JSON.parse(raw) as HookEvent;
const tool = event.tool_name ?? "";
const input = event.tool_input ?? {};

if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
  const p = String(input.file_path ?? "").replace(/\\/g, "/").toLowerCase();
  if (p.startsWith(LETHAL_ROOT)) {
    deny(`campaign fence: writes under ${LETHAL_ROOT} are refused — work in the worktree.`);
  }
}

if (tool === "Bash") {
  const cmd = String(input.command ?? "");
  if (/\blethal\b.*\brun\b/.test(cmd)) {
    const hasOnly = /--only\b/.test(cmd);
    const hasTestsOnly = /--tests-only\b/.test(cmd);
    if (!hasOnly || !hasTestsOnly) {
      deny(
        "campaign fence: `lethal run` requires BOTH --only and --tests-only in this session " +
          "(an unnarrowed DO run schedules 19,832 sites and can wedge the environment).",
      );
    }
  }
}

console.log(JSON.stringify({}));
```

- [ ] **Step 2: Write `fixtures/do-campaign/settings.json`**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bun U:/Git/LethAL/fixtures/do-campaign/fence-hook.ts"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Test the fence against a deliberately-violating prompt**

Run a throwaway agent whose task is to violate both rules, and confirm both denials:

```bash
cd U:/Git/do-lethal && claude -p \
  "Do exactly two things and report what happened: (1) write the text 'x' to U:/Git/LethAL/PROBE.txt, (2) run: lethal run --project . --dry-run" \
  --settings U:/Git/LethAL/fixtures/do-campaign/settings.json \
  --output-format stream-json --verbose --max-budget-usd 1
```

Expected: both attempts denied, and `U:/Git/LethAL/PROBE.txt` does not exist afterwards. Verify with `ls U:/Git/LethAL/PROBE.txt` — expect "No such file".

**If either violation succeeds, rung 3 does not start.**

- [ ] **Step 4: Commit**

```bash
cd U:/Git/LethAL && bunx biome check fixtures/do-campaign/fence-hook.ts
git add fixtures/do-campaign/
git commit -m "feat(campaign): rung-3 agent fence, proven against a violating prompt"
```

---

### Task 5: Rung 0 — provisioning and its six gate items

No code. Every item produces a recorded observable; the rung is not passed on impressions.

**Files:**
- Create: `docs/campaign/2026-08-03-do/rung0.precommit.md`
- Create: `docs/campaign/2026-08-03-do/manifest.md`
- Create (gitignored, outside the repo or gitignored inside): `U:/Git/do-lethal/lethal.config.envtool.json`

- [ ] **Step 1: Ask the user to pull, then cut the worktree and PIN the commit**

The user pulls `U:/Git/do-rel2` themselves — it is their repo, on a promotion branch with uncommitted state.

```bash
git -C U:/Git/do-rel2 worktree add U:/Git/do-lethal -b lethal/campaign-2026-08-03
git -C U:/Git/do-lethal rev-parse HEAD
```

Record the SHA in `manifest.md`. Every later "did a verdict change?" question is unanswerable without it.

- [ ] **Step 2: Re-derive the dry-run pre-commitment and write it BEFORE the environment exists**

```bash
cd U:/Git/LethAL && bun packages/runner/src/cli.ts run \
  --project U:/Git/do-lethal/Cloud --dry-run \
  --only "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al"
```

Write the reported site count and its per-operator composition into `rung0.precommit.md` and commit that file. It was **176** on 2026-08-03 against `U:/Git/do-rel2/Cloud`; re-derive rather than assume, because any operator landing since moves it. Record the composition honestly: 13 are attributable by operator name to post-differential operators (`swap-call-arguments` 10 at `f9e055c`, `remove-commit` 3 at `9b541cf`); the rest of the delta against the historical 138 is unreconciled and cannot be reconciled without the lost per-mutant record.

- [ ] **Step 3: Pick three selector ids inside DO's range**

DO's `Cloud/app.json` declares `idRanges: [{ from: 6175271, to: 6175468 }]`. `DEFAULT_SELECTOR_IDS` (79197–79199) is outside it. **First look for the config the earlier DO sweeps used** rather than re-deriving. Otherwise pick three free codeunit ids in range (all three injected objects are codeunits, so the declared-codeunit set is the collision set). Record them in `manifest.md`.

- [ ] **Step 4: Create the environment**

```bash
cd U:/Git && ./CLI/continia.exe env create --name lethal-do-campaign \
  --profile c803cb93-a8e4-4fb1-b61f-e5f60f17b43a --json
```

Fresh, not reusing `f19aca88`: R31 detects a published test app missing tests, but R56's shape — an older-but-complete published build — is invisible, and a fresh environment is its only mitigation. Record the environment id and `expiresUtc` in `manifest.md`. Then wait for `Running`:

```bash
until ./CLI/continia.exe env get <envId> | grep -qE "Status:\s+Running"; do sleep 20; done
```

- [ ] **Step 5: Write the envTool config**

At `U:/Git/do-lethal/lethal.config.envtool.json`, shape per `fixtures/README.md` §"Running against an external environment tool". Secrets **only** as `${VAR}` placeholders — the `no-committed-secrets` PreToolUse hook enforces this. Include the `selectorIds` section from step 3, `bcdev.alcPath` pinned to **alc 17** (DO declares `runtime 17.0`; R43: alc 18 writes a package BC 28 cannot load), and `publishApps` naming the compiled DO test app.

Record here whether `envTool.env` still needs `CONTINIA_API_TOKEN`: `continia env list` answered on 2026-08-03 with no token in the shell, so the CLI holds its own login, but whether LethAL's path needs it passed is unmeasured until this step.

- [ ] **Step 6: Gate 0, all six items, each with its observable**

1. **LethAL Control publishes and harness-verifies.** Build it first (`/control-app`) — R25: a stale local `lethal-control.app` publishes fine and then fails with a confusing `clientProtocol` rejection.
2. **DO's test app compiles and publishes.** Apply the known `CDOTelemetryTests` exclusion (pre-existing source/dependency mismatch, recorded in the 2026-07-27 run notes and again in R53's DO-route rejection) deliberately, not by rediscovery.
3. **The resolved compiler is alc 17.** Observable: read the resolved `alcPath` back (`resolveAlToolPaths`, `cli.ts:1098-1102`) and invoke it to print its version. Not inferred from "a path was configured".
4. **`--dry-run` reports the step-2 pre-committed count.**
5. **`compile-only` passes** (Task 2), with the step-3 in-range ids against `U:/Git/do-lethal/Cloud`. Pass `--control-symbol <path to the lethal-control.app built in item 1>`: the driver stages it into `--package-cache` itself, exactly as `BcDevMcpBackend.stageForCompile` does, so this item imposes no setup step a real run does not. Without the flag it refuses at parse time rather than letting alc fail to resolve `Codeunit "LC Control State"` with no hint about why.
6. **The hosted hang-stop probe.** Publish `fixtures/sandbox-hang` (committed, own app id and id range, collides with nothing) to the new environment and run `itest:hang`'s ON leg through an envtool config. This decides M0013's rung-1 branch and touches no DO code. It is **not** implementable against DO itself — `--only` selects files, not mutants, so scoping to the codeunit runs every covered mutant.

- [ ] **Step 7: Commit the rung-0 record**

```bash
cd U:/Git/LethAL && git add docs/campaign/2026-08-03-do/rung0.precommit.md docs/campaign/2026-08-03-do/manifest.md
git commit -m "measure(campaign): rung 0 — environment provisioned, six gate items recorded"
```

**Do not start rung 1 until all six pass.** A failure gets an `R<n>` row in `ROADMAP.md` and an explicit fix-or-continue decision.

---

### Task 6: Rung 1 — the smoke run

**Files:**
- Create: `docs/campaign/2026-08-03-do/rung1.precommit.md`
- Create (by the run): `rung1.report.json`, `rung1.baseline.json`

- [ ] **Step 1: Write the pre-commitment BEFORE the first run**

Into `rung1.precommit.md`, committed before anything executes:

- The mutant cardinality from rung 0 step 2.
- **M0013's branch**, decided by gate-0 item 6: *stop confirmed on hosted* → `timeout-killed`, comparison covers all N. *Stop unconfirmable* → an `R<n>` row is filed, each fresh run strands once at M0013's identity, recovery is `--resume` (auto-skip, unscored), and the comparison covers N−1 plus exactly one named excluded identity, **with that cardinality asserted**.
- The four anchors, with `coveredProcedureRanges` giving `SendPeriodStatements`'s line range in the **pinned** worktree source.
- Whether a quarantine-resumed completion is an admissible input to the determinism comparison. `docs/measurements` bars resumed runs from *differential* inputs; a verdict-only run-vs-run comparison is defensible, but decide it here, not after.

- [ ] **Step 2: Run it, twice**

```bash
cd U:/Git/LethAL && bun packages/runner/src/cli.ts run \
  --project U:/Git/do-lethal/Cloud \
  --config U:/Git/do-lethal/lethal.config.envtool.json \
  --only "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al" \
  --tests-only "Src/AutomaticDocuments/**" \
  --stop-hung-sessions \
  --out C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL/rung1-run1.json
```

`--out` goes **outside** the worktree. Then repeat identically to `rung1-run2.json`.

With `--stop-hung-sessions` on, **no quarantine is expected**. Any quarantine is a finding, and specifically a quarantine at M0013's identity means the hosted stop was unconfirmable — the most valuable thing this rung can report. **Never pass `--retry-stranded`.**

- [ ] **Step 3: Freeze run 1 and compare run 2 against it**

```bash
cd U:/Git/LethAL && bun scripts/campaign/freeze.ts <rung1-run1.json> rung1 <N>
bun scripts/campaign/freeze.ts <rung1-run2.json> rung1 <N>
```

The first call records the baseline; the second throws on any per-mutant difference. `assertCardinality` runs first in both, so a truncated or empty report fails loudly rather than self-recording something meaningless.

- [ ] **Step 4: Check the anchors — through the driver, not by hand**

Write the step-1 pre-commitment's machine half to `docs/campaign/2026-08-03-do/rung1.anchors.json` and commit it BEFORE the run:

```json
{
  "expectedMutantCount": <N>,
  "expectedBaselineTests": <T>,
  "coveredProcedureRanges": [{ "name": "SendPeriodStatements", "startLine": <a>, "endLine": <b> }],
  "reconcileNotInstrumented": false
}
```

Then:

```bash
cd U:/Git/LethAL && bun scripts/campaign/anchors.ts \
  --report docs/campaign/2026-08-03-do/rung1.report.json \
  --config docs/campaign/2026-08-03-do/rung1.anchors.json
```

**The exit code is the gate.** Non-zero = rung 1 failed; do not proceed on the printed text. Every field of the config is required and none has a default — in particular `expectedMutantCount` is never derived from the report being checked, which would make the cardinality assertion compare a report against itself. `checkAnchors` cannot be called at all without the token `assertCardinality` returns, so the cardinality precondition cannot be skipped by an operator running this ad hoc.

The driver prints every anchor, including the passing ones — paste that output into `rung1.precommit.md`'s result section verbatim. It also prints, by name, that **anchor 3 (M0013's branch) is NOT checked**: it is not derivable from the report, and step 1 decides it against the gate-0 item-6 probe result. A clean exit from this driver is three anchors, not four.

- [ ] **Step 5: Commit the record**

```bash
cd U:/Git/LethAL && git add docs/campaign/2026-08-03-do/rung1.*
git commit -m "measure(campaign): rung 1 — <N> mutants, verdict-identical across two runs, four anchors held"
```

---

### Task 7: Rung 2 — one real module

**Files:**
- Create: `docs/campaign/2026-08-03-do/rung2.precommit.md`, `rung2.report.json`, `rung2.baseline.json`

- [ ] **Step 1: Select the module, by measurement**

Rank candidates by sites × test-coverage density. **First confirm R69's per-test coverage data still exists on disk** — it is another uncommitted live-run artifact. If it is gone, rank on a cheaper offline proxy (sites per file × whether any test file names the object) and record that the ranking is weaker.

**Screen candidates for `TestPage`** in their covering tests (cheap grep; 5 files in `do-rel2/Test` carry `TestPage` tests). A module whose covering tests include one risks a baseline hang, and a baseline quarantine is a flat gate failure — the stop machinery does not reach the baseline (`orchestrator.ts:2360-2365`) and R69 Task 7 measured that hang deterministic and unrescuable, twice.

- [ ] **Step 2: Write the pre-commitment, then run**

Target ~500–1500 mutants. **Above 1,000 sites the run is refused by default** — `LARGE_RUN_MUTANT_THRESHOLD = 1_000` (`orchestrator.ts:106`, R48) — so a module in the upper half needs `--allow-large-run`, passed deliberately and recorded. Use `--max-guards-per-batch` (R44: 36.8 s per publish, linear in batch count) and `--out` outside the worktree.

- [ ] **Step 3: Apply the gates**

- **A baseline quarantine is a gate failure, period.** A mutant-phase strand scored `timeout-killed` is expected; a mutant-phase quarantine is a failure on rung 1's terms.
- **Survivor count > 0** — otherwise the survivor gate below passes vacuously, and on a module chosen for coverage density zero survivors is itself an anomaly.
- **Every survivor has `guardObserved === true`.** State the weakness alongside: `true` is the weak direction (`ControlState.IsActive` sets `observedAny` for *any* guard in the artifact, not this mutant's), so it does not prove this mutation was in play. `false` on a survivor is the strong signal and must never appear.
- **`notInstrumented` reconciles against the independent oracle**, with this exact identity: **run the oracle over the report's OWN `notInstrumented.files` paths and require `instrumentable === 0`** — every file the report calls uninstrumentable really is, read independently from its object header. Do **not** compare counts: the two quantities are unequal by construction and a count comparison would fail on a healthy project. The report lists only files with >=1 spec that cannot carry the selector var; the oracle classifies every file handed to it; so a zero-spec page is uninstrumentable to the oracle and absent from the report, and a zero-spec codeunit inverts it. The report's candidate set also drops `Mutation*` basenames, which the oracle knows nothing about. Feeding the oracle the report's own list removes every one of those asymmetries — what is compared is the CLASSIFICATION (a header regex) against the session's (a tree-sitter parse), not the population.

  Run it through the same driver, with the rung-2 config setting `"reconcileNotInstrumented": true`:

  ```bash
  cd U:/Git/LethAL && bun scripts/campaign/anchors.ts \
    --report docs/campaign/2026-08-03-do/rung2.report.json \
    --config docs/campaign/2026-08-03-do/rung2.anchors.json \
    --project U:/Git/do-lethal/Cloud
  ```

  With the flag set, `--project` is **required** and its absence is a hard error — a gate item that can silently not run is not a gate. A missing source for any listed file is also a hard error rather than a smaller reconciliation, and an empty list is reported as NOT passed (`instrumentable === 0` over zero files is vacuous). `--dry-run` remains excluded: same producer, so it would agree with the session even if both were wrong.

- [ ] **Step 4: Freeze and commit**

```bash
cd U:/Git/LethAL && bun scripts/campaign/freeze.ts <rung2-out.json> rung2 <N>
git add docs/campaign/2026-08-03-do/rung2.*
git commit -m "measure(campaign): rung 2 — <module>, <N> mutants, <k> survivors, all guard-observed"
```

---

### Task 8: Rung 3 — the agent reads the report

**Files:**
- Create: `docs/campaign/2026-08-03-do/rung3.precommit.md`, `rung3.transcript.jsonl`, `rung3.result.md`

- [ ] **Step 1: Write the prediction BEFORE the agent starts**

From the rung-2 report, into `rung3.precommit.md`, committed first: which survivors are genuine targets, which are equivalent-mutant or `no-coverage` traps, and what a correct reaction to each looks like.

Restate the reading rule so it cannot be forgotten at interpretation time: the agent runs **without `--bare`**, so it inherits this machine's global `CLAUDE.md`, plugins and skills, making it a stronger-than-typical reader. **Confusion is a hard finding; success is weak evidence.** Rung 3 can prove the report is bad. It cannot prove it is good.

- [ ] **Step 1b: REBUILD the standalone binary from the pinned campaign commit — before anything else in this rung**

Rungs 0–2 run from source (`bun packages/runner/src/cli.ts`). Rung 3 runs
`build/lethal-0.1.0-alpha.1-windows-x64.exe`, which is a **different artifact** and, as committed,
a stale one: it was built 2026-07-27 and is dozens of package-commits behind. Measured on the
committed binary, `grep -c` returns **0** for both `swap-call-arguments` and `remove-commit` — the
two operators rung 0 step 2 records as contributing 13 of the ~176 rung-1 mutants. An agent handed
that binary would be reading a rung-2 report describing mutants its own tool cannot generate.

The filename carries only `0.1.0-alpha.1`, so stale is indistinguishable from fresh by inspection —
and `build/` is **gitignored** (`.gitignore:4`), so the binary is an untracked local artifact that
exists only in the main checkout: git records nothing about which commit produced it. The manifest
entry below is the only place that fact can live. Rebuild and verify:

```bash
cd U:/Git/LethAL && git rev-parse HEAD          # record this in manifest.md as lethalCommit
bun run build:binary
for op in swap-call-arguments remove-commit; do
  printf '%s: ' "$op"; grep -ac "$op" build/lethal-0.1.0-alpha.1-windows-x64.exe
done
sha256sum build/lethal-0.1.0-alpha.1-windows-x64.exe
```

Every operator the rung-1/rung-2 mutant set depends on must report a **non-zero** count. Record the
LethAL commit, the sha256 and the build timestamp in `manifest.md`. A zero on any operator, or a
binary whose recorded commit is not the commit the campaign ran from, is a rung-3 abort: the agent's
tool and the report it is reading would describe different products.

- [ ] **Step 2: Run the agent**

**Preflight FIRST — rung 3 does not start without it.** `PreToolUse` hooks **fail open**: only exit
code 2 blocks, so a spawn failure, a missing hook file, or malformed output all let the tool call
proceed. A settings file naming a hook that does not exist gives **no fence at all, silently**. So:

```bash
bun U:/Git/LethAL/fixtures/do-campaign/preflight.ts U:/Git/LethAL/fixtures/do-campaign/settings.json || exit 1
```

Abort the rung on any non-zero exit. Note what a pass does and does not prove: it is a **wiring and
fail-open check**, confirming the configured hook answers two known probes correctly. It is not a
proof of correctness — a hook special-cased to exactly those two probes would also pass.

**Threat model, decided 2026-08-04: accident, not adversary.** The hook denies every accidental
route (absolute paths, the Git-Bash `/<drive>/` mount form, `..` traversal, plain
`--allow-large-run`). It does **not** survive deliberate evasion: `--allow-large-ru$()n` and
`leth$()al ru$()n` are demonstrated, documented residuals, and `--allow-large-run` is precisely the
flag that disables the product's own `assertRunSizeAcceptable` refusal. Closing that would need
OS-level isolation, which this campaign does not have — `U:/Git/LethAL` and `U:/Git/do-lethal` are
siblings on one filesystem under one account. See `fixtures/do-campaign/README.md`.

**The real guarantees are structural and product-level, not the hook:**
- The agent's workspace holds the DO worktree and the **standalone compiled binary**
  (`build/lethal-0.1.0-alpha.1-windows-x64.exe`) — **not** the LethAL source tree. There is no
  accidental path into the tool's own source.
- An unnarrowed run is refused by LethAL itself: `assertRunSizeAcceptable`
  (`LARGE_RUN_MUTANT_THRESHOLD = 1_000`, `orchestrator.ts:106`) is a default-on pre-flight refusal,
  and DO's default invocation schedules 19,832 sites.

```bash
cd U:/Git/do-lethal && claude -p "<task authored from the rung-2 report>" \
  --settings U:/Git/LethAL/fixtures/do-campaign/settings.json \
  --disallowedTools Task \
  --output-format stream-json --verbose \
  --session-id <fixed-uuid> \
  --max-budget-usd <n> \
  > U:/Git/LethAL/docs/campaign/2026-08-03-do/rung3.transcript.jsonl
```

The transcript **is** the measurement. `--max-turns` does not exist on the CLI (SDK-only); `--max-budget-usd` is the bound.

- [ ] **Step 3: Red-check EVERY claimed kill**

For each kill the agent claims: revert its test, confirm the mutant returns to `survived`, restore. Run the confirmation at **both** the agent's own scoping and **unnarrowed** — `--tests-only` selects tests and can change a verdict (R45), so a kill claimed under narrowing may be an artifact of the narrowing.

Two measured reasons this is not optional: R86 — `failure_note` is `NULL` for all 109 killed mutants in the last gate run, so no kill records *why* it died and a genuine kill is indistinguishable from arm E's length-overflow false kill. And this repo's signature bug is a test that passes for the wrong reason.

**Budget it explicitly.** The unnarrowed leg pays the full 1,246-test baseline (~750 s hosted, inside R44's flakiness window); three claimed kills is roughly an hour. If that is unaffordable at run time, **cap the number of claimed kills accepted for verification and say so in the result** — never drop the unnarrowed leg, which is the exact false-kill door this step exists to close.

- [ ] **Step 4: Diff against the prediction and write the result**

Into `rung3.result.md`: what the agent attacked, what it refused, where it was confused, and every red-check outcome. File an `R<n>` row for each confusion — those are the findings this whole campaign was built to produce.

- [ ] **Step 5: Archive everything BEFORE teardown**

Reports, baselines, transcript, manifest — all committed — **then** `continia env delete <envId>` and `git worktree remove U:/Git/do-lethal`. The 07-28 anchor died in exactly this order, done wrong.

```bash
cd U:/Git/LethAL && git add docs/campaign/2026-08-03-do/
git commit -m "measure(campaign): rung 3 — agent transcript, prediction diff, red-checked kills"
```

---

## What this campaign will not tell us

Carried from the spec so a result cannot be over-read:

- **Nothing about the 41% of DO that is never instrumented** (R40: 287 of 449 files carrying sites, 8,259 of 20,036 sites).
- **Nothing about GUI-guarded behaviour** (R60: every verdict describes the non-GUI branch, `GuiAllowed=No`, `ClientType=ODataV4`).
- **Nothing general about report legibility from a single agent run** — the asymmetric reading rule above.
