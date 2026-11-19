// PR-194 (R1133): `lethal run --dry-run --backend X` makes the config refusals a real run makes,
// by the same error names, because both call `preflightRunConfig`. It spawns nothing.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V3EnvironmentUnknownError } from "../src/al-runner-v3-environment";
import { dryRunFromCli, preflightRunConfig } from "../src/cli";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const LINUX = process.platform === "linux";
const BC = "28.0.46665.47126";
const IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

let root = "";
let logSpy: ReturnType<typeof spyOn>;
let spawnSpy: ReturnType<typeof spyOn>;
let spawnSyncSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pr194-"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  spawnSpy = spyOn(Bun, "spawn");
  spawnSyncSpy = spyOn(Bun, "spawnSync");
});
afterEach(async () => {
  logSpy.mockRestore();
  spawnSpy.mockRestore();
  spawnSyncSpy.mockRestore();
  await rm(root, { recursive: true, force: true });
});

/** A target project, a packages folder with a System Application, and two scripts that leave a
 *  marker file when RUN (one standing in for alc, one for al-runner). */
async function rig() {
  const app = join(root, "app");
  const pkgs = join(root, "pkgs");
  await mkdir(join(app, "src"), { recursive: true });
  await mkdir(pkgs, { recursive: true });
  await writeFile(
    join(app, "app.json"),
    JSON.stringify({
      id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
      idRanges: [{ from: 79000, to: 79199 }],
      runtime: "17.0",
    }),
  );
  await writeFile(
    join(app, "src", "A.Codeunit.al"),
    'codeunit 79000 "A"\n{\n    procedure F(X: Integer): Integer\n    begin\n        if X > 1 then X := 2;\n        exit(X);\n    end;\n}\n',
  );
  await writeFile(
    join(pkgs, "Microsoft_System Application.app"),
    buildFakeAppWithEntries({
      "NavxManifest.xml": `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="1" Name="System Application" Publisher="Microsoft" Version="${BC}" /></Package>`,
    }),
  );
  const alc = join(root, "fake-alc");
  const runner = join(root, "fake-al-runner");
  for (const [p, m] of [
    [alc, "alc-ran"],
    [runner, "runner-ran"],
  ] as const) {
    await writeFile(p, `#!/bin/sh\ntouch "${join(root, m)}"\n`);
    await chmod(p, 0o755);
  }
  const v3 = {
    path: runner,
    alcPath: alc,
    packagesDir: pkgs,
    bcVersion: BC,
    environment: "onprem",
  };
  return { app, pkgs, alc, runner, v3 };
}

async function dry(
  r: { app: string },
  config: Record<string, unknown>,
  backendKind: "al-runner-v3" | "bcdev" = "al-runner-v3",
): Promise<number> {
  const configPath = join(root, "lethal.config.json");
  await writeFile(configPath, JSON.stringify(config));
  return dryRunFromCli({
    mode: "dry-run",
    projectDir: r.app,
    dbPath: join(root, "lethal.sqlite"),
    configPath,
    configExplicit: true,
    backendKind,
  });
}

const v3test = LINUX ? test : test.skip;

