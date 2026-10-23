import { describe, expect, it } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTargetSource } from "../src/baseline-snapshot";
import type { LethalConfigFile, RunCliConfig } from "../src/cli";
import { buildBackend, validateSelectorIdsForProject } from "../src/cli";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

/**
 * R3/R4: proves the real (non-mocked) `buildBackend`/`validateSelectorIdsForProject` wiring —
 * `resolveSelectorIds` alone (tested in cli.test.ts) only proves the id CHOICE; this proves that
 * choice is actually validated against a real target project's app.json `idRanges` and its
 * already-declared object ids before a backend is built, for BOTH backends.
 *
 * Uses a real temp directory (unlike cli-envtool.test.ts's fake "C:/proj") because the whole
 * point under test is real filesystem app.json/`.al` reading.
 */
async function writeTempProject(
  idRanges: ReadonlyArray<{ from: number; to: number }>,
  extraAlFiles: Readonly<Record<string, string>> = {},
): Promise<string> {
  const dir = scratch("lethal-selector-ids-");
  await writeFile(
    join(dir, "app.json"),
    JSON.stringify({ id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a", idRanges }),
    "utf8",
  );
  for (const [name, content] of Object.entries(extraAlFiles)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

const IN_RANGE_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };
const DEFAULT_RANGE = [{ from: 79000, to: 79199 }];

function runConfig(projectDir: string, backendKind: "bcdev" | "al-runner-v3"): RunCliConfig {
  return {
    mode: "run",
    projectDir,
    testDir: "unused",
    backendKind,
    dbPath: "db",
    configPath: "cfg",
    skipKnownSurvivors: false,
    workers: 1,
    keepEnv: false,
    allowExpiringEnv: false,
  };
}

describe("validateSelectorIdsForProject", () => {
  it("accepts ids that fall inside the target app.json's idRanges", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE);
    await expect(validateSelectorIdsForProject(dir, IN_RANGE_IDS)).resolves.toBeUndefined();
  });

  it("rejects an id outside every declared range", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE);
    await expect(
      validateSelectorIdsForProject(dir, { selectorId: 1, controlId: 79198, tableId: 79197 }),
    ).rejects.toThrow(/selectorId.*= 1 falls outside every idRange/s);
  });

  it("rejects an id colliding with an existing codeunit already declared in the project", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE, {
      "Existing.Codeunit.al": 'codeunit 79197 "Existing Thing"\n{\n}\n',
    });
    await expect(validateSelectorIdsForProject(dir, IN_RANGE_IDS)).rejects.toThrow(
      /tableId.*= 79197 is already declared as codeunit 79197 "Existing Thing"/s,
    );
  });

  // R205: the check reads the session's snapshot, so an edit after it can neither reject the
  // pinned project nor hide a collision the build still holds.
  it("R205: idRanges changed on disk after the snapshot do not reject the pinned project", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE);
    const snapshot = await readTargetSource(dir);
    await writeFile(join(dir, "app.json"), JSON.stringify({ idRanges: [{ from: 1, to: 2 }] }));
    await expect(
      validateSelectorIdsForProject(dir, IN_RANGE_IDS, snapshot),
    ).resolves.toBeUndefined();
  });

  it("R205: a collision removed from disk after the snapshot is still refused", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE, {
      "Existing.Codeunit.al": 'codeunit 79197 "Existing Thing"\n{\n}\n',
    });
    const snapshot = await readTargetSource(dir);
    await rm(join(dir, "Existing.Codeunit.al"));
    await expect(validateSelectorIdsForProject(dir, IN_RANGE_IDS, snapshot)).rejects.toThrow(
      /tableId.*= 79197 is already declared as codeunit 79197 "Existing Thing"/s,
    );
  });

  it("never collides with a table at the same id (BC ids are unique only within a type)", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE, {
      "Existing.Table.al": 'table 79197 "Existing Table"\n{\n}\n',
    });
    await expect(validateSelectorIdsForProject(dir, IN_RANGE_IDS)).resolves.toBeUndefined();
  });

  it("ignores this tool's own previously emitted files (exact filenames) when scanning for collisions", async () => {
    // `emitRegisterUpgrade` bakes the *previous* tableId into a file literally named
    // MutationUpgrade.Codeunit.al (CONTROL_UPGRADE_FILENAME) — if the scan didn't skip this
    // exact, known set of this tool's own emitted filenames, a project that had EVER been
    // instrumented before would permanently collide with its own prior selector ids.
    const dir = await writeTempProject(DEFAULT_RANGE, {
      "MutationUpgrade.Codeunit.al": 'codeunit 79197 "Mutation Upgrade"\n{\n}\n',
    });
    await expect(validateSelectorIdsForProject(dir, IN_RANGE_IDS)).resolves.toBeUndefined();
  });

  it("does NOT ignore a user file that merely starts with 'Mutation' but isn't one of this tool's exact emitted filenames", async () => {
    // Review fix (R3): the original scan skipped every `Mutation*.al` file by PREFIX, which would
    // also silently skip a user's own legitimately-named file (e.g. a hand-written
    // "MutationTestHelper.Codeunit.al") from the collision scan — exactly the "miss a real
    // collision" failure this whole check exists to prevent. The scan now matches the three
    // emitted filenames exactly (CONTROL_SELECTOR_FILENAME/CONTROL_REGISTER_FILENAME/
    // CONTROL_UPGRADE_FILENAME), so a same-name-but-different file like this one is scanned like
    // any other and its id collision is caught.
    const dir = await writeTempProject(DEFAULT_RANGE, {
      "MutationTestHelper.Codeunit.al": 'codeunit 79198 "Mutation Test Helper"\n{\n}\n',
    });
    await expect(validateSelectorIdsForProject(dir, IN_RANGE_IDS)).rejects.toThrow(
      /controlId.*= 79198 is already declared as codeunit 79198 "Mutation Test Helper"/s,
    );
  });
});

