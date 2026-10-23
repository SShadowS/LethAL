// R586 T15 (plan docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md §9, C1 and M1):
// every place in packages/runner/src that decides something from WHICH backend runs is classified.
// Before R586 `!caps.authoritative` meant "al-runner" everywhere, so a second non-authoritative
// backend read as the .NET al-runner. A new read of `.authoritative`, or a compare / argument /
// default / case arm on the backend name "al-runner", fails here until it is classified below.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { initParser } from "@lethal/engine";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { type SessionConfig, runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";

const SRC = join(import.meta.dir, "..", "src");

/** A backend name as a string literal: bcdev, al-runner-v3, and the retired al-runner. */
const NAME = '"(?:bcdev|al-runner-v3|al-runner)"';

/**
 * The shapes C1, M1 and R611 name. Comment lines are skipped. A shape may span lines (`\s` matches
 * a newline): R611 added a compare split over two lines, `case` labels, `.includes` on an array of
 * names, and the v3 name (the first scanner only knew `"al-runner"` and `"bcdev"` compares).
 */
const SHAPES: readonly RegExp[] = [
  /\.authoritative\b/g,
  new RegExp(`[=!]==\\s*${NAME}`, "g"),
  new RegExp(`${NAME}\\s*[=!]==`, "g"),
  new RegExp(`[(,]\\s*${NAME}\\s*[,)]`, "g"),
  new RegExp(`=\\s*${NAME}\\s*[,;)]`, "g"),
  new RegExp(`case\\s+${NAME}\\s*:`, "g"),
  new RegExp(`\\?\\?\\s*${NAME}`, "g"),
  new RegExp(`\\[[^\\]]*${NAME}[^\\]]*\\]\\s*\\.includes\\(`, "g"),
];

/**
 * file -> the trimmed text of each classified line -> its class. Text, not line numbers (R117).
 * Classes: `retired` (R654: the retired .NET al-runner's name, kept only to refuse it),
 * `coverage-mode` (the CoverageMode "al-runner", not a backend), `report-field` (the report's own
 * `authoritative`), `config` (the CLI's backend argument / config section), `predicate` (the
 * predicate itself). R654 S3 deleted every `v2` read with the backend.
 */
const CLASSIFIED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // R611: the sites the widened scanner found (the v3 name, `case` labels). Each names its backend
  // explicitly; none treats "not bcdev" as v3. Classes: `v3` / `bcdev` (an explicit branch),
  // `exhaustive-switch` (both kinds, no default), `check-name` (a label), `path-name` (a folder).
  "backend.ts": {
    'return kind === "bcdev";': "predicate",
    'return kind === "al-runner-v3";': "predicate",
  },
  "campaign-freeze.ts": { 'if (report.backend === "al-runner-v3") {': "v3" },
  "line-map.ts": {
    'case "bcdev":': "exhaustive-switch",
    'case "al-runner-v3":': "exhaustive-switch",
  },
  "orchestrator.ts": {
    'caps.kind === "al-runner-v3" ? { kind: "al-runner-v3" } : { kind: "bcdev" };': "v3",
    'if (caps.kind === "al-runner-v3" && workers > 1) {': "v3",
    'if (kind !== "al-runner-v3") return undefined;': "v3",
  },
  "doctor.ts": { 'runCheck("al-runner-v3", async () => {': "check-name" },
  "store.ts": {
    'const v3 = "al-runner-v3";': "v3",
    'const v3 = q.backend === "al-runner-v3";': "v3",
  },
  "v2-retired.ts": {
    'export const RETIRED_V2_BACKEND = "al-runner";': "retired",
  },
  "verify-reach.ts": { 'case "al-runner":': "coverage-mode" },
  "al-runner-v3-config.ts": {
    'if (r.coverage !== undefined && r.coverage !== "al-runner" && r.coverage !== "none") {':
      "coverage-mode",
    'coverage: (r.coverage as "al-runner" | "none" | undefined) ?? "al-runner",': "coverage-mode",
  },
  // R654 S1: the coverage index passes its own `WrappedRule` ("al-runner-index"), not a backend
  // name, so it is no longer a backend-identity read.
  "report.ts": {
    "authoritative: input.caps.authoritative,": "report-field",
    "if (!r.authoritative) {": "report-field",
    'if (caps.kind === "al-runner-v3") {': "v3",
    '...(runnerBuild !== undefined && caps.kind === "al-runner-v3"': "v3",
  },
  "cli.ts": {
    'if (raw !== "bcdev" && raw !== "al-runner-v3") {': "config",
    'if (backendArg === "al-runner-v3") {': "v3",
    'instrumentedDir: join(scratchDir, "al-runner-v3"),': "path-name",
    'if (parsed.backendKind === "al-runner-v3") {': "v3",
    '} else if (paths.backendKind === "al-runner-v3") {': "v3",
    'if (backendKind === "al-runner-v3") {': "v3",
    'if (coverage === "al-runner") {': "coverage-mode",
    'if (backendArg === "bcdev" && workers > 1) {': "bcdev",
    'if (parsed.backendKind !== "bcdev" || configFile.envTool === undefined) {': "bcdev",
    'if (parsed.backendKind !== "bcdev") return {};': "bcdev",
    'if (paths.backendKind === "bcdev") {': "bcdev",
    '...(parsed.backendKind === "bcdev"': "bcdev",
    'if (highestPublished !== undefined && parsed.backendKind === "bcdev") {': "bcdev",
  },
};

