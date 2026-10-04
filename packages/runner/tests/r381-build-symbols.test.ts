import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { type SessionConfig, runSession } from "../src/orchestrator";
import {
  AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0,
  type AlRunnerPredefinedProbe,
  effectiveBuildSymbols,
} from "../src/preprocessor-symbols";
import { type SessionReport, collapseNumberedRuns, renderConsole } from "../src/report";
import { ResultsStore } from "../src/store";

/**
 * R-381: `SessionReport.buildSymbols` is the target's EFFECTIVE build symbols (app.json, config and
 * on al-runner its predefined ones). Written on every new report, `[]` included.
 */

// Line 6 sits in the `#if not CLEANSCHEMA25` arm, line 11 in `#if CLEANSCHEMA26`, which no
// build here defines: a `compiled-out` row exists on both backends.
const SOURCE = `codeunit 50013 "CS Probe"
{
    procedure Run(X: Integer)
    begin
#if not CLEANSCHEMA25
        Helper(X);
#else
        Helper(X + 1);
#endif
#if CLEANSCHEMA26
        Helper(X - 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;

const TEST_AL = `codeunit 50140 "CS Tests"
{
    Subtype = Test;

    [Test]
    procedure RunTest()
    begin
    end;
}
`;

// Written out, NOT computed: the store row and effectiveBuildSymbols share a source, so the three
// could agree while all being wrong. Lexical order, as `effectiveBuildSymbols` sorts.
const CLEANSCHEMA_LITERAL = [
  "CLEANSCHEMA1",
  "CLEANSCHEMA10",
  "CLEANSCHEMA11",
  "CLEANSCHEMA12",
  "CLEANSCHEMA13",
  "CLEANSCHEMA14",
  "CLEANSCHEMA15",
  "CLEANSCHEMA16",
  "CLEANSCHEMA17",
  "CLEANSCHEMA18",
  "CLEANSCHEMA19",
  "CLEANSCHEMA2",
  "CLEANSCHEMA20",
  "CLEANSCHEMA21",
  "CLEANSCHEMA22",
  "CLEANSCHEMA23",
  "CLEANSCHEMA24",
  "CLEANSCHEMA25",
  "CLEANSCHEMA3",
  "CLEANSCHEMA4",
  "CLEANSCHEMA5",
  "CLEANSCHEMA6",
  "CLEANSCHEMA7",
  "CLEANSCHEMA8",
  "CLEANSCHEMA9",
];

class StubBackend implements ExecutionBackend {
  private active: string | null = null;
  constructor(private readonly authoritative: boolean) {}
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      authoritative: this.authoritative,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async measurePredefinedSymbols(): Promise<AlRunnerPredefinedProbe> {
    return { symbols: [...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort() };
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
              entries: [{ objectType: "Codeunit", objectId: 50013, procedure: "Run" }],
            },
          }
        : { attestation: { observedAny: true, identityMismatch: false } }),
    };
  }
}

beforeAll(async () => {
  await initParser();
});

async function withProject<T>(
  appSymbols: readonly string[] | undefined,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r381-"));
  try {
    await Bun.write(
      join(root, "app", "app.json"),
      JSON.stringify({
        id: "11111111-2222-3333-4444-555555555555",
        name: "p",
        publisher: "x",
        version: "1.0.0.0",
        ...(appSymbols !== undefined ? { preprocessorSymbols: appSymbols } : {}),
      }),
    );
    await Bun.write(join(root, "app", "src", "Probe.Codeunit.al"), SOURCE);
    await Bun.write(join(root, "tests", "CsTests.Codeunit.al"), TEST_AL);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const session = (
  root: string,
  store: ResultsStore,
  authoritative: boolean,
  extra: Partial<SessionConfig> = {},
) =>
  runSession({
    backend: new StubBackend(authoritative),
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, authoritative ? "instr-bc" : "instr-ar"),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    ...extra,
  });

/** The report, the store row and `effectiveBuildSymbols` all name the same set. */
async function agree(
  root: string,
  authoritative: boolean,
  config: readonly string[],
): Promise<SessionReport> {
  const store = new ResultsStore(":memory:");
  const report = await session(root, store, authoritative, {
    ...(config.length > 0 ? { preprocessorSymbols: [...config] } : {}),
  });
  const row = store.getRun(1);
  const expected = await effectiveBuildSymbols(
    join(root, "app"),
    config,
    undefined,
    authoritative
      ? { kind: "bcdev" }
      : {
          kind: "al-runner",
          predefined: { symbols: [...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort() },
        },
  );
  expect(report.buildSymbols).toEqual([...expected]);
  expect(report.buildSymbols).toEqual(row?.buildSymbols ?? undefined);
  store.close();
  return report;
}

describe("R-381: report.buildSymbols equals the effective set", () => {
  test("config only", async () => {
    await withProject(undefined, async (root) => {
      const r = await agree(root, true, ["CFG"]);
      expect(r.buildSymbols).toEqual(["CFG"]);
      expect(r.preprocessorSymbols).toEqual(["CFG"]);
    });
  }, 60_000);

  test("target app.json only: the config set stays empty, the build set does not", async () => {
    await withProject(["APPSYM"], async (root) => {
      const r = await agree(root, true, []);
      expect(r.buildSymbols).toEqual(["APPSYM"]);
      expect(r.preprocessorSymbols).toEqual([]);
    });
  }, 60_000);

  test("app.json and config", async () => {
    await withProject(["APPSYM"], async (root) => {
      const r = await agree(root, true, ["CFG"]);
      expect(r.buildSymbols).toEqual(["APPSYM", "CFG"]);
    });
  }, 60_000);

  test("al-runner: its predefined symbols are included", async () => {
    await withProject(undefined, async (root) => {
      const r = await agree(root, false, []);
      expect(r.buildSymbols).toEqual(CLEANSCHEMA_LITERAL);
      expect(r.preprocessorSymbols).toEqual([]);
    });
  }, 60_000);

  test("no symbols at all: [] is PRESENT, not absent", async () => {
    await withProject(undefined, async (root) => {
      const r = await agree(root, true, []);
      expect(r.buildSymbols).toEqual([]);
      expect("buildSymbols" in r).toBe(true);
      expect(JSON.parse(JSON.stringify(r)).buildSymbols).toEqual([]);
    });
  }, 60_000);

  test("the compiled-out row names the same set as the report", async () => {
    await withProject(["APPSYM"], async (root) => {
      const r = await agree(root, true, ["CFG"]);
      const out = (r.excludedSites?.files ?? []).find((f) => f.reason === "compiled-out");
      expect(out?.detail).toBe(`symbols: ${(r.buildSymbols ?? []).join(", ")}`);
    });
  }, 60_000);

  test("a resumed run's report carries the same buildSymbols as the original's", async () => {
    await withProject(["APPSYM"], async (root) => {
      const store = new ResultsStore(":memory:");
      const first = await session(root, store, true, { preprocessorSymbols: ["CFG"] });
      const resumed = await session(root, store, true, {
        preprocessorSymbols: ["CFG"],
        resume: 1,
      });
      expect(resumed.resumedFrom?.runId).toBe(1);
      expect(first.buildSymbols).toEqual(["APPSYM", "CFG"]);
      expect(resumed.buildSymbols).toEqual(first.buildSymbols);
      store.close();
    });
  }, 60_000);
});

describe("R-381: the console banner", () => {
  const base = async (): Promise<SessionReport> => {
    let report: SessionReport | undefined;
    await withProject(undefined, async (root) => {
      report = await session(root, new ResultsStore(":memory:"), true);
    });
    if (report === undefined) throw new Error("no report");
    return report;
  };
  const BANNER = /^build symbols beyond config: \[(.*)\]$/m;
  const bannerOf = (r: SessionReport): string | undefined => BANNER.exec(renderConsole(r))?.[1];

  test("printed when app.json adds a symbol, with no per-symbol source", async () => {
    const r = await base();
    expect(bannerOf({ ...r, preprocessorSymbols: ["CFG"], buildSymbols: ["APPSYM", "CFG"] })).toBe(
      "APPSYM",
    );
  });

  test("al-runner: CLEANSCHEMA1..25 collapse into one name", async () => {
    const r = await base();
    expect(bannerOf({ ...r, buildSymbols: CLEANSCHEMA_LITERAL })).toBe("CLEANSCHEMA1..25");
  });

  test("ANY run of consecutive names collapses, not only 1..25 (R392's probe can measure more)", async () => {
    const r = await base();
    const to40 = Array.from({ length: 40 }, (_, i) => `CLEANSCHEMA${i + 1}`).sort();
    expect(bannerOf({ ...r, buildSymbols: to40 })).toBe("CLEANSCHEMA1..40");
    const range = Array.from({ length: 15 }, (_, i) => `CLEANSCHEMA${i + 26}`).sort();
    expect(bannerOf({ ...r, buildSymbols: range })).toBe("CLEANSCHEMA26..40");
  });

  test("a bare CLEANSCHEMA and a gap are kept apart from the run", async () => {
    const r = await base();
    const run = Array.from({ length: 25 }, (_, i) => `CLEANSCHEMA${i + 1}`);
    expect(
      bannerOf({ ...r, buildSymbols: [...run, "CLEANSCHEMA", "CLEANSCHEMA30", "ZED"].sort() }),
    ).toBe("CLEANSCHEMA, CLEANSCHEMA1..25, CLEANSCHEMA30, ZED");
  });

  // R-381 review: digits with a leading zero are not the same name as their number. `A01` read as 1
  // used to swallow `A2` and `A3` into a run keyed `A1`, which is not in the list, so both vanished.
  test("a leading zero is not a number in a run: nothing is dropped", () => {
    expect(collapseNumberedRuns(["A01", "A2", "A3"])).toEqual(["A01", "A2", "A3"]);
    expect(collapseNumberedRuns(["A007", "A8", "A9"])).toEqual(["A007", "A8", "A9"]);
    expect(collapseNumberedRuns(["A01", "A1", "A2", "A3"])).toEqual(["A01", "A1..3"]);
    expect(collapseNumberedRuns(["A0", "A1", "A2"])).toEqual(["A0..2"]);
  });

  test("every input name survives in the banner list, collapsed or not (property)", () => {
    // Deterministic pseudo-random lists over a few families and digit strings, leading zeros included.
    let seed = 381;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const families = ["A", "CLEANSCHEMA", "X_", "B2B"];
    const digits = ["", "0", "1", "2", "3", "4", "01", "02", "007", "10", "11", "12", "40"];
    for (let round = 0; round < 500; round++) {
      const names = new Set<string>();
      const size = 1 + next(12);
      for (let k = 0; k < size; k++) {
        names.add(`${families[next(families.length)]}${digits[next(digits.length)]}`);
      }
      const input = [...names].sort();
      const out = collapseNumberedRuns(input);
      const covered = (name: string): boolean =>
        out.some((o) => {
          if (o === name) return true;
          const range = /^(.*?[^0-9])([0-9]+)\.\.([0-9]+)$/.exec(o);
          const own = /^(.*?[^0-9])([0-9]+)$/.exec(name);
          if (range === null || own === null) return false;
          const [, fam, lo, hi] = range;
          const [, nameFam, n] = own;
          return (
            fam === nameFam &&
            n === String(Number(n)) &&
            Number(n) >= Number(lo) &&
            Number(n) <= Number(hi)
          );
        });
      for (const name of input) {
        if (!covered(name))
          throw new Error(`lost ${name}: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
      }
    }
  });

  test("absent when the effective set equals the config set", async () => {
    const r = await base();
    expect(renderConsole({ ...r, preprocessorSymbols: ["A"], buildSymbols: ["A"] })).not.toContain(
      "build symbols beyond config",
    );
    expect(renderConsole({ ...r, preprocessorSymbols: [], buildSymbols: [] })).not.toContain(
      "build symbols beyond config",
    );
  });

  test("absent on a report from before R-381 (no field)", async () => {
    const { buildSymbols: _drop, ...older } = await base();
    expect(renderConsole(older)).not.toContain("build symbols beyond config");
  });
});
