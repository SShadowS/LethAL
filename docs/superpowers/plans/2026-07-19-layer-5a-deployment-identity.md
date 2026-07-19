# Layer 5A · Deployment Identity and Compile/Publish Separation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deployment an object with an identity — compile once to an immutable,
content-addressed artifact carrying a random id and a monotonic version, publish as a separate
step, and verify it landed instead of trusting the publish tool's exit code.

**Architecture:** `ExecutionBackend.deploy()` currently compiles, indexes coverage and publishes in
one call. Split it into `ArtifactCompiler` → `ContainerDeployer` → `DeploymentVerifier` over a
shared `CompiledArtifact` descriptor. Versions become clock-derived and monotonic, sourced from the
project's own `app.json` rather than a project-local `runId`. Compile-failure bisection moves
entirely before publication and searches the full embedded manifest.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, tree-sitter-al, biome. Tests are `bun test`.

**Spec:** `docs/superpowers/specs/2026-07-19-layer-5a-deployment-identity-design.md`

## Global Constraints

- **This layer does NOT deliver concurrent-session safety.** Never name anything `Fence` or
  `LeaseIdentity`; the verification abstraction is `DeploymentVerifier`. Its guarantee is exactly:
  "a fresh Identity request observed code claiming artifact id X at that moment."
- **No non-null assertions (`!`)** — biome `noNonNullAssertion: error`. `exactOptionalPropertyTypes`
  is on: build optional properties with `...(v !== undefined ? { k: v } : {})`.
- **`bun test` does NOT type-check.** Run `bun run typecheck` separately.
- **Delete `packages/*/dist` before any reported test run** — stale compiled copies cause phantom
  failures. PowerShell `Remove-Item -Recurse -Force` if `rm -rf` is blocked.
- **Artifact id is random, never derived from `runId`, never reused**: 128 bits as 32 lowercase hex
  chars, generated **per artifact**, not per session.
- **The `.app` SHA-256 is never embedded in the package** — embedding it changes the bytes it is
  derived from. It lives only in the external `CompiledArtifact`.
- **Every publication or verification error bypasses bisection.** Only a typed `AlcCompileError`
  counts as "this subset does not compile."
- **Assert phase separation with call counters, never wall-clock timing.**
- Known-good bcdev verdicts, unchanged by this layer: **killed 3 / survived 10 / no-coverage 3,
  23.1%**. Aggregates are a smoke test only; the real gate is per-mutant equality.
- Live config lives in `fixtures/sandbox-app/lethal.config.local.json` (gitignored, populated).

---

### Task 1: Version allocator

**Files:**
- Create: `packages/runner/src/app-version.ts`
- Test: `packages/runner/tests/app-version.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `reserveAppVersion(input: ReserveInput): string`,
  `parseVersionConflict(message: string): string | null`,
  `nextAbove(version: string): string`, `class VersionOverflowError extends Error`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runner/tests/app-version.test.ts
import { describe, expect, it } from "bun:test";
import {
  VersionOverflowError,
  nextAbove,
  parseVersionConflict,
  reserveAppVersion,
} from "../src/app-version";

// 2026-07-19T00:00:00Z = 20653 days since epoch.
const T0 = Date.UTC(2026, 6, 19, 0, 0, 0);

describe("reserveAppVersion", () => {
  it("takes major.minor from the source version and clock for build.revision", () => {
    // 01:00:00 => 3600s => 1800 half-seconds
    const v = reserveAppVersion({ sourceVersion: "2.3.0.0", nowMs: T0 + 3_600_000 });
    expect(v).toBe("2.3.20653.1800");
  });

  it("never forces a 2.x project under a 1.0 ceiling", () => {
    const v = reserveAppVersion({ sourceVersion: "2.0.0.0", nowMs: T0 });
    expect(v.startsWith("2.0.")).toBe(true);
  });

  it("is strictly increasing even when the clock does not advance", () => {
    const a = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0 });
    const b = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0, lastIssued: a });
    const c = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0, lastIssued: b });
    expect(b).toBe("1.0.20653.1");
    expect(c).toBe("1.0.20653.2");
  });

  it("is strictly increasing when the clock steps backwards", () => {
    // a is stamped at 01:00:00 => 1.0.20653.1800. b is stamped an hour EARLIER, so its
    // clock-derived candidate (1.0.20653.0) sorts below a and must be overridden.
    const a = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0 + 3_600_000 });
    const b = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0, lastIssued: a });
    expect(a).toBe("1.0.20653.1800");
    expect(b).toBe("1.0.20653.1801");
  });

  it("rejects a malformed source version rather than guessing", () => {
    expect(() => reserveAppVersion({ sourceVersion: "1.0", nowMs: T0 })).toThrow(
      /four-part/,
    );
  });

  it("fails loudly on revision overflow instead of wrapping", () => {
    expect(() =>
      reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0, lastIssued: "1.0.20653.65535" }),
    ).toThrow(VersionOverflowError);
  });
});

describe("parseVersionConflict", () => {
  it("extracts the installed version BC names in its rejection", () => {
    const msg =
      "The request for path /BC/dev/apps failed with code UnprocessableEntity. Reason: " +
      "Cannot install the extension LethAL Sandbox App by LethAL 1.0.0.999 because a newer " +
      "version 1.0.106.0 was already installed.";
    expect(parseVersionConflict(msg)).toBe("1.0.106.0");
  });

  it("returns null for an unrelated publish failure", () => {
    expect(parseVersionConflict("Publish failed: connection refused")).toBeNull();
  });
});

describe("nextAbove", () => {
  it("increments the revision", () => {
    expect(nextAbove("1.0.106.0")).toBe("1.0.106.1");
  });

  it("carries into build when the revision is saturated", () => {
    expect(nextAbove("1.0.106.65535")).toBe("1.0.107.0");
  });

  it("throws rather than wrapping when no successor exists", () => {
    expect(() => nextAbove("65535.65535.65535.65535")).toThrow(VersionOverflowError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/runner/tests/app-version.test.ts`
