import { describe, expect, test } from "bun:test";
import { classify, parseAlcErrors, parseArgs, summarize } from "./r315-dc-compile";

const SAMPLE = [
  "/tmp/x/src/Foo.Codeunit.al(12,5): error AL0185: Codeunit 'Whatever' is missing",
  "C:\\p\\Bar.Table.al(3,1,3,9): error AL0118: The name 'q' does not exist",
  "/tmp/x/src/Foo.Codeunit.al(40,2): warning AL0789: ignored",
  "random line (1,1): error nope",
  "/tmp/x/src/Foo.Codeunit.al(99,5): error AL0185: Codeunit 'Other' is missing",
].join("\n");

describe("r315-dc-compile", () => {
  test("parseAlcErrors keeps code, file name and line only, and skips warnings", () => {
    const d = parseAlcErrors(SAMPLE);
    expect(d).toEqual([
      { code: "AL0185", file: "Foo.Codeunit.al", line: 12 },
      { code: "AL0118", file: "Bar.Table.al", line: 3 },
      { code: "AL0185", file: "Foo.Codeunit.al", line: 99 },
    ]);
    expect(JSON.stringify(d)).not.toContain("Whatever");
  });

  test("summarize counts by code then file", () => {
    expect(summarize(parseAlcErrors(SAMPLE))).toEqual({
      AL0185: { "Foo.Codeunit.al": 2 },
      AL0118: { "Bar.Table.al": 1 },
    });
  });

  test("classify: errors present in the control are environment, the surplus is emit", () => {
    const control = parseAlcErrors(SAMPLE);
    // The instrumented compile shifts lines, adds a third AL0185 in Foo and a new code in Baz.
    const inst = [
      ...control.map((d) => ({ ...d, line: d.line + 7 })),
      { code: "AL0185", file: "Foo.Codeunit.al", line: 200 },
      { code: "AL0631", file: "Baz.Codeunit.al", line: 5 },
    ];
    const r = classify(inst, control);
    expect(r.environment).toHaveLength(3);
    expect(r.emit).toEqual([
      { code: "AL0185", file: "Foo.Codeunit.al", line: 200 },
      { code: "AL0631", file: "Baz.Codeunit.al", line: 5 },
    ]);
    expect(classify(control, control).emit).toEqual([]);
  });

  test("parseArgs: three positionals, optional flags, refuses the rest", () => {
    const a = parseArgs(["p", "s", "o", "--control-symbol", "c.app", "--table-id", "7"]);
    expect(a).toMatchObject({
      projectDir: "p",
      symbolsDir: "s",
      outDir: "o",
      controlSymbol: "c.app",
    });
    expect(a.selectorIds).toEqual({ tableId: 7 });
    expect(() => parseArgs(["p", "s"])).toThrow("usage");
    expect(() => parseArgs(["p", "s", "o", "x"])).toThrow("usage");
    expect(() => parseArgs(["p", "s", "o", "--nope", "1"])).toThrow("unknown flag");
    expect(() => parseArgs(["p", "s", "o", "--table-id", "0"])).toThrow("positive integer");
    expect(() => parseArgs(["p", "s", "o", "--table-id"])).toThrow("needs a value");
  });

  test("parseArgs (R735): --isolate and --keep are positive integers, --keep needs --isolate", () => {
    expect(parseArgs(["p", "s", "o"]).isolate).toBeUndefined();
    const a = parseArgs(["p", "s", "o", "--isolate", "30"]);
    expect(a.isolate).toBe(30);
    expect(a.keep).toBe(2000);
    expect(parseArgs(["p", "s", "o", "--isolate", "2", "--keep", "500"]).keep).toBe(500);
    expect(() => parseArgs(["p", "s", "o", "--isolate", "0"])).toThrow("positive integer");
    expect(() => parseArgs(["p", "s", "o", "--isolate", "x"])).toThrow("positive integer");
    expect(() => parseArgs(["p", "s", "o", "--keep", "5"])).toThrow("--keep needs --isolate");
    expect(() => parseArgs(["p", "s", "o", "--isolate", "9", "--keep", "5"])).toThrow(
      "more than --keep",
    );
  });
});
