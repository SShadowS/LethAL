// PR-197 (R1113 fix 2): the TestHttpRequestPolicy of each selected test codeunit, read from source, carried on
// `tests-discovered` and printed before the run. Spec: docs/superpowers/specs/2026-11-19-pr197-r1113-outbound-http-warning.md.
import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { SelectorConfig } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { dryRunFromCli } from "../src/cli";
import { type RunEvent, createEmitter } from "../src/events";
import { httpPolicyLines, httpPolicyOf, policyOfCodeunit } from "../src/http-policy";
import { type SessionConfig, runSession } from "../src/orchestrator";
import { createProgressRenderer } from "../src/progress-renderer";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const cu = (id: number, name: string, policy: string | undefined, method = "T1") =>
  `codeunit ${id} "${name}"
{
    Subtype = Test;
${policy !== undefined ? `    TestHttpRequestPolicy = ${policy};\n` : ""}
    [Test]
    procedure ${method}()
    begin
    end;
}
`;

describe("policyOfCodeunit: the property inside the codeunit's own object text", () => {
  test("each value as written; none is the empty string", () => {
    expect(policyOfCodeunit(cu(1, "A", "BlockOutboundRequests"), "A")).toBe(
      "BlockOutboundRequests",
    );
    expect(policyOfCodeunit(cu(1, "A", "AllowOutboundFromHandler"), "A")).toBe(
      "AllowOutboundFromHandler",
    );
    expect(policyOfCodeunit(cu(1, "A", "AllowAllOutboundRequests"), "A")).toBe(
      "AllowAllOutboundRequests",
    );
    expect(policyOfCodeunit(cu(1, "A", undefined), "A")).toBe("");
  });
  test("a commented-out property is not read", () => {
    const src = cu(1, "A", undefined).replace(
      "Subtype = Test;",
      "Subtype = Test;\n    // TestHttpRequestPolicy = BlockOutboundRequests;",
    );
    expect(policyOfCodeunit(src, "A")).toBe("");
    const block = cu(1, "A", undefined).replace(
      "Subtype = Test;",
      "Subtype = Test;\n    /* TestHttpRequestPolicy = BlockOutboundRequests; */",
    );
    expect(policyOfCodeunit(block, "A")).toBe("");
  });
  test("two objects in one file: each its own property, and a name not in the file is undefined", () => {
    const src = `${cu(1, "Blocked", "BlockOutboundRequests")}\n${cu(2, "Open", undefined)}`;
    expect(policyOfCodeunit(src, "Blocked")).toBe("BlockOutboundRequests");
    expect(policyOfCodeunit(src, "Open")).toBe("");
    expect(policyOfCodeunit(src, "Elsewhere")).toBeUndefined();
  });
  test("the name compares without quotes and case", () => {
    expect(policyOfCodeunit(cu(1, "My Tests", "BlockOutboundRequests"), "my tests")).toBe(
      "BlockOutboundRequests",
    );
  });
});

describe("httpPolicyOf: classes over the selected tests", () => {
  const files: Record<string, string> = {
    "a.al": cu(1, "Open A", undefined),
    "b.al": cu(2, "Blocked B", "BlockOutboundRequests"),
    "c.al": cu(3, "Handler C", "AllowOutboundFromHandler"),
    "d.al": cu(4, "AllowAll D", "AllowAllOutboundRequests"),
  };
  const read = async (p: string) => {
    const f = files[p.split(/[\\/]/).pop() ?? ""]; // join() uses "\" on Windows
    if (f === undefined) throw new Error(`ENOENT ${p}`);
    return f;
  };
  test("block is not listed; handler apart; open and AllowAll listed; one entry per codeunit", async () => {
    const s = await httpPolicyOf(
      "/t",
      [
        { codeunitName: "Open A", file: "a.al" },
        { codeunitName: "Open A", file: "a.al" },
        { codeunitName: "Blocked B", file: "b.al" },
        { codeunitName: "Handler C", file: "c.al" },
        { codeunitName: "AllowAll D", file: "d.al" },
      ],
      read,
    );
    expect(s.codeunits).toBe(4);
    expect(s.open.map((e) => e.codeunit)).toEqual(["AllowAll D", "Open A"]);
    expect(s.handler.map((e) => e.codeunit)).toEqual(["Handler C"]);
    expect(s.unread).toEqual([]);
  });
  test("an unreadable file, no file, or a name the file lacks is unread, never safe", async () => {
    const s = await httpPolicyOf(
      "/t",
      [
        { codeunitName: "Gone", file: "gone.al" },
        { codeunitName: "No File" },
        { codeunitName: "Not In A", file: "a.al" },
      ],
      read,
    );
    expect(s.unread.map((e) => e.codeunit)).toEqual(["Gone", "No File", "Not In A"]);
    expect(s.open).toEqual([]);
  });
});

