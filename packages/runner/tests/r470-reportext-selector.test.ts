import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";

/**
 * R470: a report's globals and its reportextensions' globals share one namespace, so the selector
 * variable PLAN declares in each object that carries a mutant must not share a name across them.
 * Measured with alc 18.0.43: a report and a reportextension both declaring `MutationSelector` give
 * AL0155 on both, and so do two reportextensions of one report sharing any fixed name. A
 * reportextension's selector is `MutationSelector<its object id>` (suffixed if that identifier is
 * already in its file); every other kind keeps `MutationSelector`.
 *
 * Exact text, not compile success, is what pins it: renaming the declaration but not the guards
 * would still compile against the base report's own selector, binding the extension's guards to
 * the wrong variable.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee70",
  name: "R470",
  publisher: "P",
  version: "1.0.0.0",
  runtime: "16.0",
  idRanges: [{ from: 50470, to: 50489 }],
});

const BASE_AL = `report 50470 "R470 Base"
{
    ProcessingOnly = true;
    UsageCategory = None;

    dataset
    {
        dataitem(IntItem; Integer)
        {
            DataItemTableView = where(Number = filter(1 .. 3));
        }
    }

    procedure Twice(N: Integer): Integer
    begin
        exit(N + N);
    end;

    var
        Seen: Integer;
}
`;

/** Has a var section. */
const EXT_A_AL = `reportextension 50471 "R470 ExtA" extends "R470 Base"
{
    procedure Step(N: Integer): Integer
    begin
        Total := N;
        exit(N + 1);
    end;

    var
        Total: Integer;
}
`;

/** No var section: the selector is appended after the last member. */
const EXT_B_AL = `reportextension 50472 "R470 ExtB" extends "R470 Base"
{
    procedure Back(N: Integer): Integer
    begin
        exit(N - 1);
    end;
}
`;

/** Already declares the name its id would give it, so the selector must take a suffix. */
const EXT_C_AL = `reportextension 50473 "R470 ExtC" extends "R470 Base"
{
    procedure Tick(N: Integer): Integer
    begin
        MutationSelector50473 := N;
        exit(N + 2);
    end;

    var
        MutationSelector50473: Integer;
}
`;

/** A control of another kind in the same project: keeps the bare name. */
const CU_AL = `codeunit 50474 "R470 Cu"
{
    procedure P(N: Integer): Integer
    begin
        exit(N + 3);
    end;
}
`;

const FILES: Readonly<Record<string, string>> = {
  "src/Base.Report.al": BASE_AL,
  "src/ExtA.ReportExt.al": EXT_A_AL,
  "src/ExtB.ReportExt.al": EXT_B_AL,
  "src/ExtC.ReportExt.al": EXT_C_AL,
  "src/Cu.Codeunit.al": CU_AL,
};

const out: Record<string, string> = {};

beforeAll(async () => {
  await initParser();
  const root = await mkdtemp(join(tmpdir(), "lethal-r470-"));
  const projectDir = join(root, "app");
  const target = join(root, "out");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  for (const [rel, content] of Object.entries(FILES))
    await Bun.write(join(projectDir, rel), content);
  try {
    const set = await generateMutationSet(projectDir, { emit: () => {} });
    await writeInstrumentedProject({
      targetDir: target,
      files: set.files,
      selectorIds: { selectorId: 50487, controlId: 50488, tableId: 50489 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee70",
      operatorTiers,
      identityOrdinals: identityOrdinalsOf(set),
    });
    for (const rel of Object.keys(FILES)) {
      const base = rel.slice("src/".length);
      out[base] = await readFile(join(target, base), "utf8");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Every selector call's receiver in the text (`X.Active(` / `X.Reached(`). */
function receivers(text: string): string[] {
  return [...text.matchAll(/(\w+)\.(?:Active|Reached)\('/g)].map((m) => m[1] ?? "");
}
/** Every selector declaration's name in the text. */
function declarations(text: string): string[] {
  return [...text.matchAll(/(\w+): Codeunit "Mutation Selector";/g)].map((m) => m[1] ?? "");
}

describe("R470: a reportextension's selector is named after its own object id", () => {
  test("every file carries guards (the precondition of every other test)", () => {
    for (const name of Object.keys(out))
      expect(receivers(out[name] ?? "").length).toBeGreaterThan(0);
  });

  // Over-broad fix (rename every kind): the report and the codeunit go red.
  test("the report and the codeunit keep the bare MutationSelector", () => {
    for (const name of ["Base.Report.al", "Cu.Codeunit.al"]) {
      const text = out[name] ?? "";
      expect(declarations(text)).toEqual(["MutationSelector"]);
      expect(new Set(receivers(text))).toEqual(new Set(["MutationSelector"]));
    }
  });

  // Missing fix: ExtA and ExtB declare and call the bare name. Declaration-only rename: their
  // receivers stay bare and this goes red although alc would accept it.
  test("each extension declares and calls MutationSelector<its id>, with or without a var section", () => {
    for (const [name, id] of [
      ["ExtA.ReportExt.al", 50471],
      ["ExtB.ReportExt.al", 50472],
    ] as const) {
      const text = out[name] ?? "";
      expect(declarations(text)).toEqual([`MutationSelector${id}`]);
      expect(new Set(receivers(text))).toEqual(new Set([`MutationSelector${id}`]));
    }
  });

  test("an id-named identifier already in the file pushes the selector to a suffix", () => {
    const text = out["ExtC.ReportExt.al"] ?? "";
    expect(declarations(text)).toEqual(["MutationSelector50473_1"]);
    expect(new Set(receivers(text))).toEqual(new Set(["MutationSelector50473_1"]));
    // The user's own Integer is untouched.
    expect(text).toContain("MutationSelector50473: Integer;");
  });

  test("the report and its three extensions declare four distinct names", () => {
    const names = [
      "Base.Report.al",
      "ExtA.ReportExt.al",
      "ExtB.ReportExt.al",
      "ExtC.ReportExt.al",
    ].flatMap((n) => declarations(out[n] ?? ""));
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
  });
});
