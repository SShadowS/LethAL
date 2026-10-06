/**
 * R-300b: al-runner scores a `#if`-wrapped object that is alone in its file, by the original
 * file's line numbers (measured: `/coord/handoff/R-300b/alrunner-results.md`, hypothesis H1 on both
 * al-runner legs, two rounds). Every BC coverage path keeps refusing by name.
 *
 * The W1 text is the probe's own (`scripts/r300b-probe/target/src/W1Wrapped.Codeunit.al`), so the
 * lines al-runner reported for it (10, 14, 18) are the lines these tests feed in.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser, parseAL, wrapRoot } from "@lethal/engine";
import { AlRunnerBackend } from "../src/al-runner-backend";
import {
  alRunnerCoverageFrom,
  alRunnerCoverageFromServer,
  alRunnerCoverageSupport,
  buildAlRunnerCoverageIndex,
} from "../src/al-runner-coverage";
import {
  alRunnerAdmitsWrappedFile,
  coverageRefusedObjects,
  duplicateObjectRefusals,
  lineMapFromSources,
} from "../src/line-map";
import { generateMutationSet } from "../src/orchestrator";
import type { SpawnFn } from "../src/publisher";
import { buildCoverageIndex, coverageFilter } from "../src/selection";
import { alRunnerStdout } from "./helpers/al-runner-stdout";

const scratchDirs: string[] = [];
afterAll(async () => {
  for (const d of scratchDirs) await rm(d, { recursive: true, force: true });
});

async function bundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r300b-"));
  scratchDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(dir, rel);
    await mkdir(join(dest, ".."), { recursive: true });
    await writeFile(dest, body, "utf8");
  }
  return dir;
}

const W1_BODY = `codeunit 91900 "R300b W1 Wrapped"
{
    procedure Hit(): Integer
    var
        X: Integer;
    begin
        X := 9001;
        // gap
        // gap
        // gap
        X += 1;
        // gap
        // gap
        // gap
        exit(X);
    end;

    procedure Miss(): Integer
    begin
        exit(9009);
    end;
}
`;
/** The probe's W1: lines 10, 14 and 18 are `Hit`'s three statements, line 23 is `Miss`'s. */
const W1 = `#if PROBESYM\nnamespace LethAL.R300bProbe;\n\n${W1_BODY}#endif\n`;
const W1_FILE = "src/W1.Codeunit.al";
const SYMS = { symbols: ["PROBESYM"] };

/** The probe's Q shape alone in a file: a two-arm wrapper, active `#if`, inactive `#else`. */
const TWO_ARM = `#if PROBESYM
codeunit 91904 "R300b Q"
{
    procedure QIfHit(): Integer
    begin
        exit(1);
    end;
}
#else
codeunit 91904 "R300b Q"
{
    procedure QElseHit(): Integer
    begin
        exit(2);
    end;
}
#endif
`;

const hits = (file: string, ...lines: number[]) => lines.map((line) => ({ file, line, hits: 1 }));
const roots = async (files: Record<string, string>) => {
  await initParser();
  return Object.entries(files).map(([path, text]) => ({ path, root: wrapRoot(parseAL(text)) }));
};

describe("R-300b: the admission rule (one predicate)", () => {
  test("the measured shapes are admitted: W1, usings and a comment before the #if, a statement-level #if inside", async () => {
    const pre = `using System.Utilities;\n// leading comment\n${W1}`;
    const inner = W1.replace("exit(9009);", "#if PROBESYM\n        exit(9009);\n#endif");
    for (const [path, root] of (await roots({ a: W1, b: pre, c: inner })).map((f) => [
      f.path,
      f.root,
    ])) {
      expect([path, alRunnerAdmitsWrappedFile(root as never)]).toEqual([path, true]);
    }
  });

  test("two-arm, nested, a code-free object after, an object before, two wrappers: not admitted", async () => {
    const perms = "permissionset 91920 PS\n{\n    Assignable = true;\n}\n";
    const files = {
      twoArm: TWO_ARM,
      // One object, but an `#else` arm: still a two-arm wrapper, not measured live.
      elseWithoutObject: W1.replace("#endif", "#else\n// none\n#endif"),
      nested: `#if OUTER\n${W1}#endif\n`,
      codeFreeAfter: `${W1}${perms}`,
      objectBefore: `${perms}${W1}`,
      twoWrappers: `${W1}#if OTHER\n${perms}#endif\n`,
      plain: W1_BODY,
    };
    const got = (await roots(files)).map((f) => [f.path, alRunnerAdmitsWrappedFile(f.root)]);
    expect(got).toEqual(Object.keys(files).map((k) => [k, false]));
  });
});

