import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  IDENTITY_SCHEME,
  withRunIdentityOrdinals,
  writeInstrumentedProject,
} from "@lethal/schemata";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import { generateMutationSet, operatorTiers, runSession } from "../src/orchestrator";
import { sessionFingerprint } from "../src/resume";
import { identityKeyOf, serializeKey } from "../src/selection";
import { ResultsStore } from "../src/store";

// R323: a named return value (`procedure P() Result: Integer`) is a local of its member. These pin
// the engine's rule through the real pipeline, on the hand-written repros (invented names, no corpus
// text), asserting only site presence or absence at a pinned line, hang tags, and keys.

const APP_JSON = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "repro",
  publisher: "repro",
  version: "1.0.0.0",
  runtime: "16.0",
  idRanges: [{ from: 50100, to: 50149 }],
};

const SHOW = `
    procedure Show(A: Integer; B: Integer)
    begin
        Glob := A;
    end;

    procedure Show(A: Integer; B: Text)
    begin
        Glob := A;
    end;
`;

const REPRO: Record<string, Record<string, string>> = {
  n1: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N1"
{
    procedure Pick(X: Integer) Result: Text
    begin
        Result := 'a';
        Show(X, Result);
    end;
${SHOW}
    var
        Glob: Integer;
        Result: Integer;
}
`,
  },
  n2: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N2"
{
    procedure Pick(X: Integer) Result: Text
    begin
        Result := 'a';
        Show(X, Result);
    end;
${SHOW}
    var
        Glob: Integer;
        result: Integer;
}
`,
  },
  n3: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N3"
{
    procedure Pick(X: Integer) Result: Integer
    begin
        Result := X;
        Show(X, Result);
    end;
${SHOW}
    var
        Glob: Integer;
        Result: Integer;
}
`,
  },
  n4: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N4"
{
    procedure Pick(X: Integer) Result: Integer
    begin
        Result := X + 1;
        Glob := Result + X;
        Show(X, Result);
    end;
${SHOW}
    var
        Glob: Integer;
}
`,
  },
  n5: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N5"
{
#if not CLEAN27
    procedure Pick(X: Integer) Result: Text
#else
    procedure Pick(X: Integer) Result: Text
#endif
    begin
        Result := 'a';
        Show(X, Result);
    end;
${SHOW}
    var
        Glob: Integer;
        Result: Integer;
}
`,
  },
  n6: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N6"
{
#if not CLEAN27
    procedure Pick(X: Integer) Result: Text
    var
        K: Integer;
#else
    procedure Pick(X: Integer) Result: Text
    var
        K: Integer;
#endif
    begin
        K := X;
        Result := 'a';
        Show(K, Result);
    end;
${SHOW}
    var
        Glob: Integer;
        Result: Integer;
}
`,
  },
  n7: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N7"
{
#if not CLEAN27
    procedure Pick(X: Integer) Result: Text
#else
    procedure Pick(X: Integer): Text
#endif
    begin
        Show(X, Result);
    end;
${SHOW}
    var
        Glob: Integer;
        Result: Integer;
}
`,
  },
  n8: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N8"
{
#if not CLEAN27
    procedure Pick(X: Integer) Result: Text
#else
    procedure Pick(X: Integer) Result: Integer
#endif
    begin
        Show(X, Result);
    end;
${SHOW}
    var
        Glob: Integer;
        Result: Integer;
}
`,
  },
  n9: {
    "P.Page.al": `page 50100 "Repro N9"
{
    SourceTable = "Repro N9 Tab";
    layout { area(Content) { field(Code; Rec.Code) { } } }

    trigger OnFindRecord(Which: Text) Found: Boolean
    begin
        Found := Rec.Find(Which);
        Show(Glob, Found);
    end;

    procedure Show(A: Integer; B: Integer)
    begin
        Glob := A;
    end;

    procedure Show(A: Integer; B: Boolean)
    begin
        Glob := A;
    end;

    var
        Glob: Integer;
        Found: Integer;
}
`,
    "T.Table.al": `table 50100 "Repro N9 Tab"
{
    fields { field(1; Code; Code[20]) { } }
    keys { key(PK; Code) { Clustered = true; } }
}
`,
  },
  n11: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N11"
{
    procedure Count() Result: Integer
    begin
        Result := 0;
        while Result < 10 do
            Result := Result + 1;
    end;
}
`,
  },
  n12: {
    "H.Codeunit.al": `codeunit 50101 "Repro N12 Helper"
{
    procedure Validate(F: Integer; V: Integer)
    begin
        Glob := F + V;
    end;

    var
        Glob: Integer;
}
`,
    "Repro.Codeunit.al": `codeunit 50100 "Repro N12"
{
    procedure Make() R: Codeunit "Repro N12 Helper"
    var
        N: Integer;
    begin
        N := 1;
        R.Validate(N, 5);
    end;

    var
        R: Record "Repro N12 Tab";
}
`,
    "T.Table.al": `table 50100 "Repro N12 Tab"
{
    fields { field(1; Code; Code[20]) { } field(2; N; Integer) { } }
    keys { key(PK; Code) { Clustered = true; } }
}
`,
  },
  n13: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N13"
{
    procedure Load() R: Record "Repro N13 Tab"
    begin
        R.SetRange(Code, 'A');
        Glob := R.Amt + Glob;
    end;

    var
        Glob: Integer;
}
`,
    "T.Table.al": `table 50100 "Repro N13 Tab"
{
    fields { field(1; Code; Code[20]) { } field(2; Amt; Integer) { } }
    keys { key(PK; Code) { Clustered = true; } }
}
`,
  },
  n14: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N14"
{
    procedure Pick(X: Integer) Result: Integer
    begin
        Glob := Result + X;
    end;

    procedure Pick(X: Integer; Y: Integer)
    var
        Result: Integer;
    begin
        Glob := Result + X;
    end;

    var
        Glob: Integer;
}
`,
  },
  n15: {
    "Repro.Codeunit.al": `codeunit 50100 "Repro N15"
{
    procedure Pick(X: Integer) Result: Text
    begin
        Show(X, Result);
    end;

    procedure Pick(X: Integer; Y: Integer)
    var
        Result: Integer;
    begin
        Show(X, Result);
    end;
${SHOW}
    var
        Glob: Integer;
        Result: Integer;
}
`,
  },
};

function repro(name: string): Record<string, string> {
  const files = REPRO[name];
  if (files === undefined) throw new Error(`no repro ${name}`);
  return files;
}

/** Instruments `files` as one project (the real operator set and writer); returns the manifest. */
async function instrument(files: Record<string, string>): Promise<MutantManifest> {
  const src = await mkdtemp(join(tmpdir(), "lethal-r323-src-"));
  const out = await mkdtemp(join(tmpdir(), "lethal-r323-out-"));
  try {
    await writeFile(join(src, "app.json"), JSON.stringify(APP_JSON));
    for (const [name, text] of Object.entries(files)) await writeFile(join(src, name), text);
    const set = await generateMutationSet(src);
    await writeInstrumentedProject(
      withRunIdentityOrdinals({
        targetDir: out,
        files: set.files,
        selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: APP_JSON.id,
        operatorTiers,
      }),
    );
    return JSON.parse(await readFile(join(out, "mutant-manifest.json"), "utf8")) as MutantManifest;
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
}

function at(
  manifest: MutantManifest,
  file: string,
  line: number,
  operator: string,
): MutantManifestEntry[] {
  return manifest.mutants.filter(
    (m) => m.file === file && m.startLine === line && m.operatorName === `lethal.${operator}`,
  );
}

function keyOf(m: MutantManifestEntry): string {
  return serializeKey(identityKeyOf(m));
}

const N14_HASH = "78d263bdf45458172865b270cf8c37ce220abae7feec90e4dd915b0eabc69b89";
/** The pre-committed key: under scheme 2 it named the L12 mutant, under scheme 3 the new L5 one. */
const N14_KEY = `${N14_HASH}|Repro N14|Pick|lethal.swap-additive|1`;
const N15_KEY =
  "2712cb75f37bab6dba29aa193dc13db38dbce8d87ef832627bba27e8a0a4e55a|Repro N15|Pick|lethal.swap-call-arguments|1";

describe("R323: named return values through the real pipeline", () => {
  beforeAll(async () => {
    await initParser();
  });

  // The named return hides the same-named global, so the argument's type is the return's own
  // (Text or Boolean), the two overloads disagree, and a swap would not compile.
  const hidden: Array<[string, string, number]> = [
    ["n1", "Repro.Codeunit.al", 6],
    ["n2", "Repro.Codeunit.al", 6],
    ["n5", "Repro.Codeunit.al", 10],
    ["n6", "Repro.Codeunit.al", 15],
    ["n7", "Repro.Codeunit.al", 9],
    ["n8", "Repro.Codeunit.al", 9],
    ["n9", "P.Page.al", 9],
    ["n15", "Repro.Codeunit.al", 5],
  ];
  for (const [name, file, line] of hidden) {
    test(`${name}: no swap-call-arguments at ${file}:${line}`, async () => {
      const manifest = await instrument(repro(name));
      // The pipeline did reach the file: an absence proves nothing about an unparsed one.
      expect(manifest.mutants.some((m) => m.file === file)).toBe(true);
      expect(at(manifest, file, line, "swap-call-arguments")).toEqual([]);
    });
  }

  test("n3: a same-typed global is hidden with no change: swap-call-arguments at L6 stays", async () => {
    const manifest = await instrument(repro("n3"));
    expect(at(manifest, "Repro.Codeunit.al", 6, "swap-call-arguments")).toHaveLength(1);
  });

  test("n4: with no global, the return types by its declaration: swap-additive L6, swap-call-arguments L7", async () => {
    const manifest = await instrument(repro("n4"));
    expect(at(manifest, "Repro.Codeunit.al", 6, "swap-additive")).toHaveLength(1);
    expect(at(manifest, "Repro.Codeunit.al", 7, "swap-call-arguments")).toHaveLength(1);
  });

  test("n11: the loop's counter is the named return, so L7's assignment mutants are hang-tagged", async () => {
    const manifest = await instrument(repro("n11"));
    for (const op of ["remove-assignment", "swap-additive"]) {
      const hits = at(manifest, "Repro.Codeunit.al", 7, op);
      expect(hits).toHaveLength(1);
      expect(hits.map((m) => m.hangCapable)).toEqual(["loop-condition-target"]);
    }
  });

  test("n12: a codeunit-typed named return is not a record: no validate-to-assign at L8", async () => {
    const manifest = await instrument(repro("n12"));
    expect(at(manifest, "Repro.Codeunit.al", 8, "validate-to-assign")).toEqual([]);
    expect(at(manifest, "Repro.Codeunit.al", 8, "void-method-call")).toHaveLength(1);
  });

  test("n13: a record-typed named return is a record receiver", async () => {
    const manifest = await instrument(repro("n13"));
    expect(at(manifest, "Repro.Codeunit.al", 5, "remove-setrange")).toHaveLength(1);
    expect(at(manifest, "Repro.Codeunit.al", 5, "void-method-call")).toEqual([]);
    expect(at(manifest, "Repro.Codeunit.al", 6, "swap-additive")).toHaveLength(1);
  });

  test("n14: the new L5 swap-additive takes ordinal 0 and the overload's L12 one moves to 1", async () => {
    const manifest = await instrument(repro("n14"));
    const l5 = at(manifest, "Repro.Codeunit.al", 5, "swap-additive");
    const l12 = at(manifest, "Repro.Codeunit.al", 12, "swap-additive");
    expect(l5.map(keyOf)).toEqual([N14_KEY]);
    expect(l12.map(keyOf)).toEqual([`${N14_KEY}|1`]);
  });

  test("n15: the overload's L12 swap-call-arguments keeps ordinal 0 (L5's is gone)", async () => {
    const manifest = await instrument(repro("n15"));
    expect(at(manifest, "Repro.Codeunit.al", 12, "swap-call-arguments").map(keyOf)).toEqual([
      N15_KEY,
    ]);
  });
});

// Step 1b: the scheme 2 to 3 transition on the one key whose text is identical under both schemes
// but names a different mutant (n14). Modelled on resume.test.ts's R325 block.

const TEST_AL = `codeunit 50140 "Repro N14 Tests"
{
    Subtype = Test;

    [Test]
    procedure PickTest()
    begin
    end;
}
`;

const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

const selectorIds = { selectorId: 50147, controlId: 50148, tableId: 50149 };

/** Every test passes, so every covered mutant survives; the baseline covers both `Pick`s. */
class SurvivingBackend implements ExecutionBackend {
  private active: string | null = null;
  capabilities(): BackendCapabilities {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(this.active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 50100, procedure: "Pick" }],
            },
          }
        : { attestation: { observedAny: true, identityMismatch: false } }),
    };
  }
}

// Every project root this file makes, removed once all its tests are done.
const runRoots: string[] = [];
afterAll(async () => {
  for (const root of runRoots) await rm(root, { recursive: true, force: true });
});

async function makeN14Project() {
  const root = await mkdtemp(join(tmpdir(), "lethal-r323-run-"));
  runRoots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "Repro.Codeunit.al"), repro("n14")["Repro.Codeunit.al"] ?? "");
  await Bun.write(join(projectDir, "app.json"), JSON.stringify(APP_JSON));
  await Bun.write(join(testDir, "ReproTests.Codeunit.al"), TEST_AL);
  return { projectDir, testDir, instrumentedDir };
}

type ReportMutant = Awaited<ReturnType<typeof runSession>>["mutants"][number];

function reportKey(m: ReportMutant): string {
  return serializeKey({
    astHash: m.astHash,
    codeunitName: m.codeunitName,
    procedureName: m.procedureName ?? "",
    operatorName: m.operatorName,
    operatorMajor: m.operatorMajor,
    ordinal: m.identityOrdinal ?? 0,
  });
}

/** The L5 `swap-additive` of the report, after asserting it carries the pre-committed key text. */
function l5Of(report: Awaited<ReturnType<typeof runSession>>): ReportMutant {
  const hits = report.mutants.filter(
    (m) =>
      m.file === "Repro.Codeunit.al" && m.line === 5 && m.operatorName === "lethal.swap-additive",
  );
  expect(hits.map(reportKey)).toEqual([N14_KEY]);
  const [l5] = hits;
  if (l5 === undefined) throw new Error("unreachable");
  return l5;
}

describe("R323: a scheme-2 record never reaches a current-scheme mutant with the same key text", () => {
  beforeAll(async () => {
    await initParser();
  });

  /** A run made by this build, then relabelled to `scheme` with the fingerprint that scheme's
   *  build computes; `finished: false` clears its finish so it is resumable. */
  async function storedRun(opts: { scheme: number; finished: boolean }) {
    // 3 was R323; R318 bumped the scheme without moving a key tuple, so the controls use the
    // current scheme.
    expect(IDENTITY_SCHEME).toBeGreaterThanOrEqual(3);
    const dirs = await makeN14Project();
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
    });
    // The record holds the key as a survivor.
    expect(l5Of(first).verdict).toBe("survived");
    const run = store.db.query("SELECT id, backend FROM runs").get() as {
      id: number;
      backend: string;
    };
    const fingerprint = sessionFingerprint({
      projectDir: dirs.projectDir,
      testDir: dirs.testDir,
      backend: run.backend,
      skipKnownSurvivors: false,
      selectorIds,
      identityScheme: opts.scheme,
      // R354: what runSession computes: it always passes the mode, here the backend's.
      coverageMode: "procedure",
    });
    store.db.run(
      `UPDATE runs SET identity_scheme = ?, config_fingerprint = ?${opts.finished ? "" : ", finished_at = NULL"} WHERE id = ?`,
      [opts.scheme, fingerprint, run.id],
    );
    return { dirs, store, runId: run.id };
  }

  async function historyRun(scheme: number) {
    const { dirs, store, runId } = await storedRun({ scheme, finished: true });
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    const warnings = events.flatMap((e) =>
      e.type === "warning" && e.code === "history-identity-scheme-changed" ? [e.message] : [],
    );
    return { report, warnings, runId };
  }

  test("history: a scheme-2 survivor with the same key text is executed, and the run says why", async () => {
    const { report, warnings, runId } = await historyRun(2);
    expect(l5Of(report).verdict).toBe("survived");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`run ${runId}`);
    expect(warnings[0]).toContain("identity scheme 2");
  });

  test("history control: relabelled to the current scheme, the same record IS skipped (the key collides)", async () => {
    const { report, warnings } = await historyRun(IDENTITY_SCHEME);
    expect(l5Of(report).verdict).toBe("known-survivor");
    expect(warnings).toEqual([]);
  });

  test("--resume-run of a scheme-2 run holding the key is refused, naming both schemes and R325", async () => {
    const { dirs, store, runId } = await storedRun({ scheme: 2, finished: false });
    await expect(
      runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, resume: runId }),
    ).rejects.toThrow(
      new RegExp(
        `--resume-run ${runId} was keyed under identity scheme 2.*scheme ${IDENTITY_SCHEME}.*R325`,
      ),
    );
  });

  test("--resume-run control: relabelled to the current scheme, the same run resumes", async () => {
    const { dirs, store, runId } = await storedRun({ scheme: IDENTITY_SCHEME, finished: false });
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      resume: runId,
    });
    expect(l5Of(report).verdict).toBe("survived");
  });

  test("--resume last names the scheme-2 run instead of reporting none found", async () => {
    const { dirs, store, runId } = await storedRun({ scheme: 2, finished: false });
    await expect(
      runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, resume: "last" }),
    ).rejects.toThrow(
      new RegExp(`run ${runId}, .*identity scheme 2.*scheme ${IDENTITY_SCHEME}.*R325`),
    );
  });

  test("--resume last control: relabelled to the current scheme, the same run resumes", async () => {
    const { dirs, store } = await storedRun({ scheme: IDENTITY_SCHEME, finished: false });
    const report = await runSession({
      backend: new SurvivingBackend(),
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });
    expect(l5Of(report).verdict).toBe("survived");
  });

  async function markedRun(identityScheme: number) {
    // 3 was R323; R318 bumped the scheme without moving a key tuple, so the controls use the
    // current scheme.
    expect(IDENTITY_SCHEME).toBeGreaterThanOrEqual(3);
    const dirs = await makeN14Project();
    return runSession({
      backend: new SurvivingBackend(),
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
      equivalenceMarks: [{ key: N14_KEY, reason: "same either way", identityScheme }],
    });
  }

  test("marks: a scheme-2 mark on the key leaves the L5 mutant unmarked (stale)", async () => {
    const report = await markedRun(2);
    expect(l5Of(report).readerMark).toBeUndefined();
    expect(report.readerMarkedEquivalent?.matched).toEqual([]);
    expect(report.readerMarkedEquivalent?.stale).toEqual([N14_KEY]);
  });

  test("marks control: the same mark at the current scheme marks it", async () => {
    const report = await markedRun(IDENTITY_SCHEME);
    expect(l5Of(report).readerMark).toBeDefined();
    expect(report.readerMarkedEquivalent?.matched.map((m) => m.key)).toEqual([N14_KEY]);
  });
});
