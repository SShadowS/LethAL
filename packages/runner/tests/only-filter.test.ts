import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliConfig } from "../src/cli";
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
