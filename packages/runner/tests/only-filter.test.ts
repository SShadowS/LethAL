import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliConfig, resolveExclude, validateExcludeGlobs } from "../src/cli";
import { generateMutationSet } from "../src/orchestrator";

/**
 * R41. `--only <glob>` narrows which files' mutation sites become mutants, so a large project has
 * a cheap first run: Continia Document Output generates 11,777 mutants in a single batch, and
 * before this there was no way to ask for fewer.
 *
 * The narrowing is applied to SPEC GENERATION only. Every file is still parsed and still feeds the
 * project-wide semantic context, and every file still reaches the batch dir and the published app
 * — see the `semantic context` describe below for why that distinction is the whole ballgame.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 79300, to: 79399 }],
});

const LOGIC_AL = `codeunit 79300 "Logic"
{
    procedure P(N: Integer): Integer
    begin
        if N > 10 then
            exit(1);
        exit(0);
    end;
}
`;

const PRICING_AL = `codeunit 79301 "Pricing"
{
    procedure Q(N: Integer): Integer
    begin
        if N > 20 then
            exit(2);
        exit(0);
    end;
}
`;

async function withProject(
  files: Readonly<Record<string, string>>,
  body: (projectDir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lethal-only-"));
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

const TWO_FILES = {
  "Al/Codeunit/Logic.Codeunit.al": LOGIC_AL,
  "Al/Codeunit/Pricing.Codeunit.al": PRICING_AL,
};

describe("generateMutationSet — --only narrows the mutant set", () => {
  test("without --only, every mutable file contributes specs", async () => {
    await withProject(TWO_FILES, async (projectDir) => {
      const { files, excludedByOnly } = await generateMutationSet(projectDir);
      expect(files.map((f) => f.path).sort()).toHaveLength(2);
      expect(excludedByOnly).toBe(0);
    });
  });

  test("a matching glob keeps only that file's specs", async () => {
    await withProject(TWO_FILES, async (projectDir) => {
      const { files, excludedByOnly } = await generateMutationSet(projectDir, {
        only: ["Al/Codeunit/Logic*"],
      });
      expect(files).toHaveLength(1);
      const [only] = files;
      if (only === undefined) throw new Error("fixture drift");
      expect(only.path).toContain("Logic.Codeunit.al");
      expect(only.specs.length).toBeGreaterThan(0);
      expect(excludedByOnly).toBe(1);
    });
  });

  test("several --only patterns union rather than intersect", async () => {
    await withProject(TWO_FILES, async (projectDir) => {
      const { files, excludedByOnly } = await generateMutationSet(projectDir, {
        only: ["**/Logic.Codeunit.al", "**/Pricing.Codeunit.al"],
      });
      expect(files).toHaveLength(2);
      expect(excludedByOnly).toBe(0);
    });
  });

  test("patterns match on forward slashes regardless of platform separator", async () => {
    // readdir yields `Al\Codeunit\Logic.Codeunit.al` on Windows. A pattern written with `/` — the
    // only separator a config file or CI script can portably use — must still match it.
    await withProject(TWO_FILES, async (projectDir) => {
      const { files } = await generateMutationSet(projectDir, { only: ["Al/Codeunit/**"] });
      expect(files).toHaveLength(2);
    });
  });
});