describe("PR-194: a dry run makes the real run's config refusals", () => {
  v3test(
    "a config the real run accepts still passes the dry run, and nothing was spawned",
    async () => {
      const r = await rig();
      expect(await dry(r, { alRunnerV3: r.v3 })).toBe(0);
      expect(existsSync(join(root, "alc-ran"))).toBe(false);
      expect(existsSync(join(root, "runner-ran"))).toBe(false);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(spawnSyncSpy).not.toHaveBeenCalled();
    },
  );

  v3test(
    "R938: no environment anywhere is refused by name (V3EnvironmentUnknownError)",
    async () => {
      const r = await rig();
      const { environment: _e, ...noEnv } = r.v3;
      await expect(dry(r, { alRunnerV3: noEnv })).rejects.toBeInstanceOf(V3EnvironmentUnknownError);
    },
  );

  v3test("a missing alRunnerV3 section is refused", async () => {
    const r = await rig();
    await expect(dry(r, {})).rejects.toThrow('missing the "alRunnerV3" section');
  });

  v3test("a bad v3 key is refused by name", async () => {
    const r = await rig();
    await expect(dry(r, { alRunnerV3: { ...r.v3, transport: "pipe" } })).rejects.toThrow(
      "al-runner-v3-config-refused",
    );
  });

  v3test("a license file that is not there is refused (al-runner-v3-license-missing)", async () => {
    const r = await rig();
    await expect(
      dry(r, { alRunnerV3: { ...r.v3, license: join(root, "none.bclicense") } }),
    ).rejects.toThrow("al-runner-v3-license-missing");
  });

  v3test(
    "a packages folder that is not there is refused (al-runner-v3-packages-dir-missing)",
    async () => {
      const r = await rig();
      await expect(
        dry(r, { alRunnerV3: { ...r.v3, packagesDir: join(root, "nope") } }),
      ).rejects.toThrow("al-runner-v3-packages-dir-missing");
    },
  );

  v3test("a bcVersion that differs from the System Application is refused", async () => {
    const r = await rig();
    await expect(
      dry(r, { alRunnerV3: { ...r.v3, bcVersion: "28.4.53241.53758" } }),
    ).rejects.toThrow("al-runner-v3-bc-version-mismatch");
  });

  v3test("an alcPath that is not executable is refused (al-runner-v3-alc-not-found)", async () => {
    const r = await rig();
    await expect(
      dry(r, { alRunnerV3: { ...r.v3, alcPath: join(root, "no-such-alc") } }),
    ).rejects.toThrow("al-runner-v3-alc-not-found");
  });

  v3test("selector ids outside the app's idRanges are refused", async () => {
    const r = await rig();
    await expect(
      dry(r, {
        alRunnerV3: r.v3,
        selectorIds: { selectorId: 10, controlId: 11, tableId: 12 },
      }),
    ).rejects.toThrow(/10|idRanges|range/i);
  });

  v3test("a missing assembly probing folder is refused", async () => {
    const r = await rig();
    await expect(
      dry(r, { alRunnerV3: r.v3, assemblyProbingPaths: [join(root, "no-probing")] }),
    ).rejects.toThrow();
  });

  test("the platform refusal (al-runner-v3-platform-unsupported)", async () => {
    const r = await rig();
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    if (real === undefined) throw new Error("no process.platform");
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      await expect(dry(r, { alRunnerV3: r.v3 })).rejects.toThrow(
        "al-runner-v3-platform-unsupported",
      );
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });

  test("bcdev: a missing bcdev section, then missing fields, are refused", async () => {
    const r = await rig();
    await expect(dry(r, {}, "bcdev")).rejects.toThrow('missing the "bcdev" section');
    await expect(dry(r, { bcdev: { server: "http://x" } }, "bcdev")).rejects.toThrow(
      "missing required field(s)",
    );
  });

  test("bcdev with an envTool section: the bcdev section is left to provisioning", async () => {
    const r = await rig();
    expect(await dry(r, { bcdev: {}, envTool: { command: ["x"] } }, "bcdev")).toBe(0);
  });

  test("no config at all still passes a dry run (issue #21)", async () => {
    const r = await rig();
    expect(
      await dryRunFromCli({
        mode: "dry-run",
        projectDir: r.app,
        dbPath: join(root, "lethal.sqlite"),
        configPath: join(root, "absent.json"),
        backendKind: "al-runner-v3",
      }),
    ).toBe(0);
  });
});

describe("PR-194: the alc lookup, through the shared function", () => {
  const parsed = (backendKind: "al-runner-v3" | "bcdev") => ({
    backendKind,
    projectDir: "",
  });
  v3test("v3: no alc anywhere is refused", async () => {
    const r = await rig();
    const { alcPath: _a, ...noAlc } = r.v3;
    await expect(
      preflightRunConfig({
        parsed: { ...parsed("al-runner-v3"), projectDir: r.app },
        configFile: { alRunnerV3: noAlc },
        selectorIds: IDS,
        alToolPaths: async () => undefined,
      }),
    ).rejects.toThrow("could not locate alc under the AL Language VS Code extension");
  });
  test("bcdev: no alc / no altool is refused, and an env-tool deploy needs only alc", async () => {
    const r = await rig();
    const bcdev = {
      mcpCommand: ["x"],
      server: "http://s",
      serverInstance: "BC",
      company: "C",
      username: "u",
      password: "p",
      packageCachePath: r.pkgs,
      controlSymbolPath: "c",
    };
    const base = {
      parsed: { ...parsed("bcdev"), projectDir: r.app },
      configFile: { bcdev },
      selectorIds: IDS,
    };
    await expect(
      preflightRunConfig({ ...base, alToolPaths: async () => undefined }),
    ).rejects.toThrow("could not locate alc.exe/altool.exe");
    await expect(
      preflightRunConfig({
        ...base,
        alToolPaths: async () => undefined,
        envToolDeployed: true,
      }),
    ).rejects.toThrow("could not locate alc.exe under");
    await expect(
      preflightRunConfig({
        ...base,
        configFile: { bcdev: { ...bcdev, alcPath: "/a", altoolPath: "/b" } },
      }),
    ).resolves.toBeDefined();
  });
});
