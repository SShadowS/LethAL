// R586 T15 (plan docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md §9, C1 and M1):
// every place in packages/runner/src that decides something from WHICH backend runs is classified.
// Before R586 `!caps.authoritative` meant "al-runner" everywhere, so a second non-authoritative
// backend read as the .NET al-runner. A new read of `.authoritative`, or a compare / argument /
// default / case arm on the backend name "al-runner", fails here until it is classified below.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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
import type { AlRunnerPredefinedProbe } from "../src/preprocessor-symbols";
import { ResultsStore } from "../src/store";

const SRC = join(import.meta.dir, "..", "src");

/** The shapes C1 and M1 name. Comment lines are skipped. */
const SHAPES: readonly RegExp[] = [
  /\.authoritative\b/,
  /[=!]==\s*"al-runner"/,
  /"al-runner"\s*[=!]==/,
  /[(,]\s*"al-runner"\s*[,)]/,
  /=\s*"al-runner"\s*[,;)]/,
  /case\s+"al-runner"\s*:/,
  /\?\?\s*"al-runner"/,
  // Plan r2 §9: the bcdev compares too.
  /[=!]==\s*"bcdev"/,
  /"bcdev"\s*[=!]==/,
];

/**
 * file -> the trimmed text of each classified line -> its class. Text, not line numbers (R117).
 * Classes: `v2` (the .NET al-runner alone, v3 deliberately excluded), `coverage-mode` (the
 * CoverageMode "al-runner", not a backend), `report-field` (the report's own `authoritative`),
 * `config` (the CLI's backend argument / config section), `predicate` (the predicate itself).
 */
const CLASSIFIED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "backend.ts": {
    'return kind === "bcdev";': "predicate",
    'return kind === "al-runner";': "predicate",
    'return kind === "al-runner" || kind === "al-runner-v3";': "predicate",
  },
  "verify-reach.ts": { 'case "al-runner":': "coverage-mode" },
  "al-runner-v3-config.ts": {
    'if (r.coverage !== undefined && r.coverage !== "al-runner" && r.coverage !== "none") {':
      "coverage-mode",
    'coverage: (r.coverage as "al-runner" | "none" | undefined) ?? "al-runner",': "coverage-mode",
  },
  // The v2 coverage index's own refusal sentences; v3 reuses the index (plan M1, the safe direction).
  "al-runner-coverage.ts": {
    'for (const [key, reason] of refusedObjectsOfFile(root, file, "al-runner")) {': "v2",
  },
  // A directory name, not a backend.
  "al-runner-cache.ts": {
    'return join(homeDir(), ".local", "share", "al-runner", "artifacts");': "path",
    'return join(homeDir(), ".cache", "al-runner");': "path",
  },
  "doctor.ts": {
    'checkPromises.push(runCheck("al-runner", async () => checkAlRunner(await alRunner())));':
      "config",
  },
  "store.ts": {
    'return run.backend !== "al-runner" || run.alRunnerNames;': "v2",
    'if (names !== undefined && run.backend === "al-runner") {': "v2",
    'if (run.backend === "al-runner" && ctx.renamed !== undefined) {': "v2",
  },
  // R-300b: bcdev's shape rule with arms; v2's measured admission; v3 takes neither (refused).
  "line-map.ts": {
    'const alRunner = backendKind === "al-runner";': "v2",
    'if (backendKind === "bcdev" && arms !== undefined) {': "bcdev",
  },
  "preprocessor-symbols.ts": {
    'const predefined = backend.kind === "al-runner" ? backend.predefined.symbols : [];': "v2",
  },
  "report.ts": {
    "authoritative: input.caps.authoritative,": "report-field",
    "if (!r.authoritative) {": "report-field",
    'if (r.backend === "al-runner" && r.alRunnerCanary !== undefined) {': "v2",
    // R553's assertion screen: strips al-runner v2's `{Type}Exception: ` prefix. v3 takes the
    // bcdev branch (its messages carry no such prefix: "rows=0 counter=1", "Test exceeded 3s
    // timeout."), so these are v2-only reads.
    'const screenBackend = input.caps.kind === "al-runner" ? "al-runner" : "bcdev";': "v2",
    'screenBackend === "al-runner" &&': "v2",
  },
  "assertion-screen.ts": {
    'return backend === "al-runner" ? m.replace(AL_RUNNER_EXCEPTION_PREFIX, "") : m;': "v2",
  },
  "orchestrator.ts": {
    'backendName === "al-runner"': "v2",
    'if (reused !== undefined && snapshotRun?.backend === "al-runner") {': "v2",
    '...(backendName === "al-runner" ? { alRunnerNames: true } : {}),': "v2",
    'backendName === "al-runner" ? alRunnerAdmitsWrappedFile(f.root) : admittedOnBc(f),': "v2",
  },
  "cli.ts": {
    'if (raw !== "bcdev" && raw !== "al-runner" && raw !== "al-runner-v3") {': "config",
    'if (coverage === "al-runner") {': "coverage-mode",
    'coverage: c.coverage ?? "al-runner",': "coverage-mode",
    'if (effectiveAlRunnerTransport(section).coverage !== "al-runner") {': "coverage-mode",
    '`[lethal] al-runner-coverage-unsupported: al-runner coverage (${section.coverage === "al-runner" ? \'set by "alRunner.coverage": "al-runner"\' : "on by default"}) is turned OFF for this run, which runs with coverage "none" instead. al-runner\'s coverage cannot be placed in ${named.join(", ")}: ${why.join("; ")}. Trusting it would credit those objects\' mutants to the wrong tests, or report them no-coverage while tests do reach them.`,':
      "coverage-mode",
    'if (parsed.backendKind === "al-runner") {': "config",
    'if (paths.backendKind === "al-runner") {': "config",
    'parsed.backendKind === "al-runner"': "config",
    'if (backendArg === "bcdev" && workers > 1) {': "bcdev",
    'if (parsed.backendKind !== "bcdev" || configFile.envTool === undefined) {': "bcdev",
    'if (parsed.backendKind !== "bcdev") return {};': "bcdev",
    '} else if (paths.backendKind === "bcdev") {': "bcdev",
    '...(parsed.backendKind === "bcdev"': "bcdev",
    'if (highestPublished !== undefined && parsed.backendKind === "bcdev") {': "bcdev",
  },
};