describe("httpPolicyLines", () => {
  const e = (n: number) => ({
    codeunit: `C${String(n).padStart(2, "0")}`,
    file: `c${n}.al`,
    policy: "",
  });
  test("all blocked: one line", () => {
    expect(httpPolicyLines({ codeunits: 3, open: [], handler: [], unread: [] })).toEqual([
      "outbound HTTP: all 3 selected test codeunit(s) block outbound calls (TestHttpRequestPolicy)",
    ]);
  });
  test("the head counts each class; up to 10 names; the rest named by count", () => {
    const lines = httpPolicyLines(
      {
        codeunits: 14,
        open: Array.from({ length: 12 }, (_, i) => e(i)),
        handler: [e(90)],
        unread: [e(91)],
      },
      "see X",
    );
    expect(lines[0]).toBe(
      "outbound HTTP: 12 of 14 selected test codeunit(s) set no TestHttpRequestPolicy that blocks outbound calls (1 more use AllowOutboundFromHandler; whether a handler lets a call out is not measured).",
    );
    expect(lines[1]).toBe("  unread: 1 (policy not read; never counted as blocking)");
    expect(lines[2]).toContain("R1113");
    expect(lines[3]).toContain("BlockOutboundRequests");
    expect(lines.filter((l) => /^ {2}C\d\d \(/.test(l))).toHaveLength(10);
    expect(lines.at(-1)).toBe("  ... and 4 more (see X)");
  });
});

// ———— through runSession: the run's FINAL test list ————

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "22222222-2222-2222-2222-222222222297",
  name: "PR-197 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const selectorIds: SelectorConfig = { selectorId: 50000, controlId: 50001, tableId: 50002 };

async function makeProject() {
  const root = scratch("lethal-pr197-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "Open.Codeunit.al"), cu(79100, "Open Tests", undefined, "OpenOne"));
  await Bun.write(
    join(testDir, "Blocked.Codeunit.al"),
    cu(79101, "Blocked Tests", "BlockOutboundRequests", "BlockedOne"),
  );
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

function fakeBackend(extra: Partial<ExecutionBackend> = {}): ExecutionBackend {
  const caps: BackendCapabilities = {
    coverage: "none",
    deploy: "publish",
    isolation: "session",
    kind: "bcdev",
    authoritative: true,
  };
  return {
    capabilities: () => caps,
    status: async (): Promise<BackendStatus> => ({ ok: true, details: "fake" }),
    deploy: async (): Promise<CompiledArtifact | null> => null,
    compileCheck: async () => {},
    activate: async () => {},
    run: async (ref: TestMethodRef): Promise<TestVerdict> => ({
      ref,
      outcome: "pass",
      durationMs: 1,
    }),
    ...extra,
  };
}

async function discovered(over: Partial<SessionConfig> = {}, backend = fakeBackend()) {
  const events: RunEvent[] = [];
  await runSession({
    backend,
    store: new ResultsStore(":memory:"),
    ...(await makeProject()),
    selectorIds,
    resourceServer: "http://pr197",
    resourceServerInstance: "BC",
    emit: [createEmitter([(e) => events.push(e)])],
    ...over,
  });
  const d = events.find((e) => e.type === "tests-discovered");
  if (d === undefined || d.type !== "tests-discovered") throw new Error("no tests-discovered");
  return d;
}

describe("runSession: tests-discovered carries httpPolicy for the final test list", () => {
  test("the open codeunit is listed, the blocked one is not", async () => {
    const d = await discovered();
    expect(d.httpPolicy?.codeunits).toBe(2);
    expect(d.httpPolicy?.open.map((e) => e.codeunit)).toEqual(["Open Tests"]);
    expect(d.httpPolicyFailed).toBeUndefined();
  });
  test("--exclude-test removing the open codeunit's only test leaves nothing listed", async () => {
    const d = await discovered({ excludeTests: ["Open Tests.OpenOne"] });
    expect(d.httpPolicy).toEqual({ codeunits: 1, open: [], handler: [], unread: [] });
  });
  test("--only narrows mutants, not tests: the open codeunit is still listed", async () => {
    const d = await discovered({ only: ["SandboxLogic.Codeunit.al"] });
    expect(d.httpPolicy?.open.map((e) => e.codeunit)).toEqual(["Open Tests"]);
  });
  test("the recheck's nested session (keepOnlyTests) does not repeat it", async () => {
    const d = await discovered(
      { keepOnlyTests: ["Open Tests.OpenOne"] },
      { ...fakeBackend(), methodIsolation: true },
    );
    expect(d.httpPolicy).toBeUndefined();
    expect(d.httpPolicyFailed).toBeUndefined();
  });
  test("a failed check prints its own line and the run goes on", () => {
    const out: string[] = [];
    const render = createProgressRenderer((l) => out.push(l), { heartbeatMs: 60_000 });
    render({
      type: "tests-discovered",
      tests: [],
      httpPolicyFailed: "boom",
    } as unknown as RunEvent);
    expect(out).toEqual(["outbound HTTP check failed: boom; the run continues"]);
  });
  test("the progress renderer prints the lines", () => {
    const out: string[] = [];
    const render = createProgressRenderer((l) => out.push(l), { heartbeatMs: 60_000 });
    const ev = {
      type: "tests-discovered",
      tests: [],
      httpPolicy: {
        codeunits: 1,
        open: [{ codeunit: "Open Tests", file: "Open.al", policy: "" }],
        handler: [],
        unread: [],
      },
    } as unknown as RunEvent;
    render(ev);
    expect(out[0]).toBe(
      "outbound HTTP: 1 of 1 selected test codeunit(s) set no TestHttpRequestPolicy that blocks outbound calls.",
    );
    expect(out).toContain("  Open Tests (Open.al)");
    expect(out.some((l) => l.includes("al-runner v3 opens no connection"))).toBe(true);
  });
});

describe("review fixes: never read as blocking when unsure", () => {
  test("a #if inside the object with a policy written makes it unread, not block", () => {
    const src = cu(1, "A", undefined).replace(
      "Subtype = Test;",
      "Subtype = Test;\n#if SOMESYM\n    TestHttpRequestPolicy = BlockOutboundRequests;\n#endif",
    );
    expect(policyOfCodeunit(src, "A")).toBeUndefined();
    // a directive with no policy written is still "" (open), never unread
    expect(
      policyOfCodeunit(
        cu(1, "B", undefined).replace("Subtype = Test;", "Subtype = Test;\n#if X\n#endif"),
        "B",
      ),
    ).toBe("");
  });
  test("a file the header reader refuses is that codeunit's unread; the others are still classed", async () => {
    const files: Record<string, string> = {
      "bad.al": "not an AL object at all",
      "ok.al": cu(2, "Ok", undefined),
    };
    const s = await httpPolicyOf(
      "/t",
      [
        { codeunitName: "Bad", file: "bad.al" },
        { codeunitName: "Ok", file: "ok.al" },
      ],
      async (p) => files[p.split(/[\\/]/).pop() ?? ""] ?? "",
    );
    expect(s.unread.map((e) => e.codeunit)).toEqual(["Bad"]);
    expect(s.open.map((e) => e.codeunit)).toEqual(["Ok"]);
  });
  test("the unread count is its own line", () => {
    const lines = httpPolicyLines({
      codeunits: 2,
      open: [],
      handler: [],
      unread: [{ codeunit: "X", file: "x.al", policy: "" }],
    });
    expect(lines).toContain("  unread: 1 (policy not read; never counted as blocking)");
  });
});

describe("the dry run prints the check over the whole suite", () => {
  test("with --tests: the lines and the whole-suite note; without: not checked", async () => {
    const root = scratch("lethal-pr197-dry-");
    const app = join(root, "app");
    const tests = join(root, "tests");
    await Bun.write(join(app, "src", "Logic.Codeunit.al"), TARGET_AL);
    await Bun.write(join(tests, "app.json"), "{}");
    await Bun.write(join(tests, "Open.Codeunit.al"), cu(79100, "Open Tests", undefined, "OpenOne"));
    const base = {
      mode: "dry-run" as const,
      projectDir: app,
      dbPath: join(root, "lethal.sqlite"),
      configPath: join(root, "lethal.config.json"),
    };
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      expect(await dryRunFromCli({ ...base, testDir: tests })).toBe(0);
      expect(lines).toContain(
        "outbound HTTP: 1 of 1 selected test codeunit(s) set no TestHttpRequestPolicy that blocks outbound calls.",
      );
      expect(lines.some((l) => l.includes("a dry run checks the whole test suite"))).toBe(true);
      lines.length = 0;
      expect(await dryRunFromCli(base)).toBe(0);
      expect(lines).toContain("outbound HTTP: not checked (no test project; pass --tests)");
    } finally {
      log.mockRestore();
    }
  });
});