describe("R-300b: the backend kind is a required argument", () => {
  // The `@ts-expect-error` is the assertion: if the kind became optional, the call below would
  // stop being a type error, the directive would be unused, and `bun run typecheck` fails.
  test("coverageRefusedObjects without a kind does not compile", async () => {
    const files = await roots({ [W1_FILE]: W1 });
    // @ts-expect-error - backendKind is required (R-300b); a caller that omits it must not compile.
    expect(coverageRefusedObjects(files).size).toBe(1);
  });
});

describe("R-300b (a): the BC paths keep refusing W1 by name", () => {
  test("bcdev: coverageRefusedObjects names W1, the fenced line map places nothing, selection reads no-coverage with the note", async () => {
    const refused = coverageRefusedObjects(await roots({ [W1_FILE]: W1 }), "bcdev");
    expect([...refused.entries()]).toEqual([
      [
        "codeunit:91900",
        "coverage refused for Codeunit:91900 (src/W1.Codeunit.al): it is declared inside, or after, a #if ... #endif object wrapper, and how the compiled arm's lines are numbered is not yet measured (R300). Its mutants read no-coverage.",
      ],
    ]);
    const map = await lineMapFromSources(
      [{ path: W1_FILE, text: W1 }],
      new Set(["codeunit:91900"]),
    );
    expect(map.lookup("Codeunit", 91900, 10)).toBeUndefined();
    expect(map.isRefused("Codeunit", 91900)).toBe(true);

    const ref = { codeunitId: 91930, codeunitName: "Reach", method: "ReachW1" };
    const cov = buildCoverageIndex([
      {
        ref,
        coverage: {
          granularity: "line",
          entries: [{ objectType: "Codeunit", objectId: 91900, procedure: "Hit", line: 10 }],
        },
      },
    ]);
    const split = coverageFilter([mutant("M1", "Hit")], cov, [ref], undefined, false, refused);
    expect(split.covered.has("M1")).toBe(false);
    expect(split.refused.get("M1")).toContain("coverage refused for Codeunit:91900");
  });
});

/** A mutant of W1's procedure `proc`. */
function mutant(mutantId: string, proc: string) {
  return {
    mutantId,
    file: W1_FILE,
    startIndex: 10,
    endIndex: 20,
    startLine: proc === "Hit" ? 10 : 23,
    operatorName: "empty-block",
    operatorVersion: "1.0.0",
    astHash: "h",
    originalText: "x",
    mutatedText: "",
    objectType: "codeunit",
    codeunitId: 91900,
    codeunitName: "R300b W1 Wrapped",
    procedureName: proc,
  };
}