/** Every (file, trimmed line) matching a shape, comment lines excluded. */
function backendIdentityReads(
  files: ReadonlyMap<string, string>,
): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const [file, src] of files) {
    for (const raw of src.split("\n")) {
      const text = raw.trim();
      if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) continue;
      if (SHAPES.some((s) => s.test(text))) out.push({ file, text });
    }
  }
  return out;
}

/** The hits no class covers, and the classified texts no line has any more (a stale table). */
function unclassified(
  files: ReadonlyMap<string, string>,
  table: Readonly<Record<string, Readonly<Record<string, string>>>>,
): { readonly fresh: string[]; readonly stale: string[] } {
  const hits = backendIdentityReads(files);
  const fresh = hits
    .filter((h) => table[h.file]?.[h.text] === undefined)
    .map((h) => `${h.file}: ${h.text}`);
  const seen = new Set(hits.map((h) => `${h.file}\u0000${h.text}`));
  const stale = Object.entries(table).flatMap(([file, lines]) =>
    Object.keys(lines)
      .filter((text) => !seen.has(`${file}\u0000${text}`))
      .map((text) => `${file}: ${text}`),
  );
  return { fresh, stale };
}

function readSrc(): Map<string, string> {
  const files = new Map<string, string>();
  for (const f of readdirSync(SRC)) {
    if (f.endsWith(".ts") && !f.endsWith(".test.ts")) {
      files.set(f, readFileSync(join(SRC, f), "utf8"));
    }
  }
  return files;
}

describe("R586 T15: every backend-identity read in src is classified", () => {
  test("no unclassified read, and no stale classification", () => {
    expect(unclassified(readSrc(), CLASSIFIED)).toEqual({ fresh: [], stale: [] });
  });

  test("direction 1: a new `!caps.authoritative` read is caught", () => {
    const files = new Map([["x.ts", "  if (!caps.authoritative) {\n"]]);
    expect(unclassified(files, {}).fresh).toEqual(["x.ts: if (!caps.authoritative) {"]);
  });

  test("direction 1: a backend-name literal as an argument, a default and a case arm are caught", () => {
    const files = new Map([
      [
        "x.ts",
        [
          'lend(run, "al-runner");',
          'function f(kind = "al-runner") {}',
          '  case "al-runner":',
          '  const k = caps.kind ?? "al-runner";',
        ].join("\n"),
      ],
    ]);
    expect(unclassified(files, {}).fresh).toHaveLength(4);
  });

  test("direction 2: a classified line that is gone is reported stale, and comments are not reads", () => {
    const files = new Map([["x.ts", "// if (!caps.authoritative) {\n * caps.authoritative\n"]]);
    expect(unclassified(files, { "x.ts": { "if (x.authoritative) {": "v2" } })).toEqual({
      fresh: [],
      stale: ["x.ts: if (x.authoritative) {"],
    });
  });
});

