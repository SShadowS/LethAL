# LethAL Layer 4 Implementation Plan — Execution Runtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@lethal/runner`: sequential mutation-testing sessions against a real AL project — deploy the instrumented app, run tests per mutant through a pluggable `ExecutionBackend` (bc-dev MCP for NST; Stefan Maron's BusinessCentral.AL.Runner in-memory), record killed/survived verdicts in SQLite, and report.

**Architecture:** New package `@lethal/runner` depending on `engine`, `schemata`, `builtin-tier1`. All backend-specific behavior (deploy, activation, test invocation, isolation) lives behind the `ExecutionBackend` interface so Microsoft's announced in-memory runner becomes adapter-only work. Schemata's emitted selector is reworked to a table-backed design (prerequisite: the current in-memory SingleInstance selector cannot survive the fresh-session-per-test execution model).

**Tech Stack:** Bun + TypeScript monorepo as-is. New runtime deps in `@lethal/runner` only: `@modelcontextprotocol/sdk` (MCP client + in-memory test server). SQLite via built-in `bun:sqlite`. No other externals.

**Design spec reference:** `docs/superpowers/specs/2026-07-17-layer-4-execution-runtime-design.md` (approved). Root `design.md` §5, §6 for rationale.

## Global Constraints

- Verdict vocabulary (spec §10): `killed | survived | no-coverage | timeout-killed | known-survivor | error`. Test outcome vocabulary (spec §4): `pass | fail | skip | timeout | error`.
- Identity key (design.md §5.1): `(astHash, codeunitName, operatorName, operatorMajor)` — `file`/`line` are display-only, never part of equality.
- Guard call sites emitted by schemata are IDENTICAL across backends: `MutationSelector.Active('Mxxxx')`. Backends differ only in how `ActiveId` gets its value.
- Mutant ids (`M0001`…) are **batch-scoped**: `assignMutantIds` numbers per write. Cross-run identity uses the identity key, never the mutant code.
- Default object ids for emitted objects: selector codeunit 50000, control codeunit 50001, active table 50002. Fixture apps use the 79000 range.
- One backend per session, chosen by config. Orchestrator behavior degrades via `BackendCapabilities`, never via `instanceof` checks.
- Timeouts: baseline tests get `baselineTimeoutMs` (default 120000); mutant-run tests get `2 × that test's baseline durationMs` (design.md §6.7). Timeout under mutant = `timeout-killed`, no confirmation re-run.
- **Spec deviation (recorded here, spec amended in Task 9):** activation HTTP auth is Basic (NavUserPassword), not NTLM — `fetch` cannot do the NTLM handshake. Windows-auth support is deferred.
- All new code passes `bun run lint` (biome) and `bun run typecheck` before each commit.

---

## File Structure

```
packages/
├── schemata/
│   ├── src/
│   │   ├── selector.ts        # MODIFY — SelectorConfig {selectorId, controlId, tableId};
│   │   │                      #   emitMutationActiveTable / emitMutationSelector (table-backed)
│   │   │                      #   / emitMutationControl / emitStaticSelector / emitWebServicesXml
│   │   └── project.ts         # MODIFY — write 3 objects + webservices.xml; enrich manifest
│   │                          #   (astHash, codeunitId, codeunitName, procedureName, startLine)
│   └── tests/
│       ├── selector.test.ts   # MODIFY
│       └── project.test.ts    # MODIFY
├── runner/                    # NEW PACKAGE @lethal/runner
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── backend.ts             # ExecutionBackend + verdict/coverage/capability types
│   │   ├── discovery.ts           # regex test discovery over .al files (backend-independent)
│   │   ├── selection.ts           # identity key, history filter, overlap batcher, coverage filter
│   │   ├── store.ts               # ResultsStore (bun:sqlite)
│   │   ├── bcdev-backend.ts       # BcDevMcpBackend (MCP client over stdio)
│   │   ├── publisher.ts           # alc compile + altool publishapp (bcdev-backend internal)
│   │   ├── activation.ts          # MutationControlClient (OData, basic auth)
│   │   ├── al-runner-backend.ts   # AlRunnerBackend (CLI spawn, selector-rewrite activation)
│   │   ├── ms-inmemory-backend.ts # explicit unimplemented placeholder
│   │   ├── orchestrator.ts        # runSession state machine + generateMutationSet
│   │   ├── report.ts              # SessionReport JSON + console rendering
│   │   ├── cli.ts                 # `lethal run` entry
│   │   └── index.ts
│   └── tests/
│       ├── discovery.test.ts
│       ├── selection.test.ts
│       ├── store.test.ts
│       ├── bcdev-backend.test.ts
│       ├── publisher.test.ts
│       ├── activation.test.ts
│       ├── al-runner-backend.test.ts
│       ├── orchestrator.test.ts
│       └── fixtures/…
├── fixtures/                  # NEW — repo root, committed AL fixture apps
│   ├── sandbox-app/           # target app, object ids 79000+
│   └── sandbox-tests/         # test app, TestIsolation = Function
```

**Boundary rationale.** `publisher.ts` and `activation.ts` are separate files even though only `bcdev-backend.ts` uses them: each has a distinct external boundary (process spawn vs HTTP) with its own test seam. `discovery.ts` is backend-independent by design (spec §4). Coverage filtering lives in `selection.ts` with the other selection stages (spec file list) — they share the `MutantRecord` vocabulary.

---

## Task 1: Schemata selector rework — table-backed selector + control web service

The emitted `MutationSelector` currently holds `ActiveId` in SingleInstance memory (`packages/schemata/src/selector.ts`), which dies with the session. Rework emission into three objects plus a static-selector variant for in-memory backends.

**Files:**
- Modify: `packages/schemata/src/selector.ts`
- Modify: `packages/schemata/tests/selector.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 2, 10):
  - `interface SelectorConfig { readonly selectorId: number; readonly controlId: number; readonly tableId: number; }`
  - `emitMutationActiveTable(cfg: SelectorConfig): string`
  - `emitMutationSelector(cfg: SelectorConfig): string` — table-backed, session-cached
  - `emitMutationControl(cfg: SelectorConfig): string` — SetActive/ClearActive, Commit
  - `emitStaticSelector(cfg: { objectId: number; activeId: string }): string` — hardcoded body for in-memory backends
  - `emitWebServicesXml(cfg: SelectorConfig): string`

- [ ] **Step 1: Rewrite `packages/schemata/tests/selector.test.ts` as the failing spec of the new emission**

```ts
import { describe, expect, test } from "bun:test";
import {
  emitMutationActiveTable,
  emitMutationControl,
  emitMutationSelector,
  emitStaticSelector,
  emitWebServicesXml,
} from "../src/selector";

const cfg = { selectorId: 50000, controlId: 50001, tableId: 50002 };

describe("emitMutationActiveTable", () => {
  test("emits single-row table, cross-company", () => {
    const src = emitMutationActiveTable(cfg);
    expect(src).toContain('table 50002 "Mutation Active"');
    expect(src).toContain("DataPerCompany = false;");
    expect(src).toContain('field(1; PrimaryKey; Code[10])');
    expect(src).toContain("field(2; ActiveId; Text[64])");
  });
});

describe("emitMutationSelector", () => {
  test("reads the table once per session, then caches", () => {
    const src = emitMutationSelector(cfg);
    expect(src).toContain('codeunit 50000 "Mutation Selector"');
    expect(src).toContain("SingleInstance = true;");
    expect(src).toContain("procedure Active(MutantId: Text): Boolean");
    expect(src).toContain("if not Loaded then begin");
    expect(src).toContain("if MutationActive.Get('') then");
    expect(src).toContain("CachedId := MutationActive.ActiveId;");
  });
});

describe("emitMutationControl", () => {
  test("writes the table, commits, echoes the id", () => {
    const src = emitMutationControl(cfg);
    expect(src).toContain('codeunit 50001 "Mutation Control"');
    expect(src).toContain("procedure SetActive(MutantId: Text): Text");
    expect(src).toContain("procedure ClearActive()");
    expect(src).toContain("Commit();");
    expect(src).toContain("exit(MutantId);");
  });
});

describe("emitStaticSelector", () => {
  test("hardcodes the active id for in-memory backends", () => {
    const src = emitStaticSelector({ objectId: 50000, activeId: "M0007" });
    expect(src).toContain('codeunit 50000 "Mutation Selector"');
    expect(src).toContain("exit(MutantId = 'M0007');");
  });
  test("empty id means always inactive", () => {
    const src = emitStaticSelector({ objectId: 50000, activeId: "" });
    expect(src).toContain("exit(false);");
  });
});