Expected: FAIL — `Cannot find module '../src/app-version'`

- [ ] **Step 3: Implement**

```ts
// packages/runner/src/app-version.ts

/** BC version components are 16-bit. */
const MAX_COMPONENT = 65535;
const MS_PER_DAY = 86_400_000;

export class VersionOverflowError extends Error {}

export interface ReserveInput {
  /** The project's own version from app.json — supplies major.minor. */
  readonly sourceVersion: string;
  readonly nowMs: number;
  /** Last version this allocator issued, if any. Guarantees strict increase. */
  readonly lastIssued?: string;
}

function parse(version: string): [number, number, number, number] {
  const parts = version.split(".");
  if (parts.length !== 4) {
    throw new Error(`app version must be four-part (a.b.c.d), got "${version}"`);
  }
  const nums = parts.map((p) => {
    const n = Number.parseInt(p, 10);
    if (!Number.isInteger(n) || n < 0 || String(n) !== p) {
      throw new Error(`app version component "${p}" is not a non-negative integer ("${version}")`);
    }
    return n;
  });
  const [a, b, c, d] = nums;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error(`app version must be four-part (a.b.c.d), got "${version}"`);
  }
  return [a, b, c, d];
}

function compare(x: readonly number[], y: readonly number[]): number {
  for (let i = 0; i < 4; i++) {
    const a = x[i] ?? 0;
    const b = y[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * `<sourceMajor>.<sourceMinor>.<daysSinceUnixEpoch>.<secondsOfDay / 2>`.
 *
 * Major/minor come from the project's app.json so a 2.x project is never forced under a 1.0
 * ceiling it can never clear. The clock components need no stored counter, so there is no state
 * to lose or reset — the defect that broke publishing when `lethal.sqlite` was deleted.
 *
 * The 2-second resolution is coarser than a compile (~1s), so `lastIssued` guarantees strict
 * increase regardless of granularity or a clock that steps backwards.
 */
export function reserveAppVersion(input: ReserveInput): string {
  const [major, minor] = parse(input.sourceVersion);
  const days = Math.floor(input.nowMs / MS_PER_DAY);
  const halfSeconds = Math.floor((input.nowMs % MS_PER_DAY) / 2000);
  let candidate: [number, number, number, number] = [major, minor, days, halfSeconds];

  if (input.lastIssued !== undefined) {
    const last = parse(input.lastIssued);
    if (compare(candidate, last) <= 0) candidate = parse(nextAbove(input.lastIssued));
  }
  for (const c of candidate) {
    if (c > MAX_COMPONENT) {
      throw new VersionOverflowError(
        `app version component ${c} exceeds ${MAX_COMPONENT} (candidate ${candidate.join(".")})`,
      );
    }
  }
  return candidate.join(".");
}

/** Smallest version strictly greater than `version`, carrying right-to-left. */
export function nextAbove(version: string): string {
  const parts = parse(version);
  for (let i = 3; i >= 0; i--) {
    const cur = parts[i] ?? 0;
    if (cur < MAX_COMPONENT) {
      parts[i] = cur + 1;
      for (let j = i + 1; j < 4; j++) parts[j] = 0;
      return parts.join(".");
    }
  }
  throw new VersionOverflowError(`no version above ${version} is representable`);
}

/**
 * BC's downgrade rejection names the installed version verbatim, e.g.
 * "...because a newer version 1.0.106.0 was already installed."
 * Verified live against Cronus281 on 2026-07-19.
 */
export function parseVersionConflict(message: string): string | null {
  const m = /newer version (\d+\.\d+\.\d+\.\d+) was already installed/.exec(message);
  return m?.[1] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/runner/tests/app-version.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/app-version.ts packages/runner/tests/app-version.test.ts
git commit -m "feat(runner): clock-derived monotonic app version allocator"
```

---

### Task 2: Run provenance in the results store

**Files:**
- Modify: `packages/runner/src/store.ts` (SCHEMA `runs`, `migrate()`, add `recordArtifact`)
- Test: `packages/runner/tests/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Store.recordArtifact(runId: number, info: { appVersion: string; appId: string;
  artifactId: string; sha256: string }): void`, and `runs` columns `app_id`, `artifact_id`,
  `artifact_sha256`.

**Context:** `orchestrator.ts:322` records `cfg.appVersion ?? "0.0.0.0"` at `createRun`, before the
version is derived; the real version is stamped later at `orchestrator.ts:854-855`. Every run row
ever written claims `0.0.0.0`. Task 6 calls `recordArtifact` after compilation to correct it.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/runner/tests/store.test.ts
it("records real deployment provenance over the createRun placeholder", () => {
  const store = new Store(":memory:");
  const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
  store.recordArtifact(runId, {
    appVersion: "1.0.20653.1800",
    appId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
    artifactId: "0123456789abcdef0123456789abcdef",
    sha256: "a".repeat(64),
  });
  const row = store.db
    .query("SELECT app_version, app_id, artifact_id, artifact_sha256 FROM runs WHERE id = ?")
    .get(runId) as Record<string, string>;
  expect(row.app_version).toBe("1.0.20653.1800");
  expect(row.app_id).toBe("df1aa9ff-6539-4c86-a9d0-ad702b61ac9a");
  expect(row.artifact_id).toBe("0123456789abcdef0123456789abcdef");
  expect(row.artifact_sha256).toBe("a".repeat(64));
});

