import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeSpecs, identitySiteKey, numberIdentityOrdinals } from "@lethal/schemata";
import { V3_REFUSED_NEARBY_TAG } from "../src/al-runner-v3-backend";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { confirmMergeFromCli, parseCliConfig } from "../src/cli";
import {
  CONFIRMATION_VERSION,
  ConfirmDuplicateKeyError,
  ConfirmEmptySetError,
  ConfirmExactSitesError,
  ConfirmFlagsMismatchError,
  ConfirmInputNotReportError,
  ConfirmInputNotV3Error,
  ConfirmInputPartialError,
  ConfirmKeyMatchError,
  ConfirmMergeBcPartialError,
  ConfirmMergeBcRowNotMeasuredError,
  ConfirmMergeInputShaError,
  ConfirmMergeMissingKeyError,
  ConfirmMergeNotConfirmRunError,
  ConfirmMergeSelectedNotInV3Error,
  ConfirmMergeUnselectedKeyError,
  ConfirmResumeError,
  ConfirmSkipKnownSurvivorsError,
  ConfirmSourceMismatchError,
  ConfirmSuiteMismatchError,
  V3_NOCOV_REFUSAL_LEAD,
  assertSameScope,
  drawSample,
  isNotedNoCoverage,
  isNotedSurvivor,
  mergeConfirmation,
  narrowToConfirmed,
  planConfirm,
  renderConfirmation,
  scopeOfReport,
  sha256Hex,
} from "../src/confirm";
import type { RunEvent } from "../src/events";
import { keyOf } from "../src/mutant-key";
import {
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
  runSession,
  unsupportedCoverageNote,
} from "../src/orchestrator";
import type { SessionConfig } from "../src/orchestrator";
import type { MutantOutcome, SessionReport } from "../src/report";
import { REPORT_SCHEMA_VERSION } from "../src/report";
import { ResultsStore } from "../src/store";
import { conformsTo } from "./helpers/json-schema-subset";

/**
 * PR-171 (R1122). Each test names the guard it pins; each guard was red-checked by reverting it.
 * Nothing here touches /coord, a server or a real backend.
 */

const APP_JSON = JSON.stringify({
  id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1027",
  name: "Confirm Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

// `Twice` holds two byte-identical statements in ONE procedure: identity twins (R193).
const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOver(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

    procedure Twice(var N: Integer)
    begin
        N := N + 1;
        N := N + 1;
    end;
}
`;
const FILE = "SandboxLogic.Codeunit.al";
const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure T()
    begin
    end;
}
`;

const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "al-runner-v3",
  authoritative: false,
};

class StubBackend implements ExecutionBackend {
  deploys = 0;
  private activations: Array<string | null> = [];
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
  }
  capabilities(): BackendCapabilities {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    this.deploys++;
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: ["IsOver", "Twice"].map((procedure) => ({
                objectType: "Codeunit",
                objectId: 79000,
                procedure,
              })),
            },
          }
        : {}),
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

