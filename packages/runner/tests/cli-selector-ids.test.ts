import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import type { LethalConfigFile, RunCliConfig } from "../src/cli";
import { buildBackend, validateSelectorIdsForProject } from "../src/cli";

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
  const dir = await mkdtemp(join(tmpdir(), "lethal-selector-ids-"));
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

function runConfig(projectDir: string, backendKind: "bcdev" | "al-runner"): RunCliConfig {
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
  it("al-runner: builds successfully with in-range, non-colliding ids", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE);
    const configFile: LethalConfigFile = { alRunner: { alRunnerPath: "al-runner.exe" } };
    const backend = await buildBackend(
      runConfig(dir, "al-runner"),
      configFile,
      dir,
      undefined,
      {},
      IN_RANGE_IDS,
    );
    expect(backend).toBeInstanceOf(AlRunnerBackend);
  });

  it("al-runner: refuses an out-of-range selectorId before constructing the backend", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE);
    const configFile: LethalConfigFile = { alRunner: { alRunnerPath: "al-runner.exe" } };
    await expect(
      buildBackend(
        runConfig(dir, "al-runner"),
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
  });

  it("al-runner: honors the resolved selectorId as the emitted selector's object id", async () => {
    const dir = await writeTempProject(DEFAULT_RANGE);
    const configFile: LethalConfigFile = { alRunner: { alRunnerPath: "al-runner.exe" } };
    const customIds = { selectorId: 79150, controlId: 79151, tableId: 79152 };
    const backend = (await buildBackend(
      runConfig(dir, "al-runner"),
      configFile,
      dir,
      undefined,
      {},
      customIds,
    )) as AlRunnerBackend;
    // AlRunnerBackend keeps no public getter for `selectorObjectId` — the only observable proof
    // it received the RESOLVED id (not a silently-reverted `DEFAULT_SELECTOR_IDS.selectorId`) is
    // what `activate()` actually bakes into the emitted static selector's `codeunit <id>` header
    // (`emitStaticSelector`, selector.ts). No prior `deploy()` here, so `activate()` writes
    // straight into `cfg.instrumentedDir` (`join(scratchDir, "al-runner-active")`, scratchDir ===
    // `dir` for this call) — that directory must exist first (`activate()` itself never creates
    // it; `deploy()` normally would).
    const instrumentedDir = join(dir, "al-runner-active");
    await mkdir(instrumentedDir, { recursive: true });
    await backend.activate(null);
    const selectorSrc = await readFile(
      join(instrumentedDir, "MutationSelector.Codeunit.al"),
      "utf8",
    );
    expect(selectorSrc).toContain(`codeunit ${customIds.selectorId} "Mutation Selector"`);
    // Guards specifically against the wiring regression a red-check found missing here: reverting
    // `buildBackend`'s al-runner branch back to `selectorObjectId: DEFAULT_SELECTOR_IDS.selectorId`
    // would still construct an `AlRunnerBackend` successfully (an `instanceof` check alone can't
    // tell), but would bake object id 79199 instead of the resolved 79150 into the emitted source.
    expect(selectorSrc).not.toContain('codeunit 79199 "Mutation Selector"');
  });

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