it("migrates a pre-5A runs table that lacks the provenance columns", () => {
  const path = join(tmpdir(), `lethal-store-5a-${Date.now()}.sqlite`);
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    project_path TEXT NOT NULL,
    backend TEXT NOT NULL,
    app_version TEXT NOT NULL,
    batch_count INTEGER,
    baseline_green INTEGER
  );`);
  legacy.exec("INSERT INTO runs (project_path, backend, app_version) VALUES ('P','bcdev','0.0.0.0')");
  legacy.close();

  const store = new Store(path);
  const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
  expect(() =>
    store.recordArtifact(runId, {
      appVersion: "1.0.1.1",
      appId: "x",
      artifactId: "y",
      sha256: "z",
    }),
  ).not.toThrow();
  store.close();
  rmSync(path, { force: true });
});
```

Add any missing imports at the top of the file: `Database` from `bun:sqlite`, `tmpdir` from
`node:os`, `join` from `node:path`, `rmSync` from `node:fs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/runner/tests/store.test.ts`
Expected: FAIL — `store.recordArtifact is not a function`

- [ ] **Step 3: Implement**

In `SCHEMA`, extend the `runs` table with three nullable columns:

```sql
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  project_path TEXT NOT NULL,
  backend TEXT NOT NULL,
  app_version TEXT NOT NULL,
  batch_count INTEGER,
  baseline_green INTEGER,
  app_id TEXT,
  artifact_id TEXT,
  artifact_sha256 TEXT
);
```

Extend `migrate()`, following the existing `failure_note` pattern exactly:

```ts
  private migrate(): void {
    const cols = this.db.query("PRAGMA table_info(mutants)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "failure_note")) {
      this.db.exec("ALTER TABLE mutants ADD COLUMN failure_note TEXT");
    }
    // Layer 5A: runs gained deployment provenance. A pre-5A lethal.sqlite has a runs table
    // without these, against which recordArtifact's UPDATE would throw mid-run.
    const runCols = this.db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    for (const col of ["app_id", "artifact_id", "artifact_sha256"]) {
      if (!runCols.some((c) => c.name === col)) {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${col} TEXT`);
      }
    }
  }