async function withProject<T>(
  body: (projectDir: string, root: string) => Promise<T>,
  target = TARGET_AL,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-confirm-"));
  const projectDir = join(root, "app");
  await Bun.write(join(projectDir, FILE), target);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(root, "tests", "SandboxTests.Codeunit.al"), TEST_AL);
  try {
    return await body(projectDir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let runCounter = 0;
async function session(
  projectDir: string,
  root: string,
  extra: Partial<SessionConfig> = {},
  events: RunEvent[] = [],
): Promise<{ report: SessionReport; backend: StubBackend }> {
  const store = new ResultsStore(":memory:");
  const backend = new StubBackend();
  try {
    const report = await runSession({
      emit: [(e) => events.push(e)],
      backend,
      store,
      projectDir,
      testDir: join(root, "tests"),
      instrumentedDir: join(root, `instr-${runCounter++}`),
      selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
      ...extra,
    });
    return { report, backend };
  } finally {
    store.close();
  }
}

/** A v3 report: one unfiltered stub run, with the rows `edit` names re-marked. */
function marked(
  report: SessionReport,
  edit: (m: MutantOutcome, i: number) => Partial<MutantOutcome>,
): SessionReport {
  return { ...report, mutants: report.mutants.map((m, i) => ({ ...m, ...edit(m, i) })) };
}
const NOTE = `${V3_REFUSED_NEARBY_TAG} Other.t: refused by v3`;

function confirmInput(report: SessionReport): { input: unknown; inputSha256: string } {
  const text = JSON.stringify(report);
  return { input: JSON.parse(text), inputSha256: sha256Hex(text) };
}

/** Run a confirm session and return what it threw (or its report) and how often it deployed. */
async function confirmRun(
  projectDir: string,
  root: string,
  v3: SessionReport,
  extra: Partial<SessionConfig> = {},
  confirm: { sample?: number; seed?: string } = { sample: 0 },
  events: RunEvent[] = [],
): Promise<{ error?: unknown; report?: SessionReport; deploys: number }> {
  const store = new ResultsStore(":memory:");
  const backend = new StubBackend();
  try {
    const report = await runSession({
      emit: [(e) => events.push(e)],
      backend,
      store,
      projectDir,
      testDir: join(root, "tests"),
      instrumentedDir: join(root, `instr-${runCounter++}`),
      selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
      confirm: { inputPath: "v3.json", ...confirmInput(v3), ...confirm },
      ...extra,
    });
    return { report, deploys: backend.deploys };
  } catch (error) {
    return { error, deploys: backend.deploys };
  } finally {
    store.close();
  }
}

// --------------------------------------------------------------------------------------------
// The key
// --------------------------------------------------------------------------------------------

describe("keyOf moved to src", () => {
  test("is the itest's keyOf (re-exported), with the ordinal only when non-zero", async () => {
    const itest = await import("../itest/mutant-equality");
    expect(itest.keyOf).toBe(keyOf);
    const m = {
      astHash: "h",
      codeunitName: "C",
      procedureName: "",
      triggerName: "OnX",
      operatorName: "op",
      operatorMajor: 2,
    } as MutantOutcome;
    expect(keyOf(m)).toBe("h|C|OnX|op|2");
    expect(keyOf({ ...m, identityOrdinal: 0 })).toBe("h|C|OnX|op|2");
    expect(keyOf({ ...m, identityOrdinal: 3 })).toBe("h|C|OnX|op|2|3");
  });
});

// --------------------------------------------------------------------------------------------
// Selection
// --------------------------------------------------------------------------------------------

/** A minimal v3 report of `n` rows, for the pure selection tests. */
type Row = Partial<MutantOutcome> & { verdict: MutantOutcome["verdict"] };

function v3Rows(rows: ReadonlyArray<Row>): SessionReport {
  return {
    schemaVersion: 3,
    backend: "al-runner-v3",
    preprocessorSymbols: [],
    identityScheme: 48,
    sourceSha256: "s".repeat(64),
    dependencySourceSha256: "d".repeat(64),
    mutants: rows.map((r, i) => ({
      mutantCode: `M${i}`,
      file: "F.al",
      line: i + 1,
      operatorName: "op",
      batchIndex: 0,
      astHash: `h${i}`,
      codeunitName: "C",
      procedureName: "P",
      operatorMajor: 1,
      ...r,
    })),
  } as unknown as SessionReport;
}

function plan(report: SessionReport, extra: Partial<Parameters<typeof planConfirm>[0]> = {}) {
  const { input, inputSha256 } = confirmInput(report);
  return planConfirm({
    inputPath: "v3.json",
    input,
    inputSha256,
    skipKnownSurvivors: false,
    resume: false,
    exactSites: false,
    ...extra,
  });
}

describe("selection: planConfirm", () => {
  const report = v3Rows([
    { verdict: "survived", failureNote: NOTE }, // h0 noted
    { verdict: "survived" }, // h1 unnoted
    { verdict: "killed", failureNote: NOTE }, // h2 killed, never selected
    {
      verdict: "no-coverage",
      failureNote: `${V3_NOCOV_REFUSAL_LEAD}: mutant covered by test(s) x`,
    }, // h3
    { verdict: "no-coverage", failureNote: "unsupported test type: nothing" }, // h4 not R609
    { verdict: "survived", failureNote: `x ${V3_REFUSED_NEARBY_TAG}` }, // h5 tag not at the start
    { verdict: "survived" }, // h6 unnoted
  ]);

  test("selects the noted survivors and the R609 no-coverage rows, and no one else", () => {
    const p = plan(report, { sample: 0 });
    expect(p.given.selected).toEqual([
      { key: "h0|C|P|op|1", group: "noted" },
      { key: "h3|C|P|op|1", group: "nocov-noted" },
    ]);
  });

  test("the sample draws unnoted survivors only (never a noted, killed or other row)", () => {
    const p = plan(report, { sample: 99 });
    const sample = p.given.selected.filter((s) => s.group === "sample").map((s) => s.key);
    // h1, h5 (tag not at the start: unnoted) and h6
    expect(sample.sort()).toEqual(["h1|C|P|op|1", "h5|C|P|op|1", "h6|C|P|op|1"]);
  });

  test("n bounds the sample; 0 turns it off; the default is 30", () => {
    expect(
      plan(report, { sample: 1 }).given.selected.filter((s) => s.group === "sample"),
    ).toHaveLength(1);
    expect(
      plan(report, { sample: 0 }).given.selected.filter((s) => s.group === "sample"),
    ).toHaveLength(0);
    expect(plan(report).given.sample).toBe(30);
  });

  test("the draw is deterministic, seeded by the input's sha256 unless a seed is given", () => {
    const a = plan(report, { sample: 1 });
    const b = plan(report, { sample: 1 });
    expect(a.given.selected).toEqual(b.given.selected);
    expect(a.given.seed).toBe(a.given.inputSha256);
    const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
    expect(drawSample(keys, 5, "s1")).toEqual(drawSample([...keys].reverse(), 5, "s1"));
    expect(drawSample(keys, 5, "s1")).not.toEqual(drawSample(keys, 5, "s2"));
    expect(new Set(drawSample(keys, 5, "s1")).size).toBe(5);
    expect(plan(report, { sample: 1, seed: "custom" }).given.seed).toBe("custom");
  });

  test("the note tests: isNotedSurvivor and isNotedNoCoverage read the start of failureNote and the verdict", () => {
    const base = { astHash: "h" } as MutantOutcome;
    expect(isNotedSurvivor({ ...base, verdict: "survived", failureNote: NOTE })).toBe(true);
    expect(isNotedSurvivor({ ...base, verdict: "killed", failureNote: NOTE })).toBe(false);
    expect(isNotedSurvivor({ ...base, verdict: "survived" })).toBe(false);
    expect(
      isNotedNoCoverage({
        ...base,
        verdict: "no-coverage",
        failureNote: `${V3_NOCOV_REFUSAL_LEAD}: x`,
      }),
    ).toBe(true);
    expect(
      isNotedNoCoverage({
        ...base,
        verdict: "survived",
        failureNote: `${V3_NOCOV_REFUSAL_LEAD}: x`,
      }),
    ).toBe(false);
  });

  test("R609's writer and this reader agree: unsupportedCoverageNote starts with the lead", () => {
    const note = unsupportedCoverageNote(["A.t"], new Map(), new Map(), new Set(["A.t"]));
    expect(note.startsWith(V3_NOCOV_REFUSAL_LEAD)).toBe(true);
    expect(isNotedNoCoverage({ verdict: "no-coverage", failureNote: note } as MutantOutcome)).toBe(
      true,
    );
    // a permissions refusal is not R609's note
    const other = unsupportedCoverageNote(["A.t"], new Map([["A.t", "no permission"]]));
    expect(isNotedNoCoverage({ verdict: "no-coverage", failureNote: other } as MutantOutcome)).toBe(
      false,
    );
  });

  test("refuses: nothing to confirm", () => {
    const none = v3Rows([{ verdict: "survived" }, { verdict: "killed" }]);
    expect(() => plan(none, { sample: 0 })).toThrow(ConfirmEmptySetError);
    // with a sample the same report has something to select
    expect(plan(none, { sample: 5 }).given.selected).toHaveLength(1);
  });

  test("refuses: the input is not a SessionReport", () => {
    for (const bad of [
      null,
      [],
      "x",
      {},
      { mutants: [] },
      { mutants: [], backend: "al-runner-v3" },
    ]) {
      expect(() => planConfirm({ ...basePlan(), input: bad })).toThrow(ConfirmInputNotReportError);
    }
  });

  test("refuses: the input's run was not al-runner-v3", () => {
    expect(() => plan({ ...report, backend: "bcdev" } as SessionReport)).toThrow(
      ConfirmInputNotV3Error,
    );
  });

  test("refuses: a partial input (quarantined, time budget, stranded)", () => {
    const partial = [
      { quarantined: { reason: "r" } },
      { timeBudget: { budgetSeconds: 1, unscheduledCount: 1, batchesNotStarted: 0 } },
    ];
    for (const p of partial) {
      expect(() => plan({ ...report, ...p } as unknown as SessionReport)).toThrow(
        ConfirmInputPartialError,
      );
    }
    const stranded = marked(report, (_m, i) =>
      i === 1 ? { verdict: "error", cause: "stranded" } : {},
    );
    expect(() => plan(stranded)).toThrow(ConfirmInputPartialError);
  });

  test("refuses: --skip-known-survivors, --resume and the recheck's exactSites", () => {
    expect(() => plan(report, { skipKnownSurvivors: true })).toThrow(
      ConfirmSkipKnownSurvivorsError,
    );
    expect(() => plan(report, { resume: true })).toThrow(ConfirmResumeError);
    expect(() => plan(report, { exactSites: true })).toThrow(ConfirmExactSitesError);
  });

  test("refuses: a key two rows of the input share", () => {
    const dup = v3Rows([
      { verdict: "survived", failureNote: NOTE },
      { verdict: "survived", failureNote: NOTE, astHash: "h0" },
    ]);
    expect(() => plan(dup)).toThrow(ConfirmDuplicateKeyError);
  });
});

function basePlan(): Parameters<typeof planConfirm>[0] {
  return {
    inputPath: "v3.json",
    input: null,
    inputSha256: "0".repeat(64),
    skipKnownSurvivors: false,
    resume: false,
    exactSites: false,
  };
}

// --------------------------------------------------------------------------------------------
// Scope comparison
// --------------------------------------------------------------------------------------------

describe("assertSameScope", () => {
  const base = scopeOfReport(v3Rows([{ verdict: "survived" }]));

  test("equal scopes pass, and order inside a list does not matter", () => {
    expect(() => assertSameScope(base, { ...base })).not.toThrow();
    expect(() =>
      assertSameScope({ ...base, only: ["a", "b"] }, { ...base, only: ["b", "a"] }),
    ).not.toThrow();
  });

  test("refuses a differing --only, --exclude, --operator, --lines or preprocessor symbol set", () => {
    for (const f of ["only", "exclude", "operators", "lines", "preprocessorSymbols"] as const) {
      expect(() => assertSameScope(base, { ...base, [f]: ["x"] }), f).toThrow(
        ConfirmFlagsMismatchError,
      );
    }
  });

  test("refuses a differing --tests-only or --exclude-test", () => {
    for (const f of ["testsOnly", "excludeTests"] as const) {
      expect(() => assertSameScope(base, { ...base, [f]: ["x"] }), f).toThrow(
        ConfirmSuiteMismatchError,
      );
    }
  });

  test("refuses a differing source sha, dependency sha or identity scheme, and an absent one", () => {
    expect(() => assertSameScope(base, { ...base, sourceSha256: "z" })).toThrow(
      ConfirmSourceMismatchError,
    );
    expect(() => assertSameScope(base, { ...base, dependencySourceSha256: "z" })).toThrow(
      ConfirmSourceMismatchError,
    );
    expect(() => assertSameScope(base, { ...base, identityScheme: 1 })).toThrow(
      ConfirmSourceMismatchError,
    );
    const unknown = { ...base, sourceSha256: undefined };
    expect(() => assertSameScope(unknown, unknown)).toThrow(ConfirmSourceMismatchError);
  });
});

// --------------------------------------------------------------------------------------------
// Narrowing (needs a real generated set)
// --------------------------------------------------------------------------------------------

describe("narrowToConfirmed: after numbering, over the full set", () => {
  test("keeps exactly the selected sites; the second twin (ordinal 1) is selected and joins", async () => {
    await withProject(async (projectDir) => {
      const set = await generateMutationSet(projectDir);
      const ordinals = identityOrdinalsOf(set);
      const tierOf = (n: string) => operatorTiers.get(n);
      // Every key of the full set, with its ordinal, from the numbering over the FULL set.
      const all = set.files.flatMap((f) => dedupeSpecs(f.specs, tierOf));
      expect(all.length).toBeGreaterThan(2);
      const twinKey = [...ordinals.values()].some((n) => n > 0);
      expect(twinKey).toBe(true);
      // Build the keys the same way a report row would carry them.
      const { identityEntriesOf } = await import("@lethal/schemata");
      const entries = set.files.flatMap((f) =>
        identityEntriesOf(f.path, f.source, dedupeSpecs(f.specs, tierOf)),
      );
      const keyOfEntry = (e: (typeof entries)[number]) => {
        const o =
          ordinals.get(identitySiteKey(e.file, e.startIndex, e.endIndex, e.operatorName)) ?? 0;
        return o > 0 ? `${e.tuple}|${o}` : e.tuple;
      };
      const second = entries.find(
        (e) =>
          (ordinals.get(identitySiteKey(e.file, e.startIndex, e.endIndex, e.operatorName)) ?? 0) ===
          1,
      );
      if (second === undefined) throw new Error("fixture has no second twin");
      const selected = [{ key: keyOfEntry(second), group: "noted" as const }];
      const r = narrowToConfirmed(set.files, ordinals, tierOf, selected);
      const kept = r.files.flatMap((f) => f.specs);
      expect(kept).toHaveLength(1);
      expect(r.excluded).toBe(all.length - 1);
      expect(kept[0]?.before.startIndex).toBe(second.startIndex);
    });
  });

  test("refuses a selected key that matches no site, naming it", async () => {
    await withProject(async (projectDir) => {
      const set = await generateMutationSet(projectDir);
      const err = (() => {
        try {
          narrowToConfirmed(set.files, identityOrdinalsOf(set), (n) => operatorTiers.get(n), [
            { key: "nope|C|P|op|1", group: "noted" },
          ]);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ConfirmKeyMatchError);
      expect((err as ConfirmKeyMatchError).unmatched).toEqual(["nope|C|P|op|1"]);
    });
  });

  test("refuses a selected key two sites share (ordinals that do not separate the twins)", async () => {
    await withProject(async (projectDir) => {
      const set = await generateMutationSet(projectDir);
      const real = identityOrdinalsOf(set);
      // The twins' ordinals flattened to 0, as a numbering over a filtered set could leave them.
      const flat = new Map([...real.keys()].map((k) => [k, 0] as const));
      const { identityEntriesOf } = await import("@lethal/schemata");
      const tierOf = (n: string) => operatorTiers.get(n);
      const entries = set.files.flatMap((f) =>
        identityEntriesOf(f.path, f.source, dedupeSpecs(f.specs, tierOf)),
      );
      const counts = new Map<string, number>();
      for (const e of entries) counts.set(e.tuple, (counts.get(e.tuple) ?? 0) + 1);
      const twin = [...counts].find(([, n]) => n > 1)?.[0];
      if (twin === undefined) throw new Error("fixture has no twins");
      const err = (() => {
        try {
          narrowToConfirmed(set.files, flat, tierOf, [{ key: twin, group: "noted" }]);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ConfirmKeyMatchError);
      expect((err as ConfirmKeyMatchError).ambiguous).toEqual([twin]);
    });
  });

  test("numberIdentityOrdinals over the filtered set would number the twin 0: the order matters", async () => {
    await withProject(async (projectDir) => {
      const set = await generateMutationSet(projectDir);
      const full = identityOrdinalsOf(set);
      const tierOf = (n: string) => operatorTiers.get(n);
      const { identityEntriesOf } = await import("@lethal/schemata");
      const entries = set.files.flatMap((f) =>
        identityEntriesOf(f.path, f.source, dedupeSpecs(f.specs, tierOf)),
      );
      const second = entries.find(
        (e) =>
          (full.get(identitySiteKey(e.file, e.startIndex, e.endIndex, e.operatorName)) ?? 0) === 1,
      );
      if (second === undefined) throw new Error("fixture has no second twin");
      const alone = numberIdentityOrdinals([second]);
      expect(
        alone.get(
          identitySiteKey(second.file, second.startIndex, second.endIndex, second.operatorName),
        ),
      ).toBe(0);
    });
  });
});

// --------------------------------------------------------------------------------------------
// The session: --confirm-from reaches the mutant set AND the report, and every refusal comes
// before any deploy
// --------------------------------------------------------------------------------------------

describe("runSession with --confirm-from", () => {
  test("deploys exactly the selected mutants and records the narrowing (events and report)", async () => {
    await withProject(async (projectDir, root) => {
      const { report: full } = await session(projectDir, root);
      expect(full.confirm).toBeUndefined();
      const v3 = marked(full, (_m, i) => (i % 3 === 0 ? { failureNote: NOTE } : {}));
      const noted = v3.mutants.filter((m) => m.failureNote === NOTE);
      expect(noted.length).toBeGreaterThan(1);
      const events: RunEvent[] = [];
      const r = await confirmRun(projectDir, root, v3, {}, { sample: 0 }, events);
      if (r.report === undefined) throw r.error;
      expect(r.report.mutants.map(keyOf).sort()).toEqual(noted.map(keyOf).sort());
      expect(r.report.confirm?.selected).toHaveLength(noted.length);
      expect(r.report.confirm?.excludedSiteCount).toBe(v3.mutants.length - noted.length);
      // the site totals add up
      expect(r.report.mutants.length + (r.report.confirm?.excludedSiteCount ?? 0)).toBe(
        v3.mutants.length,
      );
      expect(r.report.validity.caveats).toContain("narrowed");
      expect(r.report.validity.reliability).toBe("narrowed");
      // both carriages: the given half on run-configured, the learned half on mutation-set-generated
      const configured = events.find((e) => e.type === "run-configured");
      const generated = events.find((e) => e.type === "mutation-set-generated");
      expect(configured?.type === "run-configured" ? configured.confirm?.sample : undefined).toBe(
        0,
      );
      expect(
        generated?.type === "mutation-set-generated" ? generated.excludedByConfirm : undefined,
      ).toBe(v3.mutants.length - noted.length);
    });
  });

  test("twins: a sample that draws only the second twin (ordinal 1) joins and is not refused", async () => {
    await withProject(async (projectDir, root) => {
      const { report: full } = await session(projectDir, root);
      const second = full.mutants.find((m) => (m.identityOrdinal ?? 0) === 1);
      if (second === undefined) throw new Error("fixture has no second twin");
      const v3 = marked(full, (m) => (keyOf(m) === keyOf(second) ? { failureNote: NOTE } : {}));
      const r = await confirmRun(projectDir, root, v3);
      if (r.report === undefined) throw r.error;
      expect(r.report.mutants.map(keyOf)).toEqual([keyOf(second)]);
      expect(r.report.mutants[0]?.identityOrdinal).toBe(1);
    });
  });

  test("a report without --confirm-from has no confirm block and an unchanged mutant set", async () => {
    await withProject(async (projectDir, root) => {
      const a = await session(projectDir, root);
      const b = await session(projectDir, root);
      expect(a.report.confirm).toBeUndefined();
      expect(b.report.mutants.map(keyOf)).toEqual(a.report.mutants.map(keyOf));
      expect(a.report.validity.caveats).not.toContain("narrowed");
    });
  });

  describe("every refusal is made before any deploy", () => {
    async function refused(
      edit: (v3: SessionReport) => SessionReport,
      extra: Partial<SessionConfig> = {},
      confirm: { sample?: number } = { sample: 5 },
    ) {
      return withProject(async (projectDir, root) => {
        const { report: full } = await session(projectDir, root);
        const v3 = edit(marked(full, (_m, i) => (i === 0 ? { failureNote: NOTE } : {})));
        return confirmRun(projectDir, root, v3, extra, confirm);
      });
    }

    test("the input is not a SessionReport", async () => {
      await withProject(async (projectDir, root) => {
        const store = new ResultsStore(":memory:");
        const backend = new StubBackend();
        await expect(
          runSession({
            backend,
            store,
            projectDir,
            testDir: join(root, "tests"),
            instrumentedDir: join(root, "i"),
            selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
            confirm: { inputPath: "x.json", input: { nope: 1 }, inputSha256: "a".repeat(64) },
          }),
        ).rejects.toBeInstanceOf(ConfirmInputNotReportError);
        expect(backend.deploys).toBe(0);
        store.close();
      });
    });

    test("not al-runner-v3", async () => {
      const r = await refused((v3) => ({ ...v3, backend: "bcdev" }) as SessionReport);
      expect(r.error).toBeInstanceOf(ConfirmInputNotV3Error);
      expect(r.deploys).toBe(0);
    });

    test("partial input", async () => {
      const r = await refused((v3) => ({ ...v3, quarantined: { reason: "r" } }) as SessionReport);
      expect(r.error).toBeInstanceOf(ConfirmInputPartialError);
      expect(r.deploys).toBe(0);
    });

    test("nothing to confirm", async () => {
      await withProject(async (projectDir, root) => {
        const { report: full } = await session(projectDir, root);
        const r = await confirmRun(projectDir, root, full, {}, { sample: 0 });
        expect(r.error).toBeInstanceOf(ConfirmEmptySetError);
        expect(r.deploys).toBe(0);
      });
    });

    test("--skip-known-survivors", async () => {
      const r = await refused((v) => v, { skipKnownSurvivors: true });
      expect(r.error).toBeInstanceOf(ConfirmSkipKnownSurvivorsError);
      expect(r.deploys).toBe(0);
    });

    test("--resume", async () => {
      const r = await refused((v) => v, { resume: "last" });
      expect(r.error).toBeInstanceOf(ConfirmResumeError);
      expect(r.deploys).toBe(0);
    });

    test("exactSites", async () => {
      const r = await refused((v) => v, { exactSites: new Set(["x"]) });
      expect(r.error).toBeInstanceOf(ConfirmExactSitesError);
      expect(r.deploys).toBe(0);
    });

    test("a differing --only", async () => {
      const r = await refused((v) => v, { only: [FILE] });
      expect(r.error).toBeInstanceOf(ConfirmFlagsMismatchError);
      expect(r.deploys).toBe(0);
    });

    test("a differing preprocessor symbol set", async () => {
      const r = await refused((v) => v, { preprocessorSymbols: ["SYM"] });
      expect(r.error).toBeInstanceOf(ConfirmFlagsMismatchError);
      expect(r.deploys).toBe(0);
    });

    test("a differing --tests-only", async () => {
      const r = await refused((v) => v, { testsOnly: ["**"] });
      expect(r.error).toBeInstanceOf(ConfirmSuiteMismatchError);
      expect(r.deploys).toBe(0);
    });

    test("a differing source sha, dependency sha or identity scheme", async () => {
      for (const edit of [
        { sourceSha256: "e".repeat(64) },
        { dependencySourceSha256: "e".repeat(64) },
        { identityScheme: 1 },
      ]) {
        const r = await refused((v) => ({ ...v, ...edit }) as SessionReport);
        expect(r.error, JSON.stringify(edit)).toBeInstanceOf(ConfirmSourceMismatchError);
        expect(r.deploys).toBe(0);
      }
    });

    test("a selected key that matches no mutant of this run", async () => {
      const r = await refused((v) => ({
        ...v,
        mutants: v.mutants.map((m, i) => (i === 0 ? { ...m, astHash: "gone" } : m)),
      }));
      expect(r.error).toBeInstanceOf(ConfirmKeyMatchError);
      expect(r.deploys).toBe(0);
    });
  });
});

// --------------------------------------------------------------------------------------------
// The merge
// --------------------------------------------------------------------------------------------

const STUB_TEXT = "Error: RDLC report rendering is not implemented on Linux BC";

/** v3 rows, then a bc report holding the rows `bcRows` names (key index -> bc overrides). */
function pair(opts: {
  v3: ReadonlyArray<Row>;
  bc: Record<number, Row>;
  groups?: Record<number, "noted" | "nocov-noted" | "sample">;
  sample?: number;
  bcExtra?: Partial<SessionReport>;
}) {
  const v3 = v3Rows(opts.v3);
  const v3Sha = "a".repeat(64);
  const selected = Object.keys(opts.bc)
    .map(Number)
    .map((i) => ({
      key: keyOf(v3.mutants[i] as MutantOutcome),
      group: opts.groups?.[i] ?? ("noted" as const),
    }));
  const bc = {
    ...v3Rows(
      Object.entries(opts.bc).map(([i, o]) => ({ ...(v3.mutants[Number(i)] as object), ...o })),
    ),
    confirm: {
      inputPath: "v3.json",
      inputSha256: v3Sha,
      sample: opts.sample ?? 0,
      seed: "seed",
      selected,
      excludedSiteCount: 0,
    },
    ...opts.bcExtra,
  } as unknown as SessionReport;
  // v3Rows renumbers; restore each bc row's own identity from the v3 row it answers.
  const bcRows = Object.keys(opts.bc).map(Number);
  (bc as unknown as { mutants: MutantOutcome[] }).mutants = bcRows.map(
    (i) => ({ ...(v3.mutants[i] as MutantOutcome), ...opts.bc[i] }) as MutantOutcome,
  );
  return { v3, bc, v3Sha };
}

function merge(p: ReturnType<typeof pair>) {
  return mergeConfirmation({ v3: p.v3, v3Sha256: p.v3Sha, bc: p.bc });
}

describe("mergeConfirmation: the final-verdict rule", () => {
  const p = pair({
    v3: [
      { verdict: "survived", failureNote: NOTE }, // 0 -> BC kills
      { verdict: "survived", failureNote: NOTE }, // 1 -> BC survives
      { verdict: "survived", failureNote: NOTE }, // 2 -> BC error
      { verdict: "survived" }, // 3 unconfirmed
      { verdict: "killed" }, // 4 v3 kill, not re-checked
      { verdict: "survived", failureNote: NOTE }, // 5 -> BC kills on the RDLC stub
      { verdict: "no-coverage", failureNote: `${V3_NOCOV_REFUSAL_LEAD}: x` }, // 6 -> BC survives
    ],
    bc: {
      0: { verdict: "killed", killingTest: "T.A", killingTestFailure: "Assert failed" },
      1: { verdict: "survived" },
      2: { verdict: "error", failureNote: "TestPage unsupported" },
      5: { verdict: "killed", killingTest: "T.B", killingTestFailure: STUB_TEXT },
      6: { verdict: "survived" },
    },
    groups: { 6: "nocov-noted" },
  });
  const c = merge(p);
  const row = (i: number) => c.mutants[i] as (typeof c.mutants)[number];

  test("every v3 mutant has a row", () => {
    expect(c.kind).toBe("lethal-confirmation");
    expect(c.confirmationVersion).toBe(CONFIRMATION_VERSION);
    expect(c.mutants).toHaveLength(7);
  });

  test("a confirmed mutant takes BC's verdict, measured by bcdev", () => {
    expect(row(0)).toMatchObject({
      v3Verdict: "survived",
      bcVerdict: "killed",
      finalVerdict: "killed",
      measuredBy: "bcdev",
      group: "noted",
      killingTest: "T.A",
      flags: [],
    });
    expect(row(1)).toMatchObject({
      bcVerdict: "survived",
      finalVerdict: "survived",
      measuredBy: "bcdev",
    });
    expect(row(6)).toMatchObject({
      group: "nocov-noted",
      v3Verdict: "no-coverage",
      finalVerdict: "survived",
      measuredBy: "bcdev",
    });
  });

  test("every other mutant keeps v3's verdict, measured by al-runner-v3, group unconfirmed", () => {
    expect(row(3)).toMatchObject({
      group: "unconfirmed",
      finalVerdict: "survived",
      measuredBy: "al-runner-v3",
      flags: [],
    });
    expect(row(3).bcVerdict).toBeUndefined();
    expect(row(4)).toMatchObject({ finalVerdict: "killed", measuredBy: "al-runner-v3" });
  });

  test("a BC error does not override v3: v3's verdict, flag bc-error, BC's note kept", () => {
    expect(row(2)).toMatchObject({
      bcVerdict: "error",
      finalVerdict: "survived",
      measuredBy: "al-runner-v3",
      flags: ["bc-error"],
      note: "TestPage unsupported",
    });
  });

  test("an R1121 stub kill keeps BC's killed, is flagged, counted apart and left out of the kill list", () => {
    expect(row(5)).toMatchObject({
      finalVerdict: "killed",
      measuredBy: "bcdev",
      flags: ["linux-rdlc-stub"],
    });
    expect(c.totals.bcStubKills).toBe(1);
    const lines = renderConfirmation(c);
    expect(lines.some((l) => l.includes("confirmed kill") && l.includes("T.A"))).toBe(true);
    expect(lines.some((l) => l.includes("T.B"))).toBe(false);
    expect(lines.some((l) => l.includes("of which 1 are R1121 platform-stub kills"))).toBe(true);
  });

  test("totals equal the per-mutant rows, with a provenance line beside the score", () => {
    const count = (f: (m: (typeof c.mutants)[number]) => boolean) => c.mutants.filter(f).length;
    expect(c.totals.byFinalVerdict).toEqual({ killed: 3, survived: 4 });
    expect(c.totals.byFinalVerdict.killed).toBe(count((m) => m.finalVerdict === "killed"));
    expect(c.totals.byMeasuredBy).toEqual({ bcdev: 4, "al-runner-v3": 3 });
    expect(c.totals.byMeasuredBy.bcdev).toBe(count((m) => m.measuredBy === "bcdev"));
    expect(c.totals.score).toBeCloseTo(3 / 7);
    // survivors: rows 1, 2, 3, 6 -> 4; measured on BC: 1 and 6
    expect(c.totals.provenance).toBe("4 survivors, 2 of them measured on BC");
    expect(renderConfirmation(c).some((l) => l.includes(c.totals.provenance))).toBe(true);
  });

  test("a v3 kill BC errored on is flagged v3-kill-unconfirmed and keeps v3's kill", () => {
    const q = pair({
      v3: [{ verdict: "killed" }, { verdict: "survived", failureNote: NOTE }],
      bc: { 0: { verdict: "error" }, 1: { verdict: "survived" } },
    });
    const r = merge(q);
    expect(r.mutants[0]).toMatchObject({
      finalVerdict: "killed",
      measuredBy: "al-runner-v3",
      flags: ["bc-error", "v3-kill-unconfirmed"],
    });
  });
});

describe("mergeConfirmation: the sample and its stop rule", () => {
  const unnoted = (n: number): Row[] =>
    Array.from({ length: n }, () => ({ verdict: "survived" as const }));
  const sampled = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, "sample" as const]));
  const bcSurvived = (n: number): Record<number, Row> =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [i + 1, { verdict: "survived" as const }]),
    );

  test("a sampled unnoted survivor killed on BC prints unnoted-disagreement with its key", () => {
    const p = pair({
      v3: [{ verdict: "survived", failureNote: NOTE }, ...unnoted(5)],
      bc: {
        0: { verdict: "survived" },
        ...bcSurvived(2),
        2: { verdict: "killed", killingTest: "T.K", killingTestFailure: "Assert" },
      },
      groups: { 1: "sample", 2: "sample" },
      sample: 2,
    });
    const c = merge(p);
    expect(c.sample.verdict).toBe("disagreement");
    expect(c.sample.killedOnBc).toBe(1);
    expect(c.sample.disagreementKeys).toEqual([keyOf(p.v3.mutants[2] as MutantOutcome)]);
    expect(c.sample.upperBound95).toBeNull();
    expect(renderConfirmation(c).some((l) => l.startsWith("unnoted-disagreement"))).toBe(true);
  });

  test("the same kill on the RDLC stub does NOT fire the stop rule", () => {
    const p = pair({
      v3: [{ verdict: "survived", failureNote: NOTE }, ...unnoted(5)],
      bc: {
        0: { verdict: "survived" },
        1: { verdict: "killed", killingTest: "T.K", killingTestFailure: STUB_TEXT },
        2: { verdict: "survived" },
      },
      groups: { 1: "sample", 2: "sample" },
      sample: 2,
    });
    const c = merge(p);
    expect(c.sample.verdict).toBe("agreement");
    expect(c.sample.killedOnBc).toBe(0);
    expect(c.sample.stubKilledOnBc).toBe(1);
    expect(c.sample.disagreementKeys).toEqual([]);
    expect(renderConfirmation(c).some((l) => l.startsWith("unnoted-disagreement"))).toBe(false);
  });

  test("the bound (3 / n) is printed only when the sample is smaller than the unnoted set", () => {
    const small = merge(
      pair({
        v3: [{ verdict: "survived", failureNote: NOTE }, ...unnoted(9)],
        bc: { 0: { verdict: "survived" }, ...bcSurvived(3) },
        groups: sampled(3),
        sample: 3,
      }),
    );
    expect(small.sample).toMatchObject({
      measured: 3,
      unnotedSurvivors: 9,
      allMeasured: false,
      upperBound95: 1,
    });
    expect(renderConfirmation(small).some((l) => l.includes("upper bound"))).toBe(true);
    const all = merge(
      pair({
        v3: [{ verdict: "survived", failureNote: NOTE }, ...unnoted(3)],
        bc: { 0: { verdict: "survived" }, ...bcSurvived(3) },
        groups: sampled(3),
        sample: 3,
      }),
    );
    expect(all.sample).toMatchObject({
      measured: 3,
      unnotedSurvivors: 3,
      allMeasured: true,
      upperBound95: null,
    });
    const lines = renderConfirmation(all);
    expect(lines.some((l) => l.includes("all unnoted survivors measured"))).toBe(true);
    expect(lines.some((l) => l.includes("upper bound"))).toBe(false);
  });

  test("a BC error in the sample is not a measurement, and a sample of 0 says none", () => {
    const c = merge(
      pair({
        v3: [{ verdict: "survived", failureNote: NOTE }, ...unnoted(4)],
        bc: { 0: { verdict: "survived" }, 1: { verdict: "error" }, 2: { verdict: "survived" } },
        groups: sampled(2),
        sample: 2,
      }),
    );
    expect(c.sample.measured).toBe(1);
    const none = merge(
      pair({
        v3: [{ verdict: "survived", failureNote: NOTE }],
        bc: { 0: { verdict: "survived" } },
      }),
    );
    expect(none.sample.verdict).toBe("none");
  });
});

describe("mergeConfirmation: every join refusal is made by name", () => {
  const ok = () =>
    pair({
      v3: [{ verdict: "survived", failureNote: NOTE }, { verdict: "survived" }],
      bc: { 0: { verdict: "survived" } },
    });

  test("the happy pair merges", () => {
    expect(() => merge(ok())).not.toThrow();
  });

  test("bc.json was not made with --confirm-from", () => {
    const p = ok();
    const { confirm: _c, ...rest } = p.bc;
    expect(() => merge({ ...p, bc: rest as SessionReport })).toThrow(
      ConfirmMergeNotConfirmRunError,
    );
  });

  test("bc.json's recorded input sha256 is not v3.json's", () => {
    const p = ok();
    expect(() => merge({ ...p, v3Sha: "b".repeat(64) })).toThrow(ConfirmMergeInputShaError);
  });

  test("bc.json is a partial run", () => {
    const p = ok();
    for (const extra of [{ quarantined: { reason: "r" } }, { timeBudget: { budgetSeconds: 1 } }]) {
      expect(() => merge({ ...p, bc: { ...p.bc, ...extra } as unknown as SessionReport })).toThrow(
        ConfirmMergeBcPartialError,
      );
    }
    const stranded = {
      ...p.bc,
      mutants: p.bc.mutants.map((m) => ({ ...m, cause: "stranded" })),
    } as SessionReport;
    expect(() => merge({ ...p, bc: stranded })).toThrow(ConfirmMergeBcPartialError);
  });

  test("a selected key is missing from bc.json", () => {
    const p = ok();
    expect(() => merge({ ...p, bc: { ...p.bc, mutants: [] } as SessionReport })).toThrow(
      ConfirmMergeMissingKeyError,
    );
  });

  test("bc.json holds a key that was not selected", () => {
    const p = ok();
    const extra = { ...(p.v3.mutants[1] as MutantOutcome), verdict: "survived" };
    expect(() =>
      merge({ ...p, bc: { ...p.bc, mutants: [...p.bc.mutants, extra] } as SessionReport }),
    ).toThrow(ConfirmMergeUnselectedKeyError);
  });

  test("a selected key is not in v3.json", () => {
    const p = ok();
    const bc = {
      ...p.bc,
      confirm: {
        ...p.bc.confirm,
        selected: [...(p.bc.confirm?.selected ?? []), { key: "ghost", group: "noted" }],
      },
    } as SessionReport;
    expect(() => merge({ ...p, bc })).toThrow(ConfirmMergeSelectedNotInV3Error);
  });

  test("a bc row is a known-survivor, which is not a measurement", () => {
    const p = ok();
    const bc = {
      ...p.bc,
      mutants: p.bc.mutants.map((m) => ({ ...m, verdict: "known-survivor" })),
    } as SessionReport;
    expect(() => merge({ ...p, bc })).toThrow(ConfirmMergeBcRowNotMeasuredError);
  });

  test("a key two rows of v3.json or of bc.json share", () => {
    const p = ok();
    const dupV3 = {
      ...p.v3,
      mutants: [...p.v3.mutants, p.v3.mutants[0] as MutantOutcome],
    } as SessionReport;
    expect(() => merge({ ...p, v3: dupV3 })).toThrow(ConfirmDuplicateKeyError);
    const dupBc = {
      ...p.bc,
      mutants: [...p.bc.mutants, p.bc.mutants[0] as MutantOutcome],
    } as SessionReport;
    expect(() => merge({ ...p, bc: dupBc })).toThrow(ConfirmDuplicateKeyError);
  });

  test("v3.json is not a v3 report, or is partial", () => {
    const p = ok();
    expect(() => merge({ ...p, v3: { ...p.v3, backend: "bcdev" } as SessionReport })).toThrow(
      ConfirmInputNotV3Error,
    );
    expect(() =>
      merge({ ...p, v3: { ...p.v3, quarantined: { reason: "r" } } as unknown as SessionReport }),
    ).toThrow(ConfirmInputPartialError);
    expect(() => merge({ ...p, v3: { nope: 1 } as unknown as SessionReport })).toThrow(
      ConfirmInputNotReportError,
    );
  });

  test("the two runs differ in scope or source (the same checks the confirm run makes)", () => {
    const p = ok();
    const bcWith = (extra: object) => ({ ...p.bc, ...extra }) as unknown as SessionReport;
    expect(() =>
      merge({ ...p, bc: bcWith({ only: { patterns: ["x"], excludedFileCount: 1 } }) }),
    ).toThrow(ConfirmFlagsMismatchError);
    expect(() => merge({ ...p, bc: bcWith({ testsOnly: ["x"] }) })).toThrow(
      ConfirmSuiteMismatchError,
    );
    expect(() => merge({ ...p, bc: bcWith({ sourceSha256: "q" }) })).toThrow(
      ConfirmSourceMismatchError,
    );
  });
});

// --------------------------------------------------------------------------------------------
// The CLI
// --------------------------------------------------------------------------------------------

describe("the CLI", () => {
  const base = ["run", "--project", "p", "--tests", "t", "--backend", "bcdev"];

  test("--confirm-from, --confirm-sample and --confirm-seed parse; absent they leave no key", () => {
    const cfg = parseCliConfig([
      ...base,
      "--confirm-from",
      "v3.json",
      "--confirm-sample",
      "5",
      "--confirm-seed",
      "s",
    ]);
    expect(cfg).toMatchObject({ confirm: { path: "v3.json", sample: 5, seed: "s" } });
    expect("confirm" in parseCliConfig(base)).toBe(false);
    expect(
      parseCliConfig([...base, "--confirm-from", "v3.json", "--confirm-sample", "0"]),
    ).toMatchObject({ confirm: { sample: 0 } });
  });

  test("the sample and seed need --confirm-from; the sample is a whole number of 0 or more", () => {
    expect(() => parseCliConfig([...base, "--confirm-sample", "5"])).toThrow(
      "--confirm-sample needs --confirm-from",
    );
    expect(() => parseCliConfig([...base, "--confirm-seed", "s"])).toThrow(
      "--confirm-seed needs --confirm-from",
    );
    for (const bad of ["-1", "2.5", "x"]) {
      expect(() =>
        parseCliConfig([...base, "--confirm-from", "v3.json", `--confirm-sample=${bad}`]),
      ).toThrow("--confirm-sample must be");
    }
    expect(() => parseCliConfig([...base, "--confirm-from", ""])).toThrow("--confirm-from needs");
  });

  test("--dry-run refuses --confirm-from by name", () => {
    expect(() =>
      parseCliConfig(["run", "--project", "p", "--dry-run", "--confirm-from", "v3.json"]),
    ).toThrow("--confirm-from has no effect with --dry-run");
  });

  test("confirm-merge takes exactly two reports and --out; other flags are refused", () => {
    expect(parseCliConfig(["confirm-merge", "a.json", "b.json", "--out", "c.json"])).toEqual({
      mode: "confirm-merge",
      v3Path: "a.json",
      bcPath: "b.json",
      outPath: "c.json",
    });
    expect(() => parseCliConfig(["confirm-merge", "a.json", "--out", "c.json"])).toThrow(
      "missing required <v3.json> <bc.json>",
    );
    expect(() =>
      parseCliConfig(["confirm-merge", "a.json", "b.json", "x.json", "--out", "c.json"]),
    ).toThrow("exactly two reports");
    expect(() => parseCliConfig(["confirm-merge", "a.json", "b.json"])).toThrow("--out");
    expect(() =>
      parseCliConfig(["confirm-merge", "a.json", "b.json", "--out", "c", "--project", "p"]),
    ).toThrow("only accepted by");
    expect(() => parseCliConfig([...base, "--confirm-from", "v", "--out", "o"])).not.toThrow();
  });

  test("confirmMergeFromCli writes the artifact; a refused join writes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-confirm-cli-"));
    try {
      const p = pair({
        v3: [{ verdict: "survived", failureNote: NOTE }, { verdict: "survived" }],
        bc: { 0: { verdict: "killed", killingTest: "T.A", killingTestFailure: "Assert" } },
      });
      const v3Text = JSON.stringify(p.v3);
      const bc = { ...p.bc, confirm: { ...p.bc.confirm, inputSha256: sha256Hex(v3Text) } };
      await writeFile(join(root, "v3.json"), v3Text);
      await writeFile(join(root, "bc.json"), JSON.stringify(bc));
      const out = join(root, "c.json");
      expect(
        await confirmMergeFromCli({
          mode: "confirm-merge",
          v3Path: join(root, "v3.json"),
          bcPath: join(root, "bc.json"),
          outPath: out,
        }),
      ).toBe(0);
      const written = JSON.parse(await readFile(out, "utf8"));
      expect(written.kind).toBe("lethal-confirmation");
      expect(written.v3Sha256).toBe(sha256Hex(v3Text));
      // the sha no longer matches: refused, and no file
      const bad = join(root, "bad.json");
      await writeFile(join(root, "v3b.json"), `${v3Text} `);
      await expect(
        confirmMergeFromCli({
          mode: "confirm-merge",
          v3Path: join(root, "v3b.json"),
          bcPath: join(root, "bc.json"),
          outPath: bad,
        }),
      ).rejects.toBeInstanceOf(ConfirmMergeInputShaError);
      expect(await Bun.file(bad).exists()).toBe(false);
      // not JSON
      await writeFile(join(root, "junk.json"), "{");
      await expect(
        confirmMergeFromCli({
          mode: "confirm-merge",
          v3Path: join(root, "junk.json"),
          bcPath: join(root, "bc.json"),
          outPath: bad,
        }),
      ).rejects.toBeInstanceOf(ConfirmInputNotReportError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------------------------
// The published schemas
// --------------------------------------------------------------------------------------------

describe("schemas: the optional confirm block and the confirmation artifact", () => {
  const schemaDir = join(import.meta.dir, "..", "..", "..", "schemas");
  const load = (name: string) => JSON.parse(readFileSync(join(schemaDir, name), "utf8"));

  test("a merge output validates against confirmation-v1, and a damaged one does not", () => {
    const schema = load("confirmation-v1.schema.json");
    const c = merge(
      pair({
        v3: [{ verdict: "survived", failureNote: NOTE }, { verdict: "survived" }],
        bc: { 0: { verdict: "killed", killingTest: "T.A", killingTestFailure: "Assert" } },
      }),
    );
    const doc = JSON.parse(JSON.stringify(c));
    expect(conformsTo(schema, doc)).toEqual([]);
    expect(conformsTo(schema, { ...doc, kind: "other" })).not.toEqual([]);
    expect(conformsTo(schema, { ...doc, extra: 1 })).not.toEqual([]);
    const { totals: _t, ...noTotals } = doc;
    expect(conformsTo(schema, noTotals)).not.toEqual([]);
  });

  test("a report with no confirm block still validates, and one with it validates too", async () => {
    const schema = load(`report-v${REPORT_SCHEMA_VERSION}.schema.json`);
    await withProject(async (projectDir, root) => {
      const { report: full } = await session(projectDir, root);
      expect(conformsTo(schema, JSON.parse(JSON.stringify(full)))).toEqual([]);
      const v3 = marked(full, (_m, i) => (i === 0 ? { failureNote: NOTE } : {}));
      const r = await confirmRun(projectDir, root, v3);
      if (r.report === undefined) throw r.error;
      const doc = JSON.parse(JSON.stringify(r.report));
      expect(doc.confirm).toBeDefined();
      expect(conformsTo(schema, doc)).toEqual([]);
      expect(conformsTo(schema, { ...doc, confirm: { ...doc.confirm, seed: 5 } })).not.toEqual([]);
    });
  });
});
