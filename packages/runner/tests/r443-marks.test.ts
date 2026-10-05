import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { EquivalenceMark } from "../src/equivalence-marks";
import { runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { serializeKey } from "../src/selection";
import { ResultsStore } from "../src/store";

/**
 * R443 (widened under R-443): an equivalence mark names its mutant by identity key alone, and a key
 * carries a run-wide twin ordinal (R193, R374). Any renumbering between the run a reader marked
 * from and a later run hands the key to ANOTHER twin, and the mark then hides that twin's survival
 * as "reader-marked equivalent" although nobody looked at it. R-391 closed the same hole for
 * carried verdicts; these are the three mark sequences:
 *   1. cross-file: the marked twin's file edits its twin away, and another file's twin inherits the key;
 *   2. same-file: the marked twin is deleted, and the next twin in the file inherits the key;
 *   3. R443's own: a header-refused file reserved no ordinal when the mark was made; once its
 *      header is repaired, its twin takes the marked key back.
 * In each, the mutant the mark ends up naming must NOT be reported as a matched mark.
 */

const APP_JSON = JSON.stringify({
  id: "4a7d1c52-8b8e-4f0e-9f41-3c6b2d1e5443",
  name: "R443 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 80000 }],
});
const selectorIds = { selectorId: 50290, controlId: 50291, tableId: 50292 };
const OP = "lethal.remove-assignment";
const TWIN = "X := X + 1;";

const TEST_AL = `codeunit 50200 "Twin Tests"
{
    Subtype = Test;

    [Test]
    procedure BumpWorks()
    begin
    end;
}
`;

const table = (header: string, stmts: readonly string[]) => `${header}
{
    fields
    {
        field(1; Id; Integer) { }
    }

    procedure Bump(): Integer
    var
        X: Integer;
    begin
${stmts.map((s) => `        ${s}`).join("\n")}
        exit(X);
    end;
}
`;
const codeunit = (header: string, stmts: readonly string[]) => `${header}
{
    procedure Bump(): Integer
    var
        X: Integer;
    begin
${stmts.map((s) => `        ${s}`).join("\n")}
        exit(X);
    end;
}
`;

/** Every mutant survives; the baseline covers both `Bump`s. */
class AllSurvive implements ExecutionBackend {
  private active: string | null = null;
  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    if (this.active === null) {
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: {
          granularity: "procedure",
          entries: [
            { objectType: "Table", objectId: 50100, procedure: "Bump" },
            { objectType: "Codeunit", objectId: 50100, procedure: "Bump" },
            { objectType: "Codeunit", objectId: 50101, procedure: "Bump" },
          ],
        },
      };
    }
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
beforeAll(async () => {
  await initParser();
});

async function world(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "lethal-r443-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  for (const [p, text] of Object.entries(files)) await Bun.write(join(projectDir, p), text);
  await Bun.write(join(testDir, "TwinTests.Codeunit.al"), TEST_AL);
  const run = (equivalenceMarks?: readonly EquivalenceMark[]) =>
    runSession({
      backend: new AllSurvive(),
      store: new ResultsStore(":memory:"),
      projectDir,
      testDir,
      instrumentedDir,
      selectorIds,
      ...(equivalenceMarks !== undefined ? { equivalenceMarks } : {}),
    });
  const write = (p: string, text: string) => Bun.write(join(projectDir, p), text);
  return { run, write };
}

type Mutant = SessionReport["mutants"][number];
const twinsOf = (r: SessionReport, file: string): Mutant[] =>
  r.mutants.filter((m) => m.operatorName === OP && m.file === file).sort((a, b) => a.line - b.line);
const keyOf = (m: Mutant): string =>
  serializeKey({
    astHash: m.astHash,
    codeunitName: m.codeunitName,
    procedureName: m.procedureName ?? "",
    operatorName: m.operatorName,
    operatorMajor: m.operatorMajor,
    ordinal: m.identityOrdinal ?? 0,
  });

/** The mark a reader writes for `m` from report `r`: today what `explain` prints, the key alone. */
function markFor(_r: SessionReport, m: Mutant): EquivalenceMark {
  return { key: keyOf(m), reason: "reviewed: equivalent", identityScheme: IDENTITY_SCHEME };
}

/** `<file> @<line>` of every mutant a matched mark names in `r`. */
function matchedSites(r: SessionReport): string[] {
  const byCode = new Map(r.mutants.map((m) => [`${m.batchIndex ?? 0}/${m.mutantCode}`, m]));
  return (r.readerMarkedEquivalent?.matched ?? [])
    .map((x) => byCode.get(`${x.batchIndex}/${x.mutantCode}`))
    .map((m) => (m === undefined ? "?" : `${m.file} @${m.line}`))
    .sort();
}

describe("R443: a mark never names a twin it was not written for", () => {
  test("cross-file: the marked table twin is edited away; the codeunit twin is not marked", async () => {
    const w = await world({
      "A_Twin.Table.al": table('table 50100 "Twin"', [TWIN]),
      "B_Twin.Codeunit.al": codeunit('codeunit 50100 "Twin"', [TWIN]),
    });
    const first = await w.run();
    const [a] = twinsOf(first, "A_Twin.Table.al");
    if (a === undefined) throw new Error("expected the table twin");
    const mark = markFor(first, a);
    // Control: in the same source the mark names exactly the table twin.
    expect(matchedSites(await w.run([mark]))).toEqual([`A_Twin.Table.al @${a.line}`]);

    await w.write("A_Twin.Table.al", table('table 50100 "Twin"', ["X := 2;"]));
    const second = await w.run([mark]);
    expect(matchedSites(second).filter((s) => s.startsWith("B_Twin"))).toEqual([]);
  });

  test("same-file: the marked first twin is deleted; the second twin is not marked", async () => {
    const w = await world({
      "B_Twin.Codeunit.al": codeunit('codeunit 50101 "Pair"', [TWIN, "X := X * 2;", TWIN]),
    });
    const first = await w.run();
    const [t0] = twinsOf(first, "B_Twin.Codeunit.al").filter((m) => (m.identityOrdinal ?? 0) === 0);
    if (t0 === undefined) throw new Error("expected twin 0");
    const mark = markFor(first, t0);

    await w.write("B_Twin.Codeunit.al", codeunit('codeunit 50101 "Pair"', ["X := X * 2;", TWIN]));
    const second = await w.run([mark]);
    expect(matchedSites(second)).toEqual([]);
  });

  test("header refusal (R443): a repaired file's twin does not inherit a mark made while it was refused", async () => {
    // T4's no-header shape: the namespace and the header on one line is refused (R307), and a
    // refused file reserves no ordinal, so the good file's twin held ordinal 0 when it was marked.
    const w = await world({
      "A_Bad.Table.al": table('namespace X; table 50100 "Twin"', [TWIN]),
      "B_Good.Codeunit.al": codeunit('codeunit 50100 "Twin"', [TWIN]),
    });
    const first = await w.run();
    expect(first.mutants.some((m) => m.file === "A_Bad.Table.al")).toBe(false);
    const [good] = twinsOf(first, "B_Good.Codeunit.al");
    if (good === undefined) throw new Error("expected the good twin");
    const mark = markFor(first, good);

    await w.write("A_Bad.Table.al", table('namespace X;\ntable 50100 "Twin"', [TWIN]));
    const second = await w.run([mark]);
    expect(matchedSites(second).filter((s) => s.startsWith("A_Bad"))).toEqual([]);
  });
});
