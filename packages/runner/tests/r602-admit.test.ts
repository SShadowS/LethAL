// R602: al-runner v3 coverage is ON for a project whose multi-object files and single-wrapper `#if`
// files are all shapes the coverage index places (measured: /coord/handoff/R-602/measure.md, v3
// reports every statement in its own file's frame). Every other wrapper shape keeps coverage OFF,
// by name. Each test goes red when its one guard is reverted (see /coord/handoff/R-602/redcheck.md).
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser, parseAL, wrapRoot } from "@lethal/engine";
import {
  AlRunnerCoverageFrameError,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
} from "../src/al-runner-coverage";
import { v3CoverageMode } from "../src/cli";
import { coverageRefusedObjects, wrappedRuleFor } from "../src/line-map";
import { removeScratchDir } from "./helpers/scratch";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) removeScratchDir(d);
});
beforeAll(async () => {
  await initParser();
});

async function bundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r602-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(dir, rel);
    await mkdir(join(dest, ".."), { recursive: true });
    await writeFile(dest, body, "utf8");
  }
  return dir;
}

const body = (id: number, name: string, proc: string) => `codeunit ${id} "${name}"
{
    procedure ${proc}(): Integer
    begin
        exit(1);
    end;
}
`;
/** Two codeunits in one file; the second one's `exit(1)` is on line 13. */
const MULTI = `${body(50601, "R602 A", "One")}\n${body(50602, "R602 B", "Two")}`;
const WRAPPED_ONE = `#if SYM\n${body(50603, "R602 W", "Hit")}#endif\n`;
const WRAPPED_TWO_ARM = `#if SYM\n${body(50604, "R602 Arms", "Hit")}#else\n${body(50604, "R602 Arms", "Other")}#endif\n`;
const WRAPPED_MULTI = `#if SYM\n${body(50605, "R602 WM", "Hit")}#endif\n${body(50606, "R602 WM2", "Hit")}`;
const files = (src: Record<string, string>) =>
  Object.entries(src).map(([path, text]) => ({ path, root: wrapRoot(parseAL(text)) }));

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");

describe("R602 build review M1: the guard on the REAL fixtures", () => {
  test("sandbox-wrapped as a whole is OFF, and the warning names the WrappedArms file", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await v3CoverageMode("al-runner", join(FIXTURES, "sandbox-wrapped"))).toBe("none");
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        '[lethal] al-runner-v3-coverage-off: coverage is turned OFF for this run (coverage "none"): the coverage index has no rule for the #if wrapper shape (two-arm, #elif, nested, or a multi-object file holding a wrapper) in src/WrappedArms.Codeunit.al (R602).',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("sandbox-multiobject, and the fixtures no committed v3 figure may move on, stay ON with no warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const f of [
        "sandbox-multiobject",
        "sandbox-app",
        "sandbox-data",
        "sandbox-layout",
        "sandbox-symbols",
        "sandbox-names",
      ]) {
        expect([f, await v3CoverageMode("al-runner", join(FIXTURES, f))]).toEqual([f, "al-runner"]);
      }
      expect(warn.mock.calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("R602 A3: the v3 CLI guard keeps coverage ON for a multi-object-only project", () => {
  test("a multi-object file and a single-wrapper file: coverage stays al-runner, no warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = await bundle({ "src/M.Codeunit.al": MULTI, "src/W.Codeunit.al": WRAPPED_ONE });
      expect(await v3CoverageMode("al-runner", dir)).toBe("al-runner");
      expect(warn.mock.calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("R602 B1: a single-wrapper file is no longer refused in selection on v3", () => {
  test("the v3 rule refuses nothing for an admitted wrapped file", async () => {
    expect(wrappedRuleFor("al-runner-v3")).toBe("al-runner-index");
    expect(
      coverageRefusedObjects(
        files({ "src/W.Codeunit.al": WRAPPED_ONE }),
        wrappedRuleFor("al-runner-v3"),
      ).size,
    ).toBe(0);
  });
});

describe("R602 B2: any other wrapper shape keeps coverage OFF, and the warning names the file", () => {
  const SENTENCE =
    'coverage is turned OFF for this run (coverage "none"): the coverage index has no rule for the #if wrapper shape (two-arm, #elif, nested, or a multi-object file holding a wrapper) in';
  for (const [name, text] of [
    ["a two-arm #if/#else file", WRAPPED_TWO_ARM],
    ["a multi-object file holding a wrapper", WRAPPED_MULTI],
  ] as const) {
    test(`${name} turns it off; a plain neighbour is not named`, async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const dir = await bundle({
          "src/Odd.Codeunit.al": text,
          "src/M.Codeunit.al": MULTI,
        });
        expect(await v3CoverageMode("al-runner", dir)).toBe("none");
        expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
          `[lethal] al-runner-v3-coverage-off: ${SENTENCE} src/Odd.Codeunit.al (R602).`,
        ]);
      } finally {
        warn.mockRestore();
      }
    });
  }
  test("a configured none stays none and says nothing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = await bundle({ "src/Odd.Codeunit.al": WRAPPED_TWO_ARM });
      expect(await v3CoverageMode("none", dir)).toBe("none");
      expect(warn.mock.calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("R602 D: a scope that disagrees with its position THROWS in an admitted wrapped file", () => {
  test("the frame is not the one measured, so the session stops instead of dropping the line", async () => {
    const dir = await bundle({ "src/W.Codeunit.al": WRAPPED_ONE });
    const index = await buildAlRunnerCoverageIndex(dir, { symbols: ["SYM"] });
    // Line 6 is `exit(1);` inside `Hit`; v3 names it "Other".
    const row = (scope: string) => ({
      test: "Codeunit1.T",
      coverage: [{ file: "src/W.Codeunit.al", statements: [{ line: 6, hits: 1, scope }] }],
    });
    expect(() => alRunnerCoverageFromServer(row("Other"), index)).toThrow(
      AlRunnerCoverageFrameError,
    );
    // The direction that must not fire: the agreeing scope.
    expect(alRunnerCoverageFromServer(row("Hit"), index).entries).toEqual([
      { objectType: "Codeunit", objectId: 50603, procedure: "Hit", line: 6 },
    ]);
  });
});
