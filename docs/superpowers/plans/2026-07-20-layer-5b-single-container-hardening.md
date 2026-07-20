# Layer 5B — Single-Container Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LethAL's single-container path stop stranding server work — classify failures by dispatch/effect state, retry only provably-undispatched operations, and on any post-dispatch ambiguity latch the session unsafe, record a durable tier-scoped quarantine, and issue no further work-plane calls.

**Architecture:** A pure state model (`OperationOutcome`) flows from the backend seams to the orchestrator, which gates every work-plane call behind a one-way `SessionSafety` latch. Ambiguity ⇒ durable quarantine keyed at service-tier scope; clearing is operator-proven only. All new logic is on the failure/ambiguity path; the healthy path stays byte-identical (frozen verdicts).

**Tech Stack:** Bun + TypeScript (ESM), `bun test`, `bun:sqlite`, biome. Backends: bc-dev MCP (SignalR test runner + OData activation) and al-runner. Spec: `docs/superpowers/specs/2026-07-20-layer-5b-single-container-hardening-design.md`.

## Global Constraints

- **No `!` non-null assertions** (biome `noNonNullAssertion: error`). Destructure-then-check for `undefined`.
- **`exactOptionalPropertyTypes: true`** — build optional props with `...(v !== undefined ? { k: v } : {})`, never assign `undefined`.
- **Typed error classes, not message-sniffing.** New failure classes extend `Error` **directly**, never each other, so `instanceof` cannot cross-match. Classification branches on the carried `outcome` field, never on `.message`.
- **The dist trap:** `bun test` does NOT type-check. Per task: `bun run typecheck` (separate), then `rm -rf packages/*/dist` AFTER typecheck and BEFORE any reported `bun test`, or ~21 stale compiled tests give phantom failures.
- **Frozen verdict tables:** bcdev **3 killed / 10 survived / 3 no-coverage (23.1%)**, al-runner **3 / 13 / 0 (18.8%)**. A behavioral-neutral change that moves a verdict is a bug → report BLOCKED, never update the expectation.
- **Mutation-test every load-bearing fix:** revert the specific fix, confirm the specific test goes red, restore. Report both outputs. A test that stays green has closed nothing.
- **Windows / Git bash:** Windows paths, bash syntax; never `2>nul` (use `2>/dev/null`). Never destructive git ops without explicit user confirmation.
- **biome scoped to touched files:** `bunx biome check <paths-you-touched>` — do not `biome check .` (≈90 pre-existing errors in engine/builtin-tier1).
- **Branch:** all work on `layer-5b-single-container-hardening` (already created). Never implement on master.

---

## File Structure

**New (`packages/runner/src/`):**
- `operation-outcome.ts` — the `OperationOutcome` state model + pure predicates. No I/O.
- `failure-classes.ts` — `ActivationFailure`, `PublicationFailure` typed errors carrying an `OperationOutcome`.
- `session-safety.ts` — `SessionSafety`, the one-way unsafe latch that gates work-plane calls.
- `resource-key.ts` — `quarantineResourceKey` (service-tier scope, tenant excluded).
- `quarantine-store.ts` — atomic, generation-checked machine-local quarantine store over an injected dir.
- `readiness-probe.ts` — non-mutating both-plane readiness probe (post-clear only).

**Modified (`packages/runner/src/`):**
- `backend.ts` — `TestVerdict` gains `operation?: OperationOutcome`.
- `activation.ts` — classify SetActive echo-mismatch-after-2xx as `completed-effect-unknown`; add `readActive()`.
- `bcdev-backend.ts` — `run()` sets `operation`; `activate()` throws `ActivationFailure`.
- `al-runner-backend.ts` — set `operation` on run(); local-child kill on ambiguity.
- `orchestrator.ts` — remove blind retries; `SessionSafety` gating; quarantine consult before `status()`; latch-gated `finally`; quarantine on `in-flight-unknown`; deploy:none app_version fix; compileCheck rm swallow.
- `cli.ts` — `quarantined` exit status + `clear-quarantine` command.

**Tests:** co-located `*.test.ts` per module; itest oracles under `packages/runner/itest/`.

---

## Task 1: `OperationOutcome` state model

**Files:**
- Create: `packages/runner/src/operation-outcome.ts`
- Test: `packages/runner/src/operation-outcome.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type OperationOutcome = "pre-dispatch-rejected" | "completed-accepted" | "completed-effect-unknown" | "in-flight-unknown" | "cancelled-confirmed"`
  - `function isRetrySafe(o: OperationOutcome): boolean`
  - `function requiresUnsafeLatch(o: OperationOutcome): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/runner/src/operation-outcome.test.ts
import { describe, expect, test } from "bun:test";
import { isRetrySafe, requiresUnsafeLatch, type OperationOutcome } from "./operation-outcome";

describe("OperationOutcome predicates", () => {
  test("only pre-dispatch-rejected is retry-safe", () => {
    const all: OperationOutcome[] = [
      "pre-dispatch-rejected",
      "completed-accepted",
      "completed-effect-unknown",
      "in-flight-unknown",
      "cancelled-confirmed",
    ];
    expect(all.filter(isRetrySafe)).toEqual(["pre-dispatch-rejected"]);
  });

  test("only in-flight-unknown forces the unsafe latch", () => {
    const all: OperationOutcome[] = [
      "pre-dispatch-rejected",
      "completed-accepted",
      "completed-effect-unknown",
      "in-flight-unknown",
      "cancelled-confirmed",
    ];
    expect(all.filter(requiresUnsafeLatch)).toEqual(["in-flight-unknown"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runner/src/operation-outcome.test.ts`
Expected: FAIL — module `./operation-outcome` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/runner/src/operation-outcome.ts

/**
 * The dispatch/effect state of a single backend operation. This — not whether an
 * exception was thrown — is what decides retry-safety and quarantine (spec §7).
 * "not still running" is NOT "safe to retry": the three questions (dispatched?
 * executing? committed an effect?) are distinct, so the states are distinct.
 */
export type OperationOutcome =
  | "pre-dispatch-rejected" // provably never reached the server — the ONLY retryable state
  | "completed-accepted" // terminal, well-formed server success
  | "completed-effect-unknown" // server work ended, effect-commit unknown (2xx malformed body, 500 after send)
  | "in-flight-unknown" // server may still be executing — latch unsafe + quarantine
  | "cancelled-confirmed"; // proven terminated by an external terminal signal (reserved for 5C)

/** The only state safe to re-issue: the request provably never reached the server. */
export function isRetrySafe(o: OperationOutcome): boolean {
  return o === "pre-dispatch-rejected";
}