describe("generateMutationSet — --only refuses to match nothing", () => {
  test("throws, naming the pattern, when a glob matches no file", async () => {
    // The signature failure this repo keeps hitting: a typo'd pattern that silently selects zero
    // files would report `0 mutants` and a null score, which reads as "nothing to fix" rather
    // than "you asked for a directory that does not exist".
    await withProject(TWO_FILES, async (projectDir) => {
      const err = await generateMutationSet(projectDir, { only: ["src/Codeunit/**"] }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain("src/Codeunit/**");
    });
  });

  test("throws when ONE of several patterns matches nothing, not just when all do", async () => {
    await withProject(TWO_FILES, async (projectDir) => {
      const err = await generateMutationSet(projectDir, {
        only: ["**/Logic.Codeunit.al", "**/Typo.Codeunit.al"],
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain("Typo.Codeunit.al");
      expect(message).not.toContain("**/Logic.Codeunit.al");
    });
  });
});

/**
 * The load-bearing property. `buildSemanticContext` is deliberately project-wide: the Tier-2
 * shadowing guard refuses a call whose receiver's table declares a procedure of that name
 * anywhere in the project, and with a narrower context the guard goes inert and `RemoveSetRange`
 * claims a site that is really the table's own method. Narrowing by filtering the parse set would
 * therefore make `--only` change VERDICTS, not just how many run — silently, and in the unsafe
 * direction.
 */
describe("generateMutationSet — --only does not shrink the semantic context", () => {
  const CALLER_AL = `codeunit 79310 "Shadow Caller"
{
    procedure P()
    var
        Other: Record "Other Table";
    begin
        Other.SetRange("No.", 'A');
    end;
}
`;

  const TABLE_AL = `table 79311 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }

    procedure SetRange(A: Code[20]; B: Code[20])
    begin
    end;
}
`;

  test("the shadowing refusal still fires when the shadowing table is OUTSIDE --only", async () => {
    await withProject(
      { "Caller/ShadowCaller.Codeunit.al": CALLER_AL, "Tables/OtherTable.Table.al": TABLE_AL },
      async (projectDir) => {
        const { files } = await generateMutationSet(projectDir, { only: ["Caller/**"] });
        const caller = files.find((f) => f.path.includes("ShadowCaller"));
        if (caller === undefined) throw new Error("caller produced no specs at all");
        const operators = caller.specs
          .filter((s) => s.before.text.startsWith("Other.SetRange"))
          .map((s) => s.operatorName)
          .sort();
        // Tier-1 only. `lethal.remove-setrange` appearing here means the context was narrowed
        // along with the mutant set and the guard went inert.
        expect(operators).toEqual(["lethal.void-method-call"]);
      },
    );
  });

  test("counterweight: with no shadowing procedure, the same --only run DOES claim the site", async () => {
    // Without this, the test above would pass just as well if `--only` had broken spec
    // generation for the caller entirely, or if RemoveSetRange never fired in this shape.
    const tableWithoutProcedure = `table 79311 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }
}
`;
    await withProject(
      {
        "Caller/ShadowCaller.Codeunit.al": CALLER_AL,
        "Tables/OtherTable.Table.al": tableWithoutProcedure,
      },
      async (projectDir) => {
        const { files } = await generateMutationSet(projectDir, { only: ["Caller/**"] });
        const caller = files.find((f) => f.path.includes("ShadowCaller"));
        if (caller === undefined) throw new Error("caller produced no specs at all");
        const operators = caller.specs
          .filter((s) => s.before.text.startsWith("Other.SetRange"))
          .map((s) => s.operatorName)
          .sort();
        expect(operators).toEqual(["lethal.remove-setrange", "lethal.void-method-call"]);
      },
    );
  });
});

describe("parseCliConfig — --only", () => {
  const RUN_ARGS = ["run", "--project", "p", "--tests", "t", "--backend", "al-runner"] as const;

  test("a single --only lands as a one-element array", () => {
    const cfg = parseCliConfig([...RUN_ARGS, "--only", "Al/Codeunit/**"]);
    expect(cfg.mode).toBe("run");
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.only).toEqual(["Al/Codeunit/**"]);
  });

  test("--only is repeatable and preserves order", () => {
    const cfg = parseCliConfig([...RUN_ARGS, "--only", "a/**", "--only", "b/**"]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.only).toEqual(["a/**", "b/**"]);
  });

  test("omitting --only leaves the key ABSENT, not an empty array", () => {
    // `exactOptionalPropertyTypes` convention, and what keeps `runSession` from recording an
    // `only` block on a report for a run that was never narrowed.
    const cfg = parseCliConfig([...RUN_ARGS]);
    expect("only" in cfg).toBe(false);
  });

  test("an empty --only is refused at parse time", () => {
    expect(() => parseCliConfig([...RUN_ARGS, "--only", ""])).toThrow(
      /--only requires a non-empty/,
    );
  });

  test("--dry-run carries --only too", () => {
    const cfg = parseCliConfig(["run", "--project", "p", "--dry-run", "--only", "Al/**"]);
    expect(cfg.mode).toBe("dry-run");
    if (cfg.mode !== "dry-run") throw new Error("mode drift");
    expect(cfg.only).toEqual(["Al/**"]);
  });
});

describe("parseCliConfig — --tests-only (R45)", () => {
  const RUN_ARGS = ["run", "--project", "p", "--tests", "t", "--backend", "al-runner"] as const;

  test("parses and is repeatable", () => {
    const cfg = parseCliConfig([
      ...RUN_ARGS,
      "--tests-only",
      "Src/A/**",
      "--tests-only",
      "Src/B/**",
    ]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.testsOnly).toEqual(["Src/A/**", "Src/B/**"]);
  });

  test("omitting it leaves the key absent", () => {
    const cfg = parseCliConfig([...RUN_ARGS]);
    expect("testsOnly" in cfg).toBe(false);
  });

  test("an empty pattern is refused at parse time", () => {
    expect(() => parseCliConfig([...RUN_ARGS, "--tests-only", ""])).toThrow(
      /--tests-only requires a non-empty/,
    );
  });

  test("refused with --dry-run, which executes no tests at all", () => {
    // Accepting it silently would imply the dry run had been scoped by it.
    expect(() =>
      parseCliConfig(["run", "--project", "p", "--dry-run", "--tests-only", "Src/**"]),
    ).toThrow(/no effect with --dry-run/);
  });

  test("--only and --tests-only are independent", () => {
    const cfg = parseCliConfig([
      ...RUN_ARGS,
      "--only",
      "Al/Codeunit/**",
      "--tests-only",
      "Src/Documents/**",
    ]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.only).toEqual(["Al/Codeunit/**"]);
    expect(cfg.testsOnly).toEqual(["Src/Documents/**"]);
  });
});

/**
 * R221. `--exclude <glob>` is `--only`'s complement: the files it names contribute NO mutants.
 *
 * It exists because `--only` is an allow-list, and "mutate everything except the upgrade code" had
 * to be written as an enumeration of every other folder. On a real project that is not a workaround
 * anyone maintains.
 *
 * Same discipline as `--only`: applied to SPEC GENERATION only, so an excluded file is still
 * parsed, still feeds the project-wide semantic context, and still reaches the published app.
 * Excluding a file must not be able to change what a mutant elsewhere does.
 */
describe("generateMutationSet — --exclude removes files from the mutant set", () => {
  test("a matching glob drops that file's specs and counts it apart from --only", async () => {
    await withProject(TWO_FILES, async (projectDir) => {
      const { files, excludedByOnly, excludedByExclude } = await generateMutationSet(projectDir, {
        exclude: ["Al/Codeunit/Pricing*"],
      });
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toContain("Logic.Codeunit.al");
      // The counters are separate so a run using both flags can say which one dropped a file.
      expect(excludedByExclude).toBe(1);
      expect(excludedByOnly).toBe(0);
    });
  });

  test("several --exclude patterns union", async () => {
    await withProject(TWO_FILES, async (projectDir) => {
      await expect(
        generateMutationSet(projectDir, {
          exclude: ["Al/Codeunit/Logic*", "Al/Codeunit/Pricing*"],
        }),
      ).rejects.toThrow(/every .al file was excluded/);
    });
  });

  test("--exclude is SUBTRACTIVE, applied after --only", async () => {
    // "this subtree, except that file" — the order people say it in. Given both flags, a file must
    // satisfy `--only` AND survive `--exclude`.
    await withProject(TWO_FILES, async (projectDir) => {
      const { files, excludedByOnly, excludedByExclude } = await generateMutationSet(projectDir, {
        only: ["Al/Codeunit/**"],
        exclude: ["**/Pricing*"],
      });
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toContain("Logic.Codeunit.al");
      expect(excludedByExclude).toBe(1);
      expect(excludedByOnly).toBe(0);
    });
  });

  test("REFUSES a pattern that matches nothing", async () => {
    // Sharper than `--only`'s refusal and for a different reason: a typo'd `--only` selects FEWER
    // files and the report says so, while a typo'd `--exclude` selects MORE and mutates the files
    // the caller said to leave alone. Silence there under-reports; silence here misreports.
    await withProject(TWO_FILES, async (projectDir) => {
      await expect(
        generateMutationSet(projectDir, { exclude: ["Al/Codeunit/Nope*"] }),
      ).rejects.toThrow(/--exclude matched no .al file for pattern "Al\/Codeunit\/Nope\*"/);
    });
  });

  test("refuses when EVERY file is excluded, rather than reporting a null score", async () => {
    await withProject(TWO_FILES, async (projectDir) => {
      await expect(generateMutationSet(projectDir, { exclude: ["**"] })).rejects.toThrow(
        /every .al file was excluded from mutation/,
      );
    });
  });

  test("an excluded file still feeds the semantic context", async () => {
    // The whole ballgame, and the same claim the `--only` suite above makes. If exclusion narrowed
    // the PARSE set instead of the generation set, excluding a file could change what a mutant in
    // another file resolves to, and the exclusion would be changing verdicts rather than scope.
    await withProject(TWO_FILES, async (projectDir) => {
      const withoutExclusion = await generateMutationSet(projectDir);
      const withExclusion = await generateMutationSet(projectDir, {
        exclude: ["Al/Codeunit/Pricing*"],
      });
      const logicOf = (r: Awaited<ReturnType<typeof generateMutationSet>>) =>
        r.files.find((f) => f.path.includes("Logic"))?.specs.length ?? -1;
      expect(logicOf(withExclusion)).toBe(logicOf(withoutExclusion));
    });
  });
});

describe("parseCliConfig — --exclude", () => {
  test("collects repeated patterns", () => {
    const cfg = parseCliConfig([
      "run",
      "--project",
      "p",
      "--tests",
      "t",
      "--backend",
      "al-runner",
      "--exclude",
      "src/Upgrade/**",
      "--exclude",
      "src/Generated/**",
    ]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.exclude).toEqual(["src/Upgrade/**", "src/Generated/**"]);
  });

  test("refuses an empty pattern at parse time", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "p",
        "--tests",
        "t",
        "--backend",
        "al-runner",
        "--exclude",
        "",
      ]),
    ).toThrow(/--exclude requires a non-empty glob/);
  });

  test("absent when not given, so a plain run is unchanged", () => {
    const cfg = parseCliConfig(["run", "--project", "p", "--tests", "t", "--backend", "al-runner"]);
    // Absent rather than empty, so a plain run's config is byte-identical to what it was before
    // `--exclude` existed.
    expect("exclude" in cfg).toBe(false);
  });
});