describe("emitWebServicesXml", () => {
  test("exposes Mutation Control as a web service", () => {
    const xml = emitWebServicesXml(cfg);
    expect(xml).toContain("<ObjectType>Codeunit</ObjectType>");
    expect(xml).toContain("<ObjectID>50001</ObjectID>");
    expect(xml).toContain("<ServiceName>MutationControl</ServiceName>");
    expect(xml).toContain("<Published>true</Published>");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/schemata/tests/selector.test.ts`
Expected: FAIL — `emitMutationActiveTable` etc. not exported; existing `emitMutationSelector` shape mismatched.

- [ ] **Step 3: Rewrite `packages/schemata/src/selector.ts`**

```ts
export interface SelectorConfig {
  readonly selectorId: number;
  readonly controlId: number;
  readonly tableId: number;
}

export function emitMutationActiveTable(cfg: SelectorConfig): string {
  return `table ${cfg.tableId} "Mutation Active"
{
    DataPerCompany = false;

    fields
    {
        field(1; PrimaryKey; Code[10]) { }
        field(2; ActiveId; Text[64]) { }
    }

    keys
    {
        key(PK; PrimaryKey) { Clustered = true; }
    }
}
`;
}

export function emitMutationSelector(cfg: SelectorConfig): string {
  return `codeunit ${cfg.selectorId} "Mutation Selector"
{
    SingleInstance = true;

    var
        CachedId: Text;
        Loaded: Boolean;

    procedure Active(MutantId: Text): Boolean
    var
        MutationActive: Record "Mutation Active";
    begin
        if not Loaded then begin
            if MutationActive.Get('') then
                CachedId := MutationActive.ActiveId;
            Loaded := true;
        end;
        if CachedId = '' then
            exit(false);
        exit(CachedId = MutantId);
    end;
}
`;
}

export function emitMutationControl(cfg: SelectorConfig): string {
  return `codeunit ${cfg.controlId} "Mutation Control"
{
    procedure SetActive(MutantId: Text): Text
    var
        MutationActive: Record "Mutation Active";
    begin
        if not MutationActive.Get('') then begin
            MutationActive.Init();
            MutationActive.PrimaryKey := '';
            MutationActive.Insert();
        end;
        MutationActive.ActiveId := CopyStr(MutantId, 1, MaxStrLen(MutationActive.ActiveId));
        MutationActive.Modify();
        Commit();
        exit(MutantId);
    end;

    procedure ClearActive()
    var
        MutationActive: Record "Mutation Active";
    begin
        if MutationActive.Get('') then begin
            MutationActive.ActiveId := '';
            MutationActive.Modify();
            Commit();
        end;
    end;
}
`;
}

export function emitStaticSelector(cfg: { objectId: number; activeId: string }): string {
  const body =
    cfg.activeId === ""
      ? "        exit(false);"
      : `        exit(MutantId = '${cfg.activeId}');`;
  return `codeunit ${cfg.objectId} "Mutation Selector"
{
    procedure Active(MutantId: Text): Boolean
    begin
${body}
    end;
}
`;
}

export function emitWebServicesXml(cfg: SelectorConfig): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ExportedData>
  <TenantWebServiceCollection>
    <TenantWebService>
      <ObjectType>Codeunit</ObjectType>
      <ObjectID>${cfg.controlId}</ObjectID>
      <ServiceName>MutationControl</ServiceName>
      <Published>true</Published>
    </TenantWebService>
  </TenantWebServiceCollection>
</ExportedData>
`;
}
```


- [ ] **Step 4: Update `packages/schemata/src/index.ts` exports**

```ts
export {
  emitMutationSelector,
  emitMutationActiveTable,
  emitMutationControl,
  emitStaticSelector,
  emitWebServicesXml,
} from "./selector";
export type { SelectorConfig } from "./selector";
```

(Replace the two existing selector export lines; keep all other exports.)

- [ ] **Step 5: Run tests, fix `project.ts` compile break**

Run: `bun test packages/schemata`
`project.ts` still calls `emitMutationSelector({ objectId })` — it breaks. That is Task 2's subject; for THIS commit, make the minimal fix inside `project.ts`: replace the old call with the three-object emission using a temporary hardcoded mapping from the existing `selectorObjectId` input:

```ts
  const selectorCfg = {
    selectorId: input.selectorObjectId,
    controlId: input.selectorObjectId + 1,
    tableId: input.selectorObjectId + 2,
  };
  await writeFile(
    join(input.targetDir, "MutationSelector.Codeunit.al"),
    emitMutationSelector(selectorCfg),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, "MutationActive.Table.al"),
    emitMutationActiveTable(selectorCfg),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, "MutationControl.Codeunit.al"),
    emitMutationControl(selectorCfg),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, "webservices.xml"),
    emitWebServicesXml(selectorCfg),
    "utf8",
  );
```

Update `project.test.ts` expectations: instrumented dir now contains `MutationActive.Table.al`, `MutationControl.Codeunit.al`, `webservices.xml` alongside `MutationSelector.Codeunit.al`.

Expected: all schemata tests PASS. Run full suite: `bun test` → everything green (102+ tests).

- [ ] **Step 6: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add packages/schemata
git commit -m "feat(schemata): table-backed selector + control web service emission

In-memory SingleInstance ActiveId cannot survive the Layer 4
fresh-session-per-test execution model. Selector now reads a
DataPerCompany=false table (cached per session); a Mutation Control
codeunit exposed as a web service performs activation. Static-selector
variant added for in-memory backends."
```

---

## Task 2: Schemata manifest enrichment + `selectorIds` input

The runner needs per-mutant identity and coverage-lookup fields without re-parsing: `astHash`, `codeunitId`, `codeunitName`, `procedureName`, `startLine`. Also replace the temporary `selectorObjectId + n` mapping with an explicit `selectorIds` input.

**Files:**
- Modify: `packages/schemata/src/project.ts`
- Modify: `packages/schemata/tests/project.test.ts`

**Interfaces:**
- Consumes: `astSubtreeHash(node)`, `findEnclosingProcedure(node)`, `findFirst`, `ALNodeKind` from `@lethal/engine`; `SelectorConfig` from Task 1.
- Produces (used by Tasks 4, 5, 6, 11):

```ts
export interface WriteInput {
  readonly targetDir: string;
  readonly files: readonly InstrumentedFile[];
  readonly selectorIds: SelectorConfig;         // replaces selectorObjectId
}

export interface MutantManifestEntry {
  readonly mutantId: string;
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startLine: number;                   // 1-based, display only
  readonly operatorName: string;
  readonly operatorVersion: string;
  readonly astHash: string;                     // astSubtreeHash(spec.before)
  readonly codeunitId: number;                  // enclosing object id
  readonly codeunitName: string;                // enclosing object name
  readonly procedureName: string;               // enclosing procedure name ("" if none)
}

export interface MutantManifest {
  readonly selectorIds: SelectorConfig;
  readonly mutants: readonly MutantManifestEntry[];
}
```

- [ ] **Step 1: Extend `project.test.ts` with a failing enrichment test**

Add to the existing describe block (which already parses a small AL fixture and writes a project):

```ts
test("manifest entries carry identity and coverage-lookup fields", async () => {
  // reuse the existing test's write flow; then:
  const manifest = JSON.parse(
    await readFile(join(dir, "mutant-manifest.json"), "utf8"),
  );
  expect(manifest.selectorIds).toEqual({ selectorId: 60000, controlId: 60001, tableId: 60002 });
  const entry = manifest.mutants[0];
  expect(entry.astHash).toMatch(/^[0-9a-f]{8,}$/);
  expect(entry.codeunitId).toBe(70000);          // id from the fixture codeunit header
  expect(entry.codeunitName).toBe("Sample");     // name from the fixture codeunit header
  expect(entry.procedureName).not.toBe("");
  expect(entry.startLine).toBeGreaterThan(0);
});
```

Adapt the literal id/name assertions to the fixture AL source the existing test file already uses (read that test first; keep its fixture, assert its actual codeunit id/name). Update all existing `WriteInput` construction in tests: `selectorObjectId: 60000` → `selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 }`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/schemata/tests/project.test.ts`
Expected: FAIL — type error on `selectorIds` / missing manifest fields.

- [ ] **Step 3: Implement in `project.ts`**

```ts
import {
  type ALSyntaxNode,
  type MutationSpec,
  astSubtreeHash,
  findEnclosingProcedure,
} from "@lethal/engine";
```

Replace the `selectorObjectId` plumbing with `selectorIds: SelectorConfig` end to end (WriteInput, manifest, emission calls from Task 1 Step 5 use `input.selectorIds` directly — delete the `+1/+2` mapping).

Enrichment helpers (module-local):

```ts
function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

const OBJECT_HEADER = /^\s*(codeunit|table|page|report|query|xmlport|enum)\s+(\d+)\s+("([^"]+)"|(\w+))/im;

function objectHeaderOf(source: string): { id: number; name: string } {
  const m = OBJECT_HEADER.exec(source);
  if (!m) throw new Error("instrumented file has no AL object header");
  return { id: Number(m[2]), name: m[4] ?? m[5] ?? "" };
}

function procedureNameOf(spec: MutationSpec): string {
  const proc = findEnclosingProcedure(spec.before);
  if (!proc) return "";
  const nameNode = proc.childForFieldName?.("name");
  return nameNode?.text ?? "";
}
```

Grammar note (from Layer 3 plan): `procedure` has a field `name`. If `ALSyntaxNode` lacks `childForFieldName`, use the engine's existing accessor for field children (check `packages/engine/src/ast/syntax-node.ts` — Layer 1 wrapped tree-sitter nodes; use whatever accessor `semantic/symbol-table.ts` uses to read procedure names, and mirror it).

Manifest construction gains per-entry:

```ts
      const header = objectHeaderOf(f.source);
      manifest.push({
        mutantId,
        file: f.path,
        startIndex: spec.before.startIndex,
        endIndex: spec.before.endIndex,
        startLine: lineOfIndex(f.source, spec.before.startIndex),
        operatorName: spec.operatorName,
        operatorVersion: spec.operatorVersion,
        astHash: astSubtreeHash(spec.before),
        codeunitId: header.id,
        codeunitName: header.name,
        procedureName: procedureNameOf(spec),
      });
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/schemata` then `bun test`
Expected: PASS across the board.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add packages/schemata
git commit -m "feat(schemata): enrich mutant manifest with identity + coverage fields

astHash, codeunitId/Name, procedureName, startLine per entry;
WriteInput takes explicit selectorIds. Runner consumes the manifest
without re-parsing instrumented sources."
```

---

## Task 3: `@lethal/runner` scaffold, backend types, test discovery

**Files:**
- Create: `packages/runner/package.json`
- Create: `packages/runner/tsconfig.json`
- Modify: `U:/Git/LethAL/tsconfig.json` (add project reference — copy the pattern used for `builtin-tier1`)
- Create: `packages/runner/src/backend.ts`
- Create: `packages/runner/src/discovery.ts`
- Create: `packages/runner/src/index.ts`
- Create: `packages/runner/tests/discovery.test.ts`
- Create: `packages/runner/tests/fixtures/al/SampleTests.Codeunit.al`

**Interfaces:**
- Produces (used by every later task):

```ts
// backend.ts — the complete file
export interface TestMethodRef {
  readonly codeunitId: number;
  readonly codeunitName: string;
  readonly method: string;
}

export type TestOutcome = "pass" | "fail" | "skip" | "timeout" | "error";

export interface CoverageEntry {
  readonly objectType: string;
  readonly objectId: number;
  readonly procedure: string;
  readonly line?: number;
}

export interface CoverageMap {
  readonly granularity: "procedure" | "line";
  readonly entries: readonly CoverageEntry[];
}

export interface TestVerdict {
  readonly ref: TestMethodRef;
  readonly outcome: TestOutcome;
  readonly durationMs: number;
  readonly failureMessage?: string;
  readonly coverage?: CoverageMap;
}

export interface BackendCapabilities {
  readonly coverage: "none" | "procedure" | "line";
  readonly deploy: "publish" | "none";
  readonly isolation: "session" | "full-reset";
  readonly authoritative: boolean;
}

export interface BackendStatus {
  readonly ok: boolean;
  readonly details: string;
}

export interface RunOpts {
  readonly coverage: "none" | "procedure" | "line";
  readonly timeoutMs: number;
}

export interface ExecutionBackend {
  capabilities(): BackendCapabilities;
  status(): Promise<BackendStatus>;
  deploy(instrumentedDir: string): Promise<void>;
  activate(mutantId: string | null): Promise<void>;
  run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict>;
}
```

  - `discoverTests(testDir: string): Promise<TestMethodRef[]>` from `discovery.ts`.

- [ ] **Step 1: Scaffold package**

`packages/runner/package.json`:

```json
{
  "name": "@lethal/runner",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@lethal/engine": "workspace:*",
    "@lethal/schemata": "workspace:*",
    "@lethal/builtin-tier1": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

`packages/runner/tsconfig.json`: copy `packages/builtin-tier1/tsconfig.json`, adjust `references` to engine, schemata, builtin-tier1. Add the project reference in root `tsconfig.json`. Run `bun install`.

- [ ] **Step 2: Write `backend.ts`** — exactly the interface block above. Write `src/index.ts` exporting everything from `./backend` and `./discovery`.

- [ ] **Step 3: Failing discovery test**

`packages/runner/tests/fixtures/al/SampleTests.Codeunit.al`:

```al
codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;
    TestIsolation = Function;

    [Test]
    procedure PostingUpdatesTotal()
    begin
    end;

    [Test]
    [HandlerFunctions('MsgHandler')]
    procedure DiscountCapped()
    begin
    end;

    procedure Helper()
    begin
    end;

    [MessageHandler]
    procedure MsgHandler(Msg: Text[1024])
    begin
    end;
}
```

`packages/runner/tests/discovery.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverTests } from "../src/discovery";

describe("discoverTests", () => {
  test("finds [Test] methods in Subtype=Test codeunits, skips helpers and handlers", async () => {
    const refs = await discoverTests(join(import.meta.dir, "fixtures", "al"));
    expect(refs).toEqual([
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" },
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "DiscountCapped" },
    ]);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `bun test packages/runner`
Expected: FAIL — `discovery.ts` missing.

- [ ] **Step 5: Implement `discovery.ts`**

Regex-based (deliberate: matches bc-dev's filesystem-only discovery; no server, no grammar-shape risk):

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestMethodRef } from "./backend";

const CODEUNIT_HEADER = /codeunit\s+(\d+)\s+("([^"]+)"|(\w+))/i;
const SUBTYPE_TEST = /Subtype\s*=\s*Test\s*;/i;
const TEST_METHOD = /\[Test\]\s*(?:\[[^\]]*\]\s*)*procedure\s+("([^"]+)"|(\w+))\s*\(/gi;

export async function discoverTests(testDir: string): Promise<TestMethodRef[]> {
  const refs: TestMethodRef[] = [];
  const entries = await readdir(testDir, { recursive: true });
  const alFiles = entries.filter((e) => e.toLowerCase().endsWith(".al")).sort();
  for (const rel of alFiles) {
    const source = await readFile(join(testDir, rel), "utf8");
    const header = CODEUNIT_HEADER.exec(source);
    if (!header || !SUBTYPE_TEST.test(source)) continue;
    const codeunitId = Number(header[1]);
    const codeunitName = header[3] ?? header[4] ?? "";
    for (const m of source.matchAll(TEST_METHOD)) {
      refs.push({ codeunitId, codeunitName, method: m[2] ?? m[3] ?? "" });
    }
  }
  return refs;
}
```

- [ ] **Step 6: Run tests**

Run: `bun test packages/runner`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add packages/runner tsconfig.json bun.lock
git commit -m "feat(runner): package scaffold, ExecutionBackend types, test discovery"
```

---

## Task 4: Selection — identity key, history filter, overlap batcher

**Files:**
- Create: `packages/runner/src/selection.ts`
- Create: `packages/runner/tests/selection.test.ts`

**Interfaces:**
- Consumes: `MutantManifestEntry` from `@lethal/schemata` (Task 2 shape).
- Produces (used by Tasks 6, 11):

```ts
export interface IdentityKey {
  readonly astHash: string;
  readonly codeunitName: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
}
export function identityKeyOf(m: MutantManifestEntry): IdentityKey;
export function serializeKey(k: IdentityKey): string;      // "hash|codeunit|op|major"
export interface HistorySplit {
  readonly execute: MutantManifestEntry[];
  readonly knownSurvivors: MutantManifestEntry[];
}
export function filterHistory(
  mutants: readonly MutantManifestEntry[],
  priorSurvivorKeys: ReadonlySet<string>,
  opts: { skipKnownSurvivors: boolean },
): HistorySplit;
export function batchByOverlap(
  mutants: readonly MutantManifestEntry[],
): MutantManifestEntry[][];
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { batchByOverlap, filterHistory, identityKeyOf, serializeKey } from "../src/selection";

function entry(over: Partial<Record<string, unknown>> = {}) {
  return {
    mutantId: "M0001",
    file: "Sample.Codeunit.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 2,
    operatorName: "conditional-boundary",
    operatorVersion: "1.2.0",
    astHash: "abc123",
    codeunitId: 70000,
    codeunitName: "Sample",
    procedureName: "Post",
    ...over,
  };
}

describe("identityKeyOf", () => {
  test("major version extracted; file/line excluded", () => {
    const k = identityKeyOf(entry({ operatorVersion: "2.9.1" }));
    expect(k).toEqual({
      astHash: "abc123",
      codeunitName: "Sample",
      operatorName: "conditional-boundary",
      operatorMajor: 2,
    });
  });
});

describe("filterHistory", () => {
  const survivorKey = serializeKey(identityKeyOf(entry()));
  test("default: everything executes", () => {
    const s = filterHistory([entry()], new Set([survivorKey]), { skipKnownSurvivors: false });
    expect(s.execute.length).toBe(1);
    expect(s.knownSurvivors.length).toBe(0);
  });
  test("skipKnownSurvivors demotes matching keys", () => {
    const fresh = entry({ mutantId: "M0002", astHash: "zzz999" });
    const s = filterHistory([entry(), fresh], new Set([survivorKey]), { skipKnownSurvivors: true });
    expect(s.execute).toEqual([fresh]);
    expect(s.knownSurvivors.length).toBe(1);
  });
});

describe("batchByOverlap", () => {
  test("non-overlapping mutants share a batch", () => {
    const a = entry({ mutantId: "M0001", startIndex: 0, endIndex: 10 });
    const b = entry({ mutantId: "M0002", startIndex: 20, endIndex: 30 });
    expect(batchByOverlap([a, b])).toEqual([[a, b]]);
  });
  test("overlapping mutants split into later batches", () => {
    const a = entry({ mutantId: "M0001", startIndex: 0, endIndex: 15 });
    const b = entry({ mutantId: "M0002", startIndex: 10, endIndex: 30 });
    const c = entry({ mutantId: "M0003", startIndex: 12, endIndex: 14 });
    const batches = batchByOverlap([a, b, c]);
    expect(batches.length).toBe(3);
    expect(batches.flat().length).toBe(3);
  });
  test("same offsets in different files do not overlap", () => {
    const a = entry({ mutantId: "M0001" });
    const b = entry({ mutantId: "M0002", file: "Other.Codeunit.al" });
    expect(batchByOverlap([a, b]).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/runner/tests/selection.test.ts` → FAIL.

- [ ] **Step 3: Implement `selection.ts`**

```ts
import type { MutantManifestEntry } from "@lethal/schemata";

export interface IdentityKey {
  readonly astHash: string;
  readonly codeunitName: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
}

export function identityKeyOf(m: MutantManifestEntry): IdentityKey {
  return {
    astHash: m.astHash,
    codeunitName: m.codeunitName,
    operatorName: m.operatorName,
    operatorMajor: Number(m.operatorVersion.split(".")[0] ?? "0"),
  };
}

export function serializeKey(k: IdentityKey): string {
  return `${k.astHash}|${k.codeunitName}|${k.operatorName}|${k.operatorMajor}`;
}

export interface HistorySplit {
  readonly execute: MutantManifestEntry[];
  readonly knownSurvivors: MutantManifestEntry[];
}

export function filterHistory(
  mutants: readonly MutantManifestEntry[],
  priorSurvivorKeys: ReadonlySet<string>,
  opts: { skipKnownSurvivors: boolean },
): HistorySplit {
  if (!opts.skipKnownSurvivors) return { execute: [...mutants], knownSurvivors: [] };
  const execute: MutantManifestEntry[] = [];
  const knownSurvivors: MutantManifestEntry[] = [];
  for (const m of mutants) {
    if (priorSurvivorKeys.has(serializeKey(identityKeyOf(m)))) knownSurvivors.push(m);
    else execute.push(m);
  }
  return { execute, knownSurvivors };
}

function overlaps(a: MutantManifestEntry, b: MutantManifestEntry): boolean {
  return a.file === b.file && a.startIndex < b.endIndex && b.startIndex < a.endIndex;
}

export function batchByOverlap(
  mutants: readonly MutantManifestEntry[],
): MutantManifestEntry[][] {
  const sorted = [...mutants].sort(
    (a, b) => a.file.localeCompare(b.file) || a.startIndex - b.startIndex,
  );
  const batches: MutantManifestEntry[][] = [];
  for (const m of sorted) {
    let placed = false;
    for (const batch of batches) {
      if (!batch.some((x) => overlaps(x, m))) {
        batch.push(m);
        placed = true;
        break;
      }
    }
    if (!placed) batches.push([m]);
  }
  return batches;
}
```

Note the batcher works on manifest entries, but batching must happen BEFORE `writeInstrumentedProject` (ids are assigned at write). At orchestration time (Task 11) batching operates on `MutationSpec`s pre-write; to keep one algorithm, Task 11 wraps specs in a minimal `{file, startIndex, endIndex}` shape and reuses `batchByOverlap` via structural typing — therefore relax the parameter type here to:

```ts
export interface OverlapSite {
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
}
export function batchByOverlap<T extends OverlapSite>(mutants: readonly T[]): T[][];
```

(Implement generically; the tests above still pass unchanged.)

- [ ] **Step 4: Run tests** — PASS. Export from `index.ts`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
git add packages/runner
git commit -m "feat(runner): identity keys, history filter, generic overlap batcher"
```

---

## Task 5: Results store (bun:sqlite)

**Files:**
- Create: `packages/runner/src/store.ts`
- Create: `packages/runner/tests/store.test.ts`

**Interfaces:**
- Consumes: `TestMethodRef`, `TestOutcome` (Task 3); `serializeKey`/`identityKeyOf` (Task 4).
- Produces (used by Task 11):

```ts
export type MutantVerdict =
  | "killed" | "survived" | "no-coverage" | "timeout-killed" | "known-survivor" | "error";

export interface MutantRow {
  readonly mutantCode: string;
  readonly astHash: string;
  readonly codeunitName: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
  readonly file: string;
  readonly line: number;
  readonly verdict: MutantVerdict;
  readonly killingTest?: string;
  readonly durationMs: number;
}

export class ResultsStore {
  constructor(dbPath: string);                       // ":memory:" supported
  createRun(info: { projectPath: string; backend: string; appVersion: string }): number;
  finishRun(runId: number, info: { batchCount: number; baselineGreen: boolean }): void;
  recordMutant(runId: number, row: MutantRow): void; // one transaction per call
  recordTestResult(runId: number, mutantCode: string | null, ref: TestMethodRef,
                   outcome: TestOutcome, durationMs: number, failureMessage?: string): void;
  priorSurvivorKeys(projectPath: string): Set<string>;  // serialized keys of latest-run survivors
  close(): void;
}
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { ResultsStore } from "../src/store";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

function mutantRow(verdict: string, over: Record<string, unknown> = {}) {
  return {
    mutantCode: "M0001",
    astHash: "abc123",
    codeunitName: "Sample",
    operatorName: "conditional-boundary",
    operatorMajor: 1,
    file: "Sample.Codeunit.al",
    line: 12,
    verdict,
    durationMs: 40,
    ...over,
  };
}

describe("ResultsStore", () => {
  test("round-trips a run with mutants and test results", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.1.1" });
    store.recordTestResult(runId, null, ref, "pass", 30);
    store.recordMutant(runId, mutantRow("killed", { killingTest: "PostingUpdatesTotal" }));
    store.recordMutant(runId, mutantRow("survived", { mutantCode: "M0002", astHash: "def456" }));
    store.finishRun(runId, { batchCount: 1, baselineGreen: true });
    expect(store.priorSurvivorKeys("/p")).toEqual(
      new Set(["def456|Sample|conditional-boundary|1"]),
    );
    store.close();
  });

  test("priorSurvivorKeys reads only the latest finished run for the project", () => {
    const store = new ResultsStore(":memory:");
    const r1 = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
    store.recordMutant(r1, mutantRow("survived"));
    store.finishRun(r1, { batchCount: 1, baselineGreen: true });
    const r2 = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "2" });
    store.recordMutant(r2, mutantRow("killed"));
    store.finishRun(r2, { batchCount: 1, baselineGreen: true });
    expect(store.priorSurvivorKeys("/p").size).toBe(0);
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL, `store.ts` missing.

- [ ] **Step 3: Implement `store.ts`**

```ts
import { Database } from "bun:sqlite";
import type { TestMethodRef, TestOutcome } from "./backend";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  project_path TEXT NOT NULL,
  backend TEXT NOT NULL,
  app_version TEXT NOT NULL,
  batch_count INTEGER,
  baseline_green INTEGER
);
CREATE TABLE IF NOT EXISTS mutants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  mutant_code TEXT NOT NULL,
  ast_hash TEXT NOT NULL,
  codeunit_name TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  operator_major INTEGER NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  killing_test TEXT,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutants_identity
  ON mutants(ast_hash, codeunit_name, operator_name, operator_major);
CREATE TABLE IF NOT EXISTS test_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  mutant_code TEXT,
  codeunit_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  failure_message TEXT
);
`;

export class ResultsStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  createRun(info: { projectPath: string; backend: string; appVersion: string }): number {
    const r = this.db
      .query("INSERT INTO runs (project_path, backend, app_version) VALUES (?, ?, ?) RETURNING id")
      .get(info.projectPath, info.backend, info.appVersion) as { id: number };
    return r.id;
  }

  finishRun(runId: number, info: { batchCount: number; baselineGreen: boolean }): void {
    this.db
      .query("UPDATE runs SET finished_at = datetime('now'), batch_count = ?, baseline_green = ? WHERE id = ?")
      .run(info.batchCount, info.baselineGreen ? 1 : 0, runId);
  }

  recordMutant(runId: number, row: MutantRow): void {
    this.db
      .query(
        `INSERT INTO mutants (run_id, mutant_code, ast_hash, codeunit_name, operator_name,
         operator_major, file, line, verdict, killing_test, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, row.mutantCode, row.astHash, row.codeunitName, row.operatorName,
        row.operatorMajor, row.file, row.line, row.verdict, row.killingTest ?? null, row.durationMs);
  }

  recordTestResult(
    runId: number, mutantCode: string | null, ref: TestMethodRef,
    outcome: TestOutcome, durationMs: number, failureMessage?: string,
  ): void {
    this.db
      .query(
        `INSERT INTO test_results (run_id, mutant_code, codeunit_id, method, outcome, duration_ms, failure_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, mutantCode, ref.codeunitId, ref.method, outcome, durationMs, failureMessage ?? null);
  }

  priorSurvivorKeys(projectPath: string): Set<string> {
    const run = this.db
      .query(
        "SELECT id FROM runs WHERE project_path = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(projectPath) as { id: number } | null;
    if (!run) return new Set();
    const rows = this.db
      .query(
        "SELECT ast_hash, codeunit_name, operator_name, operator_major FROM mutants WHERE run_id = ? AND verdict = 'survived'",
      )
      .all(run.id) as Array<{
      ast_hash: string; codeunit_name: string; operator_name: string; operator_major: number;
    }>;
    return new Set(
      rows.map((r) => `${r.ast_hash}|${r.codeunit_name}|${r.operator_name}|${r.operator_major}`),
    );
  }

  close(): void {
    this.db.close();
  }
}
```

(Include the `MutantRow`/`MutantVerdict` type declarations from the Interfaces block above in the file.)

- [ ] **Step 4: Run tests** — PASS. Export from `index.ts`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
git add packages/runner
git commit -m "feat(runner): SQLite results store with identity-key survivor lookup"
```

---

## Task 6: Coverage inversion + coverage filter

**Files:**
- Modify: `packages/runner/src/selection.ts`
- Modify: `packages/runner/tests/selection.test.ts`

**Interfaces:**
- Consumes: `CoverageMap`, `TestMethodRef`, `TestVerdict` (Task 3); `MutantManifestEntry` (Task 2).
- Produces (used by Task 11):

```ts
export type CoverageIndex = ReadonlyMap<string /* `${objectId}::${procLower}` */, ReadonlySet<string /* testKey */>>;
export function testKeyOf(ref: TestMethodRef): string;   // `${codeunitId}::${method}`
export function buildCoverageIndex(
  baseline: ReadonlyArray<{ ref: TestMethodRef; coverage?: CoverageMap }>,
): CoverageIndex;
export interface CoverageSplit {
  readonly covered: ReadonlyMap<string /* mutantId */, readonly TestMethodRef[]>;
  readonly uncovered: MutantManifestEntry[];
}
export function coverageFilter(
  mutants: readonly MutantManifestEntry[],
  index: CoverageIndex,
  allTests: readonly TestMethodRef[],
): CoverageSplit;
```

- [ ] **Step 1: Failing tests** (append to `selection.test.ts`)

```ts
import { buildCoverageIndex, coverageFilter, testKeyOf } from "../src/selection";

const t1 = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };
const t2 = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "DiscountCapped" };

describe("coverage", () => {
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "Post" }],
      },
    },
    { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
  ];

  test("mutant in covered procedure maps to its covering tests", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "Post" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.get("M0001")).toEqual([t1]);
    expect(split.uncovered.length).toBe(0);
  });

  test("mutant in uncovered procedure lands in uncovered", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "Untested" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered.length).toBe(1);
  });

  test("procedure match is case-insensitive", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "POST" });
    expect(coverageFilter([m], index, [t1, t2]).covered.get("M0001")).toEqual([t1]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement in `selection.ts`**

```ts
export function testKeyOf(ref: TestMethodRef): string {
  return `${ref.codeunitId}::${ref.method}`;
}

export function buildCoverageIndex(
  baseline: ReadonlyArray<{ ref: TestMethodRef; coverage?: CoverageMap }>,
): CoverageIndex {
  const index = new Map<string, Set<string>>();
  for (const b of baseline) {
    for (const e of b.coverage?.entries ?? []) {
      const key = `${e.objectId}::${e.procedure.toLowerCase()}`;
      let set = index.get(key);
      if (!set) {
        set = new Set();
        index.set(key, set);
      }
      set.add(testKeyOf(b.ref));
    }
  }
  return index;
}

export function coverageFilter(
  mutants: readonly MutantManifestEntry[],
  index: CoverageIndex,
  allTests: readonly TestMethodRef[],
): CoverageSplit {
  const byKey = new Map(allTests.map((t) => [testKeyOf(t), t]));
  const covered = new Map<string, TestMethodRef[]>();
  const uncovered: MutantManifestEntry[] = [];
  for (const m of mutants) {
    const testKeys = index.get(`${m.codeunitId}::${m.procedureName.toLowerCase()}`);
    if (!testKeys || testKeys.size === 0) {
      uncovered.push(m);
      continue;
    }
    covered.set(
      m.mutantId,
      [...testKeys].flatMap((k) => byKey.get(k) ?? []),
    );
  }
  return { covered, uncovered };
}
```

- [ ] **Step 4: Run tests** — PASS. Export new names from `index.ts`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
git add packages/runner
git commit -m "feat(runner): coverage index inversion + per-mutant test selection"
```

---

## Task 7: BcDevMcpBackend — MCP client over stdio

**Files:**
- Create: `packages/runner/src/bcdev-backend.ts`
- Create: `packages/runner/tests/bcdev-backend.test.ts`

**Interfaces:**
- Consumes: `ExecutionBackend` and friends (Task 3); `Publisher` and `MutationControlClient` are injected LATER (Task 8/9 wire them in) — this task implements `capabilities`/`status`/`run`; `deploy`/`activate` throw `new Error("wired in Task 8/9")` for now.
- Produces:

```ts
export interface BcDevConfig {
  readonly mcpCommand: readonly string[];   // e.g. ["bun", "x", "bc-dev-mcp"] — argv to spawn
  readonly project: string;                 // AL project dir (launch.json defaults source)
  readonly server?: string;
  readonly serverInstance?: string;
  readonly tenant?: string;
  readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
  readonly environmentName?: string;
  readonly company?: string;
}
export class BcDevMcpBackend implements ExecutionBackend {
  constructor(cfg: BcDevConfig, transportFactory?: () => Transport);  // factory injectable for tests
}
```

**Documented response-shape assumption (verify in the Task 12 integration run):** `bcdev_test_run` returns its payload as the first `text` content item, JSON of shape
`{ results: [{ codeunitId, method, outcome: "pass"|"fail"|"skip", durationMs, failureMessage?, coverage?: { granularity, entries } }] }`.
If the real shape differs, fix the parsing in ONE place (`parseTestRunPayload`) during integration — the adapter tests pin today's assumption.

- [ ] **Step 1: Failing tests with an in-memory MCP server**

```ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BcDevMcpBackend } from "../src/bcdev-backend";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