// --- C1 through runSession: a v3-kind backend is not the .NET al-runner -----------------------

const SOURCE = `codeunit 50013 "K Probe"
{
    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
`;
const TEST_AL = `codeunit 50140 "K Tests"
{
    Subtype = Test;

    [Test]
    procedure TwiceTest()
    begin
    end;
}
`;

class V3KindStub implements ExecutionBackend {
  v2ProbeCalls = 0;
  constructor(private readonly predefined: readonly string[] | undefined) {}
  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner-v3",
      coverage: "none",
      deploy: "none",
      isolation: "session",
      authoritative: false,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(): Promise<void> {}
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    return { ref, outcome: "pass", durationMs: 1 };
  }
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
  }
}
/** The probe only where the stub was given a measured set. */
function withProbe(b: V3KindStub, set: readonly string[] | undefined): ExecutionBackend {
  if (set === undefined) return b;
  return Object.assign(b, {
    measurePredefinedSymbols: async (): Promise<AlRunnerPredefinedProbe> => ({ symbols: [...set] }),
  });
}

beforeAll(async () => {
  await initParser();
});

async function inProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r586-kind-"));
  try {
    const app = { id: "11111111-2222-3333-4444-555555555555", name: "p", publisher: "x" };
    await Bun.write(join(root, "app", "app.json"), JSON.stringify({ ...app, version: "1.0.0.0" }));
    await Bun.write(join(root, "app", "src", "K.Codeunit.al"), SOURCE);
    await Bun.write(join(root, "tests", "KTests.Codeunit.al"), TEST_AL);
    await Bun.write(
      join(root, "tests", "app.json"),
      JSON.stringify({ name: "t", publisher: "x", version: "1.0.0.0" }),
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const v3Session = (
  root: string,
  store: ResultsStore,
  backend: ExecutionBackend,
  extra: Partial<SessionConfig> = {},
) =>
  runSession({
    backend,
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    ...extra,
  });

describe("R586 C1: runSession keys on kind, not on authoritative", () => {
  test("a v3 session is recorded and reported as al-runner-v3, never as al-runner", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const report = await v3Session(root, store, withProbe(new V3KindStub([]), []));
      expect(report.backend).toBe("al-runner-v3");
      // Step 4: the v3 build on the directly measured execution context.
      expect(report.validity.executionContexts[0]).toMatchObject({
        clientType: "al-runner v3 CLI",
        runnerBuild: "alrunner 3.0.0-alpha.2 (91253f2d6)",
        binarySha256: "b".repeat(64),
      });
      expect(store.getRun(1)?.backend).toBe("al-runner-v3");
      // R557's stamp is the v2 mark: a v3 run must not carry it.
      expect(store.getRun(1)?.alRunnerNames).toBe(false);
      // R586: the build `runMayLend` lends under.
      expect(store.getRun(1)?.runnerBuild).toBe(
        `alrunner 3.0.0-alpha.2 (91253f2d6) ${"b".repeat(64)}`,
      );
    });
  });

  test("a v3 backend that cannot name its build is refused (its run would lend under none)", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const b = Object.assign(new V3KindStub(undefined), {
        runnerBuild: async () => ({ version: "", binarySha256: "" }),
      });
      await expect(v3Session(root, store, b)).rejects.toThrow(/named no usable build/);
    });
  });

  test("T27: v3 never takes v2's predefined-probe branch, and its build set has no predefined symbol", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      let probed = 0;
      const b = Object.assign(new V3KindStub(undefined), {
        measurePredefinedSymbols: async (): Promise<AlRunnerPredefinedProbe> => {
          probed += 1;
          return { symbols: ["CLEANSCHEMA25"] };
        },
      });
      await v3Session(root, store, b);
      expect(probed).toBe(0);
      expect(store.getRun(1)?.buildSymbols).toEqual([]);
    });
  });

  test("T27 (other direction): a v2-kind backend without the R392 probe is still refused", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const v2 = Object.assign(new V3KindStub(undefined), {
        capabilities: (): BackendCapabilities => ({
          kind: "al-runner",
          coverage: "none",
          deploy: "none",
          isolation: "session",
          authoritative: false,
        }),
      });
      await expect(v3Session(root, store, v2)).rejects.toThrow(/measurePredefinedSymbols/);
    });
  });

  test("workers > 1 is refused for v3 by name", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const mk = () => withProbe(new V3KindStub([]), []);
      await expect(
        v3Session(root, store, mk(), { workers: 2, backendFactory: () => mk() }),
      ).rejects.toThrow(/refused for the al-runner-v3 backend/);
    });
  });
});
