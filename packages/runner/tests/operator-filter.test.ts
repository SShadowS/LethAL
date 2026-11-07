import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownTimeout } from "@lethal/engine/own-timeout";
import { dedupeSpecs } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { parseCliConfig, runFromCli } from "../src/cli";
import type { RunEvent, RunEventInput } from "../src/events";
import {
  admittedOperatorNames,
  generateMutationSet,
  operatorTiers,
  resolveOperatorNames,
  runSession,
} from "../src/orchestrator";
import { buildReport, renderConsole } from "../src/report";
import type { FoldStatics } from "../src/report-fold";
import { ResultsStore } from "../src/store";
import { removeRunScratchAfterAll } from "./helpers/scratch";

removeRunScratchAfterAll();

/**
 * R127. `--operator <name>` narrows which OPERATORS contribute mutants, so a question about one
 * kind of change does not have to buy every other operator's sites in the same files.
 *
 * The measured cost of not having it: R85's first rung deployed 894 mutants to score 3 argument
 * swaps, because the only scope knob was a file glob and asking for the files that hold swap sites
 * also buys every `empty-block` and `void-method-call` site in them.
 *
 * Two properties are load-bearing and each has its own describe below:
 *   - it cannot change a VERDICT, which is why the filter runs AFTER per-file dedup;
 *   - it cannot silently select nothing, which is why an unknown name and a barren registered name
 *     both throw.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 79300, to: 79399 }],
});

/**
 * Four statements chosen so three of them are Tier-1/Tier-2 COLLISIONS and one is not — see the
 * dedup describe below for what that buys. Measured shape, not a guess:
 *   Other.SetRange(...)   -> void-method-call (dropped) + remove-setrange   (identical `""` text)
 *   Other.CalcFields(...) -> void-method-call (dropped) + remove-calcfields (identical `""` text)
 *   Other.TestField(...)  -> void-method-call (dropped) + remove-testfield  (identical `""` text)
 *   Other.Modify(true)    -> void-method-call (KEPT)    + swap-modify-flag  (different text)
 * plus one `empty-block` over the whole procedure body.
 */
const CALLER_AL = `codeunit 79310 "Caller"
{
    procedure P()
    var
        Other: Record "Other Table";
    begin
        Other.SetRange("No.", 'A');
        Other.CalcFields("Amt");
        Other.TestField("No.");
        Other.Modify(true);
    end;
}
`;

const TABLE_AL = `table 79311 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } field(2; "Amt"; Decimal) { } }
}
`;

/** Holds code, is NOT a carrier kind — see `CARRIER_KINDS` (@lethal/schemata). */
const XMLPORT_AL = `xmlport 79330 "Only Xmlport"
{
    schema
    {
        textelement(Root)
        {
            trigger OnBeforePassVariable()
            var
                Other: Record "Other Table";
            begin
                Other.SetRange("No.", 'A');
            end;
        }
    }
}
`;

