import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunEventInput } from "../src/events";
import { generateMutationSet } from "../src/orchestrator";
import { CAVEAT_INTERPRETATIONS, renderConsole } from "../src/report";
import { foldEvents } from "../src/report-fold";
import type { FoldStatics } from "../src/report-fold";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R144. `generateMutationSet` drops every matched site that is not inside executable AL — an AL
 * page/report property is declarative and has no statement to wrap — and before this the count
 * reached one `warn(...)` on stderr and nothing else. A reader of a report could not tell a project
 * with no declarative surface from one where LethAL silently declined 154 sites, and no gate could
 * pin either.
 *
 * The drop itself is R135's ruling ("LethAL does not mutate declarative surfaces"). These tests are
 * about the second half of that ruling: the report has to SAY so.
 *
 * The declarative shape used below was measured, not guessed (2026-08-14, grammar 4.0.x): a page
 * property whose value is a boolean EXPRESSION (`Enabled = Rec.Amount > 0`) is still claimed by
 * `lethal.conditional-boundary` and still dropped, whereas `SubPageLink`, `SourceTableView`,
 * `TableRelation ... where(...)`, `DataItemTableFilter` and `RunPageLink` no longer parse as
 * comparison expressions at all under the current grammar and produce no spec to drop.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 79300, to: 79399 }],
});

const CODEUNIT_AL = `codeunit 79300 "Logic"
{
    procedure P(N: Integer): Integer
    begin
        if N > 10 then
            exit(1);
        exit(0);
    end;
}
`;

/** Two declarative sites, both boolean expressions in page properties. */
const PAGE_WITH_DECLARATIVE_AL = `page 79300 "Probe Card"
{
    layout
    {
        area(content)
        {
            field(A; Rec.A)
            {
                ApplicationArea = All;
                Enabled = Rec.Amount > 0;
                Editable = Rec.Amount < 100;
            }
        }
    }
}
`;

/** The same page with the two declarative properties removed — the control. */
const PAGE_WITHOUT_DECLARATIVE_AL = `page 79300 "Probe Card"
{
    layout
    {
        area(content)
        {
            field(A; Rec.A)
            {
                ApplicationArea = All;
            }
        }
    }
}
`;

async function withProject(
  files: Readonly<Record<string, string>>,
  body: (projectDir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lethal-decl-"));
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

describe("generateMutationSet — declarative sites are counted, not just warned about", () => {
  test("a page property holding a boolean expression is reported per file, with its object kind", async () => {
    await withProject(
      {
        "Al/Codeunit/Logic.Codeunit.al": CODEUNIT_AL,
        "Al/Page/Probe.Page.al": PAGE_WITH_DECLARATIVE_AL,
      },
      async (projectDir) => {
        const { declarativeSites } = await generateMutationSet(projectDir);
        expect(declarativeSites).toHaveLength(1);
        const [only] = declarativeSites;
        if (only === undefined) throw new Error("unreachable — length asserted above");
        expect(only.file.replaceAll("\\", "/")).toBe("Al/Page/Probe.Page.al");
        expect(only.kinds).toBe("page_declaration");
        expect(only.sites).toBe(2);
      },
    );
  });

  test("a project with no declarative surface reports a measured empty list, never a missing one", async () => {
    await withProject({ "Al/Codeunit/Logic.Codeunit.al": CODEUNIT_AL }, async (projectDir) => {
      const { declarativeSites } = await generateMutationSet(projectDir);
      expect(declarativeSites).toEqual([]);
    });
  });

  /**
   * CONTROL — passes whether or not the reporting above exists. A declarative site produces NO
   * mutant, so adding two of them must not move the executable mutant set by one spec. If this ever
   * fails, the drop itself regressed and the counting is the least of the problems.
   */
  test("declarative properties change no executable mutant", async () => {
    await withProject(
      {
        "Al/Codeunit/Logic.Codeunit.al": CODEUNIT_AL,
        "Al/Page/Probe.Page.al": PAGE_WITH_DECLARATIVE_AL,
      },
      async (withDecl) => {
        const a = await generateMutationSet(withDecl);
        await withProject(
          {
            "Al/Codeunit/Logic.Codeunit.al": CODEUNIT_AL,
            "Al/Page/Probe.Page.al": PAGE_WITHOUT_DECLARATIVE_AL,
          },
          async (withoutDecl) => {
            const b = await generateMutationSet(withoutDecl);
            expect(a.files.map((f) => f.specs.length)).toEqual(b.files.map((f) => f.specs.length));
            expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path));
          },
        );
      },
    );
  });
});

