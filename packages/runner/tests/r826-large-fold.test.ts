import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import { assignMutantIds, compileSchemataForFile, dedupeSpecs } from "@lethal/schemata";
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
  BOUND_BYTES_PER_GUARD,
  LARGE_METHOD_BYTES,
  emittedBound,
  largeFoldWarning,
  largeMethodOf,
  largeMethodSuspect,
  largestMethodBytes,
} from "../src/large-fold";
import { generateMutationSet, operatorTiers, runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";

const tierOf = (n: string) => operatorTiers.get(n);

/**
 * One procedure holding `for Y := 1 to Z do begin <flat statements> end;`. R827: a body's
 * `empty-block` is a guard now and folds nothing. R828 O1: an `if` copies only its own statement, so
 * what still makes a long chain is a LOOP: in a free body every statement in it joins the loop's one
 * flat chain (R246).
 */
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
  const body = Array.from({ length: statements }, (_, i) => `            Z := Z + ${i + 1};`).join(
    "\n",
  );
  writeFileSync(
    join(dir, "src", "P.Codeunit.al"),
    `codeunit 50000 "P"\n{\n    procedure Big()\n    var\n        Y: Integer;\n        Z: Integer;\n    begin\n        for Y := 1 to Z do begin\n${body}\n        end;\n    end;\n}\n`,
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

/** The real emitted text of one generated file, as a batch's compile writes it. */
function emitted(f: Awaited<ReturnType<typeof project>>[number]): string {
  const deduped = dedupeSpecs(f.specs, tierOf);
  const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
  return compileSchemataForFile(f.source, f.root, deduped, ided, f.path);
}

class StubBackend implements ExecutionBackend {
  constructor(
    private readonly kind: "bcdev" | "al-runner-v3",
    /** R875: every run's server-side fate is unknown, as when the tier stops. */
    private readonly strand = false,
  ) {}
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
    if (this.strand) {
      return {
        ref,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "the service tier stopped answering",
      };
    }
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
  return (await session(statements, kind)).codes;
}

/** R875: a session's warnings and the reason it was quarantined, if it was. */
async function session(
  statements: number,
  kind: "bcdev" | "al-runner-v3",
  strand = false,
): Promise<{ codes: string[]; quarantined: string[] }> {
  const projectDir = writeProject(statements);
  const testDir = mkdtempSync(join(tmpdir(), "r826-tests-"));
  writeFileSync(
    join(testDir, "T.Codeunit.al"),
    'codeunit 50050 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure T1()\n    begin\n    end;\n}\n',
  );
  const codes: string[] = [];
  const quarantined: string[] = [];
  const store = new ResultsStore(":memory:");
  try {
    await runSession({
      backend: new StubBackend(kind, strand),
      store,
      projectDir,
      testDir,
      instrumentedDir: join(mkdtempSync(join(tmpdir(), "r826-i-")), "instr"),
      selectorIds: { selectorId: 50090, controlId: 50091, tableId: 50092 },
      maxGuardsPerBatch: 100000,
      emit: [
        (e) => {
          if (e.type === "warning") codes.push(e.code);
          if (e.type === "quarantined") quarantined.push(e.reason);
        },
      ],
    });
  } finally {
    store.close();
  }
  return { codes, quarantined };
}

/** The operators that make the loop one chain: the free body's (which lifts to the loop) and the loop's own. */
const ROOTS = [
  "lethal.empty-block",
  "lethal.conditional-boundary",
  "lethal.negate-conditional",
  "lethal.loop-skip",
  "lethal.loop-truncate",
];
const allBut = (files: Awaited<ReturnType<typeof project>>) =>
  [...new Set(files.flatMap((f) => f.specs.map((s) => s.operatorName)))].filter(
    (o) => !ROOTS.includes(o),
  );

describe("R826: the large-method warning", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("a loop folded by its own mutants emits a very large method; without them the same code does not", async () => {
    const files = await project(150);
    const [f] = files;
    if (f === undefined) throw new Error("no file");
    const big = largeMethodOf(f, tierOf);
    expect(big?.methodBytes).toBeGreaterThanOrEqual(LARGE_METHOD_BYTES);
    // R875: the figure is the real emitted text's, to the byte.
    expect(big?.methodBytes).toBe(largestMethodBytes(emitted(f)));
    const flat = await project(150, allBut(files));
    const [g] = flat;
    if (g === undefined) throw new Error("no file");
    expect(largeMethodOf(g, tierOf)).toBeUndefined();
    expect(largestMethodBytes(emitted(g))).toBeLessThan(LARGE_METHOD_BYTES);
  });

  test("it names the file and the figures, says it is unmeasured, and gives the way out", async () => {
    const files = await project(150);
    const message = largeFoldWarning(files, tierOf) ?? "";
    expect(message).toContain("P.Codeunit.al");
    expect(message).toMatch(/chain \d+, \d+ KB in one method/);
    expect(message).toContain("not proven");
    expect(message).toContain("not measured");
    // R827, R828: a body's `empty-block`, an `if` condition and a `case` arm are no longer the cause,
    // so the text names what is.
    expect(message).toContain("Loops and statements holding a `#if`");
    expect(message).not.toContain("`case` arms");
    expect(message).toContain("--exclude-operator");
    expect(message).toContain("--only");
  });

  test("it stays quiet below both figures", async () => {
    const files = await project(10);
    expect(largeFoldWarning(files, tierOf)).toBeUndefined();
  });

  test("the figure counts AT the size the real text has, and one method below it does not warn", async () => {
    // Grow the loop until its real largest method crosses the figure: the warning flips exactly there.
    let below: Awaited<ReturnType<typeof project>>[number] | undefined;
    let at: Awaited<ReturnType<typeof project>>[number] | undefined;
    for (let n = 40; n < 200 && at === undefined; n += 4) {
      const [f] = await project(n);
      if (f === undefined) throw new Error("no file");
      if (largestMethodBytes(emitted(f)) >= LARGE_METHOD_BYTES) at = f;
      else below = f;
    }
    if (at === undefined || below === undefined)
      throw new Error("the sizes did not cross the figure");
    expect(largeMethodOf(at, tierOf)).toBeDefined();
    // The file just below is over the bound, with a chain over 100, so the real size alone says no:
    // neither the bound's shortcut nor a chain test could be why it stays quiet.
    expect(emittedBound(below, tierOf)).toBeGreaterThanOrEqual(LARGE_METHOD_BYTES);
    expect(dedupeSpecs(below.specs, tierOf).length).toBeGreaterThanOrEqual(100);
    expect(largeMethodOf(below, tierOf)).toBeUndefined();
  });

  test("a long chain alone does not warn: only the method's size does (R875)", async () => {
    // The old chain test fired at 100 members; on 986 DC and DO files it caught nothing the size did.
    const [f] = await project(40);
    if (f === undefined) throw new Error("no file");
    const deduped = dedupeSpecs(f.specs, tierOf);
    expect(deduped.length).toBeGreaterThanOrEqual(100);
    expect(largestMethodBytes(emitted(f))).toBeLessThan(LARGE_METHOD_BYTES);
    expect(largeMethodOf(f, tierOf)).toBeUndefined();
  });

  test("the bound is never under the real text, so a file it skips cannot hold the large method", async () => {
    for (const n of [5, 40, 150]) {
      const [f] = await project(n);
      if (f === undefined) throw new Error("no file");
      expect(emittedBound(f, tierOf)).toBeGreaterThanOrEqual(emitted(f).length);
    }
    // And it is what makes the skip: with no guard overhead it is under the real text.
    const [f] = await project(150);
    if (f === undefined) throw new Error("no file");
    const deduped = dedupeSpecs(f.specs, tierOf);
    expect(emittedBound(f, tierOf) - deduped.length * BOUND_BYTES_PER_GUARD).toBeLessThan(
      emitted(f).length,
    );
  });

  test("largestMethodBytes measures header to header, attribute lines with their method", () => {
    const text = [
      "codeunit 1 C",
      "{",
      "    [EventSubscriber(ObjectType::Codeunit, 1, 'X', '', false, false)]",
      "    local procedure A()",
      "    begin",
      `        ${"x".repeat(300)}`,
      "    end;",
      "    trigger OnRun()",
      "    begin",
      "    end;",
      "}",
    ].join("\n");
    const a = text.indexOf("    [EventSubscriber");
    const t = text.indexOf("    trigger OnRun");
    expect(largestMethodBytes(text)).toBe(t - a);
    expect(largestMethodBytes("no methods here")).toBe(0);
  });

  test("a batch names its suspect only when it holds the large method", () => {
    const large = [{ path: "src/Big.Codeunit.al", chain: 454, methodBytes: 24 * 1024 * 1024 }];
    const said = largeMethodSuspect(large, ["src/Other.al", "src/Big.Codeunit.al"]) ?? "";
    expect(said).toContain("src/Big.Codeunit.al (chain 454, 24576 KB in one method)");
    expect(said).toContain("not proven, GitHub #28");
    expect(largeMethodSuspect(large, ["src/Other.al"])).toBeUndefined();
    expect(largeMethodSuspect([], ["src/Big.Codeunit.al"])).toBeUndefined();
  });

  test("a quarantine names the large method when the batch holds one, and not otherwise", async () => {
    const big = await session(150, "bcdev", true);
    expect(big.quarantined).toHaveLength(1);
    expect(big.quarantined[0]).toContain("the service tier stopped answering");
    expect(big.quarantined[0]).toContain("one suspect (not proven, GitHub #28)");
    expect(big.quarantined[0]).toContain("P.Codeunit.al");
    const small = await session(10, "bcdev", true);
    expect(small.quarantined).toHaveLength(1);
    expect(small.quarantined[0]).not.toContain("suspect");
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
    const comment = "            // padding\n".repeat(4000);
    const body = Array.from({ length: 12 }, (_, i) => `            Z := Z + ${i + 1};`).join("\n");
    writeFileSync(
      join(dir, "src", "P.Codeunit.al"),
      `codeunit 50000 "P"\n{\n    procedure Big()\n    var\n        Y: Integer;\n        Z: Integer;\n    begin\n        for Y := 1 to Z do begin\n${comment}${body}\n        end;\n    end;\n}\n`,
    );
    const set = await generateMutationSet(dir, { emit: () => {} } as never);
    const [f] = set.files;
    if (f === undefined) throw new Error("no file");
    const big = largeMethodOf(f, tierOf);
    expect(big?.chain).toBeLessThan(100);
    expect(big?.methodBytes).toBeGreaterThanOrEqual(LARGE_METHOD_BYTES);
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