function makeBackend(handler: (args: unknown) => unknown) {
  const server = new McpServer({ name: "fake-bc-dev", version: "0.0.0" });
  server.tool("bcdev_test_run", { type: "object" } as never, async (args: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(handler(args)) }],
  }));
  server.tool("bcdev_status", { type: "object" } as never, async () => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true, details: "fake" }) }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return new BcDevMcpBackend(
    { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
    () => clientTransport,
  );
}

describe("BcDevMcpBackend.run", () => {
  test("maps a passing result with coverage", async () => {
    const backend = makeBackend(() => ({
      results: [{
        codeunitId: 79100, method: "PostingUpdatesTotal", outcome: "pass", durationMs: 42,
        coverage: {
          granularity: "procedure",
          entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "Post" }],
        },
      }],
    }));
    const v = await backend.run(ref, { coverage: "procedure", timeoutMs: 5000 });
    expect(v.outcome).toBe("pass");
    expect(v.durationMs).toBe(42);
    expect(v.coverage?.entries[0]?.procedure).toBe("Post");
  });

  test("forwards codeunit/method restriction and connection params", async () => {
    let seen: unknown;
    const backend = makeBackend((args) => {
      seen = args;
      return { results: [{ codeunitId: 79100, method: "PostingUpdatesTotal", outcome: "pass", durationMs: 1 }] };
    });
    await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(seen).toMatchObject({
      codeunits: [{ id: 79100, methods: ["PostingUpdatesTotal"] }],
      coverage: "none",
      project: "/al",
      server: "http://bc",
      serverInstance: "BC",
    });
  });

  test("maps a failing result", async () => {
    const backend = makeBackend(() => ({
      results: [{ codeunitId: 79100, method: "PostingUpdatesTotal", outcome: "fail", durationMs: 7, failureMessage: "expected 2, got 1" }],
    }));
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("fail");
    expect(v.failureMessage).toBe("expected 2, got 1");
  });

  test("timeout yields outcome=timeout", async () => {
    const backend = makeBackend(() => new Promise(() => {}) as never);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("timeout");
  });

  test("transport error yields outcome=error", async () => {
    const backend = makeBackend(() => {
      throw new Error("NST unreachable");
    });
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("NST unreachable");
  });
});
```

Note on the fake-server API: `McpServer.tool()` signature varies across SDK minors — check the installed `@modelcontextprotocol/sdk` version's docs (`node_modules/@modelcontextprotocol/sdk/README.md`) and adjust registration; the assertions stay the same.

- [ ] **Step 2: Run to verify failure** — FAIL, module missing.

- [ ] **Step 3: Implement `bcdev-backend.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  BackendCapabilities, BackendStatus, ExecutionBackend, RunOpts, TestMethodRef, TestVerdict,
} from "./backend";

