/**
 * PR-327 (a): the `[singleinstance-carry-unobservable]` note on an al-runner-v3 survivor whose site
 * is in a SingleInstance codeunit and whose covering tests span 2+ test codeunits. Note only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { buildAlRunnerCoverageIndex } from "../src/al-runner-coverage";
import {
  AlRunnerV3Backend,
  V3_REFUSED_NEARBY_TAG,
  V3_SINGLEINSTANCE_TAG,
  singleInstanceCarryNoteOf,
} from "../src/al-runner-v3-backend";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { isNotedSurvivor } from "../src/confirm";
import { appendNote, runSession } from "../src/orchestrator";
import type { MutantOutcome } from "../src/report";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";

const ref = (codeunitId: number, method = "T"): TestMethodRef => ({
  codeunitId,
  codeunitName: `Tests${codeunitId}`,
  method,
});
const SITE = { objectType: "codeunit", codeunitId: 50100 };
const SI = new Set(["codeunit:50100"]);

describe("append, never replace", () => {
  // A survivor with an earlier note is not reachable through a stub session (a held timeout or error
  // ends as a timeout or error verdict), so the orchestrator's one call site is covered here by its helper.
  test("the survivor note comes first, the earlier text follows", () => {
    expect(appendNote("held earlier", "[tag] x")).toBe("[tag] x held earlier");
    expect(appendNote(undefined, "[tag] x")).toBe("[tag] x");
  });
  test("isNotedSurvivor still sees a nearby-tagged survivor that carried an earlier note", () => {
    const failureNote = appendNote("held earlier", `${V3_REFUSED_NEARBY_TAG} Tests.B: refused`);
    expect(isNotedSurvivor({ verdict: "survived", failureNote } as MutantOutcome)).toBe(true);
    expect(failureNote).toContain("held earlier");
  });
});

describe("the rule", () => {
  test("tagged: SingleInstance site, tests from 2 test codeunits", () => {
    const n = singleInstanceCarryNoteOf(SI, [ref(1), ref(2)], SITE);
    expect(n).toStartWith(V3_SINGLEINSTANCE_TAG);
    expect(n).toContain("cross-codeunit carry-over not observable on al-runner-v3");
  });
  test("not tagged: 1 test codeunit, however many tests", () => {
    expect(singleInstanceCarryNoteOf(SI, [ref(1, "A"), ref(1, "B")], SITE)).toBeUndefined();
  });
  test("not tagged: site not in a SingleInstance codeunit", () => {
    expect(
      singleInstanceCarryNoteOf(SI, [ref(1), ref(2)], {
        objectType: "codeunit",
        codeunitId: 50101,
      }),
    ).toBeUndefined();
    expect(singleInstanceCarryNoteOf(undefined, [ref(1), ref(2)], SITE)).toBeUndefined();
  });
  test("not tagged: no site given (a kill, error or no-coverage never asks)", () => {
    expect(singleInstanceCarryNoteOf(SI, [ref(1), ref(2)], undefined)).toBeUndefined();
  });
  test("bcdev has no survivorNote, so the same inputs get no tag", () => {
    expect(
      (BcDevMcpBackend.prototype as unknown as { survivorNote?: unknown }).survivorNote,
    ).toBeUndefined();
  });
});

describe("placement on the v3 backend", () => {
  // A backend shell with only the two fields the note reads.
  const shell = (refused: Map<number, Set<string>>, singleInstance: Set<string>) => {
    const b = Object.create(AlRunnerV3Backend.prototype) as Record<string, unknown>;
    b.baselineRefused = refused;
    b.coverageIndex = { singleInstance };
    return b as unknown as {
      survivorNoteShared(c: readonly TestMethodRef[], s?: typeof SITE): string | undefined;
    };
  };
  test("an existing refused-nearby note is kept and the tag is appended", () => {
    const b = shell(new Map([[1, new Set(["Bad"])]]), SI);
    const n = b.survivorNoteShared([ref(1), ref(2)], SITE) ?? "";
    expect(n).toStartWith(V3_REFUSED_NEARBY_TAG);
    expect(n).toContain(`${V3_SINGLEINSTANCE_TAG} survived;`);
    expect(n.indexOf(V3_REFUSED_NEARBY_TAG)).toBeLessThan(n.indexOf(V3_SINGLEINSTANCE_TAG));
  });
  test("the tag alone when nothing was refused; the nearby note alone when not SingleInstance", () => {
    expect(shell(new Map(), SI).survivorNoteShared([ref(1), ref(2)], SITE)).toStartWith(
      V3_SINGLEINSTANCE_TAG,
    );
    const other = shell(new Map([[1, new Set(["Bad"])]]), new Set());
    const n = other.survivorNoteShared([ref(1), ref(2)], SITE) ?? "";
    expect(n).toStartWith(V3_REFUSED_NEARBY_TAG);
    expect(n).not.toContain(V3_SINGLEINSTANCE_TAG);
  });
});

describe("parser detection", () => {
  let dir = "";
  beforeAll(async () => {
    await initParser();
    dir = await mkdtemp(join(tmpdir(), "pr327-"));
    await mkdir(join(dir, "src"));
    const cu = (id: number, name: string, props: string, body = "") =>
      writeFile(
        join(dir, "src", `${name}.al`),
        `codeunit ${id} "${name}"\n{\n${props}\n    procedure P()\n    begin\n${body}\n    end;\n}\n`,
      );
    await cu(50100, "Yes", "    SingleInstance = true;");
    await cu(50101, "Mixed", "    singleinstance = TRUE;");
    await cu(50102, "No", "    SingleInstance = false;");
    await cu(50103, "Comment", "    // SingleInstance = true;\n    Access = Public;");
    await cu(50104, "Plain", "");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  test("true (any case) is detected; false, a comment and no property are not", async () => {
    const index = await buildAlRunnerCoverageIndex(dir, { symbols: [], notify: () => {} });
    expect([...(index.singleInstance ?? [])].sort()).toEqual(["codeunit:50100", "codeunit:50101"]);
  });
});

describe("through runSession: only a survivor is tagged", () => {
  const scratch = scratchDirs();
  const CAPS: BackendCapabilities = {
    coverage: "procedure",
    deploy: "publish",
    isolation: "session",
    kind: "bcdev",
    authoritative: true,
  };
  const TARGET = `codeunit 79000 "Sandbox Logic"
{
    SingleInstance = true;

    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
  const tests = (id: number) => `codeunit ${id} "Sandbox Tests ${id}"
{
    Subtype = Test;

    [Test]
    procedure T1() begin end;
}
`;
  // A stub whose survivorNote applies the new rule, as the v3 backend's does.
  class Stub implements ExecutionBackend {
    readonly killsMustReproduce = true;
    readonly runnerBuild = async () => ({ version: "stub 1", binarySha256: "b".repeat(64) });
    private active: string | null = null;
    constructor(private readonly verdictOf: (mutant: string) => TestVerdict["outcome"]) {}
    capabilities() {
      return CAPS;
    }
    async status(): Promise<BackendStatus> {
      return { ok: true, details: "stub" };
    }
    async deploy() {
      return null;
    }
    async compileCheck(): Promise<void> {}
    async activate(id: string | null) {
      this.active = id;
    }
    async run(r: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
      const a = this.active;
      return {
        ref: r,
        outcome: a === null ? "pass" : this.verdictOf(a),
        durationMs: 5,
        ...(a === null
          ? {
              coverage: {
                granularity: "procedure" as const,
                entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
              },
            }
          : {}),
        ...(opts.coverage === "none"
          ? { attestation: { observedAny: true, identityMismatch: false } }
          : {}),
        ...(opts.coverage === "none" ? { reachedActive: a !== null } : {}),
      };
    }
    survivorNote(
      covering: readonly TestMethodRef[],
      site?: { objectType: string; codeunitId: number },
    ) {
      return singleInstanceCarryNoteOf(new Set(["codeunit:79000"]), covering, site);
    }
  }
  const run = async (backend: ExecutionBackend) => {
    const root = scratch("lethal-pr327-");
    const projectDir = join(root, "app");
    const testDir = join(root, "tests");
    await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET);
    await Bun.write(
      join(projectDir, "app.json"),
      JSON.stringify({
        id: "11111111-1111-1111-1111-111111111111",
        name: "Fixture",
        publisher: "LethAL",
        version: "1.0.0.0",
        idRanges: [{ from: 79000, to: 79199 }],
      }),
    );
    await Bun.write(join(testDir, "A.Codeunit.al"), tests(79100));
    await Bun.write(join(testDir, "B.Codeunit.al"), tests(79101));
    await Bun.write(
      join(testDir, "app.json"),
      '{"name":"Tests","publisher":"P","version":"1.0.0.0"}',
    );
    const store = new ResultsStore(":memory:");
    try {
      return await runSession({
        backend,
        store,
        projectDir,
        testDir,
        instrumentedDir: join(root, "instr"),
        selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
      });
    } finally {
      store.close();
    }
  };

  test("M0001 killed carries no tag; every survivor carries it", async () => {
    const report = await run(new Stub((m) => (m === "M0001" ? "fail" : "pass")));
    const killed = report.mutants.find((m) => m.mutantCode === "M0001");
    const survivors = report.mutants.filter((m) => m.verdict === "survived");
    expect(killed?.verdict).toBe("killed");
    expect(killed?.failureNote ?? "").not.toContain(V3_SINGLEINSTANCE_TAG);
    expect(survivors.length).toBeGreaterThan(0);
    for (const s of survivors) expect(s.failureNote).toContain(V3_SINGLEINSTANCE_TAG);
  });
});
