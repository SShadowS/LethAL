import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { nestedProjectWarning } from "../src/nested-project";
import { runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { measuredV2_12 } from "./helpers/al-runner-predefined";

/**
 * R629 / R634: a project whose folder sits under another app.json (a nested module that the
 * parent also compiles) gets one warning naming both paths. A warning only: nothing is refused.
 * Every tree passes its own temp root as the stop, so a stray app.json above the temp dir (for
 * example /tmp/app.json) can never reach these tests.
 */
let roots: string[] = [];
afterEach(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});

/** Builds a tree under a fresh temp dir; a path ending in `/` is a directory, else an empty file. */
async function tree(paths: readonly string[]): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "lethal-r629-"));
  roots.push(top);
  for (const p of paths) {
    if (p.endsWith("/")) await mkdir(join(top, p), { recursive: true });
    else {
      await mkdir(join(top, p, ".."), { recursive: true });
      await writeFile(join(top, p), "{}");
    }
  }
  return top;
}

describe("R629: nested-project warning", () => {
  test("1. an enclosing app.json inside the repo: one warning naming both paths", async () => {
    const top = await tree(["root/.git/", "root/app.json", "root/mod/app.json"]);
    const projectDir = join(top, "root", "mod");
    const message = nestedProjectWarning(projectDir, top);
    expect(message).toBeDefined();
    expect(message).toContain(projectDir);
    expect(message).toContain(`${join(top, "root")},`);
    expect(message).toContain("R629");
  });

  test("1b. a worktree's .git FILE stops the search the same way", async () => {
    const top = await tree(["app.json", "root/.git", "root/mod/app.json"]);
    expect(nestedProjectWarning(join(top, "root", "mod"), top)).toBeUndefined();
  });

  test("2. no enclosing app.json: no warning", async () => {
    const top = await tree(["root/.git/", "root/mod/app.json"]);
    expect(nestedProjectWarning(join(top, "root", "mod"), top)).toBeUndefined();
  });

  test("3. an app.json in a SIBLING directory: no warning", async () => {
    const top = await tree(["root/.git/", "root/mod/app.json", "root/other/app.json"]);
    expect(nestedProjectWarning(join(top, "root", "mod"), top)).toBeUndefined();
  });

  test("4. an app.json ABOVE the .git stop (outside the repo): no warning", async () => {
    const top = await tree(["app.json", "root/.git/", "root/mod/app.json"]);
    expect(nestedProjectWarning(join(top, "root", "mod"), top)).toBeUndefined();
  });

  test("a project that is itself the repo root does not search above it", async () => {
    const top = await tree(["app.json", "root/.git/", "root/app.json"]);
    expect(nestedProjectWarning(join(top, "root"), top)).toBeUndefined();
  });
});

describe("R629: runSession emits the warning once per session, not per batch", () => {
  class StubBackend implements ExecutionBackend {
    readonly measurePredefinedSymbols = measuredV2_12;
    batches = 0;
    capabilities(): BackendCapabilities {
      return {
        coverage: "procedure",
        deploy: "publish",
        isolation: "session",
        kind: "al-runner",
        authoritative: false,
      };
    }
    async status(): Promise<BackendStatus> {
      return { ok: true, details: "stub" };
    }
    async deploy(): Promise<CompiledArtifact | null> {
      this.batches += 1;
      return null;
    }
    async compileCheck(): Promise<void> {}
    async activate(): Promise<void> {}
    async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: {
          granularity: "procedure" as const,
          entries: [
            { objectType: "Codeunit", objectId: 79000, procedure: "A" },
            { objectType: "Codeunit", objectId: 79001, procedure: "B" },
          ],
        },
        ...(opts.coverage === "none"
          ? { attestation: { observedAny: true, identityMismatch: false } }
          : {}),
      };
    }
  }

  const unit = (id: number, proc: string): string =>
    `codeunit ${id} "U${id}"\n{\n    procedure ${proc}(X: Decimal): Boolean\n    begin\n        exit(X > 1);\n    end;\n}\n`;

  async function warningsOf(nested: boolean): Promise<{ codes: string[]; batches: number }> {
    const top = await tree([
      "root/.git/",
      ...(nested ? ["root/app.json"] : []),
      "root/mod/",
      "root/tests/",
    ]);
    const projectDir = join(top, "root", "mod");
    const testDir = join(top, "root", "tests");
    await writeFile(
      join(projectDir, "app.json"),
      JSON.stringify({
        id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1629",
        name: "R629 Nested",
        publisher: "LethAL",
        version: "1.0.0.0",
        idRanges: [{ from: 79000, to: 79199 }],
      }),
    );
    await writeFile(join(projectDir, "A.Codeunit.al"), unit(79000, "A"));
    await writeFile(join(projectDir, "B.Codeunit.al"), unit(79001, "B"));
    await writeFile(
      join(testDir, "T.Codeunit.al"),
      'codeunit 79100 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure T1()\n    begin\n    end;\n}\n',
    );
    const codes: string[] = [];
    const backend = new StubBackend();
    const store = new ResultsStore(":memory:");
    try {
      await runSession({
        backend,
        store,
        projectDir,
        testDir,
        instrumentedDir: join(top, "instr"),
        selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
        maxGuardsPerBatch: 1,
        emit: [
          (e) => {
            if (e.type === "warning") codes.push(e.code);
          },
        ],
      });
    } finally {
      store.close();
    }
    return { codes, batches: backend.batches };
  }

  test("5. nested: exactly one nested-project warning over several batches", async () => {
    const { codes, batches } = await warningsOf(true);
    expect(batches).toBeGreaterThan(1);
    expect(codes.filter((c) => c === "nested-project")).toHaveLength(1);
  });

  test("5b. counterweight: the same session, not nested, has none", async () => {
    const { codes } = await warningsOf(false);
    expect(codes).not.toContain("nested-project");
  });
});