export interface BcDevConfig { /* as in the Interfaces block */ }

import type { CoverageMap } from "./backend";

interface RawResult {
  codeunitId: number;
  method: string;
  outcome: "pass" | "fail" | "skip";
  durationMs: number;
  failureMessage?: string;
  coverage?: CoverageMap;
}

interface TestRunPayload {
  results: RawResult[];
}

export class BcDevMcpBackend implements ExecutionBackend {
  private client: Client | undefined;

  constructor(
    private readonly cfg: BcDevConfig,
    private readonly transportFactory?: () => Transport,
  ) {}

  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const transport = this.transportFactory
      ? this.transportFactory()
      : new StdioClientTransport({
          command: this.cfg.mcpCommand[0] ?? "",
          args: [...this.cfg.mcpCommand.slice(1)],
        });
    const client = new Client({ name: "lethal-runner", version: "0.0.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  private connectionParams(): Record<string, unknown> {
    const { project, server, serverInstance, tenant, environmentType, environmentName, company } = this.cfg;
    return Object.fromEntries(
      Object.entries({ project, server, serverInstance, tenant, environmentType, environmentName, company })
        .filter(([, v]) => v !== undefined),
    );
  }

  async status(): Promise<BackendStatus> {
    try {
      const client = await this.connect();
      const res = await client.callTool({ name: "bcdev_status", arguments: this.connectionParams() });
      const text = firstText(res);
      return { ok: true, details: text };
    } catch (err) {
      return { ok: false, details: String(err) };
    }
  }

  async deploy(_instrumentedDir: string): Promise<void> {
    throw new Error("BcDevMcpBackend.deploy wired in Task 8");
  }

  async activate(_mutantId: string | null): Promise<void> {
    throw new Error("BcDevMcpBackend.activate wired in Task 9");
  }

  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const started = Date.now();
    try {
      const client = await this.connect();
      const call = client.callTool({
        name: "bcdev_test_run",
        arguments: {
          codeunits: [{ id: ref.codeunitId, methods: [ref.method] }],
          coverage: opts.coverage,
          ...this.connectionParams(),
        },
      });
      const res = await Promise.race([
        call,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), opts.timeoutMs)),
      ]);
      if (res === "timeout") {
        call.catch(() => {}); // late result/error deliberately discarded
        return { ref, outcome: "timeout", durationMs: Date.now() - started };
      }
      const payload = parseTestRunPayload(firstText(res));
      const r = payload.results.find(
        (x) => x.codeunitId === ref.codeunitId && x.method === ref.method,
      );
      if (!r) {
        return { ref, outcome: "error", durationMs: Date.now() - started,
          failureMessage: "bcdev_test_run returned no result for the requested method" };
      }
      return {
        ref, outcome: r.outcome, durationMs: r.durationMs,
        failureMessage: r.failureMessage,
        coverage: r.coverage,
      };
    } catch (err) {
      return { ref, outcome: "error", durationMs: Date.now() - started, failureMessage: String(err) };
    }
  }
}

