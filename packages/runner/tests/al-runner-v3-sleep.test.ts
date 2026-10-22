// R586 T30 and the pure halves of T32 (plan docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md §6).
import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import {
  AlRunnerV3CoverageJoinError,
  type SleepIndex,
  buildSleepIndex,
  decodeV3Coverage,
  sleepCallLines,
  sleepCallRefusal,
  sleepFileKey,
  sleepJoinRefusal,
  sleepPassRefusal,
} from "../src/al-runner-v3-sleep";

beforeAll(async () => {
  await initParser();
});

const SRC = `codeunit 1 X
{
    procedure P(Delay: Integer)
    var
        T: Codeunit "Y";
    begin
        Sleep(600000);
        // Sleep(5);
        Message('Sleep(5)');
        T.Sleep(3);
        if Delay > 0 then Sleep(Delay);
        sleep (Delay);
    end;
}
`;

describe("T30: the Sleep index finds bare Sleep( calls only", () => {
  test("a literal, a variable argument and any case are indexed", () => {
    expect(sleepCallLines(SRC)).toEqual([7, 11, 12]);
  });
  test("a comment, a string and X.Sleep( on a variable are not", () => {
    const lines = sleepCallLines(SRC);
    for (const l of [8, 9, 10]) expect(lines).not.toContain(l);
  });
  test("a test-app helper that sleeps is a call like any other", () => {
    const helper =
      "codeunit 50 H\n{\n    procedure Wait()\n    begin\n        Sleep(10);\n    end;\n}\n";
    expect(sleepCallLines(helper)).toEqual([5]);
  });
});

const FILE = "/x/active/Logic.Codeunit.al";
const index: SleepIndex = {
  byFile: new Map([[sleepFileKey(FILE), new Set([5])]]),
  shown: new Map([[sleepFileKey(FILE), FILE]]),
  sizes: { target: 1, test: 0 },
  roots: { target: "/x/active/", test: "/x/tests/" },
};

describe("I-1: an index whose roots join no path of the document is a named refusal", () => {
  const listing = (files: string[]) =>
    decodeV3Coverage(
      JSON.stringify({
        coverage: files.map((file) => ({ file, statements: [{ line: 1, hits: 1 }] })),
        perTestCoverage: [],
      }),
    );
  const TEST_FILE = "/x/tests/src/Tests.Codeunit.al";
  test("F2 still refuses: an indexed target file listed under ANOTHER prefix (its ending matches)", () => {
    const why = sleepJoinRefusal(listing([TEST_FILE, "/real/x/active/Logic.Codeunit.al"]), index);
    expect(why).toMatch(/al-runner-v3-coverage-join-refused/);
    expect(why).toMatch(/\/real\/x\/active\/Logic\.Codeunit\.al/);
    expect(why).toMatch(/\/x\/active\/logic\.codeunit\.al/);
  });
  test("F2 now admits the good project: no target file listed at all (a test codeunit exercising only test-app code, coverage none)", () => {
    expect(sleepJoinRefusal(listing([TEST_FILE]), index)).toBeUndefined();
  });
  test("F2: the indexed target file under its own root joins; another target file listed is fine", () => {
    expect(
      sleepJoinRefusal(listing([TEST_FILE, "/X/Active/Logic.Codeunit.al"]), index),
    ).toBeUndefined();
    expect(
      sleepJoinRefusal(listing([TEST_FILE, "/x/active/Other.Codeunit.al"]), index),
    ).toBeUndefined();
  });
  test("F2: the test side is always anchored: no listed path under the test root is refused", () => {
    expect(sleepJoinRefusal(listing(["/elsewhere/x/tests/src/Tests.Codeunit.al"]), index)).toMatch(
      /under the test root \/x\/tests\//,
    );
    expect(sleepJoinRefusal(listing([]), index)).toMatch(/under the test root/);
  });
  test("an empty index needs no join; an unavailable document is case 1, not a join failure", () => {
    const empty: SleepIndex = { ...index, byFile: new Map(), sizes: { target: 0, test: 0 } };
    expect(sleepJoinRefusal(listing(["/elsewhere/A.al"]), empty)).toBeUndefined();
    expect(sleepJoinRefusal(decodeV3Coverage(undefined), index)).toBeUndefined();
  });
  test("G1: a TEST-app file with the same relative path as a Sleep-holding target file is not a mismatch", () => {
    const helper: SleepIndex = {
      byFile: new Map([[sleepFileKey("/x/active/src/Helper.Codeunit.al"), new Set([5])]]),
      shown: new Map(),
      sizes: { target: 1, test: 0 },
      roots: { target: "/x/active/", test: "/x/tests/" },
    };
    expect(
      sleepJoinRefusal(listing([TEST_FILE, "/x/tests/src/Helper.Codeunit.al"]), helper),
    ).toBeUndefined();
  });
  test("G1: a bare relative label equal to an indexed target file's path is a mismatch", () => {
    expect(sleepJoinRefusal(listing([TEST_FILE, "Logic.Codeunit.al"]), index)).toMatch(
      /ends like the indexed target file/,
    );
  });
  test("the empty-index early return is PINNED: with 0 + 0 the join is never reached, even on a document that would otherwise refuse", () => {
    let reads = 0;
    class CountingMap<K, V> extends Map<K, V> {
      override keys(): MapIterator<K> {
        reads += 1;
        return super.keys();
      }
    }
    const roots = {
      get target(): string {
        reads += 1;
        return "/x/active/";
      },
      get test(): string {
        reads += 1;
        return "/x/tests/";
      },
    };
    const empty: SleepIndex = {
      byFile: new CountingMap(),
      shown: new Map(),
      sizes: { target: 0, test: 0 },
      roots,
    };
    // Every rule would refuse this document: no test-root path, and a target ending under another
    // prefix. With an empty index the function must return before looking at any of it.
    const refusing = listing(["/elsewhere/x/active/logic.codeunit.al"]);
    expect(sleepJoinRefusal(refusing, empty)).toBeUndefined();
    expect(reads).toBe(0);
  });
  test("the error class extends Error directly", () => {
    const e = new AlRunnerV3CoverageJoinError("x");
    expect(Object.getPrototypeOf(AlRunnerV3CoverageJoinError.prototype)).toBe(Error.prototype);
    expect(e.name).toBe("AlRunnerV3CoverageJoinError");
  });
});