/** The state that means "server may still be executing" — forces the unsafe latch (spec §8). */
export function requiresUnsafeLatch(o: OperationOutcome): boolean {
  return o === "in-flight-unknown";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runner/src/operation-outcome.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bunx biome check packages/runner/src/operation-outcome.ts packages/runner/src/operation-outcome.test.ts
git add packages/runner/src/operation-outcome.ts packages/runner/src/operation-outcome.test.ts
git commit -m "feat(runner): OperationOutcome dispatch/effect state model"
```

---

## Task 2: Typed failure classes

**Files:**
- Create: `packages/runner/src/failure-classes.ts`
- Test: `packages/runner/src/failure-classes.test.ts`

**Interfaces:**
- Consumes: `OperationOutcome` (Task 1).
- Produces:
  - `class ActivationFailure extends Error { readonly outcome: OperationOutcome; constructor(message: string, outcome: OperationOutcome) }`
  - `class PublicationFailure extends Error { readonly outcome: OperationOutcome; constructor(message: string, outcome: OperationOutcome) }`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/runner/src/failure-classes.test.ts
import { describe, expect, test } from "bun:test";
import { ActivationFailure, PublicationFailure } from "./failure-classes";

describe("failure classes", () => {
  test("carry their OperationOutcome and message", () => {
    const e = new ActivationFailure("SetActive timed out", "in-flight-unknown");
    expect(e.outcome).toBe("in-flight-unknown");
    expect(e.message).toBe("SetActive timed out");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ActivationFailure");
  });

  test("extend Error directly, never each other — instanceof cannot cross-match", () => {
    const a = new ActivationFailure("x", "pre-dispatch-rejected");
    const p = new PublicationFailure("y", "in-flight-unknown");
    expect(a).not.toBeInstanceOf(PublicationFailure);
    expect(p).not.toBeInstanceOf(ActivationFailure);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runner/src/failure-classes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/runner/src/failure-classes.ts
import type { OperationOutcome } from "./operation-outcome";

/**
 * Thrown by a backend's `activate()` when SetActive/ClearActive fails. Extends Error
 * DIRECTLY (never PublicationFailure) so `instanceof` cannot cross-match — the project's
 * typed-error rule (see AlcCompileError/DeploymentError). The orchestrator branches on
 * `.outcome`, never on the class or the message.
 */
export class ActivationFailure extends Error {
  constructor(
    message: string,
    readonly outcome: OperationOutcome,
  ) {
    super(message);
    this.name = "ActivationFailure";
  }
}

/** Thrown by the publish path when publication's server-side fate is ambiguous. Extends Error
 *  directly, never ActivationFailure. */
export class PublicationFailure extends Error {
  constructor(
    message: string,
    readonly outcome: OperationOutcome,
  ) {
    super(message);
    this.name = "PublicationFailure";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runner/src/failure-classes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bunx biome check packages/runner/src/failure-classes.ts packages/runner/src/failure-classes.test.ts
git add packages/runner/src/failure-classes.ts packages/runner/src/failure-classes.test.ts
git commit -m "feat(runner): typed ActivationFailure/PublicationFailure carrying OperationOutcome"
```

---

## Task 3: `SessionSafety` unsafe latch

**Files:**
- Create: `packages/runner/src/session-safety.ts`
- Test: `packages/runner/src/session-safety.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class SessionSafety { latchUnsafe(reason: string): void; get isUnsafe(): boolean; get reason(): string | undefined; assertSafe(op: string): void }`
  - `class SessionUnsafeError extends Error` (thrown by `assertSafe` after latch).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/runner/src/session-safety.test.ts
import { describe, expect, test } from "bun:test";
import { SessionSafety, SessionUnsafeError } from "./session-safety";

describe("SessionSafety", () => {
  test("starts safe; assertSafe is a no-op before latch", () => {
    const s = new SessionSafety();
    expect(s.isUnsafe).toBe(false);
    expect(() => s.assertSafe("activate")).not.toThrow();
  });

  test("latch is one-way and records the first reason", () => {
    const s = new SessionSafety();
    s.latchUnsafe("deadline exceeded on M0007");
    s.latchUnsafe("something later"); // must not overwrite
    expect(s.isUnsafe).toBe(true);
    expect(s.reason).toBe("deadline exceeded on M0007");
  });

  test("assertSafe throws SessionUnsafeError after latch, naming the op and reason", () => {
    const s = new SessionSafety();
    s.latchUnsafe("deadline exceeded on M0007");
    let caught: unknown;
    try {
      s.assertSafe("activate(null)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionUnsafeError);
    expect((caught as Error).message).toContain("activate(null)");
    expect((caught as Error).message).toContain("deadline exceeded on M0007");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runner/src/session-safety.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/runner/src/session-safety.ts

/** Thrown when a work-plane call is attempted after the session has latched unsafe. */
export class SessionUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionUnsafeError";
  }
}

/**
 * A per-session, one-way latch (spec §8). Once any operation resolves to `in-flight-unknown`,
 * the session is unsafe: from that point NO work-plane call (deploy/activate/test/verify/status/
 * readiness/final ClearActive) may run — only local teardown. The latch never resets and keeps
 * the FIRST reason, which is the real cause; later reasons are downstream noise.
 */
export class SessionSafety {
  #unsafe = false;
  #reason: string | undefined;

  latchUnsafe(reason: string): void {
    if (this.#unsafe) return;
    this.#unsafe = true;
    this.#reason = reason;
  }

  get isUnsafe(): boolean {
    return this.#unsafe;
  }

  get reason(): string | undefined {
    return this.#reason;
  }

  /** Guard every work-plane call site. No-op while safe; throws once latched. */
  assertSafe(op: string): void {
    if (this.#unsafe) {
      throw new SessionUnsafeError(
        `refusing work-plane call ${op}: session latched unsafe (${this.#reason ?? "unknown"})`,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runner/src/session-safety.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Mutation-check the one-way property**

Temporarily change `if (this.#unsafe) return;` in `latchUnsafe` to always overwrite (`this.#reason = reason;` unconditionally). Run the test.
Expected: the "one-way and records the first reason" test goes RED (reason becomes "something later"). Restore the line and confirm GREEN. Record both outputs in the task report.

- [ ] **Step 6: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bunx biome check packages/runner/src/session-safety.ts packages/runner/src/session-safety.test.ts
git add packages/runner/src/session-safety.ts packages/runner/src/session-safety.test.ts
git commit -m "feat(runner): SessionSafety one-way unsafe latch"
```

---

## Task 4: `quarantineResourceKey` (tier scope, tenant excluded)

**Files:**
- Create: `packages/runner/src/resource-key.ts`
- Test: `packages/runner/src/resource-key.test.ts`

**Interfaces:**
- Consumes: nothing (mirrors `ContainerKeyConfig` from `publish-serializer.ts` structurally).
- Produces:
  - `interface ResourceKeyConfig { readonly server: string; readonly serverInstance: string }`
  - `function quarantineResourceKey(cfg: ResourceKeyConfig): string`

**Rationale (spec §9):** the death spiral exhausts the shared NST/SQL worker pool, which is tier-wide. `canonicalContainerKey` includes tenant and is the wrong domain for quarantine — a strand under tenant A must block a tenant-B session on the same tier.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/runner/src/resource-key.test.ts
import { describe, expect, test } from "bun:test";
import { quarantineResourceKey } from "./resource-key";
import { canonicalContainerKey } from "./publish-serializer";

describe("quarantineResourceKey", () => {
  test("two tenants on the same tier collapse to ONE quarantine key", () => {
    const a = quarantineResourceKey({ server: "http://Cronus281", serverInstance: "BC" });
    // tenant is not even part of the input — the same tier is the same key
    const b = quarantineResourceKey({ server: "http://cronus281/", serverInstance: "BC" });
    expect(a).toBe(b);
  });

  test("differs by server and by instance", () => {
    expect(quarantineResourceKey({ server: "http://a", serverInstance: "BC" })).not.toBe(
      quarantineResourceKey({ server: "http://b", serverInstance: "BC" }),
    );
    expect(quarantineResourceKey({ server: "http://a", serverInstance: "BC" })).not.toBe(
      quarantineResourceKey({ server: "http://a", serverInstance: "BC2" }),
    );
  });

  test("is a DIFFERENT domain from canonicalContainerKey (which keeps tenant)", () => {
    // Same tier, two tenants: quarantine key identical, container key distinct.
    const qk = quarantineResourceKey({ server: "http://a", serverInstance: "BC" });
    const ck1 = canonicalContainerKey({ server: "http://a", serverInstance: "BC", tenant: "t1" });
    const ck2 = canonicalContainerKey({ server: "http://a", serverInstance: "BC", tenant: "t2" });
    expect(ck1).not.toBe(ck2);
    expect(qk).not.toBe(ck1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runner/src/resource-key.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/runner/src/resource-key.ts

/** Fields identifying a physical BC SERVICE TIER (the shared-resource scope for quarantine).
 *  Deliberately excludes tenant — the SQL worker pool is shared across tenants on one tier. */
export interface ResourceKeyConfig {
  readonly server: string;
  readonly serverInstance: string;
}

/** Lowercase + strip a single trailing slash, matching publish-serializer's normalization so
 *  `http://Cronus281/` and `http://cronus281` name the same tier. Host-vs-IP aliases are NOT
 *  resolvable here and are an operator responsibility (spec §9). */
function normalizeServer(server: string): string {
  const lower = server.toLowerCase();
  return lower.endsWith("/") ? lower.slice(0, -1) : lower;
}

/**
 * Tier-scoped quarantine identity: two configs naming the same server (modulo case/trailing
 * slash) and server instance collapse to one key, regardless of tenant. Distinct from
 * `canonicalContainerKey` (publish-serializer.ts), which keeps tenant for a different domain.
 */
export function quarantineResourceKey(cfg: ResourceKeyConfig): string {
  return `${normalizeServer(cfg.server)}|${cfg.serverInstance}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runner/src/resource-key.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Mutation-check the tenant-exclusion property**

Temporarily add a `tenant` to the key template (e.g. append `|default`). This is behavior-neutral for the given tests only if it collapses — confirm instead that adding `|${(cfg as {tenant?:string}).tenant ?? ""}` does NOT break tests (it can't, since callers pass no tenant). The real guard: revert the key to include tenant from a hypothetical field and confirm the "two tenants collapse" test would fail if tenant entered the key. Document that the key's input type structurally cannot carry tenant — that is the guard. Record reasoning in the task report.

- [ ] **Step 6: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bunx biome check packages/runner/src/resource-key.ts packages/runner/src/resource-key.test.ts
git add packages/runner/src/resource-key.ts packages/runner/src/resource-key.test.ts
git commit -m "feat(runner): tier-scoped quarantineResourceKey (tenant excluded)"
```

---

## Task 5: `QuarantineStore` — atomic write + read

**Files:**
- Create: `packages/runner/src/quarantine-store.ts`
- Test: `packages/runner/src/quarantine-store.test.ts`

**Interfaces:**
- Consumes: `quarantineResourceKey` output (a string).
- Produces:
  - `interface QuarantineRecord { readonly resourceKey: string; readonly opKind: string; readonly detail: string; readonly recordedAtIso: string; readonly generation: number }`
  - `class QuarantineStore { constructor(baseDir: string); read(resourceKey: string): Promise<QuarantineRecord | null>; record(rec: Omit<QuarantineRecord, "generation">): Promise<QuarantineRecord> }`

**Notes:** one file per resource under `baseDir`, filename = a filesystem-safe hash of `resourceKey`. Write is temp-file → rename (atomic on Windows/NTFS for same-directory rename). `generation` increments on each `record`. Clearing is Task 6.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/runner/src/quarantine-store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuarantineStore } from "./quarantine-store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lethal-quarantine-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("QuarantineStore write/read", () => {
  test("read of an unquarantined tier is null", async () => {
    const store = new QuarantineStore(dir);
    expect(await store.read("http://a|BC")).toBeNull();
  });

  test("record then read round-trips and stamps generation 1", async () => {
    const store = new QuarantineStore(dir);
    const rec = await store.record({
      resourceKey: "http://a|BC",
      opKind: "test-run",
      detail: "deadline exceeded on M0007",
      recordedAtIso: "2026-07-20T10:00:00.000Z",
    });
    expect(rec.generation).toBe(1);
    const read = await store.read("http://a|BC");
    expect(read).toEqual(rec);
  });

  test("a second record increments generation and persists across store instances", async () => {
    const s1 = new QuarantineStore(dir);
    await s1.record({ resourceKey: "http://a|BC", opKind: "test-run", detail: "x", recordedAtIso: "2026-07-20T10:00:00.000Z" });
    const second = await s1.record({ resourceKey: "http://a|BC", opKind: "activation", detail: "y", recordedAtIso: "2026-07-20T10:05:00.000Z" });
    expect(second.generation).toBe(2);
    const s2 = new QuarantineStore(dir); // fresh instance = "next session"
    expect(await s2.read("http://a|BC")).toEqual(second);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runner/src/quarantine-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/runner/src/quarantine-store.ts
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface QuarantineRecord {
  readonly resourceKey: string;
  readonly opKind: string;
  readonly detail: string;
  readonly recordedAtIso: string;
  readonly generation: number;
}

/**
 * Machine-local durable quarantine, one file per service tier under `baseDir` (spec §9).
 *
 * GUARANTEE (honest): best-effort durable across NON-overlapping processes on one host. It is
 * NOT concurrent-session-safe — two overlapping processes can still race (B reads before A
 * writes). Closing that race needs a pre-operation cross-process lease — 5C, not this module.
 *
 * Each write is atomic (temp file → rename) so a crash never leaves a partial record; a write
 * that cannot be made durable throws (the caller then fails the session loudly, never proceeds
 * unmarked). `generation` monotonically increases per tier and gates clears (Task 6).
 */
export class QuarantineStore {
  constructor(private readonly baseDir: string) {}

  private fileFor(resourceKey: string): string {
    const safe = createHash("sha256").update(resourceKey).digest("hex").slice(0, 32);
    return join(this.baseDir, `${safe}.json`);
  }

  async read(resourceKey: string): Promise<QuarantineRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(resourceKey), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return JSON.parse(raw) as QuarantineRecord;
  }

  async record(rec: Omit<QuarantineRecord, "generation">): Promise<QuarantineRecord> {
    await mkdir(this.baseDir, { recursive: true });
    const prior = await this.read(rec.resourceKey);
    const next: QuarantineRecord = { ...rec, generation: (prior?.generation ?? 0) + 1 };
    const target = this.fileFor(rec.resourceKey);
    const tmp = `${target}.tmp-${next.generation}`;
    await writeFile(tmp, JSON.stringify(next), "utf8");
    await rename(tmp, target); // atomic same-dir rename
    return next;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runner/src/quarantine-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bunx biome check packages/runner/src/quarantine-store.ts packages/runner/src/quarantine-store.test.ts
git add packages/runner/src/quarantine-store.ts packages/runner/src/quarantine-store.test.ts
git commit -m "feat(runner): QuarantineStore atomic tier-keyed write/read"
```

---

## Task 6: `QuarantineStore` — generation-checked clear

**Files:**
- Modify: `packages/runner/src/quarantine-store.ts`
- Modify: `packages/runner/src/quarantine-store.test.ts`

**Interfaces:**
- Produces (added): `clear(resourceKey: string, expectedGeneration: number): Promise<"cleared" | "stale">`

**Rationale (spec §9):** a stale clear (one holding an older generation) must NOT erase a newer quarantine written after it read.

- [ ] **Step 1: Write the failing test (append to the describe block)**

```typescript
describe("QuarantineStore clear (generation-checked)", () => {
  test("clear with the current generation removes the record", async () => {
    const store = new QuarantineStore(dir);
    const rec = await store.record({ resourceKey: "http://a|BC", opKind: "test-run", detail: "x", recordedAtIso: "2026-07-20T10:00:00.000Z" });
    expect(await store.clear("http://a|BC", rec.generation)).toBe("cleared");
    expect(await store.read("http://a|BC")).toBeNull();
  });

  test("a stale clear (older generation) does NOT erase a newer record", async () => {
    const store = new QuarantineStore(dir);
    const first = await store.record({ resourceKey: "http://a|BC", opKind: "test-run", detail: "x", recordedAtIso: "2026-07-20T10:00:00.000Z" });
    await store.record({ resourceKey: "http://a|BC", opKind: "activation", detail: "y", recordedAtIso: "2026-07-20T10:05:00.000Z" }); // gen 2
    expect(await store.clear("http://a|BC", first.generation)).toBe("stale"); // holding gen 1
    expect(await store.read("http://a|BC")).not.toBeNull(); // gen 2 survives
  });

  test("clear of an already-absent record is 'cleared' (idempotent)", async () => {
    const store = new QuarantineStore(dir);
    expect(await store.clear("http://a|BC", 1)).toBe("cleared");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runner/src/quarantine-store.test.ts`
Expected: FAIL — `store.clear` is not a function.

- [ ] **Step 3: Add the `clear` method**

Add to the `QuarantineStore` class in `quarantine-store.ts`:

```typescript
  /**
   * Remove the tier's quarantine ONLY if the caller holds the current generation. A clear
   * computed against an older generation (another session wrote a newer quarantine in between)
   * returns "stale" and leaves the newer record intact — a stale clear must never erase a newer
   * strand. Clearing an already-absent record is idempotent "cleared".
   */
  async clear(resourceKey: string, expectedGeneration: number): Promise<"cleared" | "stale"> {
    const current = await this.read(resourceKey);
    if (current === null) return "cleared";
    if (current.generation !== expectedGeneration) return "stale";
    await rm(this.fileFor(resourceKey), { force: true });
    return "cleared";
  }
```

Add `rm` to the existing `node:fs/promises` import:

```typescript
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runner/src/quarantine-store.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Mutation-check the generation guard**

Temporarily change `if (current.generation !== expectedGeneration) return "stale";` to `if (false) return "stale";`. Run the test.
Expected: "a stale clear ... does NOT erase a newer record" goes RED (the gen-2 record gets erased). Restore and confirm GREEN. Record both outputs.

- [ ] **Step 6: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bunx biome check packages/runner/src/quarantine-store.ts packages/runner/src/quarantine-store.test.ts
git add packages/runner/src/quarantine-store.ts packages/runner/src/quarantine-store.test.ts
git commit -m "feat(runner): generation-checked QuarantineStore.clear"
```

---

## Task 7: Backend seam — `TestVerdict.operation`

**Files:**
- Modify: `packages/runner/src/backend.ts:29-35`
- Modify: `packages/runner/src/al-runner-backend.ts` (set `operation` on every returned verdict)
- Test: `packages/runner/src/backend-seam.test.ts` (new — a compile-level + al-runner shape assertion)

**Interfaces:**
- Produces (added): `TestVerdict.operation?: OperationOutcome`.
- Consumes: `OperationOutcome` (Task 1).

**Rationale (spec §11):** `run()` returns only a final verdict, erasing dispatch state. Adding `operation` lets the orchestrator tell a retry-safe pre-dispatch failure from an in-flight-unknown one. Optional (exactOptionalPropertyTypes): absent ⇒ treat as `completed-accepted` for terminal test outcomes.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/runner/src/backend-seam.test.ts
import { describe, expect, test } from "bun:test";
import type { TestVerdict } from "./backend";

describe("TestVerdict.operation", () => {
  test("a verdict may carry an OperationOutcome", () => {
    const v: TestVerdict = {
      ref: { codeunitId: 1, codeunitName: "C", method: "m" },
      outcome: "error",
      durationMs: 1,
      operation: "pre-dispatch-rejected",
    };
    expect(v.operation).toBe("pre-dispatch-rejected");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run typecheck`
Expected: FAIL — `operation` does not exist on `TestVerdict`.

- [ ] **Step 3: Add the field**

In `backend.ts`, add the import and extend `TestVerdict`:

```typescript
import type { CompiledArtifact } from "./artifact";
import type { OperationOutcome } from "./operation-outcome";
```

```typescript
export interface TestVerdict {
  readonly ref: TestMethodRef;
  readonly outcome: TestOutcome;
  readonly durationMs: number;
  readonly failureMessage?: string;
  readonly coverage?: CoverageMap;
  /**
   * The dispatch/effect state of this run (spec §7/§11). Absent ⇒ a terminal test outcome
   * (`completed-accepted`). Set on failure paths to distinguish a retry-safe pre-dispatch
   * failure from an `in-flight-unknown` one the orchestrator must quarantine.
   */
  readonly operation?: OperationOutcome;
}
```

- [ ] **Step 4: Verify al-runner still typechecks (no behavior change yet)**

Run: `bun run typecheck`
Expected: PASS (the field is optional; existing verdicts omit it).

- [ ] **Step 5: Clear dist, run tests, commit**

```bash
cd U:/Git/LethAL && rm -rf packages/*/dist
bun test packages/runner
bunx biome check packages/runner/src/backend.ts packages/runner/src/backend-seam.test.ts
git add packages/runner/src/backend.ts packages/runner/src/backend-seam.test.ts
git commit -m "feat(runner): TestVerdict carries OperationOutcome (backend seam)"
```

---

## Task 8: bcdev `run()` — classify dispatch/effect state

**Files:**
- Modify: `packages/runner/src/bcdev-backend.ts:293-374` (the `run()` method)
- Test: `packages/runner/src/bcdev-backend.test.ts` (add cases; uses the existing `transportFactory`/fake-client harness in that file)

**Interfaces:**
- Consumes: `OperationOutcome` (Task 1), `TestVerdict.operation` (Task 7).
- Produces: `bcdev run()` returns verdicts whose `operation` is: `in-flight-unknown` on the deadline branch; `pre-dispatch-rejected` when `connect()` failed before dispatch; `in-flight-unknown` when the call rejected after dispatch; unset (⇒ completed-accepted) on a normal parsed result.

**Key discriminator:** wrap `connect()` separately from the `callTool` dispatch. A failure in `connect()` (or before `callTool` is invoked) never reached the server → `pre-dispatch-rejected`. A rejection *after* `callTool` was issued is `in-flight-unknown` (the run may have started server-side).

- [ ] **Step 1: Write the failing tests**

```typescript
// add to packages/runner/src/bcdev-backend.test.ts
import { requiresUnsafeLatch } from "./operation-outcome";

test("run() deadline is in-flight-unknown (server may still be executing)", async () => {
  // Harness: a transportFactory whose callTool never resolves within the budget.
  const backend = makeBackendWithHangingRun(); // see existing test helpers in this file
  const v = await backend.run(
    { codeunitId: 50000, codeunitName: "T", method: "t1" },
    { coverage: "none", timeoutMs: 20 },
  );
  expect(v.outcome).toBe("deadline-exceeded");
  expect(v.operation).toBe("in-flight-unknown");
  expect(requiresUnsafeLatch(v.operation ?? "completed-accepted")).toBe(true);
});

test("run() connect failure before dispatch is pre-dispatch-rejected", async () => {
  const backend = makeBackendWhoseConnectThrows("ECONNREFUSED");
  const v = await backend.run(
    { codeunitId: 50000, codeunitName: "T", method: "t1" },
    { coverage: "none", timeoutMs: 1000 },
  );
  expect(v.outcome).toBe("error");
  expect(v.operation).toBe("pre-dispatch-rejected");
});

test("run() rejection AFTER dispatch is in-flight-unknown", async () => {
  const backend = makeBackendWhoseCallRejectsAfterDispatch("socket hang up");
  const v = await backend.run(
    { codeunitId: 50000, codeunitName: "T", method: "t1" },
    { coverage: "none", timeoutMs: 1000 },
  );
  expect(v.outcome).toBe("error");
  expect(v.operation).toBe("in-flight-unknown");
});
```

> Implementer note: the three `make…` helpers are thin wrappers over this file's existing `transportFactory` fake (search the file for how current tests inject a fake MCP client). Build them to (a) hang the `callTool` promise, (b) throw from `connect()`/transport construction, (c) resolve `connect()` then reject the `callTool` promise. Keep them local to the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/src/bcdev-backend.test.ts`
Expected: FAIL — `operation` is undefined on all three.

- [ ] **Step 3: Rewrite `run()` to classify (replace lines 293-374)**

```typescript
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Phase 1 — connect. A failure here provably never dispatched a test run.
    let client: Client;
    try {
      client = await this.connect();
    } catch (err) {
      return {
        ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: String(err),
        operation: "pre-dispatch-rejected",
      };
    }

    // Phase 2 — dispatch. From the moment callTool is issued, a failure is ambiguous:
    // the run may already be executing server-side.
    try {
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
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
        }),
      ]);
      if (res === "timeout") {
        call.catch(() => {}); // late result discarded; the SERVER RUN IS NOT CANCELLED
        // Our timer fired; the server may still be executing. Ambiguous → in-flight-unknown.
        return {
          ref,
          outcome: "deadline-exceeded",
          durationMs: Date.now() - started,
          operation: "in-flight-unknown",
        };
      }
      if (isToolError(res)) {
        // The server answered (a thrown handler surfaces as a normal isError result), so this
        // is a completed, well-formed error — not an in-flight ambiguity.
        return {
          ref,
          outcome: "error",
          durationMs: Date.now() - started,
          failureMessage: firstText(res),
        };
      }
      const payload = parseTestRunPayload(firstText(res));
      const r = payload.results.find(
        (x) => x.codeunitId === ref.codeunitId && x.method === ref.method,
      );
      if (!r) {
        return {
          ref,
          outcome: "error",
          durationMs: Date.now() - started,
          failureMessage: "bcdev_test_run returned no result for the requested method",
        };
      }
      const outcome = WIRE_STATUS_TO_OUTCOME[r.status];
      const coverage =
        opts.coverage !== "none"
          ? this.buildCoverageMap(payload.coverage, ref.codeunitId)
          : undefined;
      return {
        ref,
        outcome,
        durationMs: Date.now() - started,
        ...(outcome === "fail" && r.output ? { failureMessage: r.output } : {}),
        ...(coverage !== undefined ? { coverage } : {}),
      };
    } catch (err) {
      // The call was dispatched and then rejected (transport dropped mid-flight, etc.). The
      // server may still be running the test → ambiguous.
      return {
        ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: String(err),
        operation: "in-flight-unknown",
      };
    } finally {
      clearTimeout(timer);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass, and confirm no healthy-path change**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/src/bcdev-backend.test.ts`
Expected: PASS including the three new cases; all pre-existing cases still green (a normal parsed `pass`/`fail` verdict omits `operation`).

- [ ] **Step 5: Mutation-check the dispatch boundary**

Temporarily move the `connect()` call back INSIDE the single try (so a connect failure is caught by the post-dispatch `catch` and labelled `in-flight-unknown`). Run the tests.
Expected: "connect failure before dispatch is pre-dispatch-rejected" goes RED. Restore and confirm GREEN. Record both outputs.

- [ ] **Step 6: Typecheck, clear dist, full runner suite, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
bunx biome check packages/runner/src/bcdev-backend.ts packages/runner/src/bcdev-backend.test.ts
git add packages/runner/src/bcdev-backend.ts packages/runner/src/bcdev-backend.test.ts
git commit -m "feat(runner): bcdev run() classifies pre-dispatch vs in-flight-unknown"
```

---

## Task 8A: al-runner `run()` — set `operation` (classification parity)

> **Inserted after review of Task 7.** The plan's Task 7 Files section and spec §6/§11 require al-runner to participate in dispatch/effect classification, but no numbered task wired it — Task 8 is bcdev-only. Without this, once Task 10's `runOnce` gates retry on `TestVerdict.operation`, al-runner error outcomes (today retried once by `runWithRetry`) would silently never retry. This task closes that gap. Mirrors Layer 5A's Task 7b carve-out.

**Files:**
- Modify: `packages/runner/src/al-runner-backend.ts:211-256` (the `run()` method)
- Test: `packages/runner/src/al-runner-backend.test.ts` (add cases against the existing fake-transport harness)

**Interfaces:**
- Consumes: `OperationOutcome` (Task 1), `TestVerdict.operation` (Task 7).
- Produces: al-runner `run()` sets `operation: "pre-dispatch-rejected"` on its `error` outcomes (so `runOnce` still retries them once — preserving today's behavior, and safe because al-runner recompiles fresh each call and strands no shared server); leaves `operation` UNSET on `deadline` (so Task 12's plain deadline branch handles it as a non-latching infrastructure error — al-runner has no shared tier to quarantine).

**Rationale — local-child kill is already handled, do not re-add it:** the "kill the local child on ambiguity" requirement (spec §6/§11) is ALREADY satisfied by the transport: `OneShotTransport` aborts the spawned al-runner process via its `AbortController` on deadline (`al-runner-transport.ts:61-73`), and `ServerTransport` calls `close()` (which `proc.kill()`s and forces a re-spawn next call) on deadline (`al-runner-transport.ts:244-247,263-274`). This task must NOT add a second kill path — it only sets the `operation` field on the verdict.

- [ ] **Step 1: Write the failing tests**

```typescript
// add to packages/runner/src/al-runner-backend.test.ts
import { requiresUnsafeLatch } from "./operation-outcome";

test("al-runner run() marks a transport error pre-dispatch-rejected (retry-safe; no shared strand)", async () => {
  const backend = makeAlRunnerBackendWithTransport({
    send: async () => ({ kind: "error", detail: "al-runner exited 1" }),
    close: async () => {},
  });
  const v = await backend.run(
    { codeunitId: 50000, codeunitName: "T", method: "t1" },
    { coverage: "none", timeoutMs: 1000 },
  );
  expect(v.outcome).toBe("error");
  expect(v.operation).toBe("pre-dispatch-rejected");
});

test("al-runner run() deadline does NOT set an unsafe-latching operation (child already killed by transport)", async () => {
  const backend = makeAlRunnerBackendWithTransport({
    send: async () => ({ kind: "deadline" }),
    close: async () => {},
  });
  const v = await backend.run(
    { codeunitId: 50000, codeunitName: "T", method: "t1" },
    { coverage: "none", timeoutMs: 1000 },
  );
  expect(v.outcome).toBe("deadline-exceeded");
  expect(v.operation).toBeUndefined();
  expect(requiresUnsafeLatch(v.operation ?? "completed-accepted")).toBe(false);
});
```

> Implementer note: `makeAlRunnerBackendWithTransport` — reuse or extend this file's existing fake-transport construction (the tests already inject a fake `AlRunnerTransport`). The fake's `send` returns an `AlRunnerResult` (`{ kind: "deadline" } | { kind: "skip"|"error", detail } | { kind: "tests"/ok, tests }` — match the real union in `al-runner-transport.ts`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/src/al-runner-backend.test.ts`
Expected: FAIL — `operation` is undefined on the error verdict.

- [ ] **Step 3: Set `operation` on the two `error` returns**

In `al-runner-backend.ts` `run()`, add `operation: "pre-dispatch-rejected"` to BOTH `error` returns (the `res.kind === "error"` return and the missing-test `error` return). Do NOT touch the `deadline`, `skip`, `pass`, `fail`, or `timeout` returns:

```typescript
    if (res.kind === "error")
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: res.detail,
        operation: "pre-dispatch-rejected",
      };
    const t = res.tests.find((x) => x.name === ref.method);
    if (!t)
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: "al-runner output missing the requested test",
        operation: "pre-dispatch-rejected",
      };
```

Add the import if `OperationOutcome` type is needed (the literal string is enough — no import required unless you annotate).

- [ ] **Step 4: Run tests to verify they pass; full suite green**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner`
Expected: PASS — new cases pass; existing al-runner tests unaffected (they omit `operation`, still valid).

- [ ] **Step 5: Mutation-check the retry-safety classification**

Temporarily change the `res.kind === "error"` return's `operation` to `"in-flight-unknown"`. Run the tests.
Expected: "marks a transport error pre-dispatch-rejected" goes RED. Restore, confirm GREEN. Record both outputs. (This pins that al-runner errors stay retry-safe rather than latching the session unsafe.)

- [ ] **Step 6: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
bunx biome check packages/runner/src/al-runner-backend.ts packages/runner/src/al-runner-backend.test.ts
git add packages/runner/src/al-runner-backend.ts packages/runner/src/al-runner-backend.test.ts
git commit -m "feat(runner): al-runner run() sets operation (retry-safe errors, non-latching deadline)"
```

---

## Task 9: Activation — classify echo-mismatch-after-2xx; add `readActive`

**Files:**
- Modify: `packages/runner/src/activation.ts` (`postOData`, `MutationControlClient.setActive`, add `readActive`)
- Modify: `packages/runner/src/bcdev-backend.ts` (`activate()` throws `ActivationFailure` carrying outcome)
- Test: `packages/runner/src/activation.test.ts` (add cases)

**Interfaces:**
- Consumes: `OperationOutcome`, `ActivationFailure`.
- Produces:
  - `MutationControlClient.setActive` throws `ActivationFailure` with `outcome: "completed-effect-unknown"` on echo mismatch after a 2xx (the codeunit may have committed), and `"pre-dispatch-rejected"` when the request never dispatched (connect/DNS/pre-send).
  - `MutationControlClient.readActive(): Promise<string | null>` — a non-mutating read of the current active mutant id (for reconciliation).
  - `BcDevMcpBackend.activate()` throws `ActivationFailure` (never a raw `Error`).

**Rationale (spec §6, §7):** `SetActive` can reach the codeunit, `Insert`/`Commit`, then return a 2xx whose body `postOData` swallows → `setActive` throws an echo mismatch. That is `completed-effect-unknown`, NOT a clean rejection — retrying can conflict with an already-committed activation.

- [ ] **Step 1: Write the failing tests**

```typescript
// add to packages/runner/src/activation.test.ts
import { ActivationFailure } from "./failure-classes";

test("setActive: echo mismatch after a 2xx is completed-effect-unknown (no blind retry)", async () => {
  // fetch resolves 200 but with an empty/wrong body → postOData returns {} → echo mismatch
  const fetchFn = (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const client = new MutationControlClient(cfg(), fetchFn);
  let caught: unknown;
  try {
    await client.setActive("M0007");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ActivationFailure);
  expect((caught as ActivationFailure).outcome).toBe("completed-effect-unknown");
});

test("setActive: a pre-dispatch fetch throw is pre-dispatch-rejected", async () => {
  const fetchFn = (async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  }) as unknown as typeof fetch;
  const client = new MutationControlClient(cfg(), fetchFn);
  let caught: unknown;
  try {
    await client.setActive("M0007");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ActivationFailure);
  expect((caught as ActivationFailure).outcome).toBe("pre-dispatch-rejected");
});

test("readActive returns the current active id from the OData read", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ value: "M0007" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const client = new MutationControlClient(cfg(), fetchFn);
  expect(await client.readActive()).toBe("M0007");
});
```

> Implementer note: `cfg()` is a small helper returning a valid `ActivationConfig`; reuse or add one at the top of the test file. The `readActive` OData action name is assumed `GetActive` — verify the actual `MutationControl_*` read action exposed by the generated selector AL (`packages/schemata/src/selector.ts`) and use the real name; if none exists, this task also adds a read action to the emitter (see Step 3b).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/src/activation.test.ts`
Expected: FAIL — `setActive` throws a plain `Error`, no `readActive`.

- [ ] **Step 3: Classify in `setActive`; distinguish dispatch in `postOData`**

Change `postOData` to throw a typed marker on pre-dispatch failure. Wrap the `fetchFn` call so a throw *before* a response is received is distinguishable from an HTTP-status rejection:

```typescript
// in postOData, replace the try body's fetch + !res.ok handling:
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // No HTTP response ever arrived. If our own timeout aborted it, the request may have reached
    // the server → ambiguous. A pre-response network throw (DNS/connect refused) never dispatched.
    const aborted = controller.signal.aborted;
    throw new ActivationFailure(
      `MutationControl_${action} ${aborted ? "timed out" : "failed pre-dispatch"}: ${String(err)}`,
      aborted ? "in-flight-unknown" : "pre-dispatch-rejected",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // The server answered with a non-2xx. The request was dispatched and the codeunit MAY have
    // committed before the error surfaced → effect unknown, not a clean pre-dispatch rejection.
    throw new ActivationFailure(`MutationControl_${action} failed: HTTP ${res.status}`, "completed-effect-unknown");
  }
  return await res.json().catch(() => ({}));
```

Add the import at the top of `activation.ts`:

```typescript
import { ActivationFailure } from "./failure-classes";
```

Change `setActive` so the echo mismatch (2xx body did not confirm) is `completed-effect-unknown`:

```typescript
  async setActive(mutantId: string): Promise<void> {
    const payload = (await this.post("SetActive", { mutantId })) as { value?: string };
    if (payload.value !== mutantId) {
      throw new ActivationFailure(
        `activation echo mismatch: sent ${mutantId}, got ${String(payload.value)}`,
        "completed-effect-unknown",
      );
    }
  }
```

Add `readActive` (non-mutating reconciliation read):

```typescript
  /** Non-mutating read of the current active mutant id (spec §7 reconciliation). Returns null
   *  when nothing is active. Used to decide, after a completed-effect-unknown activation, whether
   *  the effect actually landed — never a retry. */
  async readActive(): Promise<string | null> {
    const payload = (await this.post("GetActive")) as { value?: string | null };
    return typeof payload.value === "string" && payload.value !== "" ? payload.value : null;
  }
```

- [ ] **Step 3b (conditional): add the `GetActive` read action to the selector emitter**

If `packages/schemata/src/selector.ts` does not already emit a `MutationControl_GetActive` unbound OData function returning the active id, add it (mirroring the existing `SetActive`/`ClearActive` shape, `ObjectType` exactly `CodeUnit`), and add it to BOTH `emitMutationSelector` and `emitStaticSelector` (they must expose the same procedure set — see `mem:conventions`). Add a schemata unit test asserting the emitted AL contains the `GetActive` action. This is only needed if no read surface exists.

- [ ] **Step 4: Make `BcDevMcpBackend.activate()` throw `ActivationFailure`**

`activate()` currently delegates to `clearActive`/`setActive`, which now throw `ActivationFailure` themselves — so no wrapping is needed for `setActive`. For `clearActive` (which had no echo check), ensure a failure still surfaces as `ActivationFailure` (it will, via `postOData`). Confirm `activate()` adds no `catch` that downgrades the typed error to a raw `Error`. No code change expected beyond verifying; add a test:

```typescript
// add to packages/runner/src/bcdev-backend.test.ts
import { ActivationFailure } from "./failure-classes";

test("activate() surfaces ActivationFailure with a classified outcome", async () => {
  const backend = makeBackendWhoseActivationEchoMismatches(); // fake activation client
  let caught: unknown;
  try {
    await backend.activate("M0007");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ActivationFailure);
  expect((caught as ActivationFailure).outcome).toBe("completed-effect-unknown");
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/src/activation.test.ts packages/runner/src/bcdev-backend.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-check the effect-unknown classification**

Temporarily change the echo-mismatch outcome from `"completed-effect-unknown"` to `"pre-dispatch-rejected"`. Run the tests.
Expected: "echo mismatch after a 2xx is completed-effect-unknown" goes RED. Restore, confirm GREEN. Record both.

- [ ] **Step 7: Typecheck, clear dist, full runner suite, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
bunx biome check packages/runner/src/activation.ts packages/runner/src/activation.test.ts packages/runner/src/bcdev-backend.ts packages/runner/src/bcdev-backend.test.ts
git add packages/runner/src/activation.ts packages/runner/src/activation.test.ts packages/runner/src/bcdev-backend.ts packages/runner/src/bcdev-backend.test.ts
git commit -m "feat(runner): classify SetActive echo-mismatch as completed-effect-unknown; add readActive"
```

---

## Task 10: Orchestrator — remove blind retries

**Files:**
- Modify: `packages/runner/src/orchestrator.ts:1039-1058` (`activateWithRetry`, `runWithRetry`)
- Modify: `packages/runner/src/orchestrator.ts:835,888` (call sites) and `:855,889` (run call sites)
- Test: `packages/runner/src/orchestrator.test.ts` (add retry-classification cases against the existing fake backend)

**Interfaces:**
- Consumes: `isRetrySafe` (Task 1), `ActivationFailure` (Task 2), `TestVerdict.operation` (Task 7).
- Produces:
  - `activateOnce(backend, safety, mutantId)` — one attempt; retry ONLY if the thrown `ActivationFailure.outcome` is retry-safe; on `in-flight-unknown` latch unsafe and rethrow.
  - `runOnce(backend, ref, opts)` — one attempt; retry ONLY if `first.operation` is retry-safe.

**Rationale (spec §12):** the current `activateWithRetry` retries on ANY failure and `runWithRetry` retries on ANY `error` — including a post-dispatch ambiguity, the death-spiral trigger.

- [ ] **Step 1: Write the failing tests**

```typescript
// add to packages/runner/src/orchestrator.test.ts
import { ActivationFailure } from "./failure-classes";
import { SessionSafety } from "./session-safety";

test("activateOnce retries a pre-dispatch-rejected activation exactly once", async () => {
  let calls = 0;
  const backend = fakeBackend({
    activate: async () => {
      calls++;
      if (calls === 1) throw new ActivationFailure("boom", "pre-dispatch-rejected");
      // second call succeeds
    },
  });
  const safety = new SessionSafety();
  await activateOnce(backend, safety, "M0007");
  expect(calls).toBe(2);
  expect(safety.isUnsafe).toBe(false);
});

test("activateOnce does NOT retry an in-flight-unknown activation; latches unsafe and rethrows", async () => {
  let calls = 0;
  const backend = fakeBackend({
    activate: async () => {
      calls++;
      throw new ActivationFailure("timed out", "in-flight-unknown");
    },
  });
  const safety = new SessionSafety();
  await expect(activateOnce(backend, safety, "M0007")).rejects.toBeInstanceOf(ActivationFailure);
  expect(calls).toBe(1); // never retried
  expect(safety.isUnsafe).toBe(true);
});

test("runOnce retries only a pre-dispatch-rejected run", async () => {
  let calls = 0;
  const backend = fakeBackend({
    run: async (ref) => {
      calls++;
      if (calls === 1) return { ref, outcome: "error", durationMs: 1, operation: "pre-dispatch-rejected" };
      return { ref, outcome: "pass", durationMs: 1 };
    },
  });
  const v = await runOnce(backend, aRef(), { coverage: "none", timeoutMs: 100 });
  expect(calls).toBe(2);
  expect(v.outcome).toBe("pass");
});

test("runOnce does NOT retry an in-flight-unknown run", async () => {
  let calls = 0;
  const backend = fakeBackend({
    run: async (ref) => {
      calls++;
      return { ref, outcome: "error", durationMs: 1, operation: "in-flight-unknown" };
    },
  });
  const v = await runOnce(backend, aRef(), { coverage: "none", timeoutMs: 100 });
  expect(calls).toBe(1);
  expect(v.operation).toBe("in-flight-unknown");
});
```

> Implementer note: `fakeBackend`, `aRef` — reuse the existing orchestrator test fakes in this file; extend `fakeBackend` to accept partial `run`/`activate` overrides if it doesn't already.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/src/orchestrator.test.ts`
Expected: FAIL — `activateOnce`/`runOnce` not exported.

- [ ] **Step 3: Replace `activateWithRetry` and `runWithRetry`**

Replace lines 1039-1058 with:

```typescript
/**
 * One activation attempt. Retries ONLY a `pre-dispatch-rejected` failure (provably never reached
 * the server). An `in-flight-unknown` failure latches the session unsafe and rethrows — retrying
 * an activation that may still be executing is the death-spiral trigger (spec §12). A
 * `completed-effect-unknown` failure is NOT retried either — the caller reconciles via readActive.
 */
async function activateOnce(
  backend: ExecutionBackend,
  safety: SessionSafety,
  mutantId: string | null,
): Promise<void> {
  safety.assertSafe(`activate(${mutantId ?? "null"})`);
  try {
    await backend.activate(mutantId);
  } catch (err) {
    if (err instanceof ActivationFailure) {
      if (isRetrySafe(err.outcome)) {
        await backend.activate(mutantId); // one retry: nothing was dispatched the first time
        return;
      }
      if (requiresUnsafeLatch(err.outcome)) {
        safety.latchUnsafe(`activation in-flight-unknown: ${err.message}`);
      }
    }
    throw err;
  }
}

/**
 * One test run. Retries ONLY a `pre-dispatch-rejected` run (the connect never dispatched a test).
 * An `in-flight-unknown` run is never retried — the first run may still be executing server-side.
 */
async function runOnce(
  backend: ExecutionBackend,
  ref: TestMethodRef,
  opts: { coverage: "none" | "procedure" | "line"; timeoutMs: number },
): Promise<TestVerdict> {
  const first = await backend.run(ref, opts);
  if (first.outcome !== "error") return first;
  if (first.operation !== undefined && isRetrySafe(first.operation)) {
    return backend.run(ref, opts);
  }
  return first;
}
```

Add imports at the top of `orchestrator.ts`:

```typescript
import { isRetrySafe, requiresUnsafeLatch } from "./operation-outcome";
import { ActivationFailure } from "./failure-classes";
import { SessionSafety } from "./session-safety";
```

- [ ] **Step 4: Rename call sites**

Replace every `activateWithRetry(args.backend, X)` / `activateWithRetry(cfg.backend, X)` with `activateOnce(<backend>, safety, X)` and every `runWithRetry(...)` with `runOnce(...)`. (Threading `safety` into these functions is Task 11; for now, construct a local `SessionSafety` at the top of `runSession` and pass it through — Task 11 wires it fully. Sites: `:576`, `:835`, `:888` for activation; `:855`, `:889` for run.)

- [ ] **Step 5: Run tests to verify they pass; full suite green**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner`
Expected: PASS — new retry tests pass; existing orchestrator tests unaffected (healthy path never hits the error branch).

- [ ] **Step 6: Mutation-check the no-retry-after-ambiguity guard**

Temporarily change `if (first.operation !== undefined && isRetrySafe(first.operation))` to `if (true)` in `runOnce`. Run the tests.
Expected: "runOnce does NOT retry an in-flight-unknown run" goes RED (calls === 2). Restore, confirm GREEN. Repeat for `activateOnce`: change `isRetrySafe(err.outcome)` to `true` → "does NOT retry an in-flight-unknown activation" goes RED. Record all outputs.

- [ ] **Step 7: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
bunx biome check packages/runner/src/orchestrator.ts packages/runner/src/orchestrator.test.ts
git add packages/runner/src/orchestrator.ts packages/runner/src/orchestrator.test.ts
git commit -m "feat(runner): retry only pre-dispatch failures; latch unsafe on in-flight-unknown"
```

---

## Task 11: Orchestrator — gate all work-plane calls on `SessionSafety`

**Files:**
- Modify: `packages/runner/src/orchestrator.ts` — `runSession` (`:343-346` status/quarantine ordering, `:749-759` finally), the mutant loop, publication path.
- Test: `packages/runner/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: `SessionSafety` (Task 3), `QuarantineStore` (Tasks 5-6), `quarantineResourceKey` (Task 4).
- Produces: `runSession` constructs one `SessionSafety` + consults quarantine BEFORE `status()`; the `finally` teardown is latch-gated (no `activate(null)` after unsafe); `DeploymentVerifier` and `status()` never run after unsafe.

- [ ] **Step 1: Write the failing tests**

```typescript
// add to packages/runner/src/orchestrator.test.ts
test("finally teardown does NOT call activate(null) once the session is unsafe", async () => {
  const activateCalls: Array<string | null> = [];
  const backend = fakeBackend({
    run: async (ref) => ({ ref, outcome: "deadline-exceeded", durationMs: 1, operation: "in-flight-unknown" }),
    activate: async (id) => { activateCalls.push(id); },
  });
  await runSessionForTest(backend, { quarantineDir: freshTmpDir() }).catch(() => {});
  // The mutant-loop activate(mutantId) may appear, but NO activate(null) after the unsafe latch:
  const afterUnsafe = activateCalls.slice(activateCalls.indexOf("M0007") + 1);
  expect(afterUnsafe).not.toContain(null);
});

test("a pre-quarantined tier refuses to run before status() is ever called", async () => {
  const dir = freshTmpDir();
  const store = new QuarantineStore(dir);
  await store.record({ resourceKey: "http://cronus281|BC", opKind: "test-run", detail: "prior strand", recordedAtIso: "2026-07-20T10:00:00.000Z" });
  let statusCalled = false;
  const backend = fakeBackend({ status: async () => { statusCalled = true; return { ok: true, details: "" }; } });
  await expect(runSessionForTest(backend, { quarantineDir: dir })).rejects.toThrow(/quarantined/i);
  expect(statusCalled).toBe(false);
});
```

> Implementer note: `runSessionForTest` is a thin wrapper building a `SessionConfig` around the fake backend with an injected `quarantineDir` and a tier resource key of `http://cronus281|BC`. Add a `quarantineDir?: string` (and the resolved resource key) to `SessionConfig` so tests can inject a temp dir; production defaults to `~/.lethal/quarantine`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/src/orchestrator.test.ts`
Expected: FAIL — quarantine not consulted; `activate(null)` still runs in finally.

- [ ] **Step 3: Consult quarantine before `status()`**

At the top of `runSession` (before line 344-346), add:

```typescript
  const safety = new SessionSafety();
  const resourceKey = quarantineResourceKey({
    server: cfg.resourceServer,
    serverInstance: cfg.resourceServerInstance,
  });
  const quarantineStore = new QuarantineStore(cfg.quarantineDir ?? defaultQuarantineDir());
  const existing = await quarantineStore.read(resourceKey);
  if (existing !== null) {
    throw new Error(
      `tier ${resourceKey} is quarantined (${existing.opKind}: ${existing.detail}, ` +
        `recorded ${existing.recordedAtIso}, generation ${existing.generation}). ` +
        `Recycle the tier and run 'lethal clear-quarantine' to clear it.`,
    );
  }
```

> `defaultQuarantineDir()` = `join(homedir(), ".lethal", "quarantine")` (import `homedir` from `node:os`). `cfg.resourceServer`/`cfg.resourceServerInstance` are added to `SessionConfig` (sourced from the bcdev config; for al-runner, quarantine is a no-op — guard the whole block behind `caps.authoritative`).

- [ ] **Step 4: Latch-gate the `finally` teardown (replace lines 749-759)**

```typescript
  } finally {
    // After an unsafe latch, NO work-plane call — not even the deactivating ClearActive, which is
    // itself a mutating op on the stranded tier (spec §8). Only local teardown runs.
    if (!safety.isUnsafe) {
      await cfg.backend.activate(null).catch(() => {});
      for (const backend of workerBackends) {
        await backend.activate(null).catch(() => {});
        await closeIfSupported(backend).catch(() => {});
      }
    } else {
      // local teardown only: close transports/children, never activate.
      await closeIfSupported(cfg.backend).catch(() => {});
      for (const backend of workerBackends) {
        await closeIfSupported(backend).catch(() => {});
      }
    }
  }
```

- [ ] **Step 5: Thread `safety` through the mutant loop and gate the verifier**

Pass `safety` into the mutant-loop function (the one at `:824`) and into `activateOnce`/`runOnce` calls. In the publication path, guard the post-publish-failure `DeploymentVerifier` behind `safety.assertSafe`/`isUnsafe` — do not verify after an ambiguous publish. (Verifier lives in `bcdev-backend.deploy()`; if the deploy call resolved to an ambiguous publication failure, the orchestrator must not re-invoke any verify path — see Task 12 for the publication-hang classification. For this task, ensure the existing verifier call is not reached once `safety.isUnsafe`.)

- [ ] **Step 6: Run tests to verify they pass; full suite green**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner`
Expected: PASS.

- [ ] **Step 7: Mutation-check the finally gate**

Temporarily change `if (!safety.isUnsafe) {` to `if (true) {`. Run the tests.
Expected: "finally teardown does NOT call activate(null) once unsafe" goes RED. Restore, confirm GREEN. Then change the pre-status quarantine block to a no-op and confirm "pre-quarantined tier refuses before status()" goes RED. Record both.

- [ ] **Step 8: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
bunx biome check packages/runner/src/orchestrator.ts packages/runner/src/orchestrator.test.ts
git add packages/runner/src/orchestrator.ts packages/runner/src/orchestrator.test.ts
git commit -m "feat(runner): gate work-plane calls on SessionSafety; consult quarantine before status()"
```

---

## Task 12: Orchestrator — quarantine on in-flight-unknown + `quarantined` exit

**Files:**
- Modify: `packages/runner/src/orchestrator.ts` (mutant loop deadline branch `:864-870`, session result)
- Modify: `packages/runner/src/report.ts` (add a `quarantined` session status/summary field)
- Test: `packages/runner/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: `SessionSafety`, `QuarantineStore`, `quarantineResourceKey`, `requiresUnsafeLatch`.
- Produces: on any `in-flight-unknown` outcome in the mutant loop, the orchestrator latches unsafe, records a durable quarantine (opKind + detail + ISO timestamp threaded from `cfg.nowIso`), stops the loop, and the session report carries a `quarantined` marker naming the stranded op.

**Note on timestamps:** `Date.now()`/`new Date()` are fine in production code here (only workflow SCRIPTS forbid them). Thread the ISO string via a `cfg.nowIso?: () => string` injectable defaulting to `() => new Date().toISOString()` so tests are deterministic.

- [ ] **Step 1: Write the failing test**

```typescript
// add to packages/runner/src/orchestrator.test.ts
test("an in-flight-unknown deadline records a durable quarantine and reports quarantined", async () => {
  const dir = freshTmpDir();
  const backend = fakeBackend({
    run: async (ref) => ({ ref, outcome: "deadline-exceeded", durationMs: 1, operation: "in-flight-unknown" }),
  });
  const report = await runSessionForTest(backend, {
    quarantineDir: dir,
    nowIso: () => "2026-07-20T12:00:00.000Z",
  }).catch((e) => e);
  // session exits quarantined (either a thrown quarantined error or a report flag — assert the store):
  const store = new QuarantineStore(dir);
  const rec = await store.read("http://cronus281|BC");
  expect(rec).not.toBeNull();
  expect(rec?.opKind).toBe("test-run");
  expect(rec?.recordedAtIso).toBe("2026-07-20T12:00:00.000Z");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/src/orchestrator.test.ts`
Expected: FAIL — no quarantine recorded.

- [ ] **Step 3: Record quarantine on the deadline branch**

In the mutant loop, replace the `if (v.outcome === "deadline-exceeded")` branch (`:864-870`) so it latches + quarantines when the run is `in-flight-unknown`:

```typescript
      if (v.operation !== undefined && requiresUnsafeLatch(v.operation)) {
        // The server may still be executing this test. Latch unsafe, record a durable tier
        // quarantine, and stop — no further work-plane call (spec §8, §12).
        safety.latchUnsafe(`test in-flight-unknown running ${ref.method} (mutant ${m.mutantId})`);
        await quarantineStore.record({
          resourceKey,
          opKind: "test-run",
          detail: `deadline exceeded running ${ref.method} (mutant ${m.mutantId}); server op may be in flight`,
          recordedAtIso: cfg.nowIso(),
        });
        verdict = "error";
        failureNote = `quarantined: ${ref.method} timed out, container may be stranded`;
        cause = "deadline-exceeded";
        break;
      }
      if (v.outcome === "deadline-exceeded") {
        // Our timer fired but the seam did not mark it in-flight-unknown (al-runner: no shared
        // server to strand). Infrastructure error, not a kill; no quarantine.
        verdict = "error";
        failureNote = `deadline exceeded running ${ref.method} (infrastructure, not a kill)`;
        cause = "deadline-exceeded";
        break;
      }
```

After the mutant loop, if `safety.isUnsafe`, stop scheduling further mutants (break the outer loop) and surface the quarantined state in the report/return. Thread `cfg.nowIso` (default `() => new Date().toISOString()`) and `resourceKey`/`quarantineStore` from Task 11.

- [ ] **Step 4: Run test to verify it passes; full suite green**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner`
Expected: PASS.

- [ ] **Step 5: Mutation-check the quarantine-record path**

Temporarily change the `requiresUnsafeLatch(v.operation)` guard to `false`. Run the test.
Expected: "in-flight-unknown deadline records a durable quarantine" goes RED (no record written). Restore, confirm GREEN. Record both.

- [ ] **Step 6: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
bunx biome check packages/runner/src/orchestrator.ts packages/runner/src/report.ts packages/runner/src/orchestrator.test.ts
git add packages/runner/src/orchestrator.ts packages/runner/src/report.ts packages/runner/src/orchestrator.test.ts
git commit -m "feat(runner): record durable quarantine and stop on in-flight-unknown"
```

---

## Task 13: `ReadinessProbe` + `clear-quarantine` CLI command

**Files:**
- Create: `packages/runner/src/readiness-probe.ts`
- Modify: `packages/runner/src/cli.ts` (add `clear-quarantine <resourceKey>` and a `quarantined` exit code)
- Test: `packages/runner/src/readiness-probe.test.ts`, `packages/runner/src/cli.test.ts` (if present; else a focused unit test on the clear path)

**Interfaces:**
- Consumes: `QuarantineStore`, `MutationControlClient.readActive` (non-mutating), a read-only test-plane handshake.
- Produces:
  - `class ReadinessProbe { constructor(deps); probe(): Promise<{ ok: boolean; detail: string }> }` — both-plane NON-mutating reads; never `ClearActive`.
  - CLI `clear-quarantine`: reads the current record's generation and calls `store.clear(key, gen)` (operator-proven clearing, spec §10). Prints `cleared` / `stale` / `not-quarantined`.

- [ ] **Step 1: Write the failing test (readiness probe uses only non-mutating reads)**

```typescript
// packages/runner/src/readiness-probe.test.ts
import { describe, expect, test } from "bun:test";
import { ReadinessProbe } from "./readiness-probe";

describe("ReadinessProbe", () => {
  test("passes only when BOTH planes answer, using non-mutating reads", async () => {
    const calls: string[] = [];
    const probe = new ReadinessProbe({
      odataRead: async () => { calls.push("odata"); },
      testPlaneHandshake: async () => { calls.push("test"); },
    });
    const r = await probe.probe();
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["odata", "test"]);
  });

  test("fails if either plane throws", async () => {
    const probe = new ReadinessProbe({
      odataRead: async () => { throw new Error("7048 wedged"); },
      testPlaneHandshake: async () => {},
    });
    const r = await probe.probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("7048 wedged");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/src/readiness-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ReadinessProbe`**

```typescript
// packages/runner/src/readiness-probe.ts

/** Dependencies are NON-mutating reads only. `odataRead` MUST be a read (e.g. Identity or
 *  GetActive), never ClearActive — ClearActive mutates the very table observed stranded (spec §10). */
export interface ReadinessProbeDeps {
  odataRead: () => Promise<unknown>;
  testPlaneHandshake: () => Promise<unknown>;
}

/**
 * Post-clear readiness check for BOTH work planes the mutation loop drives (OData 7048 + the
 * SignalR test runner). Runs ONLY after quarantine has been cleared by proven recycle (spec §10).
 * A pass is necessary to resume but proves nothing about any past strand.
 */
export class ReadinessProbe {
  constructor(private readonly deps: ReadinessProbeDeps) {}

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.deps.odataRead();
    } catch (err) {
      return { ok: false, detail: `OData plane not ready: ${String(err)}` };
    }
    try {
      await this.deps.testPlaneHandshake();
    } catch (err) {
      return { ok: false, detail: `test plane not ready: ${String(err)}` };
    }
    return { ok: true, detail: "both work planes answered" };
  }
}
```

- [ ] **Step 4: Add the `clear-quarantine` CLI command**

In `cli.ts`, add a subcommand that, given a resource key (or server+instance), reads the current record and calls `store.clear(key, rec.generation)`. Print the outcome. Wire a distinct process exit code for a `quarantined` session result (e.g. exit 3), separate from a normal failure. Add a focused test asserting `clear-quarantine` on a recorded tier removes it and prints `cleared`, and that a second run prints `not-quarantined`.

```typescript
// sketch — match cli.ts's existing arg-parsing style
// lethal clear-quarantine --server http://Cronus281 --instance BC
const key = quarantineResourceKey({ server: args.server, serverInstance: args.instance });
const store = new QuarantineStore(defaultQuarantineDir());
const rec = await store.read(key);
if (rec === null) { console.log("not-quarantined"); process.exit(0); }
const result = await store.clear(key, rec.generation);
console.log(result); // "cleared" | "stale"
process.exit(result === "cleared" ? 0 : 1);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner`
Expected: PASS.

- [ ] **Step 6: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
bunx biome check packages/runner/src/readiness-probe.ts packages/runner/src/readiness-probe.test.ts packages/runner/src/cli.ts
git add packages/runner/src/readiness-probe.ts packages/runner/src/readiness-probe.test.ts packages/runner/src/cli.ts packages/runner/src/cli.test.ts
git commit -m "feat(runner): non-mutating ReadinessProbe + operator clear-quarantine command"
```

---

## Task 14: Fold-ins — deploy:none app_version, compileCheck rm, equality-gate rename

**Files:**
- Modify: `packages/runner/src/orchestrator.ts` (deploy:none app_version) — find where `runs.app_version` is written for al-runner (`deploy: "none"`) and pass the project's own `app.json` version instead of `0.0.0.0`.
- Modify: `packages/runner/src/bcdev-backend.ts:284` (`compileCheck`'s `rm`) → `.catch(() => {})`.
- Modify/rename: `packages/runner/itest/mutant-equality.ts` usage — rename its role to "healthy-path regression guard" in comments/exports; wire it as a guard in the itest harness (Task 15 consumes it).
- Test: `packages/runner/src/orchestrator.test.ts` (app_version), `packages/runner/src/bcdev-backend.test.ts` (rm swallow).

- [ ] **Step 1: Write the failing tests**

```typescript
// orchestrator.test.ts — deploy:none records the real app version
test("deploy:none (al-runner) records the project's app.json version, not 0.0.0.0", async () => {
  const report = await runAlRunnerSessionForTest({ appVersion: "1.2.3.4" });
  expect(report.appVersion).toBe("1.2.3.4");
});

// bcdev-backend.test.ts — compileCheck cleanup failure does not throw
test("compileCheck swallows a cleanup rm failure (does not mask the compile result)", async () => {
  const backend = makeBackendWhoseCompiledAppPathIsAlreadyGone();
  await expect(backend.compileCheck(someInstrumentedDir())).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner`
Expected: FAIL on both.

- [ ] **Step 3: Fix deploy:none app_version**

Locate the al-runner session's `createRun({ ..., appVersion: cfg.appVersion ?? "0.0.0.0" })` (orchestrator.ts `:360-364`) and ensure `cfg.appVersion` is populated for `deploy: "none"` backends from the project's `app.json` version (the same source publishing runs now use, Layer 5A). If the al-runner path never sets `cfg.appVersion`, read it from `app.json` at session start and thread it.

- [ ] **Step 4: Fix compileCheck rm**

`bcdev-backend.ts:284`:

```typescript
    await rm(artifact.appPath, { force: true }).catch(() => {});
```

- [ ] **Step 5: Rename equality gate role**

In `packages/runner/itest/mutant-equality.ts`, update the file's doc comment and any exported symbol/const that describes it as "the oracle" to "healthy-path regression guard" — it guards the healthy path's per-mutant verdicts only, and gives NO evidence for the failure path (spec §13). Do not change its comparison logic. If an exported name literally contains "oracle", rename it (e.g. `assertMutantEquality` → keep; a `GATE_ROLE` string const → update text).

- [ ] **Step 6: Run tests to verify they pass; full suite green**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner`
Expected: PASS.

- [ ] **Step 7: Typecheck, clear dist, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
bunx biome check packages/runner/src/orchestrator.ts packages/runner/src/bcdev-backend.ts packages/runner/itest/mutant-equality.ts
git add -A
git commit -m "fix(runner): deploy:none app_version + compileCheck rm swallow; rename equality gate to healthy-path guard"
```

---

## Task 15: Per-seam fault-injection itest oracles + wedged-tier live gate doc

**Files:**
- Create: `packages/runner/itest/fault-injection.itest.ts` (env-gated like the other itests)
- Modify: `packages/runner/itest/bcdev.itest.ts` and `alrunner.itest.ts` — assert the healthy-path regression guard (per-mutant equality) against the stored baseline.
- Modify: `fixtures/README.md` — document the deliberately-wedged-tier reproduction recipe (bccontainerhelper restart) and the operator clear-quarantine step.

**Interfaces:**
- Consumes: every unit from Tasks 1-14.

**Rationale (spec §14):** the healthy-path guard proves nothing about the failure path. Each failure seam needs its own fault-injection oracle. Most run as unit-level fault injection (already added in Tasks 8-12); this task collects the cross-cutting ones and the live gate.

- [ ] **Step 1: Write the fault-injection oracle suite**

Assemble a single `fault-injection.itest.ts` (unit-level, no live server — runnable in CI) that drives `runSession` with fake backends injecting each fault and asserts the containment invariant for each. Cover, one test each:
  - client deadline after dispatch → `in-flight-unknown` → unsafe latched, quarantine recorded, no further work-plane call;
  - transport close before vs after dispatch → retry vs quarantine;
  - `SetActive` 2xx malformed body → `completed-effect-unknown` → verify-active, no retry;
  - store write failure (inject a `QuarantineStore` whose `record` rejects) → session fails loudly, never proceeds unmarked;
  - crash-between-ambiguity-and-write simulation → durable marker present on a fresh `QuarantineStore` read;
  - `finally` / `DeploymentVerifier` / `status()` suppressed after unsafe latch.

Each test uses **stateful fakes** (a fake backend that keeps reporting "still running" until a terminal signal it never receives), so "call abort then continue" cannot pass.

- [ ] **Step 2: Run the oracle suite**

Run: `cd U:/Git/LethAL && rm -rf packages/*/dist && bun test packages/runner/itest/fault-injection.itest.ts`
Expected: PASS (all seams contained).

- [ ] **Step 3: Wire the healthy-path regression guard into the live itests**

In `bcdev.itest.ts` and `alrunner.itest.ts`, after the run, assert per-mutant equality (via `mutant-equality.ts`) against the committed baseline, in addition to the aggregate verdict counts. A per-mutant difference fails the itest.

- [ ] **Step 4: Live gate — run both itests, verdicts frozen**

Run foreground (minutes each; do not poll):

```bash
cd U:/Git/LethAL
LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
```

Expected: al-runner **3 / 13 / 0 (18.8%)**, bcdev **3 / 10 / 3 (23.1%)**, per-mutant equality green. A differing verdict → **BLOCKED** (a bug in the change, not an expectation to update).

- [ ] **Step 5: Document the wedged-tier reproduction + operator clear**

Add to `fixtures/README.md`: how to deliberately wedge a tier (or simulate a stranded op), observe LethAL quarantine it and exit `quarantined`, restart the tier via `bccontainerhelper` on the host, run `lethal clear-quarantine --server ... --instance ...`, and confirm the next session runs. Record a transcript in the spec's §18 evidence appendix.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
git add packages/runner/itest/ fixtures/README.md docs/superpowers/specs/2026-07-20-layer-5b-single-container-hardening-design.md
git commit -m "test(runner): per-seam fault-injection oracles + healthy-path guard in live itests"
```

---

## Self-Review

**Spec coverage (each spec section → task):**
- §7 dispatch/effect state model → Tasks 1, 7, 8, 9.
- §8 unsafe latch + gating → Tasks 3, 11.
- §9 tier-scoped key + atomic/CAS store → Tasks 4, 5, 6.
- §10 operator-proven clearing + non-mutating readiness probe → Task 13.
- §11 backend seam preserves evidence → Tasks 7, 8, 9.
- §12 orchestrator: retry removal + quarantine-on-ambiguity + ordering → Tasks 10, 11, 12.
- §13 fold-ins → Task 14.
- §14 fault-injection oracles + live gate → Task 15 (+ per-task mutation checks).
- §17 review disposition → structurally enforced by the above (no confirmable-cancel, no active recovery, tier key, gated re-pokes).

**Placeholder scan:** the two conditional/judgement steps (Task 9 Step 3b `GetActive` emitter, Task 11 Step 5 verifier gating, Task 14 Step 3 app_version source) name the exact file and the exact condition under which to act; they are decisions the implementer resolves against the real file, not vague TODOs. Test helper wrappers (`make…`, `fakeBackend`, `runSessionForTest`) are explicitly delegated to the existing per-file fakes with a note on what each must do.

**Type consistency:** `OperationOutcome` string literals identical across Tasks 1/7/8/9/10/12. `SessionSafety` API (`latchUnsafe`/`isUnsafe`/`assertSafe`) identical across Tasks 3/10/11/12. `QuarantineStore` (`read`/`record`/`clear`) + `QuarantineRecord` (`generation`) identical across Tasks 5/6/11/12/13. `quarantineResourceKey` signature identical across Tasks 4/11/12/13.

**Open dependencies flagged for execution:** Task 9 Step 3b (schemata `GetActive` action) and Task 13's `testPlaneHandshake` source depend on live capability — resolve against the real emitter/bc-dev at execution; if unavailable, fall back per spec §10/§16 (operator-confirmed, `in-flight-unknown` default) and record the fallback.