function firstText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const t = content.find((c) => c.type === "text")?.text;
  if (t === undefined) throw new Error("MCP result had no text content");
  return t;
}

function parseTestRunPayload(text: string): TestRunPayload {
  return JSON.parse(text) as TestRunPayload;
}
```

- [ ] **Step 4: Run tests** — PASS. Export `BcDevMcpBackend`, `BcDevConfig` from `index.ts`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
git add packages/runner
git commit -m "feat(runner): BcDevMcpBackend MCP client (run/status; deploy+activate stubs)"
```

---

## Task 8: Publisher (alc compile + altool publishapp) wired into BcDevMcpBackend.deploy

**Files:**
- Create: `packages/runner/src/publisher.ts`
- Create: `packages/runner/tests/publisher.test.ts`
- Modify: `packages/runner/src/bcdev-backend.ts` (deploy delegates to an injected `Publisher`)

**Interfaces:**
- Produces:

```ts
export type SpawnFn = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export interface PublisherConfig {
  readonly alcPath: string;
  readonly altoolPath: string;
  readonly packageCachePath: string;    // target project's .alpackages
  readonly outputDir: string;           // where the .app lands
  readonly server: string;
  readonly serverInstance: string;
  readonly tenant?: string;
}
export class Publisher {
  constructor(cfg: PublisherConfig, spawn?: SpawnFn);   // default SpawnFn uses Bun.spawn
  compile(instrumentedDir: string): Promise<string>;    // returns .app path; throws with stderr on failure
  publish(appPath: string): Promise<void>;              // throws with stderr on failure
}
export function defaultAlToolPaths(): { alcPath: string; altoolPath: string } | undefined;
// scans ~/.vscode/extensions/ms-dynamics-smb.al-* (newest by version), returns bin paths
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { Publisher } from "../src/publisher";

function recordingSpawn(result = { exitCode: 0, stdout: "", stderr: "" }) {
  const calls: string[][] = [];
  const spawn = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return result;
  };
  return { calls, spawn };
}

const cfg = {
  alcPath: "C:/ext/bin/alc.exe",
  altoolPath: "C:/ext/bin/altool.exe",
  packageCachePath: "C:/proj/.alpackages",
  outputDir: "C:/out",
  server: "http://bcserver",
  serverInstance: "BC",
};

describe("Publisher.compile", () => {
  test("invokes alc with project, packagecache, out", async () => {
    const { calls, spawn } = recordingSpawn();
    const appPath = await new Publisher(cfg, spawn).compile("C:/instr");
    expect(calls[0]?.[0]).toBe("C:/ext/bin/alc.exe");
    expect(calls[0]).toContain("/project:C:/instr");
    expect(calls[0]).toContain("/packagecachepath:C:/proj/.alpackages");
    expect(appPath.startsWith("C:/out")).toBe(true);
  });

  test("failure surfaces stderr verbatim", async () => {
    const { spawn } = recordingSpawn({ exitCode: 1, stdout: "", stderr: "AL0132: nope" });
    await expect(new Publisher(cfg, spawn).compile("C:/instr")).rejects.toThrow("AL0132: nope");
  });
});

describe("Publisher.publish", () => {
  test("invokes altool publishapp with server params and ForceSync", async () => {
    const { calls, spawn } = recordingSpawn();
    await new Publisher(cfg, spawn).publish("C:/out/x.app");
    expect(calls[0]?.slice(0, 2)).toEqual(["C:/ext/bin/altool.exe", "publishapp"]);
    expect(calls[0]).toContain("C:/out/x.app");
    expect(calls[0]?.join(" ")).toContain("ForceSync");
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement `publisher.ts`**

```ts
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SpawnFn = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const bunSpawn: SpawnFn = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
};

export class Publisher {
  constructor(
    private readonly cfg: PublisherConfig,
    private readonly spawn: SpawnFn = bunSpawn,
  ) {}

  async compile(instrumentedDir: string): Promise<string> {
    const appPath = join(this.cfg.outputDir, "lethal-instrumented.app");
    const res = await this.spawn([
      this.cfg.alcPath,
      `/project:${instrumentedDir}`,
      `/packagecachepath:${this.cfg.packageCachePath}`,
      `/out:${appPath}`,
    ]);
    if (res.exitCode !== 0) {
      throw new Error(`alc compile failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`);
    }
    return appPath;
  }

  async publish(appPath: string): Promise<void> {
    const argv = [
      this.cfg.altoolPath, "publishapp", appPath,
      "--server", this.cfg.server,
      "--serverInstance", this.cfg.serverInstance,
      "--schemaSyncMode", "ForceSync",
    ];
    if (this.cfg.tenant) argv.push("--tenant", this.cfg.tenant);
    const res = await this.spawn(argv);
    if (res.exitCode !== 0) {
      throw new Error(`altool publishapp failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`);
    }
  }
}

export async function defaultAlToolPaths(): Promise<{ alcPath: string; altoolPath: string } | undefined> {
  const extDir = join(homedir(), ".vscode", "extensions");
  let entries: string[];
  try {
    entries = await readdir(extDir);
  } catch {
    return undefined;
  }
  const al = entries.filter((e) => e.startsWith("ms-dynamics-smb.al-")).sort().at(-1);
  if (!al) return undefined;
  const bin = join(extDir, al, "bin", "win32");
  return { alcPath: join(bin, "alc.exe"), altoolPath: join(bin, "altool.exe") };
}
```

**`altool` flag caveat:** exact flag names (`--server` vs `-Server`, `--schemaSyncMode` casing) MUST be verified against `altool.exe publishapp --help` during the Task 12 integration run — earlier investigation confirmed the verbs exist, not the exact flag spellings. The tests pin the current guess; correct both together in one commit if the help output differs.

- [ ] **Step 4: Wire into `BcDevMcpBackend`**

Constructor gains an optional `publisher?: Publisher`; `deploy(instrumentedDir)` becomes:

```ts
  async deploy(instrumentedDir: string): Promise<void> {
    if (!this.publisher) throw new Error("BcDevMcpBackend: no Publisher configured");
    const appPath = await this.publisher.compile(instrumentedDir);
    await this.publisher.publish(appPath);
  }
```

Add a backend test: recording-spawn Publisher injected, `deploy("/instr")` → both alc and altool invoked in order.

- [ ] **Step 5: Run tests** — PASS. Export from `index.ts`.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
git add packages/runner
git commit -m "feat(runner): alc+altool publisher wired into BcDevMcpBackend.deploy"
```

---

## Task 9: Activation client wired into BcDevMcpBackend.activate + spec auth amendment

**Files:**
- Create: `packages/runner/src/activation.ts`
- Create: `packages/runner/tests/activation.test.ts`
- Modify: `packages/runner/src/bcdev-backend.ts`
- Modify: `docs/superpowers/specs/2026-07-17-layer-4-execution-runtime-design.md` (one line: NTLM → Basic/NavUserPassword, Windows auth deferred)

**Interfaces:**
- Produces:

```ts
export type FetchFn = typeof fetch;
export interface ActivationConfig {
  readonly baseUrl: string;         // e.g. http://bcserver:7048/BC
  readonly company: string;
  readonly username: string;
  readonly password: string;        // NavUserPassword (Basic) — Windows auth deferred
}
export class MutationControlClient {
  constructor(cfg: ActivationConfig, fetchFn?: FetchFn);
  setActive(mutantId: string): Promise<void>;   // verifies the echoed id; throws on mismatch
  clearActive(): Promise<void>;
}
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { MutationControlClient } from "../src/activation";

const cfg = { baseUrl: "http://bc:7048/BC", company: "CRONUS", username: "u", password: "p" };

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("MutationControlClient.setActive", () => {
  test("POSTs to the unbound action with basic auth and verifies the echo", async () => {
    const { calls, fetchFn } = fakeFetch(200, { value: "M0007" });
    await new MutationControlClient(cfg, fetchFn).setActive("M0007");
    const call = calls[0];
    expect(call?.url).toBe(
      "http://bc:7048/BC/ODataV4/MutationControl_SetActive?company=CRONUS",
    );
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(`Basic ${btoa("u:p")}`);
    expect(call?.init.body).toBe(JSON.stringify({ mutantId: "M0007" }));
  });

  test("echo mismatch throws", async () => {
    const { fetchFn } = fakeFetch(200, { value: "M0001" });
    await expect(new MutationControlClient(cfg, fetchFn).setActive("M0007"))
      .rejects.toThrow("activation echo mismatch");
  });

  test("HTTP failure throws with status", async () => {
    const { fetchFn } = fakeFetch(401, {});
    await expect(new MutationControlClient(cfg, fetchFn).setActive("M0007"))
      .rejects.toThrow("401");
  });
});

describe("MutationControlClient.clearActive", () => {
  test("POSTs ClearActive", async () => {
    const { calls, fetchFn } = fakeFetch(200, {});
    await new MutationControlClient(cfg, fetchFn).clearActive();
    expect(calls[0]?.url).toContain("MutationControl_ClearActive");
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement `activation.ts`**

```ts
export class MutationControlClient {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async post(action: string, body?: Record<string, unknown>): Promise<unknown> {
    const url = `${this.cfg.baseUrl}/ODataV4/MutationControl_${action}?company=${encodeURIComponent(this.cfg.company)}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`MutationControl_${action} failed: HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  async setActive(mutantId: string): Promise<void> {
    const payload = (await this.post("SetActive", { mutantId })) as { value?: string };
    if (payload.value !== mutantId) {
      throw new Error(
        `activation echo mismatch: sent ${mutantId}, got ${String(payload.value)}`,
      );
    }
  }