describe("I-1: the index is built under realpath", () => {
  test("a symlinked root is indexed (and reported) by its real path", async () => {
    const { mkdtemp, mkdir, writeFile, symlink, realpath, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "lethal-r586-real-"));
    try {
      await mkdir(join(base, "real", "src"), { recursive: true });
      await mkdir(join(base, "tests"), { recursive: true });
      await writeFile(join(base, "real", "src", "S.Codeunit.al"), SRC);
      await symlink(join(base, "real"), join(base, "link"));
      const idx = await buildSleepIndex(join(base, "link"), join(base, "tests"));
      const real = (await realpath(join(base, "real"))).replaceAll("\\", "/");
      expect(idx.roots.target).toBe(`${real.toLowerCase()}/`);
      expect([...idx.shown.values()]).toEqual([`${real}/src/S.Codeunit.al`]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
const doc = (o: {
  top?: { line: number; hits: number }[];
  own?: { line: number; hits: number }[];
  entry?: boolean;
}) =>
  decodeV3Coverage(
    JSON.stringify({
      coverage: [{ file: FILE, statements: o.top ?? [{ line: 5, hits: 0 }] }],
      perTestCoverage:
        o.entry === false
          ? []
          : [
              {
                test: "Codeunit1.A",
                coverage: [{ file: FILE, statements: o.own ?? [{ line: 6, hits: 1 }] }],
              },
            ],
    }),
  );

describe("T32 and T12, pure", () => {
  test("a complete document with the indexed line present at 0 hits makes nothing error", () => {
    expect(sleepPassRefusal(doc({}), index, "Codeunit1.A")).toBeUndefined();
    expect(sleepCallRefusal(doc({}), index)).toBeUndefined();
  });
  test("case 3: a per-test hit on the indexed line", () => {
    const d = doc({ top: [{ line: 5, hits: 1 }], own: [{ line: 5, hits: 1 }] });
    expect(sleepPassRefusal(d, index, "Codeunit1.A")).toMatch(
      /^\[v3-sleep-noop\] covered Sleep at/,
    );
  });
  test("case 1: no document, an unparsable one, a missing per-test entry", () => {
    expect(sleepPassRefusal(decodeV3Coverage(undefined), index, "Codeunit1.A")).toMatch(
      /coverage unavailable/,
    );
    expect(sleepPassRefusal(decodeV3Coverage("{"), index, "Codeunit1.A")).toMatch(
      /coverage unavailable/,
    );
    expect(sleepPassRefusal(doc({ entry: false }), index, "Codeunit1.A")).toMatch(
      /no per-test entry/,
    );
  });
  test("case 1 fires with an EMPTY index too (cases 2-4 cannot)", () => {
    const empty: SleepIndex = {
      byFile: new Map(),
      shown: new Map(),
      sizes: { target: 0, test: 0 },
      roots: { target: "/x/active/", test: "/x/tests/" },
    };
    expect(sleepPassRefusal(decodeV3Coverage(undefined), empty, "Codeunit1.A")).toMatch(
      /coverage unavailable/,
    );
    expect(sleepPassRefusal(doc({ entry: false }), empty, "Codeunit1.A")).toMatch(
      /no per-test entry/,
    );
    expect(sleepPassRefusal(doc({}), empty, "Codeunit1.A")).toBeUndefined();
  });
  test("case 2: the indexed line missing from a file v3 listed; a file v3 did not list is not case 2", () => {
    expect(sleepCallRefusal(doc({ top: [{ line: 6, hits: 0 }] }), index)).toMatch(
      /not in v3's coverage/,
    );
    const unlisted = decodeV3Coverage(JSON.stringify({ coverage: [], perTestCoverage: [] }));
    expect(sleepCallRefusal(unlisted, index)).toBeUndefined();
  });
  test("case 4: a top-level hit no per-test entry holds", () => {
    expect(sleepCallRefusal(doc({ top: [{ line: 5, hits: 1 }] }), index)).toMatch(
      /unattributed Sleep hit/,
    );
  });
});