describe("buildBackend — R3/R4 selector id validation wiring", () => {
  // R654: these ran on the retired .NET al-runner. Re-pointed to al-runner-v3, whose build checks
  // the ids right after its platform check (so Linux only) and BEFORE it reads its config section:
  // an empty config reaching the `alRunnerV3` section error proves the id check passed.
  it.skipIf(process.platform !== "linux")(
    "R205 al-runner-v3: the id check inside buildBackend reads the snapshot it is handed",
    async () => {
      const dir = await writeTempProject(DEFAULT_RANGE);
      const snapshot = await readTargetSource(dir);
      await writeFile(join(dir, "app.json"), JSON.stringify({ idRanges: [{ from: 1, to: 2 }] }));
      await expect(
        buildBackend(
          runConfig(dir, "al-runner-v3"),
          {},
          dir,
          undefined,
          {},
          IN_RANGE_IDS,
          snapshot,
        ),
      ).rejects.toThrow(/alRunnerV3/);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "al-runner-v3: refuses an out-of-range selectorId before constructing the backend",
    async () => {
      const dir = await writeTempProject(DEFAULT_RANGE);
      const configFile: LethalConfigFile = {};
      await expect(
        buildBackend(
          runConfig(dir, "al-runner-v3"),
          configFile,
          dir,
          undefined,
          {},
          {
            selectorId: 1,
            controlId: 79198,
            tableId: 79197,
          },
        ),
      ).rejects.toThrow(/selectorId.*= 1 falls outside every idRange/s);
    },
  );

  it("bcdev: refuses an id colliding with the target's existing objects, once alc/altool are found", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE, {
      "Existing.Codeunit.al": 'codeunit 79198 "Existing Thing"\n{\n}\n',
    });
    const configFile: LethalConfigFile = {
      bcdev: {
        mcpCommand: ["bun", "mcp"],
        server: "https://host",
        serverInstance: "BC",
        company: "CRONUS",
        username: "u",
        password: "p",
        packageCachePath: "C:/pkg",
        controlSymbolPath: "C:/lethal-control.app",
      },
    };
    // `alToolPaths` is mocked truthy (a real, unmocked lookup would depend on whatever's actually
    // installed on the machine running this suite — non-deterministic for a unit test). Placed
    // AFTER the "could not locate alc.exe/altool.exe" guard in `buildBackend` (see that function's
    // comment on this ordering): it must still run well before any real ArtifactCompiler/alc
    // invocation, which is what this test proves.
    await expect(
      buildBackend(
        runConfig(dir, "bcdev"),
        configFile,
        dir,
        undefined,
        {
          alToolPaths: async () => ({ alcPath: "fake-alc.exe", altoolPath: "fake-altool.exe" }),
        },
        IN_RANGE_IDS,
      ),
    ).rejects.toThrow(/controlId.*= 79198 is already declared as codeunit 79198 "Existing Thing"/s);
  });

  it("bcdev: still reports the missing alc/altool install first when BOTH are wrong", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE);
    const configFile: LethalConfigFile = {
      bcdev: {
        mcpCommand: ["bun", "mcp"],
        server: "https://host",
        serverInstance: "BC",
        company: "CRONUS",
        username: "u",
        password: "p",
        packageCachePath: "C:/pkg",
        controlSymbolPath: "C:/lethal-control.app",
      },
    };
    await expect(
      buildBackend(
        runConfig(dir, "bcdev"),
        configFile,
        dir,
        undefined,
        { alToolPaths: async () => undefined },
        { selectorId: 1, controlId: 79198, tableId: 79197 }, // also out of range
      ),
    ).rejects.toThrow(/could not locate alc\.exe\/altool\.exe/);
  });
});