  async clearActive(): Promise<void> {
    await this.post("ClearActive");
  }
}
```

OData note: BC unbound codeunit actions take parameter names camel-cased from the AL signature (`MutantId` → `mutantId`) and return `{"value": <return>}` — this matches the emitted `SetActive(MutantId: Text): Text`. Verify against the live server in Task 12; company-name casing matters.

- [ ] **Step 4: Wire into `BcDevMcpBackend`**

Constructor gains optional `activation?: MutationControlClient`. `activate(mutantId)`:

```ts
  async activate(mutantId: string | null): Promise<void> {
    if (!this.activation) throw new Error("BcDevMcpBackend: no activation client configured");
    if (mutantId === null) await this.activation.clearActive();
    else await this.activation.setActive(mutantId);
  }
```

Backend test: fake fetch injected via a real `MutationControlClient`, `activate("M0002")` hits SetActive, `activate(null)` hits ClearActive.

- [ ] **Step 5: Amend the spec** — in the design doc's §5 BcDevMcpBackend bullet on activation, replace "OnPrem NTLM auth" with "Basic auth (NavUserPassword) — `fetch` cannot perform the NTLM handshake; Windows-auth support deferred".

- [ ] **Step 6: Run tests, lint, typecheck, commit**

```bash
bun test packages/runner && bun run lint && bun run typecheck
git add packages/runner docs/superpowers/specs/2026-07-17-layer-4-execution-runtime-design.md
git commit -m "feat(runner): OData activation client wired into BcDevMcpBackend

Spec amended: activation auth is Basic (NavUserPassword); NTLM/Windows
auth deferred - fetch cannot perform the NTLM handshake."
```

---

## Task 10: AlRunnerBackend + MsInMemoryBackend placeholder

**Files:**
- Create: `packages/runner/src/al-runner-backend.ts`
- Create: `packages/runner/src/ms-inmemory-backend.ts`
- Create: `packages/runner/tests/al-runner-backend.test.ts`

**Interfaces:**
- Consumes: `emitStaticSelector` from `@lethal/schemata` (Task 1); `SpawnFn` from Task 8; `ExecutionBackend` types.
- Produces:

```ts
export interface AlRunnerConfig {
  readonly alRunnerPath: string;      // path to the al-runner executable
  readonly instrumentedDir: string;   // schemata output (LethAL-owned scratch)
  readonly testDir: string;
  readonly packagesDir?: string;      // --packages symbol resolution
  readonly stubsDir?: string;         // --stubs for target-app dependencies
  readonly selectorObjectId: number;  // id used when rewriting MutationSelector.Codeunit.al
}
export class AlRunnerBackend implements ExecutionBackend;
export class MsInMemoryBackend implements ExecutionBackend;  // every method throws
```

**Documented CLI assumption (verify in Task 12):** `al-runner --run <method> <srcDir> <testDir> --output-json` prints JSON `{ tests: [{ codeunit, method, result: "pass"|"fail", durationMs, message? }] }` to stdout; exit 0 all-pass, 1 failures, 2 runner limitation, 3 compile error. Parse pinned in `parseAlRunnerOutput` — one place to fix.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import { MsInMemoryBackend } from "../src/ms-inmemory-backend";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

function okSpawn(payload: unknown, exitCode = 0) {
  const calls: string[][] = [];
  const spawn = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { exitCode, stdout: JSON.stringify(payload), stderr: "" };
  };
  return { calls, spawn };
}

async function makeBackend(spawn: ReturnType<typeof okSpawn>["spawn"]) {
  const dir = await mkdtemp(join(tmpdir(), "lethal-alrunner-"));
  await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
  return {
    dir,
    backend: new AlRunnerBackend(
      { alRunnerPath: "al-runner", instrumentedDir: dir, testDir: "/tests", selectorObjectId: 50000 },
      spawn,
    ),
  };
}

describe("AlRunnerBackend.activate", () => {
  test("rewrites MutationSelector.Codeunit.al with the hardcoded id", async () => {
    const { dir, backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    await backend.activate("M0009");
    const src = await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8");
    expect(src).toContain("exit(MutantId = 'M0009');");
    await backend.activate(null);
    const cleared = await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8");
    expect(cleared).toContain("exit(false);");
  });
});

describe("AlRunnerBackend.run", () => {
  test("spawns al-runner with --run and parses a pass", async () => {
    const { calls, spawn } = okSpawn({
      tests: [{ codeunit: "Sandbox Tests", method: "PostingUpdatesTotal", result: "pass", durationMs: 3 }],
    });
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("pass");
    expect(calls[0]).toContain("--run");
    expect(calls[0]).toContain("PostingUpdatesTotal");
    expect(calls[0]).toContain("--output-json");
  });

  test("exit 1 with fail result maps to fail", async () => {
    const { spawn } = okSpawn(
      { tests: [{ codeunit: "Sandbox Tests", method: "PostingUpdatesTotal", result: "fail", durationMs: 3, message: "boom" }] },
      1,
    );
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("fail");
    expect(v.failureMessage).toBe("boom");
  });

  test("exit 2 maps to skip, exit 3 maps to error", async () => {
    for (const [code, outcome] of [[2, "skip"], [3, "error"]] as const) {
      const { backend } = await makeBackend(okSpawn({ tests: [] }, code).spawn);
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
      expect(v.outcome).toBe(outcome);
    }
  });
});

describe("AlRunnerBackend capabilities", () => {
  test("in-memory profile", async () => {
    const { backend } = await makeBackend(okSpawn({ tests: [] }).spawn);
    expect(backend.capabilities()).toEqual({
      coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false,
    });
  });
});

describe("MsInMemoryBackend", () => {
  test("throws with a pointer to the spec", () => {
    const b = new MsInMemoryBackend();
    expect(() => b.capabilities()).toThrow(/2026-07-17-layer-4/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement `al-runner-backend.ts`**

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emitStaticSelector } from "@lethal/schemata";
import type {
  BackendCapabilities, BackendStatus, ExecutionBackend, RunOpts, TestMethodRef, TestVerdict,
} from "./backend";
import type { SpawnFn } from "./publisher";

export class AlRunnerBackend implements ExecutionBackend {
  constructor(
    private readonly cfg: AlRunnerConfig,
    private readonly spawn: SpawnFn,     // default bunSpawn — export it from publisher.ts
  ) {}

  capabilities(): BackendCapabilities {
    return { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false };
  }

  async status(): Promise<BackendStatus> {
    const res = await this.spawn([this.cfg.alRunnerPath, "--version"]).catch((e) => ({
      exitCode: -1, stdout: "", stderr: String(e),
    }));
    return res.exitCode === 0
      ? { ok: true, details: res.stdout.trim() }
      : { ok: false, details: `al-runner not runnable: ${res.stderr}` };
  }

  async deploy(_instrumentedDir: string): Promise<void> {
    // no-op: the CLI reads the instrumented source directly
  }

  async activate(mutantId: string | null): Promise<void> {
    await writeFile(
      join(this.cfg.instrumentedDir, "MutationSelector.Codeunit.al"),
      emitStaticSelector({ objectId: this.cfg.selectorObjectId, activeId: mutantId ?? "" }),
      "utf8",
    );
  }

  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const started = Date.now();
    const argv = [
      this.cfg.alRunnerPath,
      "--run", ref.method,
      this.cfg.instrumentedDir,
      this.cfg.testDir,
      "--output-json",
    ];
    if (this.cfg.packagesDir) argv.push("--packages", this.cfg.packagesDir);
    if (this.cfg.stubsDir) argv.push("--stubs", this.cfg.stubsDir);

    const res = await Promise.race([
      this.spawn(argv),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), opts.timeoutMs)),
    ]);
    const durationMs = Date.now() - started;
    if (res === "timeout") return { ref, outcome: "timeout", durationMs };
    if (res.exitCode === 2) return { ref, outcome: "skip", durationMs, failureMessage: res.stdout || res.stderr };
    if (res.exitCode === 3 || res.exitCode < 0) {
      return { ref, outcome: "error", durationMs, failureMessage: res.stderr || res.stdout };
    }
    const parsed = parseAlRunnerOutput(res.stdout);
    const t = parsed.find((x) => x.method === ref.method);
    if (!t) return { ref, outcome: "error", durationMs, failureMessage: "al-runner output missing the requested test" };
    return {
      ref,
      outcome: t.result === "pass" ? "pass" : "fail",
      durationMs: t.durationMs ?? durationMs,
      failureMessage: t.message,
    };
  }
}

interface AlRunnerTest { codeunit: string; method: string; result: string; durationMs?: number; message?: string; }

function parseAlRunnerOutput(stdout: string): AlRunnerTest[] {
  const parsed = JSON.parse(stdout) as { tests?: AlRunnerTest[] };
  return parsed.tests ?? [];
}
```

`ms-inmemory-backend.ts`:

```ts
import type { ExecutionBackend } from "./backend";

const MSG =
  "MsInMemoryBackend is a placeholder for Microsoft's announced in-memory AL runner. " +
  "See docs/superpowers/specs/2026-07-17-layer-4-execution-runtime-design.md §7.";

export class MsInMemoryBackend implements ExecutionBackend {
  capabilities(): never { throw new Error(MSG); }
  status(): never { throw new Error(MSG); }
  deploy(): never { throw new Error(MSG); }
  activate(): never { throw new Error(MSG); }
  run(): never { throw new Error(MSG); }
}
```

Also: export `bunSpawn` from `publisher.ts` (rename export `defaultSpawn`) and default `AlRunnerBackend`'s `spawn` parameter to it.

- [ ] **Step 4: Run tests** — PASS. Export both backends + `AlRunnerConfig` from `index.ts`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
git add packages/runner
git commit -m "feat(runner): AlRunnerBackend (in-memory, selector-rewrite activation) + MS placeholder"
```

---

## Task 11: Orchestrator + report

**Files:**
- Create: `packages/runner/src/orchestrator.ts`
- Create: `packages/runner/src/report.ts`
- Create: `packages/runner/tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
// orchestrator.ts
export interface SessionConfig {
  readonly backend: ExecutionBackend;
  readonly store: ResultsStore;
  readonly projectDir: string;          // target AL project (source of truth)
  readonly testDir: string;
  readonly instrumentedDir: string;     // scratch output dir for schemata writes
  readonly selectorIds: SelectorConfig;
  readonly baselineTimeoutMs?: number;  // default 120000
  readonly skipKnownSurvivors?: boolean;
  readonly appVersion?: string;         // stamped into runs; default "0.0.0.0"
}
export function runSession(cfg: SessionConfig): Promise<SessionReport>;
export function generateMutationSet(projectDir: string): Promise<InstrumentedFile[]>;
// parse every .al in projectDir (skip emitted Mutation* files), run tier1Operators via
// createRegistry + validateSpec — mirror packages/builtin-tier1/tests/end-to-end.test.ts

// report.ts
export interface SessionReport {
  readonly backend: string;
  readonly authoritative: boolean;
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly counts: {
    killed: number; survived: number; noCoverage: number;
    timeoutKilled: number; knownSurvivors: number; unstable: number; errors: number;
  };
  readonly mutationScore: number | null;  // killed / (killed + survived); null when denominator 0
  readonly mutants: readonly MutantOutcome[];
}
export interface MutantOutcome {
  readonly mutantCode: string; readonly file: string; readonly line: number;
  readonly operatorName: string; readonly verdict: MutantVerdict; readonly killingTest?: string;
}
export function renderConsole(r: SessionReport): string;
export function writeJsonReport(r: SessionReport, path: string): Promise<void>;
```

- [ ] **Step 1: Failing orchestrator scenario tests**

Build a `StubBackend` implementing `ExecutionBackend` with a scripted behavior table; drive `runSession` against `fixtures/` AL sources embedded in the test dir (small single-codeunit project written to a temp dir with `mkdtemp`, so `generateMutationSet` runs the REAL Layer 1–3 pipeline).

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultsStore } from "../src/store";
import { runSession } from "../src/orchestrator";
import type {
  BackendCapabilities, BackendStatus, ExecutionBackend, RunOpts, TestMethodRef, TestVerdict,
} from "../src/backend";

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;

const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;
    TestIsolation = Function;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;
}
`;

class StubBackend implements ExecutionBackend {
  activations: Array<string | null> = [];
  deploys: string[] = [];
  constructor(
    private readonly caps: BackendCapabilities,
    private readonly script: (mutant: string | null, ref: TestMethodRef) => TestVerdict["outcome"],
    private readonly coverageProcedures: string[] = [],
  ) {}
  capabilities() { return this.caps; }
  async status(): Promise<BackendStatus> { return { ok: true, details: "stub" }; }
  async deploy(dir: string) { this.deploys.push(dir); }
  async activate(id: string | null) { this.activations.push(id); }
  async run(ref: TestMethodRef, _opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    const outcome = this.script(active, ref);
    return {
      ref, outcome, durationMs: 5,
      coverage:
        active === null && this.caps.coverage === "procedure"
          ? {
              granularity: "procedure",
              entries: this.coverageProcedures.map((p) => ({
                objectType: "Codeunit", objectId: 79000, procedure: p,
              })),
            }
          : undefined,
    };
  }
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "lethal-orch-"));
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TEST_AL);
  return { projectDir, testDir, instrumentedDir };
}