async function withProject(
  files: Readonly<Record<string, string>>,
  body: (projectDir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lethal-operator-"));
  const projectDir = join(root, "app");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  for (const [rel, content] of Object.entries(files)) {
    await Bun.write(join(projectDir, rel), content);
  }
  try {
    await body(projectDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const FIXTURE = {
  "Al/Codeunit/Caller.Codeunit.al": CALLER_AL,
  "Al/Table/Other.Table.al": TABLE_AL,
};

function operatorNamesOf(
  files: readonly { readonly specs: readonly { operatorName: string }[] }[],
) {
  return files
    .flatMap((f) => f.specs.map((s) => s.operatorName))
    .sort((a, b) => a.localeCompare(b));
}

describe("resolveOperatorNames — the refusal, without parsing any AL", () => {
  const REGISTERED = ["lethal.empty-block", "lethal.void-method-call", "lethal.remove-setrange"];

  test("no names given means no narrowing at all, distinct from an empty set", () => {
    expect(resolveOperatorNames([], REGISTERED)).toBeUndefined();
  });

  test("an exact registered name resolves to itself", () => {
    expect([...(resolveOperatorNames(["lethal.empty-block"], REGISTERED) ?? [])]).toEqual([
      "lethal.empty-block",
    ]);
  });

  test("the `lethal.` prefix is optional and resolves to the full registered name", () => {
    // The report records the RESOLVED name, so a later reader never has to guess what an
    // abbreviation meant.
    expect([...(resolveOperatorNames(["empty-block"], REGISTERED) ?? [])]).toEqual([
      "lethal.empty-block",
    ]);
  });

  test("an unregistered name throws, naming it AND listing what is registered", () => {
    let message = "";
    try {
      resolveOperatorNames(["empty-blocks"], REGISTERED);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('"empty-blocks"');
    expect(message).toContain('"lethal.empty-block"');
  });

  test("throws when ONE of several names is unknown, not only when all are", () => {
    let message = "";
    try {
      resolveOperatorNames(["empty-block", "typo"], REGISTERED);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('"typo"');
    // The good name is not reported as the problem.
    expect(message).not.toContain('does not register: "empty-block"');
  });

  test("every builtin operator resolves without its prefix", () => {
    // Guards the prefix rule against a future operator registered under a bare name: if one is
    // ever added, this fails and whoever adds it has to decide what `--operator <bare>` means.
    const registered = [...operatorTiers.keys()];
    for (const full of registered) {
      expect(full.startsWith("lethal.")).toBe(true);
      const bare = full.slice("lethal.".length);
      expect([...(resolveOperatorNames([bare], registered) ?? [])]).toEqual([full]);
    }
  });
});

describe("generateMutationSet — --operator narrows the mutant set", () => {
  test("without --operator, every registered operator contributes", async () => {
    await withProject(FIXTURE, async (projectDir) => {
      const { files, excludedByOperator } = await generateMutationSet(projectDir);
      const names = new Set(operatorNamesOf(files));
      expect(names.has("lethal.void-method-call")).toBe(true);
      expect(names.has("lethal.remove-setrange")).toBe(true);
      expect(names.has("lethal.empty-block")).toBe(true);
      expect(excludedByOperator).toBe(0);
    });
  });

  test("one operator keeps only that operator's specs, and counts the rest", async () => {
    await withProject(FIXTURE, async (projectDir) => {
      const full = await generateMutationSet(projectDir);
      const deployedUnfiltered = fullDeployedCount(full.files);

      const { files, excludedByOperator } = await generateMutationSet(projectDir, {
        operators: ["empty-block"],
      });
      expect(operatorNamesOf(files)).toEqual(["lethal.empty-block"]);
      // The count adds up against the unfiltered DEPLOYED set — that is what makes it a number a
      // reader can subtract, rather than a number that merely looks plausible.
      const kept = files.reduce((n, f) => n + f.specs.length, 0);
      expect(excludedByOperator).toBe(deployedUnfiltered - kept);
    });
  });

  test("several --operator names union rather than intersect", async () => {
    await withProject(FIXTURE, async (projectDir) => {
      const { files } = await generateMutationSet(projectDir, {
        operators: ["empty-block", "swap-modify-flag"],
      });
      expect(operatorNamesOf(files)).toEqual(["lethal.empty-block", "lethal.swap-modify-flag"]);
    });
  });

  test("--operator and --only compose: both narrowings apply", async () => {
    await withProject(
      { ...FIXTURE, "Al/Codeunit/Other.Codeunit.al": CALLER_AL.replace("79310", "79312") },
      async (projectDir) => {
        const { files, excludedByOnly } = await generateMutationSet(projectDir, {
          only: ["Al/Codeunit/Caller.Codeunit.al"],
          operators: ["empty-block"],
        });
        expect(files).toHaveLength(1);
        expect(operatorNamesOf(files)).toEqual(["lethal.empty-block"]);
        expect(excludedByOnly).toBeGreaterThan(0);
      },
    );
  });
});

/**
 * THE load-bearing property, and the reason the filter runs after `dedupeSpecs` rather than before.
 *
 * `dedupeSpecs` drops a Tier-1 spec when a Tier-2 operator emits byte-identical AL at the same node
 * (design §3.2 precedence). In this fixture three of the four `void-method-call` specs lose that
 * way. Filtering the operator list BEFORE dedup would hide the Tier-2 winners, and
 * `--operator void-method-call` would then deploy FOUR mutants where an unfiltered run deploys
 * exactly one — mutants the project's real mutant set does not contain. That is a narrowing knob
 * changing what exists, which R127 says it must never do.
 */
describe("R832: --exclude-operator", () => {
  const REGISTERED = ["lethal.a", "lethal.b", "lethal.c"];

  /** What an unfiltered run deploys: its files still hold the specs dedup deletes. */
  async function fullDeployed(dir: string): Promise<string[]> {
    const { files } = await generateMutationSet(dir);
    return operatorNamesOf(
      files.map((f) => ({ specs: dedupeSpecs(f.specs, (n) => operatorTiers.get(n)) })),
    );
  }

  test("admits every other operator, with or without the prefix", () => {
    expect([...(admittedOperatorNames({ excludeOperators: ["a"] }, REGISTERED) ?? [])]).toEqual([
      "lethal.b",
      "lethal.c",
    ]);
    expect([
      ...(admittedOperatorNames({ excludeOperators: ["lethal.a", "c"] }, REGISTERED) ?? []),
    ]).toEqual(["lethal.b"]);
  });

  test("no names at all means no narrowing", () => {
    expect(admittedOperatorNames({}, REGISTERED)).toBeUndefined();
  });

  test("an unregistered name is refused, and the refusal names this flag", () => {
    expect(() => admittedOperatorNames({ excludeOperators: ["typo"] }, REGISTERED)).toThrow(
      '--exclude-operator named an operator this build does not register: "typo"',
    );
  });

  test("both flags together are refused", async () => {
    expect(() =>
      admittedOperatorNames({ operators: ["a"], excludeOperators: ["b"] }, REGISTERED),
    ).toThrow("cannot be combined");
    await withProject(FIXTURE, async (dir) => {
      await expect(
        generateMutationSet(dir, {
          operators: ["empty-block"],
          excludeOperators: ["remove-assignment"],
        }),
      ).rejects.toThrow("cannot be combined");
    });
  });

  test("keeps exactly the full run's mutants minus that operator, and counts them", async () => {
    await withProject(FIXTURE, async (dir) => {
      const full = await fullDeployed(dir);
      const left = "lethal.empty-block";
      const dropped = full.filter((n) => n === left).length;
      expect(dropped).toBeGreaterThan(0);
      const set = await generateMutationSet(dir, { excludeOperators: ["empty-block"] });
      expect(operatorNamesOf(set.files)).toEqual(full.filter((n) => n !== left));
      expect(set.excludedByOperator).toBeGreaterThan(0);
    });
  });

  test("leaving out an operator with no site here changes nothing and is not refused", async () => {
    await withProject(FIXTURE, async (dir) => {
      const full = await fullDeployed(dir);
      const absent = [...operatorTiers.keys()].find((n) => !full.includes(n));
      expect(absent).toBeDefined();
      const set = await generateMutationSet(dir, { excludeOperators: [absent ?? ""] });
      expect(operatorNamesOf(set.files)).toEqual(full);
    });
  });

  test("leaving out every operator that found a site is refused, not an empty run", async () => {
    await withProject(FIXTURE, async (dir) => {
      const full = [...new Set(operatorNamesOf((await generateMutationSet(dir)).files))];
      await expect(generateMutationSet(dir, { excludeOperators: full })).rejects.toThrow(
        "no deployable mutation site is left in this scope with --exclude-operator",
      );
    });
  });

  test("the warning names the flag and the operator left out", async () => {
    await withProject(FIXTURE, async (dir) => {
      const seen: string[] = [];
      await generateMutationSet(dir, {
        excludeOperators: ["empty-block"],
        emit: (e) => {
          if (e.type === "warning" && e.code === "operator-narrowed-run") seen.push(e.message);
        },
      });
      expect(seen.length).toBe(1);
      expect(seen[0]).toContain("--exclude-operator left out empty-block");
    });
  });
});

describe("generateMutationSet — --operator cannot resurrect a mutant dedup deletes", () => {
  test("void-method-call yields ONLY the site no Tier-2 operator claims", async () => {
    await withProject(FIXTURE, async (projectDir) => {
      const { files } = await generateMutationSet(projectDir, {
        operators: ["void-method-call"],
      });
      const specs = files.flatMap((f) => f.specs);
      expect(specs.map((s) => s.operatorName)).toEqual(["lethal.void-method-call"]);
      expect(specs[0]?.before.text).toContain("Other.Modify(true)");
    });
  });

  test("counterweight: the three suppressed sites DO exist, they are just Tier-2's", async () => {
    // Without this the test above would pass just as well if `--operator` had broken spec
    // generation for those three statements outright, or if this fixture never produced them.
    await withProject(FIXTURE, async (projectDir) => {
      const { files } = await generateMutationSet(projectDir);
      const suppressed = files
        .flatMap((f) => f.specs)
        .filter((s) => s.operatorName === "lethal.void-method-call")
        .map((s) => s.before.text);
      expect(suppressed).toHaveLength(4);
      expect(suppressed.join("|")).toContain("Other.SetRange");
    });
  });

  test("every operator-scoped mutant is one an unfiltered run also deploys", async () => {
    // The general statement of the property above, checked over EVERY registered operator rather
    // than the one the fixture was built around: the union of all single-operator runs must be
    // exactly the unfiltered deployed set, never larger.
    await withProject(FIXTURE, async (projectDir) => {
      const full = await generateMutationSet(projectDir);
      const unfiltered = new Set(
        full.files.flatMap((f) => f.specs).map((s) => siteKey(s.operatorName, s)),
      );
      let union = 0;
      for (const name of operatorTiers.keys()) {
        const scoped = await generateMutationSet(projectDir, { operators: [name] }).catch(
          () => undefined,
        );
        if (scoped === undefined) continue; // barren operator: refused, nothing to compare
        for (const spec of scoped.files.flatMap((f) => f.specs)) {
          union++;
          expect(unfiltered.has(siteKey(spec.operatorName, spec))).toBe(true);
        }
      }
      expect(union).toBe(fullDeployedCount(full.files));
    });
  });
});

describe("generateMutationSet — --operator refuses to select nothing", () => {
  test("an unregistered name throws before any file is read", async () => {
    await withProject(FIXTURE, async (projectDir) => {
      const err = await generateMutationSet(projectDir, { operators: ["not-an-operator"] }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err instanceof Error ? err.message : "").toContain('"not-an-operator"');
    });
  });

  test("a REGISTERED operator with no site in this project throws too", async () => {
    // The signature failure this repo keeps hitting. `swap-call-arguments` is a real operator, so
    // the name check above cannot catch it; without this refusal the run would publish, run a full
    // baseline and report a null score with no failures, which reads as "nothing to fix".
    await withProject(FIXTURE, async (projectDir) => {
      const err = await generateMutationSet(projectDir, {
        operators: ["swap-call-arguments"],
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain('"lethal.swap-call-arguments"');
      expect(message).toContain("no deployable mutation site");
    });
  });

  test("the refusal names only the barren operator, not the productive one beside it", async () => {
    await withProject(FIXTURE, async (projectDir) => {
      const err = await generateMutationSet(projectDir, {
        operators: ["empty-block", "swap-call-arguments"],
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain('"lethal.swap-call-arguments"');
      expect(message).not.toContain('"lethal.empty-block"');
    });
  });

  test("an operator whose only sites are in an UNINSTRUMENTABLE file says so", () => {
    // An `xmlport` holds code but is not in `CARRIER_KINDS`, so its sites never deploy. Refusing
    // with the same message as "no sites at all" would send the reader looking for code that is
    // right there in front of them. (A `page` would NOT work as this fixture: pages have been
    // carriers since R40.)
    return withProject(
      { "Al/X/Only.XmlPort.al": XMLPORT_AL, "Al/Table/Other.Table.al": TABLE_AL },
      async (projectDir) => {
        const err = await generateMutationSet(projectDir, {
          operators: ["empty-block"],
        }).then(
          () => undefined,
          (e: unknown) => e,
        );
        const message = err instanceof Error ? err.message : "";
        expect(message).toContain("only in files no selector var can be injected into");
      },
    );
  });
});

/**
 * R127's second hard constraint: narrowing which mutants deploy must SURFACE, the way `--only`
 * already does, so nobody can quote an operator-scoped score as a project score. Built as real
 * events + statics rather than through the legacy bag shim, per report-fold.test.ts's pattern.
 */
describe("buildReport — an operator-scoped run says so", () => {
  const CAPS = {
    kind: "bcdev",
    authoritative: true,
    coverage: "procedure",
    deploy: "publish",
    isolation: "session",
  } as const;

  function reportFor(statics: Partial<FoldStatics>) {
    const events: RunEvent[] = (
      [
        {
          type: "mutation-set-generated",
          siteCount: 3,
          deployedCount: 3,
          hangCapableCount: 0,
          totalFiles: 91,
          instrumentableFiles: 91,
          notInstrumentedFiles: [],
          declarativeSiteFiles: [],
          preprocExcludedFiles: [],
          excludedByOnly: 0,
          excludedByExclude: 0,
          excludedByOperator: 891,
        },
        { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
        { type: "session-finished", elapsedMs: 10 },
      ] as RunEventInput[]
    ).map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
    return buildReport({ caps: CAPS, buildSymbols: [], ...statics }, events);
  }

  test("pushes `operator-narrowed`, a caveat distinct from `narrowed`", () => {
    const r = reportFor({ operators: { names: ["lethal.swap-call-arguments"] } });
    expect(r.validity.caveats).toContain("operator-narrowed");
    // Distinct strings: a reader must be able to tell "fewer FILES contributed" from "fewer
    // OPERATORS contributed", because the two describe different slices of the project.
    expect(r.validity.caveats).not.toContain("narrowed");
  });

  test("degrades reliability to `narrowed` on its own, with no --only present", () => {
    const r = reportFor({ operators: { names: ["lethal.swap-call-arguments"] } });
    expect(r.validity.reliability).toBe("narrowed");
  });

  test("records the resolved names and the measured excluded-site count", () => {
    const r = reportFor({ operators: { names: ["lethal.swap-call-arguments"] } });
    expect(r.operators).toEqual({
      names: ["lethal.swap-call-arguments"],
      excludedSiteCount: 891,
    });
  });

  test("scoreDescribes names the operator scope, not just the file count", () => {
    const r = reportFor({ operators: { names: ["lethal.swap-call-arguments"] } });
    expect(r.validity.scoreDescribes).toContain("lethal.swap-call-arguments");
    expect(r.validity.scoreDescribes).toContain("891 site(s) from other operators excluded");
  });

  test("an unscoped run keeps every one of those absent", () => {
    // The counterweight. Without it each assertion above would pass just as well if the field were
    // populated unconditionally, which is the failure mode that makes a caveat useless.
    const r = reportFor({});
    expect(r.operators).toBeUndefined();
    expect(r.validity.caveats).not.toContain("operator-narrowed");
    expect(r.validity.reliability).toBe("full");
    expect(r.validity.scoreDescribes).not.toContain("operators");
  });

  test("renderConsole prints the narrowing next to the score", () => {
    const out = renderConsole(reportFor({ operators: { names: ["lethal.swap-call-arguments"] } }));
    expect(out).toContain("NARROWED (--operator)");
    expect(out).toContain("it is not a project score");
  });

  test("renderConsole prints nothing of the sort for an unscoped run", () => {
    expect(renderConsole(reportFor({}))).not.toContain("--operator");
  });
});

/**
 * The wiring, end to end through `runSession`, because every assertion above is blind to it.
 * `generateMutationSet` could filter perfectly and `buildReport` could render perfectly while
 * `runSession` forgot to pass `cfg.operators` to either — a whole-file test of two correct halves
 * that never meet. This repo's standing lesson: red-check the CALL SITE, not the function.
 */
describe("runSession — --operator reaches both the mutant set AND the report", () => {
  const RUN_CAPS: BackendCapabilities = {
    coverage: "procedure",
    deploy: "publish",
    isolation: "session",
    kind: "al-runner-v3",
    authoritative: false,
  };

  const RUN_APP_JSON = JSON.stringify({
    id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1027",
    name: "Operator Scope Fixture",
    publisher: "LethAL",
    version: "1.0.0.0",
    idRanges: [{ from: 79000, to: 79199 }],
  });

  // Two operators' worth of sites: one `empty-block` over the body, plus a `negate-conditional`
  // and a `conditional-boundary` on the comparison. Filtering to `empty-block` must therefore
  // exclude a non-zero number, or the test would pass on a no-op filter.
  const RUN_TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;

  const RUN_TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;
}
`;

  class StubBackend implements ExecutionBackend {
    // R654: re-pointed from the retired .NET al-runner to al-runner-v3, which names its build.
    async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
      return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
    }
    private activations: Array<string | null> = [];
    capabilities(): BackendCapabilities {
      return RUN_CAPS;
    }
    async status(): Promise<BackendStatus> {
      return { ok: true, details: "stub" };
    }
    async deploy(): Promise<CompiledArtifact | null> {
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
                entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
              },
            }
          : {}),
        ...(opts.coverage === "none"
          ? { attestation: { observedAny: true, identityMismatch: false } }
          : {}),
      };
    }
  }

  async function runWith(
    operators: readonly string[] | undefined,
    excludeOperators?: readonly string[],
    /** A fixed folder, and where to put the run's fingerprint: it digests the paths too. */
    fingerprint?: { readonly root: string; readonly seen: (string | undefined)[] },
  ) {
    const root = fingerprint?.root ?? (await mkdtemp(join(tmpdir(), "lethal-operator-run-")));
    const projectDir = join(root, "app");
    const testDir = join(root, "tests");
    await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), RUN_TARGET_AL);
    await Bun.write(join(projectDir, "app.json"), RUN_APP_JSON);
    await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), RUN_TEST_AL);
    const store = new ResultsStore(":memory:");
    const createRun = store.createRun.bind(store);
    store.createRun = (info) => {
      fingerprint?.seen.push(info.configFingerprint);
      return createRun(info);
    };
    try {
      return await runSession({
        backend: new StubBackend(),
        store,
        projectDir,
        testDir,
        instrumentedDir: join(root, "instr"),
        selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
        ...(operators !== undefined ? { operators } : {}),
        ...(excludeOperators !== undefined ? { excludeOperators } : {}),
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  test("the run deploys only the named operator's mutants, and the report says so", async () => {
    const unfiltered = await runWith(undefined);
    const scoped = await runWith(["empty-block"]);

    const scopedOperators = new Set(scoped.mutants.map((m) => m.operatorName));
    expect([...scopedOperators]).toEqual(["lethal.empty-block"]);
    // Non-trivial: the unfiltered run really did carry more, so the filter did work rather than
    // matching everything.
    expect(unfiltered.mutants.length).toBeGreaterThan(scoped.mutants.length);

    expect(scoped.operators?.names).toEqual(["lethal.empty-block"]);
    expect(scoped.operators?.excludedSiteCount).toBe(
      unfiltered.mutants.length - scoped.mutants.length,
    );
    expect(scoped.validity.caveats).toContain("operator-narrowed");
    expect(scoped.validity.reliability).toBe("narrowed");
  });

  test("R832: --exclude-operator runs the rest, and the report says so", async () => {
    const unfiltered = await runWith(undefined);
    // Most registered operators have no site here: a run must not refuse them as barren.
    const scoped = await runWith(undefined, ["empty-block"]);

    const left = (m: { operatorName: string }) => m.operatorName === "lethal.empty-block";
    expect(unfiltered.mutants.some(left)).toBe(true);
    expect(scoped.mutants.some(left)).toBe(false);
    // Not `mutantCode`: ids are numbered per run, so they shift when a mutant is left out.
    const key = (m: { operatorName: string; line: number }) => `${m.operatorName}:${m.line}`;
    expect(scoped.mutants.map(key).sort()).toEqual(
      unfiltered.mutants
        .filter((m) => !left(m))
        .map(key)
        .sort(),
    );

    expect(scoped.operators?.names).toEqual(
      // R856: an opt-in operator is not admitted by exclusion, so it is not in the list.
      [...operatorTiers.keys()]
        .filter((n) => n !== "lethal.empty-block" && n !== "lethal.swap-workdate-today")
        .sort(),
    );
    expect(scoped.operators?.excludedSiteCount).toBe(
      unfiltered.mutants.length - scoped.mutants.length,
    );
    expect(scoped.validity.caveats).toContain("operator-narrowed");
    expect(scoped.validity.reliability).toBe("narrowed");
  });

  test("R832: an empty exclude list leaves --operator's scope alone", async () => {
    const scoped = await runWith(["empty-block"], []);
    expect([...new Set(scoped.mutants.map((m) => m.operatorName))]).toEqual(["lethal.empty-block"]);
  });

  test("R832: the resume fingerprint moves with what is left out", async () => {
    const root = join(tmpdir(), "lethal-operator-fingerprint");
    const seen: (string | undefined)[] = [];
    await runWith(undefined, ["empty-block"], { root, seen });
    await runWith(undefined, ["lethal.empty-block"], { root, seen });
    await runWith(undefined, ["negate-conditional"], { root, seen });
    await runWith(undefined, undefined, { root, seen });
    const [a, same, other, none] = seen;
    expect(a).toBeDefined();
    expect(same).toBe(a);
    expect(other).not.toBe(a);
    expect(none).not.toBe(a);
  });

  test("counterweight: the same run without --operator carries none of that", async () => {
    const unfiltered = await runWith(undefined);
    expect(unfiltered.operators).toBeUndefined();
    expect(unfiltered.validity.caveats).not.toContain("operator-narrowed");
    expect(unfiltered.validity.reliability).toBe("full");
  });
});

const CLI = join(import.meta.dir, "../src/cli.ts");
const SANDBOX = join(import.meta.dir, "../../../fixtures/sandbox-app");

// Not on Windows: the one backend an empty config suits refuses there (R586).
test.skipIf(process.platform === "win32")(
  "R832: `lethal run` hands --exclude-operator to runSession",
  async () => {
    await withProject(FIXTURE, async (projectDir) => {
      const configPath = join(projectDir, "lethal.config.json");
      await Bun.write(configPath, "{}");
      const parsed = parseCliConfig([
        "run",
        "--project",
        projectDir,
        "--tests",
        join(projectDir, "..", "tests"),
        "--backend",
        "al-runner-v3",
        "--config",
        configPath,
        "--db",
        ":memory:",
        "--exclude-operator",
        "empty-block",
      ]);
      if (parsed.mode !== "run") throw new Error("mode drift");
      let captured: readonly string[] | undefined;
      const stop = new Error("captured");
      await expect(
        runFromCli(parsed, {
          validateSelectorIdsForProject: async () => {},
          buildBackend: async () => ({}) as ExecutionBackend,
          runSession: async (cfg) => {
            captured = cfg.excludeOperators;
            throw stop;
          },
        }),
      ).rejects.toBe(stop);
      expect(captured).toEqual(["empty-block"]);
    });
  },
);

describe("parseCliConfig — --operator", () => {
  const RUN_ARGS = ["run", "--project", "p", "--tests", "t", "--backend", "bcdev"] as const;

  test("a single --operator lands as a one-element array", () => {
    const cfg = parseCliConfig([...RUN_ARGS, "--operator", "swap-call-arguments"]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.operators).toEqual(["swap-call-arguments"]);
  });

  test("--operator is repeatable and preserves order", () => {
    const cfg = parseCliConfig([...RUN_ARGS, "--operator", "a", "--operator", "b"]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.operators).toEqual(["a", "b"]);
  });

  test("omitting --operator leaves the key ABSENT, not an empty array", () => {
    const cfg = parseCliConfig([...RUN_ARGS]);
    expect("operators" in cfg).toBe(false);
  });

  test("an empty --operator is refused at parse time", () => {
    expect(() => parseCliConfig([...RUN_ARGS, "--operator", ""])).toThrow(
      /--operator requires a non-empty/,
    );
  });

  test("--dry-run carries --operator too", () => {
    const cfg = parseCliConfig(["run", "--project", "p", "--dry-run", "--operator", "empty-block"]);
    if (cfg.mode !== "dry-run") throw new Error("mode drift");
    expect(cfg.operators).toEqual(["empty-block"]);
  });

  test("R832: --exclude-operator is repeatable, also on a dry run, absent when not given", () => {
    const cfg = parseCliConfig([...RUN_ARGS, "--exclude-operator", "a", "--exclude-operator", "b"]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.excludeOperators).toEqual(["a", "b"]);
    expect("excludeOperators" in parseCliConfig([...RUN_ARGS])).toBe(false);
    const dry = parseCliConfig(["run", "--project", "p", "--dry-run", "--exclude-operator", "a"]);
    if (dry.mode !== "dry-run") throw new Error("mode drift");
    expect(dry.excludeOperators).toEqual(["a"]);
  });

  test(
    "R832: the real CLI's dry run honours the flag, and refuses it beside --operator",
    async () => {
      const cli = async (...flags: string[]) => {
        const p = Bun.spawn(
          [process.execPath, CLI, "run", "--project", SANDBOX, "--dry-run", ...flags],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [out, err] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ]);
        return { code: await p.exited, text: out + err };
      };
      const left = await cli("--exclude-operator", "empty-block");
      expect(left.text).toContain('narrowed by --exclude-operator "empty-block"');
      expect(left.text).not.toContain("lethal.empty-block");
      const both = await cli("--exclude-operator", "empty-block", "--operator", "return-value");
      expect(both.code).not.toBe(0);
      expect(both.text).toContain("cannot be combined");
    },
    ownTimeout(30_000),
  );

  test("R832: both flags are refused at parse time, before a run provisions anything", () => {
    expect(() =>
      parseCliConfig([...RUN_ARGS, "--operator", "a", "--exclude-operator", "b"]),
    ).toThrow("cannot be combined");
  });

  test("R832: an empty --exclude-operator is refused at parse time", () => {
    expect(() => parseCliConfig([...RUN_ARGS, "--exclude-operator", ""])).toThrow(
      /--exclude-operator requires a non-empty/,
    );
  });

  test("--only and --operator are independent", () => {
    const cfg = parseCliConfig([...RUN_ARGS, "--only", "Al/**", "--operator", "empty-block"]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.only).toEqual(["Al/**"]);
    expect(cfg.operators).toEqual(["empty-block"]);
  });
});

function siteKey(operatorName: string, spec: { before: { startIndex: number; endIndex: number } }) {
  return `${operatorName}:${spec.before.startIndex}-${spec.before.endIndex}`;
}

function fullDeployedCount(
  files: readonly { readonly specs: readonly { operatorName: string }[] }[],
): number {
  // Not `dedupeSpecs` re-run here: this counts what the FILTERED path already agreed to deploy,
  // by summing every single-operator run. Kept as a helper so the two call sites above cannot
  // drift into two different definitions of "deployed".
  return files.reduce((n, f) => n + f.specs.length, 0) - COLLIDING_SITES;
}

/**
 * Tier-1 specs this fixture loses to a Tier-2 winner at dedup — measured, not assumed: the three
 * `void-method-call` specs at `SetRange`, `CalcFields` and `TestField`. Named as a constant so the
 * arithmetic above states WHY the filtered and unfiltered counts differ instead of hiding it in a
 * magic number.
 */
const COLLIDING_SITES = 3;