const STATICS: FoldStatics = {
  caps: { authoritative: true, coverage: "procedure", deploy: "publish", isolation: "session" },
};

function foldWith(
  declarativeSiteFiles: readonly { file: string; kinds: string; sites: number }[],
): ReturnType<typeof foldEvents> {
  const events: RunEventInput[] = [
    {
      type: "mutation-set-generated",
      siteCount: 1,
      deployedCount: 1,
      totalFiles: 2,
      instrumentableFiles: 1,
      notInstrumentedFiles: [],
      declarativeSiteFiles,
      excludedByOnly: 0,
      excludedByOperator: 0,
    },
    {
      type: "baseline-batch-finished",
      batchIndex: 0,
      verdicts: [{ name: "T.a", outcome: "pass", classification: [] }],
    },
    {
      type: "coverage-split",
      batchIndex: 0,
      untargetedTriggerCount: 0,
      coveredCount: 1,
      noCoverageCount: 0,
    },
    { type: "session-finished", elapsedMs: 10 },
  ];
  return foldEvents(
    STATICS,
    events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent),
  );
}

describe("foldEvents — the declarative count reaches the report", () => {
  test("carries the per-file rows off `mutation-set-generated`", () => {
    const folded = foldWith([
      { file: "Al/Page/Probe.Page.al", kinds: "page_declaration", sites: 2 },
    ]);
    expect(folded.declarativeSites).toEqual([
      { file: "Al/Page/Probe.Page.al", kinds: "page_declaration", sites: 2 },
    ]);
  });

  test("an empty list folds to an empty list, not to undefined", () => {
    expect(foldWith([]).declarativeSites).toEqual([]);
  });
});

describe("buildReport — the count, the caveat and the console line", () => {
  function build(declarativeSites: readonly { file: string; kinds: string; sites: number }[]) {
    return legacyBuildReport({
      caps: { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
      baselineGreen: true,
      batches: 1,
      outcomes: [],
      unsupportedTests: [],
      notInstrumented: { totalFiles: 2, files: [] },
      declarativeSites,
      timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
      preprocessorSymbols: [],
      untargetedTriggerCount: 0,
      baselineTests: [{ codeunitName: "Tests" }],
    });
  }

  test("carries the per-file rows, the totals and the caveat", () => {
    const r = build([
      { file: "Al/Page/Probe.Page.al", kinds: "page_declaration", sites: 2 },
      { file: "Al/Report/R.Report.al", kinds: "report_declaration", sites: 3 },
    ]);
    expect(r.declarativeSites.siteCount).toBe(5);
    expect(r.declarativeSites.fileCount).toBe(2);
    expect(r.declarativeSites.files).toHaveLength(2);
    expect(r.validity.caveats).toContain("declarative-sites-dropped");
    const out = renderConsole(r);
    expect(out).toContain("DECLARATIVE SITES REFUSED: 5 matched site(s) in 2 file(s)");
    expect(out).toContain("Al/Page/Probe.Page.al (page_declaration, 2 site(s))");
  });

  test("a project with no declarative surface reports zeros, no caveat and no console line", () => {
    const r = build([]);
    expect(r.declarativeSites).toEqual({ siteCount: 0, fileCount: 0, files: [] });
    expect(r.validity.caveats).not.toContain("declarative-sites-dropped");
    expect(renderConsole(r)).not.toContain("DECLARATIVE SITES REFUSED");
  });
});

describe("CAVEAT_INTERPRETATIONS — what the number means", () => {
  test("states that these are neither survivors, nor no-coverage, nor a missing operator", () => {
    const i = CAVEAT_INTERPRETATIONS["declarative-sites-dropped"];
    expect(i.basis).toBe("R144");
    expect(i.entailedNegative).toMatch(/surviv/i);
    expect(i.entailedNegative).toMatch(/no-coverage/i);
  });
});