const CAPS_NST: BackendCapabilities = {
  coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true,
};

const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

describe("runSession", () => {
  test("kill: mutant-active fail + baseline-pass confirmation = killed", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => (mutant === null ? "pass" : "fail"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.baselineGreen).toBe(true);
    expect(report.counts.killed).toBeGreaterThan(0);
    expect(report.counts.survived).toBe(0);
    expect(backend.activations.at(-1)).toBeNull();          // finally: deactivated
    expect(backend.deploys.length).toBeGreaterThan(0);
  });

  test("survive: tests pass under every mutant", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.killed).toBe(0);
    expect(report.counts.survived).toBeGreaterThan(0);
    expect(report.mutationScore).toBe(0);
  });

  test("no coverage: uncovered procedure mutants get no-coverage, no runs", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, () => "pass", []); // covers nothing
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.noCoverage).toBeGreaterThan(0);
    expect(report.counts.survived).toBe(0);
  });

  test("coverage:none capability runs all tests per mutant", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false },
      (mutant) => (mutant === null ? "pass" : "fail"),
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.noCoverage).toBe(0);
    expect(report.counts.killed).toBeGreaterThan(0);
    expect(backend.deploys.length).toBe(0);   // deploy:"none" skips deploy
  });

  test("late flakiness: fails under mutant AND at confirmation = error + unstable", async () => {
    const dirs = await makeProject();
    // Deterministic script: the fixture has exactly 1 test, so baseline is 1 inactive run.
    // Count inactive runs: run #1 (baseline) passes; every later inactive run (the
    // confirmation re-runs) fails. Active runs always fail.
    let inactiveRuns = 0;
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => {
        if (mutant !== null) return "fail";
        inactiveRuns++;
        return inactiveRuns === 1 ? "pass" : "fail";
      },
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    expect(report.counts.unstable).toBeGreaterThan(0);
    expect(report.counts.killed).toBe(0);
  });

  test("timeout under mutant = timeout-killed, no confirmation re-run", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => (mutant === null ? "pass" : "timeout"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.timeoutKilled).toBeGreaterThan(0);
  });

  test("red baseline test is excluded and reported, session continues", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      (mutant, ref) => (ref.method === "OverBudgetDetected" ? "fail" : "pass"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.baselineGreen).toBe(false);
    // single-test fixture: every test red → batch aborted → zero executed mutants
    expect(report.counts.killed + report.counts.survived).toBe(0);
  });
});
```

(The late-flakiness test's inline comment is an instruction: implement the counting variant, delete the flag draft.)

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement `orchestrator.ts`**

Skeleton (the real file; fill nothing else in later — this IS the logic):

```ts
import { basename, join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  createRegistry, initParser, parseAL, validateSpec, wrapRoot,
  type MutationSpec,
} from "@lethal/engine";
import { tier1Operators } from "@lethal/builtin-tier1";
import {
  writeInstrumentedProject,
  type InstrumentedFile, type MutantManifest, type SelectorConfig,
} from "@lethal/schemata";
import type { ExecutionBackend, TestMethodRef, TestVerdict } from "./backend";
import { discoverTests } from "./discovery";
import {
  batchByOverlap, buildCoverageIndex, coverageFilter, filterHistory, identityKeyOf, testKeyOf,
} from "./selection";
import type { ResultsStore } from "./store";
import type { SessionReport } from "./report";
import { buildReport } from "./report";

const BASELINE_TIMEOUT_DEFAULT = 120_000;

export async function generateMutationSet(projectDir: string): Promise<InstrumentedFile[]> {
  await initParser();
  const registry = createRegistry(tier1Operators);
  const files: InstrumentedFile[] = [];
  const entries = (await readdir(projectDir, { recursive: true }))
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .filter((e) => !basename(e).startsWith("Mutation"));
  for (const rel of entries.sort()) {
    const source = await readFile(join(projectDir, rel), "utf8");
    const root = wrapRoot(parseAL(source));
    const specs: MutationSpec[] = [];
    for (const op of registry.all()) {
      for (const spec of op.generate(root, source)) {
        if (validateSpec(spec).ok) specs.push(spec);
      }
    }
    if (specs.length > 0) files.push({ path: rel, source, root, specs });
  }
  return files;
}
```

Check the real registry/generate/validate call shapes against `packages/builtin-tier1/tests/end-to-end.test.ts` before writing — mirror that test's pipeline exactly (it is the canonical ops→compile→write flow from Layer 3); the snippet above is the intent, the end-to-end test is the authority.

```ts
export interface SessionConfig { /* as in Interfaces block */ }

export async function runSession(cfg: SessionConfig): Promise<SessionReport> {
  const caps = cfg.backend.capabilities();
  const status = await cfg.backend.status();
  if (!status.ok) throw new Error(`backend not ready: ${status.details}`);

  const tests = await discoverTests(cfg.testDir);
  if (tests.length === 0) throw new Error("no tests discovered");

  const runId = cfg.store.createRun({
    projectPath: cfg.projectDir,
    backend: caps.authoritative ? "bcdev" : "al-runner",
    appVersion: cfg.appVersion ?? "0.0.0.0",
  });

  const allFiles = await generateMutationSet(cfg.projectDir);
  const allSpecs = allFiles.flatMap((f) =>
    f.specs.map((spec) => ({ file: f.path, startIndex: spec.before.startIndex, endIndex: spec.before.endIndex, spec, sourceFile: f })),
  );
  const specBatches = batchByOverlap(allSpecs);

  const outcomes: SessionOutcome[] = [];   // internal accumulation for the report
  let baselineGreenOverall = true;

  try {
    for (const [batchIdx, batchSpecs] of specBatches.entries()) {
      // 1. write instrumented project for THIS batch's specs only
      const byFile = new Map<string, typeof batchSpecs>();
      for (const s of batchSpecs) {
        const list = byFile.get(s.file) ?? [];
        list.push(s);
        byFile.set(s.file, list);
      }
      const batchFiles: InstrumentedFile[] = [...byFile.entries()].map(([path, list]) => ({
        path,
        source: list[0]!.sourceFile.source,
        root: list[0]!.sourceFile.root,
        specs: list.map((x) => x.spec),
      }));
      const batchDir = join(cfg.instrumentedDir, `batch-${batchIdx}`);
      await writeInstrumentedProject({ targetDir: batchDir, files: batchFiles, selectorIds: cfg.selectorIds });
      const manifest = JSON.parse(
        await readFile(join(batchDir, "mutant-manifest.json"), "utf8"),
      ) as MutantManifest;

      // 2. history filter
      const prior = cfg.store.priorSurvivorKeys(cfg.projectDir);
      const { execute, knownSurvivors } = filterHistory([...manifest.mutants], prior, {
        skipKnownSurvivors: cfg.skipKnownSurvivors ?? false,
      });
      for (const m of knownSurvivors) record(cfg.store, runId, m, "known-survivor", outcomes);

      // 3. deploy
      if (caps.deploy === "publish") {
        try {
          await cfg.backend.deploy(batchDir);
        } catch (err) {
          for (const m of execute) record(cfg.store, runId, m, "error", outcomes, undefined, String(err));
          continue; // batch aborted, next batch still attempted
        }
      }

      // 4. baseline
      await cfg.backend.activate(null);
      const baseline: Array<{ ref: TestMethodRef; verdict: TestVerdict }> = [];
      for (const ref of tests) {
        const v = await runWithRetry(cfg.backend, ref, {
          coverage: caps.coverage === "none" ? "none" : caps.coverage,
          timeoutMs: cfg.baselineTimeoutMs ?? BASELINE_TIMEOUT_DEFAULT,
        });
        cfg.store.recordTestResult(runId, null, ref, v.outcome, v.durationMs, v.failureMessage);
        baseline.push({ ref, verdict: v });
      }
      const greenTests = baseline.filter((b) => b.verdict.outcome === "pass");
      if (greenTests.length < baseline.length) baselineGreenOverall = false;
      if (greenTests.length === 0) {
        for (const m of execute) record(cfg.store, runId, m, "error", outcomes, undefined, "no green baseline tests");
        continue;
      }
      const baselineDuration = new Map(greenTests.map((b) => [testKeyOf(b.ref), b.verdict.durationMs]));

      // 5. coverage filter (capability-gated)
      let perMutantTests: Map<string, readonly TestMethodRef[]>;
      let uncovered: typeof execute = [];
      if (caps.coverage === "none") {
        perMutantTests = new Map(execute.map((m) => [m.mutantId, greenTests.map((b) => b.ref)]));
      } else {
        const index = buildCoverageIndex(
          greenTests.map((b) => ({ ref: b.ref, coverage: b.verdict.coverage })),
        );
        const split = coverageFilter(execute, index, greenTests.map((b) => b.ref));
        perMutantTests = new Map(split.covered);
        uncovered = split.uncovered;
      }
      for (const m of uncovered) record(cfg.store, runId, m, "no-coverage", outcomes);

      // 6. per-mutant loop
      for (const m of execute) {
        const covering = perMutantTests.get(m.mutantId);
        if (!covering) continue; // uncovered, already recorded
        await cfg.backend.activate(m.mutantId);
        let verdict: SessionVerdict = "survived";
        let killingTest: string | undefined;
        let failureNote: string | undefined;
        let spent = 0;
        for (const ref of covering) {
          const budget = 2 * (baselineDuration.get(testKeyOf(ref)) ?? cfg.baselineTimeoutMs ?? BASELINE_TIMEOUT_DEFAULT);
          const v = await runWithRetry(cfg.backend, ref, { coverage: "none", timeoutMs: budget });
          cfg.store.recordTestResult(runId, m.mutantId, ref, v.outcome, v.durationMs, v.failureMessage);
          spent += v.durationMs;
          if (v.outcome === "timeout") { verdict = "timeout-killed"; killingTest = ref.method; break; }
          if (v.outcome === "error") { verdict = "error"; failureNote = v.failureMessage; break; }
          if (v.outcome === "fail") {
            await cfg.backend.activate(null);
            const confirm = await runWithRetry(cfg.backend, ref, { coverage: "none", timeoutMs: budget });
            cfg.store.recordTestResult(runId, null, ref, confirm.outcome, confirm.durationMs, confirm.failureMessage);
            if (confirm.outcome === "pass") { verdict = "killed"; killingTest = ref.method; }
            else { verdict = "error"; failureNote = `unstable test ${ref.method}: fails at baseline confirmation`; }
            break;
          }
        }
        record(cfg.store, runId, m, verdict, outcomes, killingTest, failureNote, spent);
      }
    }
  } finally {
    await cfg.backend.activate(null).catch(() => {});
  }

  cfg.store.finishRun(runId, { batchCount: specBatches.length, baselineGreen: baselineGreenOverall });
  return buildReport({ caps, baselineGreen: baselineGreenOverall, batches: specBatches.length, outcomes });
}

