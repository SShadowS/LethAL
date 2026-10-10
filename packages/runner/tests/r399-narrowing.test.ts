import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { RunEvent, RunEventInput } from "../src/events";
import { generateMutationSet } from "../src/orchestrator";
import { buildReport, renderConsole } from "../src/report";
import { removeScratchDir } from "./helpers/scratch";

/**
 * R399: a left-out `preproc-undecided` or `not-instrumentable` row with sites makes `reliability`
 * narrowed, as an `instrumentation-refused` row has since R307. Every case here is flag-free and
 * carries NO refused row, so the new conditions cannot hide behind R307's or a filter's.
 * `compiled-out` and `declarative` rows stay non-narrowing; a zero-site undecided row too.
 */

const CAPS = {
  authoritative: true,
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
} as const;

type Row = { file: string; kinds: string; sites: number };
const UNDECIDED = (sites: number) => ({
  file: "src/Undecided.Codeunit.al",
  kinds: "codeunit_declaration",
  sites,
  reason: "preproc-undecided" as const,
  detail: "unparsed-condition at line 5",
});
const COMPILED_OUT = {
  file: "src/Out.Codeunit.al",
  kinds: "codeunit_declaration",
  sites: 4,
  reason: "compiled-out" as const,
  detail: "symbols []",
};
const QUERY: Row = { file: "src/Q.Query.al", kinds: "query_declaration", sites: 2 };
const PAGE: Row = { file: "src/P.Page.al", kinds: "page_declaration", sites: 3 };

function reportFor(
  input: {
    readonly preproc?: readonly ReturnType<typeof UNDECIDED>[] | readonly (typeof COMPILED_OUT)[];
    readonly skipped?: readonly Row[];
    readonly declarative?: readonly Row[];
  },
  baselineRed = false,
) {
  const events: RunEvent[] = (
    [
      {
        type: "mutation-set-generated",
        siteCount: 3,
        deployedCount: 3,
        hangCapableCount: 0,
        totalFiles: 10,
        instrumentableFiles: 8,
        notInstrumentedFiles: input.skipped ?? [],
        declarativeSiteFiles: input.declarative ?? [],
        preprocExcludedFiles: input.preproc ?? [],
        excludedByOnly: 0,
        excludedByExclude: 0,
        excludedByOperator: 0,
      },
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: baselineRed
          ? [{ name: "T.A", outcome: "fail", durationMs: 1, classification: [] }]
          : [],
      },
      { type: "session-finished", elapsedMs: 10 },
    ] as RunEventInput[]
  ).map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
  return buildReport({ caps: CAPS, buildSymbols: [] }, events);
}