describe("R-300b (b): al-runner scores W1 by its original file lines", () => {
  test("Cobertura and --server both name Hit at lines 10/14/18; nothing is refused; Hit is covered and Miss is a real miss", async () => {
    const dir = await bundle({ [W1_FILE]: W1 });
    const index = await buildAlRunnerCoverageIndex(dir, SYMS);
    expect(index.refusedFiles).toEqual([]);
    expect(index.skippedFiles).toEqual([]);
    expect(index.declared.has("codeunit:91900")).toBe(true);
    const want = [10, 14, 18].map((line) => ({
      objectType: "Codeunit",
      objectId: 91900,
      procedure: "Hit",
      line,
    }));
    expect(alRunnerCoverageFrom(hits(W1_FILE, 10, 14, 18), index).entries).toEqual(want);
    const server = alRunnerCoverageFromServer(
      {
        test: "Codeunit91930.ReachW1",
        coverage: [
          {
            file: W1_FILE,
            statements: [10, 14, 18].map((line) => ({ line, hits: 1, scope: "Hit" })),
          },
        ],
      },
      index,
    );
    expect(server.entries).toEqual(want);
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: true,
      multiObjectFiles: [],
      wrappedObjectFiles: [],
    });

    const refused = coverageRefusedObjects(await roots({ [W1_FILE]: W1 }), "al-runner");
    expect(refused.size).toBe(0);
    const ref = { codeunitId: 91930, codeunitName: "Reach", method: "ReachW1" };
    const cov = buildCoverageIndex([
      { ref, coverage: alRunnerCoverageFrom(hits(W1_FILE, 10, 14, 18), index) },
    ]);
    const split = coverageFilter(
      [mutant("M1", "Hit"), mutant("M2", "Miss")],
      cov,
      [ref],
      undefined,
      false,
      refused,
    );
    expect(split.covered.get("M1")).toEqual([ref]);
    expect(split.uncovered.map((m) => m.mutantId)).toEqual(["M2"]);
    expect(split.refused.size).toBe(0);
  });

  test("a not-admitted shape is still refused on al-runner, by the new sentence, in the index, the guard and selection", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = await bundle({ "src/Q.Codeunit.al": TWO_ARM });
      const index = await buildAlRunnerCoverageIndex(dir, SYMS);
      const sentence =
        "coverage refused for Codeunit:91904 (src/Q.Codeunit.al): its file holds a #if object wrapper of a shape not measured on al-runner (R300). Its mutants read no-coverage.";
      expect(index.refusedFiles).toEqual(["src/Q.Codeunit.al"]);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([`[lethal] ${sentence}`]);
      // Line 6 is `exit(1);` in QIfHit; a widened rule would place it.
      expect(alRunnerCoverageFrom(hits("src/Q.Codeunit.al", 6), index).entries).toEqual([]);
      expect((await alRunnerCoverageSupport(dir)).wrappedObjectFiles).toEqual([
        "src/Q.Codeunit.al",
      ]);
      const refused = coverageRefusedObjects(
        await roots({ "src/Q.Codeunit.al": TWO_ARM }),
        "al-runner",
      );
      expect([...refused.entries()]).toEqual([["codeunit:91904", sentence]]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a code-free object after the wrapper is not admitted: the guard names the file and nothing resolves", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const text = `${W1}permissionset 91920 PS\n{\n    Assignable = true;\n}\n`;
      const dir = await bundle({ [W1_FILE]: text });
      expect((await alRunnerCoverageSupport(dir)).wrappedObjectFiles).toEqual([W1_FILE]);
      const index = await buildAlRunnerCoverageIndex(dir, SYMS);
      expect(alRunnerCoverageFrom(hits(W1_FILE, 10), index).entries).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("R-300b (C1): only active declarations are indexed; a key in two indexed files is refused", () => {
  const pair = (cond: string, proc: string, pad: string) =>
    `#if ${cond}\ncodeunit 91910 "R300b Pair"\n{\n${pad}    procedure ${proc}(): Integer\n    begin\n        exit(1);\n    end;\n}\n#endif\n`;
  // A: `exit(1);` on line 6. B: the same statement on line 9, inside its own FromB.
  const A = pair("PROBESYM", "FromA", "");
  const B = pair("not PROBESYM", "FromB", "\n\n\n");

  test("A active, B compiled out: A's hits name A's procedure, B is skipped and its hits drop", async () => {
    const dir = await bundle({ "src/A.Codeunit.al": A, "src/B.Codeunit.al": B });
    const index = await buildAlRunnerCoverageIndex(dir, SYMS);
    expect(index.skippedFiles).toEqual(["src/b.codeunit.al"]);
    expect(
      alRunnerCoverageFrom(
        [...hits("src/A.Codeunit.al", 6), ...hits("src/B.Codeunit.al", 9)],
        index,
      ).entries,
    ).toEqual([{ objectType: "Codeunit", objectId: 91910, procedure: "FromA", line: 6 }]);
  });

  test("the same pair under no symbols: B is active and A is skipped", async () => {
    const dir = await bundle({ "src/A.Codeunit.al": A, "src/B.Codeunit.al": B });
    const index = await buildAlRunnerCoverageIndex(dir, { symbols: [] });
    expect(index.skippedFiles).toEqual(["src/a.codeunit.al"]);
    expect(
      alRunnerCoverageFrom(
        [...hits("src/A.Codeunit.al", 6), ...hits("src/B.Codeunit.al", 9)],
        index,
      ).entries,
    ).toEqual([{ objectType: "Codeunit", objectId: 91910, procedure: "FromB", line: 9 }]);
  });

  test("both active: the key is refused by name, exempt, and both files are skipped", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = await bundle({
        "src/A.Codeunit.al": pair("PROBESYM", "FromA", ""),
        "src/B.Codeunit.al": pair("PROBESYM", "FromB", "\n\n\n"),
      });
      const index = await buildAlRunnerCoverageIndex(dir, SYMS);
      const sentence =
        "coverage refused for codeunit:91910: it is declared in src/A.Codeunit.al and src/B.Codeunit.al; coverage cannot tell them apart (R300). Its mutants read no-coverage.";
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([`[lethal] ${sentence}`]);
      expect(index.exempt.has("codeunit:91910")).toBe(true);
      expect(index.declared.has("codeunit:91910")).toBe(false);
      expect(index.skippedFiles).toEqual(["src/a.codeunit.al", "src/b.codeunit.al"]);
      expect(
        alRunnerCoverageFrom(
          [...hits("src/A.Codeunit.al", 6), ...hits("src/B.Codeunit.al", 9)],
          index,
        ).entries,
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("an undecided wrapped file is refused by name and a compiled-out W1 is skipped; neither declares anything", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const undecided = `#if PROBESYM PROBESYM\n${W1_BODY.replace("91900", "91902")}#endif\n`;
      const dir = await bundle({ "src/U.Codeunit.al": undecided, [W1_FILE]: W1 });
      const index = await buildAlRunnerCoverageIndex(dir, { symbols: [] });
      expect(index.skippedFiles).toEqual(["src/u.codeunit.al", "src/w1.codeunit.al"]);
      expect(index.refusedFiles).toEqual(["src/U.Codeunit.al"]);
      expect(index.exempt.has("codeunit:91902")).toBe(true);
      expect(index.declared.size).toBe(0);
      const said = warn.mock.calls.map((c) => String(c[0]));
      expect(said).toHaveLength(1);
      expect(said[0]).toStartWith(
        "[lethal] coverage refused for Codeunit:91902 (src/U.Codeunit.al): its #if arms could not be evaluated as alc does (",
      );
      expect(alRunnerCoverageFrom(hits(W1_FILE, 10), index).entries).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("the shared function: one key in two files gives one sentence naming both; one file alone gives none", () => {
    expect([
      ...duplicateObjectRefusals([
        { path: "a.al", keys: ["codeunit:1", "table:2"] },
        { path: "b.al", keys: ["codeunit:1"] },
        { path: "c.al", keys: ["codeunit:1", "page:3"] },
      ]).entries(),
    ]).toEqual([
      [
        "codeunit:1",
        "coverage refused for codeunit:1: it is declared in a.al and b.al; coverage cannot tell them apart (R300). Its mutants read no-coverage.",
      ],
    ]);
    expect(
      duplicateObjectRefusals([{ path: "a.al", keys: ["codeunit:1", "codeunit:1"] }]).size,
    ).toBe(0);
  });

  test("selection: generateMutationSet reports the duplicate under the same sentence, and only active declarations count", async () => {
    const both = await bundle({
      "A.Codeunit.al": pair("PROBESYM", "FromA", ""),
      "B.Codeunit.al": pair("PROBESYM", "FromB", "\n\n\n"),
      "app.json": '{"preprocessorSymbols":["PROBESYM"]}',
    });
    expect([...(await generateMutationSet(both)).duplicateObjects.entries()]).toEqual([
      [
        "codeunit:91910",
        "coverage refused for codeunit:91910: it is declared in A.Codeunit.al and B.Codeunit.al; coverage cannot tell them apart (R300). Its mutants read no-coverage.",
      ],
    ]);
    const oneActive = await bundle({
      "A.Codeunit.al": A,
      "B.Codeunit.al": B,
      "app.json": '{"preprocessorSymbols":["PROBESYM"]}',
    });
    expect((await generateMutationSet(oneActive)).duplicateObjects.size).toBe(0);
  });
});

describe("R-300b (I3): --server's own name disagreeing with the position drops the line in an admitted file", () => {
  test("admitted W1: the line is dropped with a warning; the unwrapped twin keeps R383's position-wins", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Another id, so the twin is not a duplicate key of W1.
      const twin = W1.replace("#if PROBESYM", "// if PROBESYM")
        .replace("#endif", "// endif")
        .replace("91900", "91901");
      const dir = await bundle({ [W1_FILE]: W1, "src/C1.Codeunit.al": twin });
      const index = await buildAlRunnerCoverageIndex(dir, SYMS);
      const st = [{ line: 10, hits: 1, scope: "Miss" }];
      const got = alRunnerCoverageFromServer(
        {
          test: "Codeunit91930.ReachW1",
          coverage: [
            { file: W1_FILE, statements: st },
            { file: "src/C1.Codeunit.al", statements: st },
          ],
        },
        index,
      );
      expect(got.entries).toEqual([
        { objectType: "Codeunit", objectId: 91901, procedure: "Hit", line: 10 },
      ]);
      const said = warn.mock.calls.map((c) => String(c[0]));
      const at = (file: string) => `${file}:${st[0]?.line}`;
      expect(said.filter((s) => s.includes(at(W1_FILE)))).toEqual([
        `[lethal] al-runner --server named the covered statement at ${at(W1_FILE)} "Miss", but that line is inside "Hit", in a #if-wrapped file; the line is dropped (R300).`,
      ]);
      expect(said.filter((s) => s.includes(at("src/C1.Codeunit.al")))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("R-300b: the backend evaluates arms under the session's symbols", () => {
  function coveringSpawn(file: string, line: number): SpawnFn {
    return async (argv) => {
      const o = argv.indexOf("--coverage-out");
      const out = o >= 0 ? argv[o + 1] : undefined;
      if (out !== undefined) {
        await writeFile(
          out,
          `<coverage><packages><package><classes><class name="x" filename="${file}"><lines><line number="${line}" hits="1"/></lines></class></classes></package></packages></coverage>`,
          "utf8",
        );
      }
      return {
        exitCode: 0,
        stdout: alRunnerStdout({
          tests: [{ name: "Codeunit91930.ReachW1", status: "pass", durationMs: 1 }],
          passed: 1,
          failed: 0,
          errors: 0,
          total: 1,
          exitCode: 0,
        }),
        stderr: "",
      };
    };
  }
  async function batch(): Promise<string> {
    return bundle({
      [W1_FILE]: W1,
      "MutationSelector.Codeunit.al": "placeholder",
      "mutant-manifest.json": JSON.stringify({
        artifactId: "a".repeat(32),
        mutants: [{ objectType: "codeunit", codeunitId: 91900 }],
      }),
    });
  }
  const backendOf = async () =>
    new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: await bundle({}),
        testDir: "/tests",
        selectorObjectId: 50000,
        coverage: "al-runner",
      },
      coveringSpawn(W1_FILE, 10),
    );
  const ref = { codeunitId: 91930, codeunitName: "Reach", method: "ReachW1" };

  test("useBuildSymbols reaches the index: W1's line 10 names Hit", async () => {
    const backend = await backendOf();
    backend.useBuildSymbols(["PROBESYM"]);
    await backend.deploy(await batch());
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    await backend.close();
    expect(v.coverage?.entries).toEqual([
      { objectType: "Codeunit", objectId: 91900, procedure: "Hit", line: 10 },
    ]);
  });

  // Sol run 001 (I): what runSession merges into selection's refusal map after each deploy.
  test("coverageRefusals names the deployed bundle's undecided wrapped object, with the index's sentence", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const backend = await backendOf();
      backend.useBuildSymbols([]);
      await backend.deploy(
        await bundle({
          "src/U.Codeunit.al": `#if PROBESYM PROBESYM\n${W1_BODY.replace("91900", "91902")}#endif\n`,
          "MutationSelector.Codeunit.al": "placeholder",
          "mutant-manifest.json": JSON.stringify({ artifactId: "a".repeat(32), mutants: [] }),
        }),
      );
      const refusals = await backend.coverageRefusals();
      await backend.close();
      expect([...refusals.keys()]).toEqual(["codeunit:91902"]);
      expect(refusals.get("codeunit:91902")).toStartWith(
        "coverage refused for Codeunit:91902 (src/U.Codeunit.al): its #if arms could not be evaluated as alc does (",
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("without the session's symbols, a coverage deploy refuses rather than guessing the arms", async () => {
    const backend = await backendOf();
    const err = await backend.deploy(await batch()).then(
      () => undefined,
      (e: unknown) => e,
    );
    await backend.close();
    expect((err as Error | undefined)?.message).toContain("useBuildSymbols");
  });
});