async function runWithRetry(backend: ExecutionBackend, ref: TestMethodRef, opts: { coverage: "none" | "procedure" | "line"; timeoutMs: number }): Promise<TestVerdict> {
  const first = await backend.run(ref, opts);
  if (first.outcome !== "error") return first;
  return backend.run(ref, opts);   // one retry on transport error, then the error stands
}
```

Define the small internals the snippet references: `SessionVerdict` (alias of store's `MutantVerdict`), `SessionOutcome` (mutant entry + verdict + killingTest + failureNote), and `record(store, runId, m, verdict, outcomes, killingTest?, failureNote?, durationMs = 0)` which maps a `MutantManifestEntry` onto a `MutantRow` and pushes a `SessionOutcome`:

```ts
function record(
  store: ResultsStore, runId: number, m: MutantManifestEntry, verdict: MutantVerdict,
  outcomes: SessionOutcome[], killingTest?: string, failureNote?: string, durationMs = 0,
): void {
  const key = identityKeyOf(m);
  store.recordMutant(runId, {
    mutantCode: m.mutantId,
    astHash: key.astHash,
    codeunitName: key.codeunitName,
    operatorName: key.operatorName,
    operatorMajor: key.operatorMajor,
    file: m.file,
    line: m.startLine,
    verdict,
    killingTest,
    durationMs,
  });
  outcomes.push({ mutant: m, verdict, killingTest, failureNote });
}
```

Unstable/error counting: an `error` verdict whose `failureNote` starts with `unstable test` increments `unstable` as well as `errors` in `buildReport`.

`report.ts`: `buildReport` folds `outcomes` into `SessionReport.counts` + `mutationScore`; `renderConsole` prints a summary table (mutant code, file:line, operator, verdict, killing test) plus the score line, prefixed with `[backend: al-runner — mock runtime, indicative]` when `authoritative` is false; `writeJsonReport` = `Bun.write(path, JSON.stringify(report, null, 2))`.

- [ ] **Step 4: Run tests** — `bun test packages/runner` → PASS. Full suite `bun test` → PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
git add packages/runner
git commit -m "feat(runner): sequential session orchestrator + report

Baseline -> coverage-filtered per-mutant execution with kill
confirmation, timeout-as-killed, capability degradation for in-memory
backends, per-batch deploy, always-deactivate finally."
```

---

## Task 12: CLI, fixture apps, integration scripts

**Files:**
- Create: `packages/runner/src/cli.ts`
- Create: `fixtures/sandbox-app/app.json`, `fixtures/sandbox-app/src/SandboxLogic.Codeunit.al`, `fixtures/sandbox-app/src/SandboxPricing.Codeunit.al`
- Create: `fixtures/sandbox-tests/app.json`, `fixtures/sandbox-tests/src/SandboxTests.Codeunit.al`
- Create: `fixtures/sandbox-app/.vscode/launch.json` (placeholders; real values in gitignored `launch.local.json`)
- Create: `packages/runner/itest/bcdev.itest.ts`, `packages/runner/itest/al-runner.itest.ts`
- Modify: root `package.json` scripts; `.gitignore` (`launch.local.json`, `lethal.sqlite`, `*.app`)

- [ ] **Step 1: CLI**

```ts
// cli.ts
import { parseArgs } from "node:util";
import { join } from "node:path";
import { AlRunnerBackend } from "./al-runner-backend";
import { BcDevMcpBackend } from "./bcdev-backend";
import { MutationControlClient } from "./activation";
import { Publisher, defaultAlToolPaths, defaultSpawn } from "./publisher";
import { runSession } from "./orchestrator";
import { renderConsole, writeJsonReport } from "./report";
import { ResultsStore } from "./store";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    tests: { type: "string" },
    backend: { type: "string" },          // "bcdev" | "al-runner"
    db: { type: "string" },
    out: { type: "string" },              // JSON report path
    config: { type: "string" },           // lethal.config.json with backend connection details
    "skip-known-survivors": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
```

The config file (`lethal.config.json`, documented in the fixture README) supplies what flags cannot: `bcdev: { mcpCommand, server, serverInstance, tenant, company, username, password, packageCachePath }` and `alRunner: { alRunnerPath, packagesDir }`. `cli.ts` validates required fields per backend, constructs the backend (Publisher + MutationControlClient for bcdev; selector-id defaults 50000/50001/50002), instrumented scratch dir under `os.tmpdir()`, `ResultsStore` at `--db` or `<project>/lethal.sqlite`, then `runSession` → `renderConsole` to stdout, `writeJsonReport` when `--out` given, exit 0/1 by session completion. `--dry-run`: generate + batch, print batch/mutant table, run nothing. Keep `cli.ts` thin — argument marshaling only, all logic stays in `orchestrator.ts` (already tested). Add `"bin": { "lethal": "src/cli.ts" }` to `packages/runner/package.json`.

- [ ] **Step 2: Fixture apps**

`fixtures/sandbox-app/src/SandboxLogic.Codeunit.al` — every tier-1 operator must find ≥1 site:

```al
codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);                          // ConditionalBoundary + ReturnValue
    end;

    procedure ClampPercent(Value: Integer): Integer
    begin
        if (Value < 0) or (Value > 100) then            // NegateConditional + boundary
            exit(0);
        exit(Value);
    end;

    procedure ApplyAudit(Amount: Decimal)
    begin
        LogAudit(Amount);                               // VoidMethodCall
    end;

    local procedure LogAudit(Amount: Decimal)
    begin
        if Amount <> 0 then begin                       // EmptyBlock target
            Amount := Amount;
        end;
    end;
}
```

`fixtures/sandbox-app/src/SandboxPricing.Codeunit.al` — deliberately untested (produces `no-coverage` on bcdev, `survived` on al-runner):

```al
codeunit 79001 "Sandbox Pricing"
{
    procedure DiscountedPrice(Price: Decimal; Pct: Decimal): Decimal
    begin
        if Pct >= 100 then
            exit(0);
        exit(Price - (Price * Pct / 100));
    end;
}
```

`fixtures/sandbox-tests/src/SandboxTests.Codeunit.al` — kills the `IsOverBudget` mutants (both sides of the boundary plus the equality case, which distinguishes `>` from `>=`), deliberately weak on `ClampPercent` (executes it without decisive assertions, so its mutants really survive):

```al
codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;
    TestIsolation = Function;

    var
        SandboxLogic: Codeunit "Sandbox Logic";

    [Test]
    procedure OverBudgetDetected()
    begin
        if not SandboxLogic.IsOverBudget(101, 100) then
            Error('101 vs 100 must be over budget');
        if SandboxLogic.IsOverBudget(99, 100) then
            Error('99 vs 100 must not be over budget');
        if SandboxLogic.IsOverBudget(100, 100) then
            Error('equal amounts must not be over budget');
    end;

    [Test]
    procedure ClampPercentRuns()
    begin
        SandboxLogic.ClampPercent(50);   // weak on purpose: no assertion on the result
        SandboxLogic.ApplyAudit(10);
    end;
}
```

`app.json` files: minimal — unique ids, `"idRanges"` covering 79000–79199, sandbox-tests declares a dependency on sandbox-app and on the Microsoft test framework apps (`Library Assert` not required — the fixtures assert via `Error`), `"features": []`. Fixture README documents object ids, the hand-computed expected verdict table per backend, and the `launch.local.json` convention.

- [ ] **Step 3: Integration scripts** (env-gated; NOT run by `bun test`)

`packages/runner/itest/al-runner.itest.ts`: guard `if (!process.env.LETHAL_ITEST_ALRUNNER) { console.log("skipped"); process.exit(0); }` — then: real `generateMutationSet` over `fixtures/sandbox-app/src`, real `AlRunnerBackend` (path from `LETHAL_ALRUNNER_PATH`), `:memory:` store, `runSession`, assert the hand-computed verdict table from the fixture README, run TWICE and assert verdict equality (determinism exit criterion).

`packages/runner/itest/bcdev.itest.ts`: guard `LETHAL_ITEST_BCDEV`; config from `fixtures/sandbox-app/.vscode/launch.local.json` + `lethal.config.local.json`; same assertions plus `no-coverage` expectations. This run is ALSO where the three documented assumptions get verified and, if needed, fixed in one commit each: `bcdev_test_run` payload shape (Task 7), `altool` flag spellings (Task 8), OData action parameter/return shape (Task 9).

Root `package.json` scripts:

```json
    "itest:alrunner": "bun packages/runner/itest/al-runner.itest.ts",
    "itest:bcdev": "bun packages/runner/itest/bcdev.itest.ts"
```

CI note: wire `itest:alrunner` into CI only after confirming the al-runner install story (dotnet tool vs release binary — check the README of StefanMaron/BusinessCentral.AL.Runner during implementation). If install is scriptable, add it to CI in this task; if not, leave both itests manual and record that in the fixture README.

- [ ] **Step 4: Run everything**

Run: `bun test && bun run lint && bun run typecheck`
Expected: all green.
Run: `bun run itest:alrunner` (with al-runner installed) — expected: verdict table matches, two runs identical.
Run: `bun run itest:bcdev` (against the dev server) — expected: same plus no-coverage rows.

- [ ] **Step 5: Commit**

```bash
git add packages/runner fixtures package.json .gitignore
git commit -m "feat(runner): lethal run CLI, sandbox fixture apps, env-gated integration tests"
```

---

## Self-Review Checklist (run after Task 12)

1. **Spec coverage:** spec §4 interface ↔ Task 3; §5 ↔ Tasks 7–9; §6 ↔ Task 10; §7 ↔ Task 10; §8 ↔ Tasks 1–2; §9 ↔ Tasks 4+6; §10 ↔ Task 5; §11 ↔ Task 11; §12 ↔ Task 12; §13 exit criteria ↔ Task 12 Step 4.
2. **Verify-later ledger (all closed in Task 12):** bcdev payload shape, altool flags, OData action shape, al-runner CLI/JSON shape, `McpServer.tool` registration API, engine field-accessor for procedure names (Task 2).
3. **Determinism exit criterion** is asserted in both itests, not just claimed.