/**
 * Every (file, text) matching a shape, comment lines excluded. `text` is the trimmed lines the
 * match touches, joined by one space; overlapping matches share one entry, so a split compare or a
 * multi-line array is one read with one key.
 */
function backendIdentityReads(
  files: ReadonlyMap<string, string>,
): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const [file, src] of files) {
    const lines = src.split("\n");
    const code = lines.map((raw) => {
      const t = raw.trim();
      return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") ? "" : raw;
    });
    const starts: number[] = [];
    let at = 0;
    for (const l of code) {
      starts.push(at);
      at += l.length + 1;
    }
    const lineOf = (offset: number) => starts.filter((s) => s <= offset).length - 1;
    const body = code.join("\n");
    const spans: Array<[number, number]> = [];
    for (const shape of SHAPES) {
      for (const m of body.matchAll(shape)) {
        spans.push([lineOf(m.index), lineOf(m.index + Math.max(m[0].length - 1, 0))]);
      }
    }
    spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const [s, e] of spans) {
      const last = merged.at(-1);
      if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    for (const [s, e] of merged) {
      out.push({
        file,
        text: lines
          .slice(s, e + 1)
          .map((l) => l.trim())
          .join(" "),
      });
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

/** Every non-test `.ts` under `dir`, subfolders included; keys are `/`-separated relative paths. */
function readSrc(dir: string = SRC): Map<string, string> {
  const files = new Map<string, string>();
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".ts") && !f.endsWith(".test.ts")) {
      files.set(f.split(sep).join("/"), readFileSync(join(dir, f), "utf8"));
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

  // R611: the shapes the first scanner missed. Each fixture is flagged (red-going) when unclassified
  // and accepted once its collapsed text is in the table.
  test("R611 direction 1: a case label, v3 compares and a split compare are caught", () => {
    const cases: Array<[string, string]> = [
      ['switch (k) {\n  case "bcdev":\n', 'case "bcdev":'],
      ['switch (k) {\n  case "al-runner-v3":\n', 'case "al-runner-v3":'],
      ['if (caps.kind === "al-runner-v3") {\n', 'if (caps.kind === "al-runner-v3") {'],
      ['if ("al-runner-v3" !== caps.kind) {\n', 'if ("al-runner-v3" !== caps.kind) {'],
      ['if (caps.kind ===\n    "bcdev") {\n', 'if (caps.kind === "bcdev") {'],
      ['if (caps.kind !==\n    "al-runner-v3") {\n', 'if (caps.kind !== "al-runner-v3") {'],
      // `&&` after the name: only the compare shape itself can catch these two.
      ['if (caps.kind ===\n    "bcdev" && x) {\n', 'if (caps.kind === "bcdev" && x) {'],
      [
        'if (x && "al-runner-v3"\n    !== caps.kind) {\n',
        'if (x && "al-runner-v3" !== caps.kind) {',
      ],
    ];
    for (const [src, key] of cases) {
      const files = new Map([["x.ts", src]]);
      expect(unclassified(files, {}).fresh, src).toEqual([`x.ts: ${key}`]);
      expect(unclassified(files, { "x.ts": { [key]: "bcdev" } }), src).toEqual({
        fresh: [],
        stale: [],
      });
    }
  });

  test("R611 direction 1: .includes on an array of backend names is caught, one line or split", () => {
    const cases: Array<[string, string]> = [
      [
        'const ok = ["bcdev", "al-runner-v3"].includes(caps.kind);\n',
        'const ok = ["bcdev", "al-runner-v3"].includes(caps.kind);',
      ],
      [
        'const ok = [\n  "al-runner-v3",\n  "bcdev",\n].includes(caps.kind);\n',
        'const ok = [ "al-runner-v3", "bcdev", ].includes(caps.kind);',
      ],
    ];
    for (const [src, key] of cases) {
      const files = new Map([["x.ts", src]]);
      expect(unclassified(files, {}).fresh, src).toEqual([`x.ts: ${key}`]);
      expect(unclassified(files, { "x.ts": { [key]: "bcdev" } }), src).toEqual({
        fresh: [],
        stale: [],
      });
    }
  });

  test("R611: a name in a comment, a type position or an unrelated array is not a read", () => {
    const files = new Map([
      [
        "x.ts",
        [
          '// if (caps.kind === "al-runner-v3") {',
          'type K = "bcdev" | "al-runner-v3";',
          'const xs = ["a", "b"].includes(name);',
        ].join("\n"),
      ],
    ]);
    expect(unclassified(files, {})).toEqual({ fresh: [], stale: [] });
  });

  test("R611 direction 1: a file in a subfolder of src is scanned", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-r611-src-"));
    try {
      mkdirSync(join(root, "deep", "er"), { recursive: true });
      writeFileSync(join(root, "top.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "deep", "er", "x.ts"), 'if (caps.kind === "bcdev") {\n');
      writeFileSync(join(root, "deep", "er", "x.test.ts"), 'if (caps.kind === "bcdev") {\n');
      const files = readSrc(root);
      expect([...files.keys()].sort()).toEqual(["deep/er/x.ts", "top.ts"]);
      expect(unclassified(files, {}).fresh).toEqual(['deep/er/x.ts: if (caps.kind === "bcdev") {']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    measurePredefinedSymbols: async (): Promise<{ symbols: string[] }> => ({ symbols: [...set] }),
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

  // R654: the .NET al-runner's R392 probe branch is gone; its other direction (a v2-kind backend
  // without the probe refused) went with the kind.
  test("T27: v3 never calls a predefined-symbol probe, and its build set has no predefined symbol", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      let probed = 0;
      const b = Object.assign(new V3KindStub(undefined), {
        measurePredefinedSymbols: async (): Promise<{ symbols: string[] }> => {
          probed += 1;
          return { symbols: ["CLEANSCHEMA25"] };
        },
      });
      await v3Session(root, store, b);
      expect(probed).toBe(0);
      expect(store.getRun(1)?.buildSymbols).toEqual([]);
    });
  });

  test("workers > 1 is refused for v3 by name", async () => {
    await inProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const mk = () => withProbe(new V3KindStub([]), []);
      await expect(v3Session(root, store, mk(), { workers: 2 })).rejects.toThrow(
        /refused for the al-runner-v3 backend/,
      );
    });
  });
});