/**
 * R221 — the `exclude` config key.
 *
 * A flag-only feature would have been the wrong shape. Generated code, an upgrade codeunit, a
 * vendored subtree: those are true of a project every day, and a caller retyping them on every
 * invocation will eventually retype them wrong, in the direction that silently mutates files the
 * project said to leave alone.
 */
describe("lethal.config.json exclude", () => {
  test("accepts a list of globs, and absent means none", () => {
    expect(validateExcludeGlobs(["src/Upgrade/**", "src/Generated/**"])).toEqual([
      "src/Upgrade/**",
      "src/Generated/**",
    ]);
    expect(validateExcludeGlobs(undefined)).toEqual([]);
  });

  test("REFUSES a non-array, rather than treating a bare string as one pattern", () => {
    expect(() => validateExcludeGlobs("src/Upgrade/**")).toThrow(
      /must be an array of glob strings/,
    );
  });

  test("REFUSES an empty entry, which would otherwise be reported as an unmatched pattern", () => {
    // `""` reaches `Bun.Glob` as a pattern matching nothing, and the orchestrator then refuses it
    // with a message about a pattern the author never wrote.
    expect(() => validateExcludeGlobs(["ok", ""])).toThrow(/non-string or empty entry/);
    expect(() => validateExcludeGlobs(["ok", 42])).toThrow(/non-string or empty entry/);
  });

  test("UNIONS the config list with the CLI flag", () => {
    expect(resolveExclude({ exclude: ["src/Generated/**"] }, ["src/Scratch/**"])).toEqual([
      "src/Generated/**",
      "src/Scratch/**",
    ]);
  });

  test("a CLI flag cannot switch OFF a config exclusion, which is the point of unioning", () => {
    // Override semantics would mean someone narrowing to one folder for a quick run silently
    // re-enables mutation of generated code. There is deliberately no spelling of `--exclude` that
    // removes a config exclusion: to stop excluding something, stop saying so in the config.
    const merged = resolveExclude({ exclude: ["src/Generated/**"] }, ["src/Other/**"]);
    expect(merged).toContain("src/Generated/**");
  });

  test("de-duplicates, so naming the same pattern twice is not two patterns", () => {
    expect(resolveExclude({ exclude: ["src/Gen/**"] }, ["src/Gen/**"])).toEqual(["src/Gen/**"]);
  });

  test("either side alone works", () => {
    expect(resolveExclude({}, ["src/A/**"])).toEqual(["src/A/**"]);
    expect(resolveExclude({ exclude: ["src/B/**"] }, undefined)).toEqual(["src/B/**"]);
    expect(resolveExclude({}, undefined)).toEqual([]);
  });
});
