import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { MAX_MUTATION_TEXT, clipMutationText } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { hashSourceSnapshot, readTargetSource } from "../src/baseline-snapshot";
import { explainFromCli } from "../src/cli";
import {
  type ExplainSourceMark,
  MalformedReportError,
  ProjectSourceRefusedError,
  REDACTION_MARKER,
  explain,
} from "../src/explain";
import { runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";

/**
 * R274: `lethal explain --project <dir>` renders each gap's source with its survivors marked, and
 * only from source that hashes to the report's `sourceSha256`. Driven through a real `runSession`
 * so every offset is one generation recorded. The target file has a UTF-8 BOM, CRLF line ends, a
 * tab, a site spanning two lines and a site longer than the manifest's 600-character clip, and it
 * lives under `src/` so the report's `/` path meets the snapshot's key.
 */

const APP_JSON = JSON.stringify({
  id: "4a7d1c52-8b8e-4f0e-9f41-3c6b2d1e5274",
  name: "R274 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 80000 }],
  // R214: an app.json symbol beside the config's, so the hash must use the CONFIG's alone.
  preprocessorSymbols: ["APPSYM"],
});
const selectorIds = { selectorId: 50290, controlId: 50291, tableId: 50292 };
const FILE = "src/SrcOps.Codeunit.al";
const LONG = "y".repeat(MAX_MUTATION_TEXT + 50);
const TARGET = `﻿${[
  'codeunit 50100 "Src Ops"',
  "{",
  "    procedure Bump(): Integer",
  "    var",
  "        X: Integer;",
  "        S: Text;",
  "    begin",
  "        X := X + 1;",
  "        X := X +",
  "            2;",
  `        S := '${LONG}';`,
  "        if X > 0 then begin",
  "\t\tX := X * 3;",
  "        end;",
  "        exit(X);",
  "    end;",
  "}",
  "",
].join("\r\n")}`;

const TEST_AL = `codeunit 50200 "Src Tests"
{
    Subtype = Test;

    [Test]
    procedure BumpWorks()
    begin
    end;
}
`;

/** Every mutant survives; the baseline covers `Bump`. */
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
          entries: [{ objectType: "Codeunit", objectId: 50100, procedure: "Bump" }],
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

async function world() {
  const root = await mkdtemp(join(tmpdir(), "lethal-r274-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(projectDir, FILE), TARGET);
  await Bun.write(join(testDir, "SrcTests.Codeunit.al"), TEST_AL);
  const run = (emit?: (e: { readonly type: string }) => void) =>
    runSession({
      backend: new AllSurvive(),
      store: new ResultsStore(":memory:"),
      projectDir,
      testDir,
      instrumentedDir: join(root, "instr"),
      selectorIds,
      preprocessorSymbols: ["CFGSYM"],
      ...(emit !== undefined ? { emit: [emit] } : {}),
    });
  return { projectDir, run };
}

/** The file text a mark names, read back from the raw file by its own line/column arithmetic. */
function textAt(file: string, m: ExplainSourceMark): string {
  const lines = file.split("\n");
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
  return file.slice(offset(m.startLine, m.startColumn), offset(m.endLine, m.endColumn));
}

let fixture: {
  projectDir: string;
  report: SessionReport;
  source: ReadonlyMap<string, Buffer>;
};
beforeAll(async () => {
  const w = await world();
  const report = await w.run();
  fixture = { projectDir: w.projectDir, report, source: await readTargetSource(w.projectDir) };
});

const redacted = (r: SessionReport): SessionReport => ({
  ...r,
  mutants: r.mutants.map((m) => ({
    ...m,
    originalText: REDACTION_MARKER,
    mutatedText: REDACTION_MARKER,
  })),
});

describe("R274: the report records the source its positions refer to", () => {
  test("sourceSha256 is the generation hash over the CONFIG's symbols, not the build's", async () => {
    const { report, projectDir } = fixture;
    const snap = await readTargetSource(projectDir);
    expect(report.buildSymbols).toEqual(["APPSYM", "CFGSYM"]);
    expect(report.sourceSha256).toBe(hashSourceSnapshot(snap, ["CFGSYM"]));
    expect(report.sourceSha256).not.toBe(hashSourceSnapshot(snap, report.buildSymbols ?? []));
  });

  test("a mid-run edit: the report keeps the hash of the bytes generation parsed", async () => {
    const w = await world();
    const before = hashSourceSnapshot(await readTargetSource(w.projectDir), ["CFGSYM"]);
    const report = await w.run((e) => {
      if (e.type === "mutation-set-generated") {
        writeFileSync(join(w.projectDir, FILE), TARGET.replace("X + 1", "X + 4"));
      }
    });
    expect(report.sourceSha256).toBe(before);
    // The edited project is not that source: refused by name.
    const edited = await readTargetSource(w.projectDir);
    expect(() => explain(report, { projectSource: edited })).toThrow(ProjectSourceRefusedError);
    writeFileSync(join(w.projectDir, FILE), TARGET);
    const restored = await readTargetSource(w.projectDir);
    expect(explain(report, { projectSource: restored }).gaps?.length).toBeGreaterThan(0);
  });
});

describe("R274: explain --project renders each gap's source", () => {
  test("every survivor of every gap is marked exactly on its own text", async () => {
    const { report, projectDir } = fixture;
    const out = explain(report, { projectSource: await readTargetSource(projectDir) });
    const gaps = out.gaps ?? [];
    expect(gaps.length).toBeGreaterThan(1);
    const byCode = new Map(report.mutants.map((m) => [m.mutantCode, m]));
    for (const g of gaps) {
      expect(g.file).toBe(FILE);
      const src = g.source;
      if (src === undefined) throw new Error(`gap ${g.gapId} has no source`);
      expect(src.startLine).toBe(g.blockStartLine);
      expect(src.lines).toEqual(TARGET.split("\r\n").slice(g.blockStartLine - 1, g.blockEndLine));
      expect(src.marks.map((m) => m.mutantCode)).toEqual([...g.members]);
      for (const mark of src.marks) {
        const row = byCode.get(mark.mutantCode);
        expect(clipMutationText(textAt(TARGET, mark))).toBe(row?.originalText ?? "");
      }
    }
    const marks = gaps.flatMap((g) => g.source?.marks ?? []);
    // The shapes this fixture exists for are all among them.
    expect(marks.some((m) => m.endLine > m.startLine)).toBe(true);
    expect(
      marks.some((m) => byCode.get(m.mutantCode)?.originalText.includes("[truncated") === true),
    ).toBe(true);
    // The tab line: column 3 is the `X` after two tabs.
    expect(marks.some((m) => m.startLine === 13 && m.startColumn === 3)).toBe(true);
  });

  test("a redacted report renders the same marks", async () => {
    const { report, projectDir } = fixture;
    const source = await readTargetSource(projectDir);
    expect(explain(redacted(report), { projectSource: source }).gaps).toEqual(
      explain(report, { projectSource: source }).gaps,
    );
  });

  test("an unredacted originalText that is not the text at its offsets throws", () => {
    const { report } = fixture;
    const survivor = report.mutants.find((m) => m.verdict === "survived");
    if (survivor === undefined) throw new Error("no survivor");
    const wrong: SessionReport = {
      ...report,
      mutants: report.mutants.map((m) =>
        m === survivor ? { ...m, originalText: `${m.originalText} ` } : m,
      ),
    };
    expect(() => explain(wrong, { projectSource: fixture.source })).toThrow(MalformedReportError);
  });

  test("offsets past the end of the file throw, even on a redacted report", () => {
    const { report } = fixture;
    const survivor = report.mutants.find((m) => m.verdict === "survived");
    if (survivor === undefined) throw new Error("no survivor");
    const past = redacted({
      ...report,
      mutants: report.mutants.map((m) =>
        m === survivor ? { ...m, endIndex: TARGET.length + 5 } : m,
      ),
    });
    // By its own message: the block-line check after it would also throw, for another reason.
    expect(() => explain(past, { projectSource: fixture.source })).toThrow(
      `${survivor.mutantCode}'s offsets are not in ${FILE}`,
    );
  });

  test("snapshot keys with `\\` render under the report's `/` paths", () => {
    const { report } = fixture;
    const back = new Map([...fixture.source].map(([k, v]) => [k.replaceAll("/", "\\"), v]));
    expect([...back.keys()]).toContain("src\\SrcOps.Codeunit.al");
    expect(explain(report, { projectSource: back }).gaps).toEqual(
      explain(report, { projectSource: fixture.source }).gaps,
    );
  });

  test("--project adds no string but the verified project's own lines", () => {
    const strings = (v: unknown): string[] =>
      typeof v === "string"
        ? [v]
        : Array.isArray(v)
          ? v.flatMap(strings)
          : typeof v === "object" && v !== null
            ? Object.values(v).flatMap(strings)
            : [];
    const allowed = new Set([...strings(explain(fixture.report)), ...TARGET.split("\r\n")]);
    const out = explain(fixture.report, { projectSource: fixture.source });
    expect(strings(out).filter((s) => !allowed.has(s))).toEqual([]);
  });

  test("--project reaches exactly the gaps[].source paths explain.test.ts pins", () => {
    const paths = (v: unknown, at: string): string[] =>
      Array.isArray(v)
        ? v.flatMap((x) => paths(x, `${at}[]`))
        : typeof v === "object" && v !== null
          ? Object.entries(v).flatMap(([k, x]) => paths(x, `${at}.${k}`))
          : [at];
    const out = explain(fixture.report, { projectSource: fixture.source });
    const reached = new Set(paths(out, "$").filter((p) => p.startsWith("$.gaps[].source")));
    expect([...reached].sort()).toEqual(
      [
        "$.gaps[].source.startLine",
        "$.gaps[].source.lines[]",
        "$.gaps[].source.marks[].mutantCode",
        "$.gaps[].source.marks[].startLine",
        "$.gaps[].source.marks[].startColumn",
        "$.gaps[].source.marks[].endLine",
        "$.gaps[].source.marks[].endColumn",
      ].sort(),
    );
  });

  test("without a project, no gap carries source", () => {
    const gaps = explain(fixture.report).gaps ?? [];
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.filter((g) => "source" in g)).toEqual([]);
  });
});

describe("R274: refusals, by name", () => {
  test("a one-byte edit in any hashed file refuses as source-mismatch", () => {
    // The snapshot keys use the OS separator (`\` on Windows).
    const keys = [...fixture.source.keys()];
    expect(keys.map((k) => k.replaceAll("\\", "/")).sort()).toEqual(["app.json", FILE]);
    for (const key of keys) {
      const edited = new Map(fixture.source);
      const bytes = edited.get(key);
      if (bytes === undefined) throw new Error(`no ${key}`);
      edited.set(key, Buffer.concat([bytes, Buffer.from(" ")]));
      let err: unknown;
      try {
        explain(fixture.report, { projectSource: edited });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProjectSourceRefusedError);
      expect((err as ProjectSourceRefusedError).reason).toBe("source-mismatch");
      expect((err as Error).message).toContain("the source this report's positions refer to");
    }
  });

  test("a report without sourceSha256 refuses as no-source-hash", () => {
    const { sourceSha256: _, ...older } = fixture.report;
    let err: unknown;
    try {
      explain(older, { projectSource: fixture.source });
    } catch (e) {
      err = e;
    }
    expect((err as ProjectSourceRefusedError).reason).toBe("no-source-hash");
    // Without --project the same report explains as before.
    expect(explain(older).gaps?.length).toBeGreaterThan(0);
  });

  test("preprocessorSymbols that is not a string array is refused, not spread", () => {
    const bad = { ...fixture.report, preprocessorSymbols: "CFGSYM" } as unknown as SessionReport;
    expect(() => explain(bad, { projectSource: fixture.source })).toThrow(MalformedReportError);
  });

  test("a malformed sourceSha256 is refused at validation", () => {
    const bad = { ...fixture.report, sourceSha256: "abc" };
    expect(() => explain(bad)).toThrow(MalformedReportError);
  });

  test("CLI: a mismatch prints nothing on stdout; a match prints the sourced gaps", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-r274-cli-"));
    roots.push(root);
    const reportPath = join(root, "report.json");
    await Bun.write(reportPath, JSON.stringify(fixture.report));
    const log = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const other = join(root, "other");
      await Bun.write(join(other, "app.json"), APP_JSON);
      await Bun.write(join(other, FILE), TARGET.replace("X + 1", "X + 4"));
      await expect(
        explainFromCli({ mode: "explain", reportPath, projectDir: other }),
      ).rejects.toThrow(ProjectSourceRefusedError);
      expect(log).not.toHaveBeenCalled();

      await explainFromCli({ mode: "explain", reportPath, projectDir: fixture.projectDir });
      const printed = JSON.parse(String(log.mock.calls[0]?.[0])) as ReturnType<typeof explain>;
      expect(printed.gaps?.every((g) => g.source !== undefined)).toBe(true);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