```

Add the method:

```ts
  /**
   * Corrects the run row after compilation. `createRun` runs before the version is derived, so
   * it can only write a placeholder; leaving it there made runs.app_version wrong for every run
   * ever recorded. 5C needs this provenance, and retrofitting it after pooled runs exist would
   * make historical diagnostics ambiguous.
   */
  recordArtifact(
    runId: number,
    info: { appVersion: string; appId: string; artifactId: string; sha256: string },
  ): void {
    this.db
      .query(
        "UPDATE runs SET app_version = ?, app_id = ?, artifact_id = ?, artifact_sha256 = ? WHERE id = ?",
      )
      .run(info.appVersion, info.appId, info.artifactId, info.sha256, runId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/runner/tests/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/store.ts packages/runner/tests/store.test.ts
git commit -m "feat(runner): record real deployment provenance on the run row"
```

---

### Task 3: Artifact identity in generated AL

**Files:**
- Modify: `packages/schemata/src/selector.ts` (`emitMutationSelector`, `emitStaticSelector`,
  `emitMutationControl`)
- Modify: `packages/schemata/src/project.ts` (`WriteInput`, `MutantManifest`,
  `writeInstrumentedProject`)
- Test: `packages/schemata/tests/selector.test.ts`, `packages/schemata/tests/project.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `emitMutationSelector(cfg: SelectorConfig & { artifactId: string })`,
  `emitStaticSelector(cfg: { objectId: number; activeId: string; artifactId: string })`,
  `emitMutationControl(cfg: SelectorConfig)` gaining an `Identity` procedure,
  `WriteInput.artifactId`, `MutantManifest.artifactId`.

**Context — the trap this task exists to avoid:** `AlRunnerBackend.activate()` overwrites the whole
generated `MutationSelector.Codeunit.al` with `emitStaticSelector(...)` output on every activation.
If `MutationControl.Identity()` calls a selector procedure and the static selector lacks it, the
next al-runner compile fails. Both emitters must stay in interface parity.

`MutationControl` is already published as a web service (`emitWebServicesXml`, ObjectType exactly
`CodeUnit` — lowercase `Codeunit` silently fails to validate and alc drops the file), so a new
public procedure on it is reachable as `MutationControl_Identity` with no XML change.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/schemata/tests/selector.test.ts
import { describe, expect, it } from "bun:test";
import {
  emitMutationControl,
  emitMutationSelector,
  emitStaticSelector,
} from "../src/selector";

const IDS = { selectorId: 79000, controlId: 79001, tableId: 79002 };
const ARTIFACT = "0123456789abcdef0123456789abcdef";

describe("artifact identity parity", () => {
  it("the generated selector exposes ArtifactId", () => {
    const al = emitMutationSelector({ ...IDS, artifactId: ARTIFACT });
    expect(al).toContain("procedure ArtifactId(): Text");
    expect(al).toContain(`exit('${ARTIFACT}')`);
  });

  it("the STATIC selector exposes ArtifactId too, or al-runner activation breaks the next compile", () => {
    const al = emitStaticSelector({ objectId: 79000, activeId: "M0001", artifactId: ARTIFACT });
    expect(al).toContain("procedure ArtifactId(): Text");
    expect(al).toContain(`exit('${ARTIFACT}')`);
  });

  it("both emitters expose the same procedure set", () => {
    const procs = (al: string) => [...al.matchAll(/procedure (\w+)/g)].map((m) => m[1]).sort();
    expect(procs(emitStaticSelector({ objectId: 79000, activeId: "", artifactId: ARTIFACT }))).toEqual(
      procs(emitMutationSelector({ ...IDS, artifactId: ARTIFACT })),
    );
  });

  it("MutationControl exposes Identity, reachable as MutationControl_Identity", () => {
    const al = emitMutationControl(IDS);
    expect(al).toContain("procedure Identity(): Text");
    expect(al).toContain("MutationSelector.ArtifactId()");
  });
});
```

```ts
// packages/schemata/tests/project.test.ts — append
it("writes the artifact id into the manifest and the generated selector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lethal-artifactid-"));
  await writeInstrumentedProject({
    targetDir: dir,
    files: [],
    selectorIds: { selectorId: 79000, controlId: 79001, tableId: 79002 },
    artifactId: "0123456789abcdef0123456789abcdef",
  });
  const manifest = JSON.parse(
    await readFile(join(dir, "mutant-manifest.json"), "utf8"),
  ) as { artifactId: string };
  expect(manifest.artifactId).toBe("0123456789abcdef0123456789abcdef");
  const selector = await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8");
  expect(selector).toContain("0123456789abcdef0123456789abcdef");
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/schemata/tests/selector.test.ts packages/schemata/tests/project.test.ts`
Expected: FAIL — `ArtifactId` absent; `artifactId` not accepted by `WriteInput`.

- [ ] **Step 3: Implement**

In `selector.ts`, add `ArtifactId()` to both emitters and `Identity()` to the control codeunit:

```ts
export function emitMutationSelector(cfg: SelectorConfig & { artifactId: string }): string {
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

    procedure ArtifactId(): Text
    begin
        exit('${cfg.artifactId}');
    end;
}
`;
}
```

```ts
export function emitStaticSelector(cfg: {
  objectId: number;
  activeId: string;
  artifactId: string;
}): string {
  const body =
    cfg.activeId === ""
      ? "        exit(false);"
      : `        exit(MutantId = '${cfg.activeId}');`;
  // ArtifactId must be present here too: AlRunnerBackend.activate() replaces the entire
  // generated selector with this output on every activation, so an emitter missing a procedure
  // MutationControl calls would break the NEXT compile.
  return `codeunit ${cfg.objectId} "Mutation Selector"
{
    procedure Active(MutantId: Text): Boolean
    begin
${body}
    end;

    procedure ArtifactId(): Text
    begin
        exit('${cfg.artifactId}');
    end;
}
`;
}
```

In `emitMutationControl`, add before the closing brace:

```
    procedure Identity(): Text
    var
        MutationSelector: Codeunit "Mutation Selector";
    begin
        exit(MutationSelector.ArtifactId());
    end;
```

In `project.ts`, add `readonly artifactId: string;` to `WriteInput` and
`readonly artifactId: string;` to `MutantManifest`, pass it to `emitMutationSelector`, and include
it in `manifestJson`:

```ts
  const manifestJson: MutantManifest = {
    selectorIds: input.selectorIds,
    artifactId: input.artifactId,
    mutants: manifest,
  };
```

Then update every existing caller of `writeInstrumentedProject` and `emitStaticSelector` to pass
`artifactId`. For `AlRunnerBackend`, read it from the deployed batch's `mutant-manifest.json`
during `deploy()` and store it on the instance, so `activate()` can pass it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/schemata packages/runner && bun run typecheck`
Expected: PASS. Typecheck will point at every caller that still omits `artifactId` — fix each.

- [ ] **Step 5: Commit**

```bash
git add packages/schemata packages/runner
git commit -m "feat(schemata): bake a per-artifact id into generated AL, exposed via MutationControl_Identity"
```

---

### Task 4: CompiledArtifact, ArtifactCompiler and ContainerDeployer

**Files:**
- Create: `packages/runner/src/artifact.ts`
- Modify: `packages/runner/src/publisher.ts` (split config, typed errors, content-addressed output)
- Test: `packages/runner/tests/artifact.test.ts`

**Interfaces:**
- Consumes: `MutantManifest` from `@lethal/schemata`.
- Produces: `interface CompiledArtifact`, `class AlcCompileError extends Error`,
  `class ArtifactPrepareError extends Error`, `ArtifactCompiler.compile(input) =>
  Promise<CompiledArtifact>`, `ContainerDeployer.publish(artifact) => Promise<void>`.

**Context:** `Publisher.compile()` writes every result to a fixed `lethal-instrumented.app`
(`publisher.ts:60-68`) and collapses compiler rejections and process-launch failures into generic
`Error`s (`publisher.ts:65-88`). Both must change: the fixed path violates the immutable-artifact
contract, and the untyped errors would make bisection treat an I/O failure as "does not compile."

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runner/tests/artifact.test.ts
import { describe, expect, it } from "bun:test";
import { AlcCompileError, ArtifactPrepareError, ArtifactCompiler } from "../src/artifact";

const CFG = {
  alcPath: "alc",
  packageCachePath: "/cache",
  outputDir: "/out",
};

describe("ArtifactCompiler", () => {
  it("returns a descriptor whose sha256 matches the produced bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readArtifact: async () => bytes,
      writeArtifact: async () => {},
    });
    const art = await compiler.compile({
      projectDir: "/proj",
      artifactId: "0123456789abcdef0123456789abcdef",
      appId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
      appVersion: "1.0.1.1",
      mutantManifest: { selectorIds: { selectorId: 1, controlId: 2, tableId: 3 }, artifactId: "0123456789abcdef0123456789abcdef", mutants: [] },
      appManifest: {},
    });
    expect(art.sha256).toBe(Bun.SHA256.hash(bytes, "hex"));
    expect(art.appPath).toContain(art.sha256.slice(0, 16));
    expect(art.artifactId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("throws a TYPED AlcCompileError on a compiler rejection", async () => {
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => ({ exitCode: 1, stdout: "AL0118: unknown identifier", stderr: "" }),
      readArtifact: async () => new Uint8Array(),
      writeArtifact: async () => {},
    });
    await expect(compiler.compile(BASE_INPUT)).rejects.toBeInstanceOf(AlcCompileError);
  });

  it("throws ArtifactPrepareError — NOT AlcCompileError — when the compiler cannot be spawned", async () => {
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => {
        throw new Error("ENOENT: alc not found");
      },
      readArtifact: async () => new Uint8Array(),
      writeArtifact: async () => {},
    });
    const err = await compiler.compile(BASE_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactPrepareError);
    expect(err).not.toBeInstanceOf(AlcCompileError);
  });

  it("throws ArtifactPrepareError when the output file is missing", async () => {
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readArtifact: async () => {
        throw new Error("ENOENT");
      },
      writeArtifact: async () => {},
    });
    await expect(compiler.compile(BASE_INPUT)).rejects.toBeInstanceOf(ArtifactPrepareError);
  });
});
```

Define `BASE_INPUT` once at the top of the file with the same shape used in the first test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/runner/tests/artifact.test.ts`
Expected: FAIL — `Cannot find module '../src/artifact'`

- [ ] **Step 3: Implement**

```ts
// packages/runner/src/artifact.ts
import type { MutantManifest } from "@lethal/schemata";
import { join } from "node:path";
import type { SpawnFn } from "./publisher";

/**
 * A deterministic compiler rejection: alc ran and said no. This is the ONLY error the bisection
 * predicate may read as "this subset does not compile". Everything else aborts the search.
 */
export class AlcCompileError extends Error {}

/** Any failure that is not a compiler verdict: spawn, I/O, hashing, manifest inconsistency. */
export class ArtifactPrepareError extends Error {}

export interface ArtifactCoverageMetadata {
  readonly methodIndexSource: string;
  readonly localProcedures: readonly string[];
}

export interface CompiledArtifact {
  readonly artifactId: string;
  readonly appId: string;
  readonly appVersion: string;
  /** Absolute, content-addressed, immutable once written. */
  readonly appPath: string;
  /** SHA-256 of the exact final .app bytes. Never embedded in the package. */
  readonly sha256: string;
  readonly mutantManifest: MutantManifest;
  readonly appManifest: Readonly<Record<string, unknown>>;
}

export interface CompileInput {
  readonly projectDir: string;
  readonly artifactId: string;
  readonly appId: string;
  readonly appVersion: string;
  readonly mutantManifest: MutantManifest;
  readonly appManifest: Readonly<Record<string, unknown>>;
}

export interface ArtifactCompilerConfig {
  readonly alcPath: string;
  readonly packageCachePath: string;
  readonly outputDir: string;
}

export interface ArtifactIo {
  readonly spawn: SpawnFn;
  readonly readArtifact: (path: string) => Promise<Uint8Array>;
  readonly writeArtifact: (from: string, to: string) => Promise<void>;
}

function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

export class ArtifactCompiler {
  constructor(
    private readonly cfg: ArtifactCompilerConfig,
    private readonly io: ArtifactIo,
  ) {}

  async compile(input: CompileInput): Promise<CompiledArtifact> {
    const scratch = toForwardSlashes(join(this.cfg.outputDir, `${input.artifactId}.app`));
    let res: { exitCode: number; stdout: string; stderr: string };
    try {
      res = await this.io.spawn([
        this.cfg.alcPath,
        `/project:${toForwardSlashes(input.projectDir)}`,
        `/packagecachepath:${toForwardSlashes(this.cfg.packageCachePath)}`,
        `/out:${scratch}`,
      ]);
    } catch (err) {
      throw new ArtifactPrepareError(
        `could not run alc (${this.cfg.alcPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.exitCode !== 0) {
      throw new AlcCompileError(`alc compile failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.io.readArtifact(scratch);
    } catch (err) {
      throw new ArtifactPrepareError(
        `alc reported success but its output could not be read at ${scratch}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const sha256 = Bun.SHA256.hash(bytes, "hex");
    const appPath = toForwardSlashes(
      join(this.cfg.outputDir, `${sha256.slice(0, 16)}-${input.artifactId}.app`),
    );
    try {
      await this.io.writeArtifact(scratch, appPath);
    } catch (err) {
      throw new ArtifactPrepareError(
        `could not place artifact at ${appPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (input.mutantManifest.artifactId !== input.artifactId) {
      throw new ArtifactPrepareError(
        `manifest artifactId ${input.mutantManifest.artifactId} does not match ${input.artifactId}`,
      );
    }
    return {
      artifactId: input.artifactId,
      appId: input.appId,
      appVersion: input.appVersion,
      appPath,
      sha256,
      mutantManifest: input.mutantManifest,
      appManifest: input.appManifest,
    };
  }
}
```

Then reshape `publisher.ts` into `ContainerDeployer`: keep the existing `publish()` argv and env
handling verbatim (the flag names and `BC_SERVER_USERNAME`/`BC_SERVER_PASSWORD` env are all
verified against real `altool`), but take a `CompiledArtifact`, re-hash `artifact.appPath` before
spawning, and refuse to publish on mismatch:

```ts
  async publish(artifact: CompiledArtifact): Promise<void> {
    const bytes = await this.io.readArtifact(artifact.appPath);
    const actual = Bun.SHA256.hash(bytes, "hex");
    if (actual !== artifact.sha256) {
      throw new Error(
        `refusing to publish ${artifact.appPath}: digest ${actual} does not match the compiled ` +
          `artifact's ${artifact.sha256} — the file changed after compilation`,
      );
    }
    // ...existing altool argv, spawn, and exitCode !== 0 check, unchanged...
  }
```

Split `PublisherConfig` into `ArtifactCompilerConfig` (alcPath, packageCachePath, outputDir) and
`ContainerDeployerConfig` (altoolPath, server, serverInstance, tenant?, username, password).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/runner && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/artifact.ts packages/runner/src/publisher.ts packages/runner/tests/artifact.test.ts
git commit -m "feat(runner): immutable content-addressed artifacts with typed compile errors"
```

---

### Task 5: DeploymentVerifier

**Files:**
- Create: `packages/runner/src/deployment-verifier.ts`
- Test: `packages/runner/tests/deployment-verifier.test.ts`

**Interfaces:**
- Consumes: `CompiledArtifact` (Task 4), `ActivationConfig` shape from `activation.ts`.
- Produces: `type DeploymentVerification = { status: "accepted" } | { status: "mismatch";
  reported: string | null } | { status: "unavailable"; detail: string }`,
  `class DeploymentVerifier { verify(expected: CompiledArtifact): Promise<DeploymentVerification> }`,
  `decidePublishOutcome(publishOk: boolean, verification: DeploymentVerification):
  "accepted" | "indeterminate" | "anomalous" | "failed"`.

**Context:** this is deliberately NOT a fence. Its only guarantee is that a fresh Identity request
observed code claiming artifact id X at that moment. Document that on the class.

It calls `MutationControl_Identity` at the same OData base URL and with the same Basic auth as
`MutationControlClient` (`activation.ts:32-57`). Reuse that request-shaping code rather than
duplicating it — extract a small shared `postOData(action, body)` helper if needed.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runner/tests/deployment-verifier.test.ts
import { describe, expect, it } from "bun:test";
import { decidePublishOutcome } from "../src/deployment-verifier";

describe("decidePublishOutcome", () => {
  it("accepts only when the publish succeeded AND identity matches", () => {
    expect(decidePublishOutcome(true, { status: "accepted" })).toBe("accepted");
  });

  it("treats a successful publish with mismatched identity as indeterminate", () => {
    expect(decidePublishOutcome(true, { status: "mismatch", reported: "other" })).toBe(
      "indeterminate",
    );
  });

  it("treats a successful publish with unavailable identity as indeterminate", () => {
    expect(decidePublishOutcome(true, { status: "unavailable", detail: "404" })).toBe(
      "indeterminate",
    );
  });

  it("treats a FAILED publish whose identity matches as anomalous, never as success", () => {
    expect(decidePublishOutcome(false, { status: "accepted" })).toBe("anomalous");
  });

  it("treats a failed publish with mismatched identity as a publication failure", () => {
    expect(decidePublishOutcome(false, { status: "mismatch", reported: null })).toBe("failed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/runner/tests/deployment-verifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/runner/src/deployment-verifier.ts

export type DeploymentVerification =
  | { readonly status: "accepted" }
  | { readonly status: "mismatch"; readonly reported: string | null }
  | { readonly status: "unavailable"; readonly detail: string };

export type PublishOutcome = "accepted" | "indeterminate" | "anomalous" | "failed";

/**
 * Identity is mandatory ADDITIONAL evidence. It never grants permission to ignore a failed
 * publish: a failed publish whose identity happens to match is `anomalous`, and the session
 * aborts rather than running tests against a deployment we cannot explain.
 */
export function decidePublishOutcome(
  publishOk: boolean,
  verification: DeploymentVerification,
): PublishOutcome {
  if (publishOk) return verification.status === "accepted" ? "accepted" : "indeterminate";
  return verification.status === "accepted" ? "anomalous" : "failed";
}
```

Then the client. Its doc comment must state the limitation verbatim from the spec:

```ts
/**
 * Verifies that a fresh Identity request observed code claiming a given artifact id.
 *
 * This is NOT a fence. It does not prove continued ownership, that the artifact cannot
 * subsequently be replaced, that a test runner loaded the same code, or that an activation
 * belongs to the caller. Server-side fencing is Layer 5C.
 */
export class DeploymentVerifier {
  // constructor takes the same base URL / company / tenant / credentials as MutationControlClient
  async verify(expected: CompiledArtifact): Promise<DeploymentVerification> {
    // POST MutationControl_Identity, read `value`, compare to expected.artifactId.
    // Any transport/HTTP failure => { status: "unavailable", detail }.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/runner/tests/deployment-verifier.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/deployment-verifier.ts packages/runner/tests/deployment-verifier.test.ts
git commit -m "feat(runner): deployment verification via MutationControl_Identity"
```

---

### Task 6: Wire the phases into the backend and orchestrator

**Files:**
- Modify: `packages/runner/src/backend.ts` (`ExecutionBackend.deploy` return type)
- Modify: `packages/runner/src/bcdev-backend.ts:167-178` (`deploy` split)
- Modify: `packages/runner/src/orchestrator.ts` (version reservation, retry, `recordArtifact`,
  `prepareBatchProject`)
- Modify: `packages/runner/src/cli.ts` (construct compiler + deployer + verifier)
- Test: `packages/runner/tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `reserveAppVersion`, `parseVersionConflict`, `nextAbove` (Task 1);
  `Store.recordArtifact` (Task 2); `writeInstrumentedProject` with `artifactId` (Task 3);
  `ArtifactCompiler`, `ContainerDeployer`, `CompiledArtifact`, `AlcCompileError` (Task 4);
  `DeploymentVerifier`, `decidePublishOutcome` (Task 5).
- Produces: `deploy(instrumentedDir: string): Promise<CompiledArtifact | null>` on
  `ExecutionBackend` (null for backends with `deploy: "none"`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runner/tests/orchestrator.test.ts — append
it("calls compile once, then publish, then verify — in that order, before any test runs", async () => {
  const calls: string[] = [];
  const backend = fakeBackendRecording(calls); // compile/publish/verify/run push their names
  await runSession(configWith(backend));
  const firstRun = calls.indexOf("run");
  expect(calls.filter((c) => c === "compile")).toHaveLength(1);
  expect(calls.indexOf("compile")).toBeLessThan(calls.indexOf("publish"));
  expect(calls.indexOf("publish")).toBeLessThan(calls.indexOf("verify"));
  expect(calls.indexOf("verify")).toBeLessThan(firstRun);
});

it("records the version actually compiled, not the createRun placeholder", async () => {
  const store = new Store(":memory:");
  await runSession(configWith(fakeBackend(), { store }));
  const row = store.db.query("SELECT app_version FROM runs LIMIT 1").get() as { app_version: string };
  expect(row.app_version).not.toBe("0.0.0.0");
  expect(row.app_version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
});

it("re-stamps above the version BC names and retries exactly once on conflict", async () => {
  let attempts = 0;
  const backend = fakeBackendWherePublish(() => {
    attempts++;
    if (attempts === 1) {
      throw new Error(
        "Cannot install the extension X by Y 1.0.1.1 because a newer version 9.9.9.9 was already installed.",
      );
    }
  });
  const report = await runSession(configWith(backend));
  expect(attempts).toBe(2);
  expect(backend.lastCompiledVersion).toBe("9.9.9.10");
  expect(report.counts.error).toBe(0);
});

it("fails loudly on a SECOND version conflict rather than retrying forever", async () => {
  const backend = fakeBackendWherePublish(() => {
    throw new Error("...because a newer version 9.9.9.9 was already installed.");
  });
  await expect(runSession(configWith(backend))).rejects.toThrow(/version conflict/i);
});

it("runs no tests when identity does not match the published artifact", async () => {
  const calls: string[] = [];
  const backend = fakeBackendRecording(calls, { identity: "some-other-artifact-id" });
  await expect(runSession(configWith(backend))).rejects.toThrow(/indeterminate/i);
  expect(calls).not.toContain("run");
  expect(calls).not.toContain("activate");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/runner/tests/orchestrator.test.ts`
Expected: FAIL — ordering and version assertions unmet.

- [ ] **Step 3: Implement**

In `bcdev-backend.ts`, `deploy()` becomes composition over the three phases, preserving the
existing ordering constraint that coverage indexing happens from the exact artifact before publish:

```ts
  async deploy(instrumentedDir: string): Promise<CompiledArtifact> {
    if (!this.compiler || !this.deployer) throw new Error("BcDevMcpBackend: no compiler/deployer");
    const artifact = await this.compiler.compile(await this.prepareInput(instrumentedDir));
    // Before publish, from the exact artifact/source that produced them (unchanged intent).
    this.methodIndex = await AppMethodIndex.fromAppFile(artifact.appPath);
    this.localProcedures = await findLocalProcedureNames(instrumentedDir);

    let publishOk = true;
    try {
      await this.deployer.publish(artifact);
    } catch (err) {
      publishOk = false;
      this.lastPublishError = err instanceof Error ? err.message : String(err);
    }
    const verification = this.verifier
      ? await this.verifier.verify(artifact)
      : ({ status: "unavailable", detail: "no verifier configured" } as const);
    const outcome = decidePublishOutcome(publishOk, verification);
    if (outcome !== "accepted") {
      throw new DeploymentError(outcome, this.lastPublishError, verification);
    }
    return artifact;
  }
```

`DeploymentError` is a new typed error in `artifact.ts` — critically, it is **not** an
`AlcCompileError`, so Task 7's bisection guard skips it.

In `orchestrator.ts`:

- Reserve the version before compiling. Read `app.json`'s `version` for major/minor, thread a
  session-scoped `lastIssued` so repeated artifacts stay strictly increasing.
- Replace `manifest.version = \`1.0.${runId}.${batchIdx}\`` at `orchestrator.ts:854-855` with the
  reserved version passed into `prepareBatchProject`.
- Generate `artifactId` per artifact with
  `crypto.getRandomValues(new Uint8Array(16))` hex-encoded, and pass it to
  `writeInstrumentedProject`.
- After a successful deploy, call
  `cfg.store.recordArtifact(runId, { appVersion, appId, artifactId, sha256 })`.
- On a publish failure whose message `parseVersionConflict` matches, re-stamp with
  `nextAbove(reported)`, recompile and retry **once**; a second conflict throws
  `version conflict persisted after retry: ...`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/runner && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner
git commit -m "feat(runner): reserve versions, verify deployments, record artifact provenance"
```

---

### Task 7: Compile-only bisection over the full manifest

**Files:**
- Modify: `packages/runner/src/orchestrator.ts:410-438` and `:540-579` (`bisectAndNote` call sites)
- Test: `packages/runner/tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `AlcCompileError`, `DeploymentError` (Tasks 4 and 6).
- Produces: no new exports; behavioural change only.

**Context — the shipped defect:** `orchestrator.ts:422` passes `subsetMutants: execute`, the
post-history-filter set produced at `orchestrator.ts:395-403`. Known survivors are still
instrumented into the compiled artifact but are absent from the search space, so a malformed
known-survivor mutation breaks the full compile while being provably unfindable. The existing
comment acknowledges a "no-reproduction case" without identifying this as a cause.

History filtering is an execution decision, not a compilation decision.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runner/tests/orchestrator.test.ts — append
it("bisects the FULL embedded manifest, so a malformed known-survivor is findable", async () => {
  // M0003 is a known survivor: excluded from `execute`, but still compiled into the artifact.
  const store = new Store(":memory:");
  seedPriorSurvivor(store, "M0003");
  const backend = fakeBackendWhereCompileFailsFor("M0003");
  const report = await runSession(
    configWith(backend, { store, skipKnownSurvivors: true }),
  );
  const noted = report.mutants.find((m) => m.failureNote !== undefined);
  expect(noted?.failureNote).toContain("M0003");
});

it("never bisects a PUBLISH failure — that is environmental, not a mutant", async () => {
  let compileCalls = 0;
  const backend = fakeBackend({
    onCompile: () => {
      compileCalls++;
    },
    onPublish: () => {
      throw new Error("NST unavailable");
    },
  });
  await expect(runSession(configWith(backend))).rejects.toThrow();
  // One production compile, and NOT ONE bisection compile.
  expect(compileCalls).toBe(1);
});

it("aborts the search when a subset fails for a non-compiler reason", async () => {
  const backend = fakeBackendWhereCompileThrows(new ArtifactPrepareError("disk full"));
  await expect(runSession(configWith(backend))).rejects.toThrow(/disk full/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/runner/tests/orchestrator.test.ts`
Expected: FAIL — the known-survivor culprit is not found; publish failure triggers bisection.

- [ ] **Step 3: Implement**

Change the deploy-catch to bisect the full manifest and to skip non-compiler failures:

```ts
      } catch (err) {
        // A publish/verification failure is environmental: catalog conflict, schema sync,
        // dependency mismatch, license, transport, NST limits. Attributing it to a mutant would
        // be unsound, and republishing subset artifacts to diagnose it can leave a narrowed
        // candidate installed. Only a deterministic alc rejection is bisectable.
        if (!(err instanceof AlcCompileError)) throw err;
        await bisectAndNote({
          ...
          // Known survivors are excluded from `execute` but ARE compiled into the artifact, so
          // searching `execute` cannot find a malformed one. History filtering is an execution
          // decision, not a compilation decision.
          subsetMutants: manifest.mutants,
          ...
        });
      }
```

Apply the same two changes at the per-shard catch (`orchestrator.ts:540-579`).

In `bisectAndNote`'s `compiles` callback, let anything that is not an `AlcCompileError` propagate
rather than resolving `false`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/runner && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner
git commit -m "fix(runner): bisect the full manifest and never bisect a publish failure"
```

---

### Task 8: Live verification and stale-publication probes

**Files:**
- Create: `packages/runner/itest/stale-publish.itest.ts`
- Create: `packages/runner/itest/mutant-equality.ts` (normalizer + comparator)
- Modify: `package.json` (add `itest:stale-publish`)
- Modify: `fixtures/README.md` (document results)

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: `normalizeForComparison(report: SessionReport): NormalizedMutant[]`.

**Context:** aggregate counts can stay identical while individual mutants are swapped, so
per-mutant equality is the real gate. Environment-gated like the existing itests: skip unless
`LETHAL_ITEST_BCDEV=1`.

- [ ] **Step 1: Write the per-mutant equality comparator and its unit test**

```ts
// packages/runner/itest/mutant-equality.ts
export interface NormalizedMutant {
  readonly key: string; // astHash|codeunitName|operatorName|operatorMajor
  readonly verdict: string;
  readonly killingTest: string | null;
  readonly coverageFiltered: boolean;
  readonly errorClass: string | null;
}

/** Excludes duration, runId, version and artifactId — nondeterministic by design. */
export function normalizeForComparison(report: SessionReport): NormalizedMutant[] { /* ... */ }

export function diffMutants(
  before: readonly NormalizedMutant[],
  after: readonly NormalizedMutant[],
): string[] { /* returns human-readable differences; empty array means equal */ }
```

Unit-test `diffMutants` directly: equal inputs produce `[]`; a swapped verdict between two mutants
whose aggregate counts are identical produces two differences. **That swap case is the whole point
of this task** — assert it explicitly.

- [ ] **Step 2: Write the stale-publication probes**

```ts
// packages/runner/itest/stale-publish.itest.ts
// Probe A — deterministic stale dispatch.
//   1. Reserve and compile A at V.  2. Do NOT invoke altool yet.
//   3. Reserve and compile B at V+1. 4. Publish and verify B.
//   5. Now invoke publication of A.
//   Assert: A's publish fails; Identity still reports B; a fresh run still observes B.
//
// Probe B — concurrent race.
//   Compile A at V and B at V+1; start both publications concurrently; repeat 3 times.
//   Assert: regardless of completion order, Identity is B every time and A is never final.
```

Both probes must assert on **Identity plus fresh behaviour**, not on `altool` output alone.

- [ ] **Step 3: Run the probes live**

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish
```
Expected: both probes PASS. If either lets A become final after B, **stop and report BLOCKED** —
monotonic versioning is then not a sufficient deployment-order barrier and the spec's §9 says 5A
fails.

- [ ] **Step 4: Run the full live gate**

```bash
rm -rf packages/*/dist
bun test && bun run typecheck && bunx biome check packages/runner packages/schemata
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner
```

Expected: `bcdev itest: PASS`, `al-runner itest: PASS`, verdicts **killed 3 / survived 10 /
no-coverage 3 (23.1%)** on bcdev and **3 / 13 / 0 (18.8%)** on al-runner.

Then verify the actual bug is fixed: delete `fixtures/sandbox-app/lethal.sqlite`, re-run
`itest:bcdev`, and confirm publishing succeeds with no version conflict.

**If any verdict differs, that is a bug in this layer, not an expectation to update.** Report
BLOCKED with the differing table.

- [ ] **Step 5: Document and commit**

Add a "Deployment identity" section to `fixtures/README.md` recording the probe results, the
version scheme, and that `lethal.sqlite` deletion no longer breaks publishing.

```bash
git add packages/runner/itest package.json fixtures/README.md
git commit -m "test(runner): stale-publication probes and per-mutant equality gate"
```

---

## Self-Review

**Spec coverage.** §4 interfaces → Tasks 4, 5, 6. §4 publication success semantics → Task 5
(`decidePublishOutcome`) and Task 6 (wiring). §5 identity → Task 3 (baked id, parity) and Task 4
(sha256 external). §6 versioning → Task 1 and Task 6. §7 both shipped defects → Task 2
(`app_version`) and Task 7 (bisection search space). §8 compile-only bisection and typed errors →
Tasks 4 and 7. §9 probes → Task 8. §10 call-counter testing → Tasks 6, 7. §11 exit criteria →
Tasks 6, 7, 8. §3 non-goal → Global Constraints and Task 5's documented limitation.

**Gap found and closed:** §11 requires that mutating the `.app` after compilation makes publication
refuse before starting `altool`. Task 4's `publish()` re-hash covers it; assert it explicitly there.

**Gap accepted:** §11's "no version work when there is nothing to deploy" (the zero-mutant path at
`orchestrator.ts:135-142`) is an "ideally" in the spec. Task 6 should preserve the existing
invariant that no artifact is compiled or deployed; add an assertion for it if cheap.

**Type consistency.** `artifactId` is 32 lowercase hex throughout. `CompiledArtifact` field names
match between Tasks 4, 5 and 6. `AlcCompileError` / `ArtifactPrepareError` / `DeploymentError` are
introduced in Task 4 (first two) and Task 6 (third), and only `AlcCompileError` is treated as
bisectable in Task 7.
