import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { EquivalenceMark } from "../src/equivalence-marks";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";

// R214, the DC case: the build's symbols come from app.json ONLY, and no config symbol is set.
// Every runSession site that records or compares the build's symbols must see the EFFECTIVE set
// (app.json plus config), never `cfg.preprocessorSymbols` alone.

const R214 = join(import.meta.dir, "fixtures", "r214");
const norm = (p: string): string => p.replaceAll("\\", "/");

/** Every test passes, so every covered mutant survives; the baseline covers `P7 AppSym`'s `Run`. */
class SurvivingBackend implements ExecutionBackend {
  private active: string | null = null;
  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
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
              entries: [{ objectType: "Codeunit", objectId: 50007, procedure: "Run" }],
            },
          }
        : { attestation: { observedAny: true, identityMismatch: false } }),
    };
  }
}

const TEST_AL = `codeunit 50140 "P7 Tests"
{
    Subtype = Test;

    [Test]
    procedure RunTest()
    begin
    end;
}
`;

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A private copy of p7-appjson (app.json `"preprocessorSymbols": ["APPSYM"]`) and a test app. */
async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "lethal-r214-appjson-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await cp(join(R214, "p7-appjson"), projectDir, { recursive: true });
  await Bun.write(join(testDir, "P7Tests.Codeunit.al"), TEST_AL);
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

/** The `void-method-call` key at the built `#if APPSYM` arm, read from the committed capture. */
async function armKey(): Promise<string> {
  const text = await readFile(join(R214, "expected", "p7-appjson.0.txt"), "utf8");
  const key = text
    .split("\n")
    .find((l) => l.includes("\tlethal.void-method-call\t"))
    ?.split("\t")[4];
  if (key === undefined) throw new Error("no void-method-call row");
  return key;
}

async function run(
  dirs: Awaited<ReturnType<typeof makeProject>>,
  store: ResultsStore,
  marks?: EquivalenceMark[],
) {
  const events: RunEvent[] = [];
  const report = await runSession({
    backend: new SurvivingBackend(),
    store,
    ...dirs,
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    emit: [(e) => events.push(e)],
    ...(marks !== undefined ? { equivalenceMarks: marks } : {}),
  });
  const id = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
  const symbolWarnings = events.flatMap((e) =>
    e.type === "warning" && e.code === "equivalence-marks-build-symbols" ? [e.message] : [],
  );
  return { report, run: store.getRun(id), symbolWarnings };
}

describe("R214: symbols from app.json only (no config symbols)", () => {
  test("the run records ['APPSYM'] and the compiled-out row names it", async () => {
    const { report, run: row } = await run(await makeProject(), new ResultsStore(":memory:"));
    expect(row?.buildSymbols).toEqual(["APPSYM"]);
    const out = (report.excludedSites?.files ?? []).filter((f) => f.reason === "compiled-out");
    expect(out.map((f) => [norm(f.file), f.detail])).toEqual([
      ["AppSym.Codeunit.al", "symbols: APPSYM"],
    ]);
  }, 60_000);

  test("the session fingerprint differs from the same project with no app.json symbols", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const withSym = (await run(dirs, store)).run?.configFingerprint;
    const appJson = join(dirs.projectDir, "app.json");
    const manifest = JSON.parse(await readFile(appJson, "utf8")) as Record<string, unknown>;
    manifest.preprocessorSymbols = undefined; // JSON.stringify drops it
    await writeFile(appJson, JSON.stringify(manifest));
    const without = await run(dirs, store);
    expect(without.run?.buildSymbols).toEqual([]);
    expect(typeof withSym).toBe("string");
    expect(without.run?.configFingerprint).not.toBe(withSym);
  }, 60_000);

  test("a mark under ['APPSYM'] is applied; a mark with no field is stale and the warning says why", async () => {
    const key = await armKey();
    // R443: the mark carries this project's numbering digest, read from a real run.
    const plain = await run(await makeProject(), new ResultsStore(":memory:"));
    const numberingDigest = plain.report.numberingDigest;
    if (numberingDigest === undefined) throw new Error("the report records no numbering digest");
    const mark = {
      key,
      reason: "same either way",
      identityScheme: IDENTITY_SCHEME,
      numberingDigest,
    };
    const applied = await run(await makeProject(), new ResultsStore(":memory:"), [
      { ...mark, preprocessorSymbols: ["APPSYM"] },
    ]);
    expect(applied.report.readerMarkedEquivalent?.stale ?? []).toEqual([]);
    expect(applied.report.mutants.filter((m) => m.readerMark !== undefined)).toHaveLength(1);
    expect(applied.symbolWarnings).toEqual([]);

    const stale = await run(await makeProject(), new ResultsStore(":memory:"), [mark]);
    expect(stale.report.readerMarkedEquivalent?.stale).toEqual([key]);
    expect(stale.report.mutants.filter((m) => m.readerMark !== undefined)).toHaveLength(0);
    expect(stale.symbolWarnings).toHaveLength(1);
    expect(stale.symbolWarnings[0]).toContain("than this build's (APPSYM)");
  }, 60_000);
});
