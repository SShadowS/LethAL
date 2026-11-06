import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { printDryRun } from "../src/cli";
import {
  LARGE_FOLD_BYTES,
  LARGE_FOLD_CHAIN,
  foldFiguresOf,
  isLargeFold,
  largeFoldWarning,
  largestFold,
} from "../src/large-fold";
import { generateMutationSet, operatorTiers, runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";

const tierOf = (n: string) => operatorTiers.get(n);

/** One procedure of flat statements: `empty-block` folds them all into its body's one chain. */
function writeProject(statements: number): string {
  const dir = mkdtempSync(join(tmpdir(), "r826-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "app.json"),
    JSON.stringify({
      id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
      name: "P",
      publisher: "x",
      version: "1.0.0.0",
      runtime: "17.0",
      application: "28.0.0.0",
      idRanges: [{ from: 50000, to: 50099 }],
    }),
  );
  const body = Array.from({ length: statements }, (_, i) => `        Y := Y + ${i + 1};`).join(
    "\n",
  );
  writeFileSync(
    join(dir, "src", "P.Codeunit.al"),
    `codeunit 50000 "P"\n{\n    procedure Big()\n    var\n        Y: Integer;\n    begin\n${body}\n    end;\n}\n`,
  );
  return dir;
}

async function project(statements: number, operators?: readonly string[]) {
  const set = await generateMutationSet(writeProject(statements), {
    emit: () => {},
    ...(operators !== undefined ? { operators } : {}),
  } as never);
  return set.files;
}

/** What `printDryRun` prints for a project, for a backend. */
async function dryRun(dir: string, backendKind?: "bcdev" | "al-runner-v3"): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  try {
    await printDryRun(dir, undefined, {
      dbPath: join(dir, "no-such.sqlite"),
      configPath: join(dir, "no-such.json"),
      ...(backendKind !== undefined ? { backendKind } : {}),
    });
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

class StubBackend implements ExecutionBackend {
  constructor(private readonly kind: "bcdev" | "al-runner-v3") {}
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
  }
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: this.kind,
      authoritative: this.kind === "bcdev",
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
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
        entries: [{ objectType: "Codeunit", objectId: 50000, procedure: "Big" }],
      },
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

/** The warning codes a session emits for a project, on a backend. */
async function sessionCodes(statements: number, kind: "bcdev" | "al-runner-v3"): Promise<string[]> {
  const projectDir = writeProject(statements);
  const testDir = mkdtempSync(join(tmpdir(), "r826-tests-"));
  writeFileSync(
    join(testDir, "T.Codeunit.al"),
    'codeunit 50050 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure T1()\n    begin\n    end;\n}\n',
  );
  const codes: string[] = [];
  const store = new ResultsStore(":memory:");
  try {
    await runSession({
      backend: new StubBackend(kind),
      store,
      projectDir,
      testDir,
      instrumentedDir: join(mkdtempSync(join(tmpdir(), "r826-i-")), "instr"),
      selectorIds: { selectorId: 50090, controlId: 50091, tableId: 50092 },
      maxGuardsPerBatch: 100000,
      emit: [
        (e) => {
          if (e.type === "warning") codes.push(e.code);
        },
      ],
    });
  } finally {
    store.close();
  }
  return codes;
}

const EMPTY = "lethal.empty-block";
const allBut = (files: Awaited<ReturnType<typeof project>>) =>
  [...new Set(files.flatMap((f) => f.specs.map((s) => s.operatorName)))].filter((o) => o !== EMPTY);

describe("R826: the large-method warning", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("a procedure folded by empty-block is one long chain; without it the same code is not", async () => {
    const files = await project(150);
    const [f] = files;
    if (f === undefined) throw new Error("no file");
    const folded = foldFiguresOf(f.path, f.specs, tierOf);
    expect(folded.chain).toBeGreaterThanOrEqual(LARGE_FOLD_CHAIN);
    const flat = await project(150, allBut(files));
    const [g] = flat;
    if (g === undefined) throw new Error("no file");
    const small = foldFiguresOf(g.path, g.specs, tierOf);
    expect(small.chain).toBeLessThan(LARGE_FOLD_CHAIN);
    expect(small.bytes).toBeLessThan(LARGE_FOLD_BYTES);
  });

  test("it names the file and the figures, says it is unmeasured, and gives the way out", async () => {
    const files = await project(150);
    const message = largeFoldWarning(files, tierOf) ?? "";
    expect(message).toContain("P.Codeunit.al");
    expect(message).toMatch(/chain \d+, about \d+ KB/);
    expect(message).toContain("not proven");
    expect(message).toContain("not measured");
    expect(message).toContain("lethal.empty-block");
    expect(message).toContain("--exclude-operator empty-block");
    expect(message).toContain("--only");
  });

  test("it stays quiet below both figures", async () => {
    const files = await project(10);
    expect(largeFoldWarning(files, tierOf)).toBeUndefined();
  });

  test("each figure counts AT it, and one below it does not", () => {
    expect(isLargeFold({ chain: LARGE_FOLD_CHAIN, bytes: 0 })).toBe(true);
    expect(isLargeFold({ chain: LARGE_FOLD_CHAIN - 1, bytes: 0 })).toBe(false);
    expect(isLargeFold({ chain: 0, bytes: LARGE_FOLD_BYTES })).toBe(true);
    expect(isLargeFold({ chain: 0, bytes: LARGE_FOLD_BYTES - 1 })).toBe(false);
  });

  test("largestFold keeps the largest of each, in any order, and they may differ in source", () => {
    const fold = (members: number, length: number) => ({
      members: Array.from({ length: members }),
      root: { startIndex: 10, endIndex: 10 + length },
    });
    const longChain = fold(50, 10); // 500 bytes
    const bigText = fold(2, 1000); // 2000 bytes
    const small = fold(1, 1);
    const want = { chain: 50, bytes: 2000 };
    expect(largestFold([longChain, bigText, small])).toEqual(want);
    expect(largestFold([small, bigText, longChain])).toEqual(want);
    expect(largestFold([bigText, small, longChain])).toEqual(want);
    expect(largestFold([])).toEqual({ chain: 0, bytes: 0 });
  });

  test("a real file fires on its chain alone, with its bytes under their figure", async () => {
    // A fold's chain counts its members. Find the size at which `chain` crosses the figure, with
    // the bytes far under theirs, so only the chain can be why it fires.
    let below: Awaited<ReturnType<typeof project>> | undefined;
    let at: Awaited<ReturnType<typeof project>> | undefined;
    for (let n = 20; n < 120 && at === undefined; n += 1) {
      const files = await project(n);
      const [f] = files;
      if (f === undefined) throw new Error("no file");
      const { chain, bytes } = foldFiguresOf(f.path, f.specs, tierOf);
      expect(bytes).toBeLessThan(LARGE_FOLD_BYTES);
      if (chain >= LARGE_FOLD_CHAIN) at = files;
      else below = files;
    }
    if (at === undefined || below === undefined)
      throw new Error("the sizes did not cross the figure");
    expect(largeFoldWarning(at, tierOf)).toBeDefined();
    expect(largeFoldWarning(below, tierOf)).toBeUndefined();
  });

  test("the bytes figure fires on its own: one long statement in a short chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r826-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "app.json"),
      JSON.stringify({
        id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
        name: "P",
        publisher: "x",
        version: "1.0.0.0",
        runtime: "17.0",
        application: "28.0.0.0",
        idRanges: [{ from: 50000, to: 50099 }],
      }),
    );
    const comment = "// padding\n".repeat(4000);
    const body = Array.from({ length: 12 }, (_, i) => `        Y := Y + ${i + 1};`).join("\n");
    writeFileSync(
      join(dir, "src", "P.Codeunit.al"),
      `codeunit 50000 "P"\n{\n    procedure Big()\n    var\n        Y: Integer;\n    begin\n${comment}${body}\n    end;\n}\n`,
    );
    const set = await generateMutationSet(dir, { emit: () => {} } as never);
    const [f] = set.files;
    if (f === undefined) throw new Error("no file");
    const { chain, bytes } = foldFiguresOf(f.path, f.specs, tierOf);
    expect(chain).toBeLessThan(LARGE_FOLD_CHAIN);
    expect(bytes).toBeGreaterThanOrEqual(LARGE_FOLD_BYTES);
    expect(largeFoldWarning(set.files, tierOf)).toBeDefined();
  });

  test("--dry-run prints it for a BC tier, and not for al-runner-v3 or a small file", async () => {
    const big = writeProject(150);
    expect(await dryRun(big, "bcdev")).toContain("NOTE: 1 file(s) emit a very large method");
    expect(await dryRun(big)).toContain("NOTE: 1 file(s) emit a very large method");
    expect(await dryRun(big, "al-runner-v3")).not.toContain("very large method");
    expect(await dryRun(writeProject(10), "bcdev")).not.toContain("very large method");
  });

  test("a session warns once on a BC tier, not at all on v3, and a small file is silent", async () => {
    const onBc = await sessionCodes(150, "bcdev");
    expect(onBc.filter((c) => c === "large-method")).toHaveLength(1);
    expect(await sessionCodes(150, "al-runner-v3")).not.toContain("large-method");
    expect(await sessionCodes(10, "bcdev")).not.toContain("large-method");
  });

  // A new warning code on a gate fixture would fail GATE_WARNINGS far from here.
  test("no gate fixture fires it", async () => {
    const repo = resolve(import.meta.dir, "..", "..", "..");
    for (const name of [
      "sandbox-app",
      "sandbox-data",
      "sandbox-hang",
      "sandbox-harden",
      "sandbox-wrapped",
      "sandbox-names",
    ]) {
      const set = await generateMutationSet(join(repo, "fixtures", name), {
        emit: () => {},
      } as never);
      expect(largeFoldWarning(set.files, tierOf)).toBeUndefined();
    }
    const gift = await generateMutationSet(join(repo, "examples", "gift-card"), {
      emit: () => {},
    } as never);
    expect(largeFoldWarning(gift.files, tierOf)).toBeUndefined();
  });
});
