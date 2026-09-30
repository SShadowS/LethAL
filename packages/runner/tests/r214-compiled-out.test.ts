import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import { type MutantManifest, writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";

/**
 * R214's pre-commitment (docs/superpowers/specs/2026-09-29-r214-precommitment.md), per repro and
 * per build: the deployed mutants, in the capture's row format, must equal the committed file byte
 * for byte. A difference is a finding and a stop: never edit an expected file to match.
 */
const HERE = import.meta.dir;
const R214 = join(HERE, "fixtures", "r214");
const REPO = resolve(HERE, "../../..");
const norm = (p: string): string => p.replaceAll("\\", "/");
/** A capture row's first two columns. Built, so this file never spells a `file.ext:<line>` (R117). */
const row = (file: string, line: number, op: string): string => `${file}:${line}\t${op}`;

/** r3, I5: a valid codeunit with no site whose one directive-looking line is in a block comment. */
// biome-ignore lint/suspicious/noExportsInTest: Task 7's report test reuses this source (R214).
export const EMPTY_REFUSED = 'codeunit 50018 "P12 Empty"\n{\n/*\n#if R12SYM\n*/\n}\n';

/** r3, minor b: `#if and` compiles (alc builds ARM2, measured row 21), and its meaning is unknown,
 *  so the file is refused. Line 5 is the `#if`. */
// biome-ignore lint/suspicious/noExportsInTest: Task 7's report test reuses this source (R214).
export const BARE_AND = `codeunit 50017 "P12 Bare And"
{
    procedure Run(X: Integer)
    begin
#if and
        Helper(X);
#else
        Helper(X + 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;

async function capture(projectDir: string, symbols: readonly string[]) {
  const warnings: { code: string; message: string }[] = [];
  const set = await generateMutationSet(projectDir, {
    preprocessorSymbols: symbols,
    emit: (e) => {
      if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
    },
  });
  const out = await mkdtemp(join(tmpdir(), "lethal-r214-"));
  try {
    await writeInstrumentedProject({
      targetDir: out,
      files: set.files,
      selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: "00000000-0000-0000-0000-000000000000",
      operatorTiers,
    });
    const m = JSON.parse(
      await readFile(join(out, "mutant-manifest.json"), "utf8"),
    ) as MutantManifest;
    const raw = set.files.reduce((n, f) => n + f.specs.length, 0);
    const rows = [...m.mutants]
      .sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.startLine - b.startLine ||
          a.operatorName.localeCompare(b.operatorName) ||
          a.startIndex - b.startIndex,
      )
      .map((e) =>
        [
          `${e.file.replaceAll("\\", "/")}:${e.startLine}`,
          e.operatorName,
          `proc=${e.procedureName === "" ? "<none>" : e.procedureName}`,
          `hang=${e.hangCapable ?? "-"}`,
          serializeKey(identityKeyOf(e)),
          `${e.startIndex}-${e.endIndex}`,
          `grain=${e.reachGrain ?? "-"}`,
          `plat=${e.platformKillMechanism ?? "-"}`,
        ].join("\t"),
      );
    const head = `raw ${raw} deployed ${m.mutants.length} skippedFiles ${set.skipped.length}`;
    return { text: `${[head, ...rows].join("\n")}\n`, warnings, set };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function setsOf(dir: string): Promise<string[][]> {
  return JSON.parse(await readFile(join(dir, "symbol-sets.json"), "utf8")) as string[][];
}

beforeAll(async () => {
  await initParser();
});

// Listed at module load (top-level await), so each repro is its own named test.
const CASES: [string, string][] = [
  ...(await readdir(R214))
    .filter((n) => n !== "expected" && n !== "before")
    .map((n): [string, string] => [n, join(R214, n)]),
  ["fixture-sandbox-symbols", join(REPO, "fixtures", "sandbox-symbols")],
];

describe("R214: the pre-committed sites, per repro and per build", () => {
  test("every lifted repro is here (13) and has an expected file per set", async () => {
    expect(CASES).toHaveLength(14);
    for (const [name, dir] of CASES)
      for (const [i] of (await setsOf(dir)).entries())
        expect(await Bun.file(join(R214, "expected", `${name}.${i}.txt`)).exists()).toBe(true);
  });
  for (const [name, dir] of CASES) {
    test(`${name}: every build matches its expected capture`, async () => {
      for (const [i, symbols] of (await setsOf(dir)).entries()) {
        const want = await readFile(join(R214, "expected", `${name}.${i}.txt`), "utf8");
        const got = await capture(dir, symbols);
        expect(`[${symbols.join(",")}]\n${got.text}`).toBe(`[${symbols.join(",")}]\n${want}`);
      }
    }, 60_000);
  }
});

describe("R214: every drop is named and counted", () => {
  test("compiled-out sites are counted per file, with the effective symbols", async () => {
    const { warnings, set } = await capture(join(R214, "p-r214"), []);
    const w = warnings.filter((x) => x.code === "compiled-out-sites");
    expect(w).toHaveLength(1);
    // Three, not the two the brief predicted: L5 empty-block, L6 return-value and L18
    // void-method-call, which is exactly the pre-committed capture's raw 9 -> 6 (expected/p-r214.0).
    expect(w[0]?.message).toContain("R214Probe.Codeunit.al (3)");
    expect(w[0]?.message).toContain("symbols: none");
    expect(set.preprocExcluded).toEqual([
      {
        file: "R214Probe.Codeunit.al",
        kinds: "codeunit_declaration",
        sites: 3,
        reason: "compiled-out",
        detail: "symbols: none",
      },
    ]);
  });

  test("an undecidable file gets NO mutant, one warning, one counted row; its sibling is untouched", async () => {
    const { warnings, set, text } = await capture(join(R214, "p12-refused"), ["R12SYM"]);
    // Project-relative paths (r3, I6). `readdir` on Windows spells them `src\...` (measured), so
    // the actual path is normalised before an EXACT comparison; the capture text already is.
    expect(text).not.toContain("src/Refused.Codeunit.al");
    expect(text).toContain(row("src/Plain.Codeunit.al", 6, "lethal.void-method-call"));
    const w = warnings.filter((x) => x.code === "preproc-arms-undecided");
    expect(w).toHaveLength(1);
    expect(norm(w[0]?.message ?? "")).toContain("src/Refused.Codeunit.al: ");
    expect(w[0]?.message).toContain("marker-mismatch (2 directive lines, 0 markers)");
    expect(w[0]?.message).not.toContain("Helper(");
    // Task 1 deferred minor: the COUNT is pinned, in both builds, not only the rows' absence. The
    // refused file holds three sites (empty-block, swap-additive, void-method-call) in either build.
    for (const symbols of await setsOf(join(R214, "p12-refused"))) {
      const { set: s } = await capture(join(R214, "p12-refused"), symbols);
      const rows = s.preprocExcluded.filter((f) => f.reason === "preproc-undecided");
      expect([symbols, rows.map((f) => [norm(f.file), f.sites, f.detail])]).toEqual([
        symbols,
        [["src/Refused.Codeunit.al", 3, "marker-mismatch (2 directive lines, 0 markers)"]],
      ]);
    }
    const refused = set.preprocExcluded.filter((f) => f.reason === "preproc-undecided");
    expect(refused.map((f) => [norm(f.file), f.detail])).toEqual([
      ["src/Refused.Codeunit.al", "marker-mismatch (2 directive lines, 0 markers)"],
    ]);
    expect(refused[0]?.sites).toBeGreaterThan(0);
  });

  test("a refused file with NO site still gets its row, sites 0 (r3, I5)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r214-empty-"));
    try {
      await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
      // A valid, otherwise empty codeunit: the directive-looking line sits in a block comment.
      await Bun.write(join(dir, "src", "Empty.Codeunit.al"), EMPTY_REFUSED);
      const warnings: string[] = [];
      const set = await generateMutationSet(dir, {
        emit: (e) => {
          if (e.type === "warning" && e.code === "preproc-arms-undecided") warnings.push(e.message);
        },
      });
      expect(set.preprocExcluded.map((f) => [norm(f.file), f.sites, f.reason, f.detail])).toEqual([
        [
          "src/Empty.Codeunit.al",
          0,
          "preproc-undecided",
          "marker-mismatch (1 directive lines, 0 markers)",
        ],
      ]);
      expect(warnings).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a legal bare `#if and` refuses its file: unparsed-condition, no mutant, one row (r3, minor b)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r214-and-"));
    try {
      await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
      await Bun.write(join(dir, "src", "BareAnd.Codeunit.al"), BARE_AND);
      const set = await generateMutationSet(dir);
      expect(set.files.flatMap((f) => f.specs)).toHaveLength(0);
      const rows = set.preprocExcluded.map((f) => [norm(f.file), f.reason, f.detail]);
      expect(rows).toEqual([
        ["src/BareAnd.Codeunit.al", "preproc-undecided", "unparsed-condition at line 5"],
      ]);
      expect(set.preprocExcluded[0]?.sites).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("app.json's own preprocessorSymbols count", async () => {
    const { text, set } = await capture(join(R214, "p7-appjson"), []);
    expect(text).toContain(row("AppSym.Codeunit.al", 6, "lethal.void-method-call"));
    expect(text).not.toContain(row("AppSym.Codeunit.al", 8, "lethal.swap-additive"));
    expect(set.buildSymbols).toEqual(["APPSYM"]);
  });

  test("a malformed app.json symbol list throws, naming app.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r214-bad-"));
    try {
      await Bun.write(join(dir, "app.json"), JSON.stringify({ preprocessorSymbols: "APPSYM" }));
      await Bun.write(join(dir, "A.Codeunit.al"), 'codeunit 50001 "A" { }\n');
      await expect(generateMutationSet(dir)).rejects.toThrow(
        /app\.json: "preprocessorSymbols" must be an array/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