describe("R399: reliability for undecided and not-instrumentable rows", () => {
  test("one undecided row with sites -> narrowed", () => {
    expect(reportFor({ preproc: [UNDECIDED(4)] }).validity.reliability).toBe("narrowed");
  });
  test("one not-instrumentable row -> narrowed", () => {
    expect(reportFor({ skipped: [QUERY] }).validity.reliability).toBe("narrowed");
  });
  test("an undecided row with zero sites -> full", () => {
    expect(reportFor({ preproc: [UNDECIDED(0)] }).validity.reliability).toBe("full");
  });
  test("compiled-out rows only -> full", () => {
    expect(reportFor({ preproc: [COMPILED_OUT] }).validity.reliability).toBe("full");
  });
  test("declarative rows only -> full", () => {
    expect(reportFor({ declarative: [PAGE] }).validity.reliability).toBe("full");
  });
  test("with a red baseline: narrowed-degraded for each new condition", () => {
    expect(reportFor({ preproc: [UNDECIDED(4)] }, true).validity.reliability).toBe(
      "narrowed-degraded",
    );
    expect(reportFor({ skipped: [QUERY] }, true).validity.reliability).toBe("narrowed-degraded");
    // the controls stay merely degraded
    expect(reportFor({ preproc: [UNDECIDED(0)] }, true).validity.reliability).toBe("degraded");
  });
  test("the SCOPE line names the left-out sites", () => {
    const scope = (r: ReturnType<typeof reportFor>) =>
      renderConsole(r)
        .split("\n")
        .filter((l) => l.startsWith("SCOPE: "));
    expect(scope(reportFor({ preproc: [UNDECIDED(4)] }))).toEqual([
      "SCOPE: narrowed [preproc-files-refused] - 0 scored mutant(s) in 10 .al file(s); 1 file(s) with undecided #if, 4 site(s) not mutated",
    ]);
    expect(scope(reportFor({ skipped: [QUERY] }))).toEqual([
      "SCOPE: narrowed [uninstrumentable-files] - 0 scored mutant(s) in 10 .al file(s); 1 file(s) not instrumentable, 2 site(s) not mutated",
    ]);
  });
  test("the console no longer says only a codeunit or a table can carry the selector", () => {
    const text = renderConsole(reportFor({ skipped: [QUERY] }));
    expect(text).not.toContain("Only a codeunit or a table");
    expect(text).toContain("pageextension");
  });
});

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});
// A directive wrapped in a comment: LethAL cannot decide it, so the file is `preproc-undecided`.
const UNDECIDED_AL = `codeunit 50012 "Undecided"
{
    procedure Run(X: Integer)
    begin
/*
#if R12SYM
*/
        Helper(X + 1);
/*
#endif
*/
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;
const MIXED_AL = `codeunit 79302 "Mixed"
{
    procedure Q(): Boolean
    begin
        exit(true);
    end;
}

page 79303 "Mixed Page"
{
    PageType = Card;
    layout { area(Content) { } }
}
`;
const QUERY_AL = `query 79332 "Scope Query"
{
    elements
    {
        dataitem(Main; Customer)
        {
            column(No_; "No.") { }
        }
    }

    var
        Threshold: Integer;

    trigger OnBeforeOpen()
    begin
        if Threshold = 0 then
            Threshold := 10;
    end;
}
`;

const roots: string[] = [];
beforeAll(async () => {
  await initParser();
});
afterAll(() => {
  for (const r of roots) removeScratchDir(r);
});
async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r399-"));
  roots.push(root);
  await Bun.write(join(root, "app.json"), APP_JSON);
  for (const [rel, content] of Object.entries(files)) await Bun.write(join(root, rel), content);
  return root;
}

describe("R399: generation", () => {
  test("nothing left to measure: the error names the refused AND the undecided files", async () => {
    const dir = await project({
      "src/Mixed.al": MIXED_AL,
      "src/Undecided.Codeunit.al": UNDECIDED_AL,
    });
    const err = await generateMutationSet(dir, { emit: () => {} }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("nothing is left to measure");
    expect(message).toContain("object-mix in src/Mixed.al");
    expect(message).toContain("src/Undecided.Codeunit.al");
    expect(message).toContain("undecided");
  });

  test("an undecided-only project still does NOT throw", async () => {
    const dir = await project({ "src/Undecided.Codeunit.al": UNDECIDED_AL });
    const set = await generateMutationSet(dir, { emit: () => {} });
    expect(set.files).toEqual([]);
    expect(set.preprocExcluded.map((f) => f.reason)).toEqual(["preproc-undecided"]);
  });

  test("control: an operator filter that removes a query's sites leaves no row", async () => {
    const dir = await project({
      "src/Q.Query.al": QUERY_AL,
      "src/Good.Codeunit.al": MIXED_AL.split("\npage")[0] ?? "",
    });
    const plain = await generateMutationSet(dir, { emit: () => {} });
    expect(plain.skipped.map((s) => s.file)).toEqual(["src/Q.Query.al"]);
    const filtered = await generateMutationSet(dir, {
      emit: () => {},
      operators: ["lethal.return-value"],
    });
    expect(filtered.skipped).toEqual([]);
  });
});
