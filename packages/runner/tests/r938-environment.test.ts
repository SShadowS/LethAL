// R938: `--environment` for al-runner v3: the config key, the target's launch.json, the order they
// decide in, and the argv. The backend-level checks (one-shot call, serve daemon, run row, resume)
// sit beside the suites that own those rigs; this file holds the rest.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v3CallArgv } from "../src/al-runner-v3-backend";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import {
  V3EnvironmentUnknownError,
  chooseV3Environment,
  describeV3Environment,
  resolveV3Environment,
} from "../src/al-runner-v3-environment";
import { buildBackend } from "../src/cli";
import { sessionFingerprint } from "../src/resume";

const base = { packagesDir: "/p", bcVersion: "28.0.46665.47126" };
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A project dir whose .vscode/launch.json holds invented content (never a real file). */
async function project(launch: string | undefined): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r938-"));
  dirs.push(d);
  if (launch !== undefined) {
    await mkdir(join(d, ".vscode"));
    await writeFile(join(d, ".vscode", "launch.json"), launch);
  }
  return d;
}
const launchOf = (...types: string[]) =>
  `// AL launch file\n{ "version": "0.2.0", /* kept */ "configurations": [${types
    .map((t) => `{ "name": "c", "type": "al", "environmentType": "${t}", "server": "http://x" },`)
    .join("\n")}] }`;

describe("R938: alRunnerV3.environment", () => {
  test("saas and onprem are accepted, absent stays absent, anything else is refused by name", () => {
    expect(validateAlRunnerV3Config({ ...base, environment: "onprem" }).environment).toBe("onprem");
    expect(validateAlRunnerV3Config({ ...base, environment: "saas" }).environment).toBe("saas");
    expect("environment" in validateAlRunnerV3Config(base)).toBe(false);
    for (const bad of ["OnPrem", "", true, 3])
      expect(() => validateAlRunnerV3Config({ ...base, environment: bad })).toThrow(
        'al-runner-v3-config-refused: "alRunnerV3.environment" must be "saas" or "onprem"',
      );
  });
});

describe("R938: which environment is chosen", () => {
  test("launch.json OnPrem resolves onprem (comments and trailing commas are fine)", async () => {
    const c = await chooseV3Environment(await project(launchOf("OnPrem")), undefined);
    expect(c).toEqual({ value: "onprem", source: "launch.json" });
  });
  test("launch.json Sandbox and Production resolve saas", async () => {
    for (const t of ["Sandbox", "Production"])
      expect(await chooseV3Environment(await project(launchOf(t)), undefined)).toEqual({
        value: "saas",
        source: "launch.json",
      });
    expect(
      await chooseV3Environment(await project(launchOf("Sandbox", "Production")), undefined),
    ).toEqual({ value: "saas", source: "launch.json" });
  });
  test("configurations that disagree are refused, and the message names the disagreement", async () => {
    await expect(
      chooseV3Environment(await project(launchOf("OnPrem", "Sandbox")), undefined),
    ).rejects.toThrow("disagree on environmentType");
  });
  test("no launch.json, no configurations and no environmentType are refused with the exact fix", async () => {
    for (const launch of [undefined, "{}", '{ "configurations": [ { "name": "x" } ] }', "not json"])
      await expect(chooseV3Environment(await project(launch), undefined)).rejects.toThrow(
        `al-runner-v3: the target's environment is unknown (no alRunnerV3.environment in the config, no environmentType in the target's .vscode/launch.json)`,
      );
    await expect(chooseV3Environment(await project(undefined), undefined)).rejects.toThrow(
      '; set alRunnerV3.environment to "onprem" or "saas"',
    );
  });
  test("the refusal is a typed error that extends Error directly", async () => {
    const e = await chooseV3Environment(await project(undefined), undefined).catch((x) => x);
    expect(e).toBeInstanceOf(V3EnvironmentUnknownError);
    expect(Object.getPrototypeOf(V3EnvironmentUnknownError)).toBe(Error);
  });
  test("buildBackend refuses before the version check or any compile", async () => {
    if (process.platform !== "linux") return; // refuseV3Platform comes first elsewhere
    const dir = await project(undefined);
    await writeFile(
      join(dir, "app.json"),
      JSON.stringify({
        id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
        idRanges: [{ from: 79000, to: 79199 }],
        runtime: "17.0",
      }),
    );
    // packagesDir does not exist: any later check would fail with a different message.
    await expect(
      buildBackend(
        {
          mode: "run",
          projectDir: dir,
          testDir: dir,
          backendKind: "al-runner-v3",
          dbPath: "db",
          configPath: "cfg",
          skipKnownSurvivors: false,
          workers: 1,
          keepEnv: false,
          allowExpiringEnv: false,
        } as Parameters<typeof buildBackend>[0],
        { alRunnerV3: { ...base, packagesDir: join(dir, "nope") } },
        dir,
        undefined,
        { alcRunnable: () => true },
        { selectorId: 79199, controlId: 79198, tableId: 79197 },
      ),
    ).rejects.toThrow('set alRunnerV3.environment to "onprem" or "saas"');
  });
  test("the config key wins over launch.json, and then launch.json is not read", async () => {
    const dir = await project(launchOf("OnPrem"));
    expect(await chooseV3Environment(dir, "saas")).toEqual({ value: "saas", source: "config" });
    let reads = 0;
    await chooseV3Environment(dir, "onprem", async () => {
      reads += 1;
      return "";
    });
    expect(reads).toBe(0);
  });
  test("the decision itself: config, then launch.json, then a refusal", () => {
    expect(resolveV3Environment({ config: "onprem", launch: { value: "saas" } }).source).toBe(
      "config",
    );
    expect(resolveV3Environment({ launch: { value: "saas" } }).source).toBe("launch.json");
    expect(() => resolveV3Environment({ launch: {} })).toThrow(V3EnvironmentUnknownError);
  });
  test("the header line names the value and where it came from", () => {
    expect(describeV3Environment({ value: "onprem", source: "config" })).toBe(
      "al-runner-v3: environment: onprem (alRunnerV3.environment)",
    );
    expect(describeV3Environment({ value: "saas", source: "launch.json" })).toContain(
      "saas (the target's .vscode/launch.json)",
    );
  });
});

describe("R938: argv and fingerprint", () => {
  const a = {
    alRunnerPath: "/b",
    codeunitId: 7,
    stopSeconds: 3,
    packagesDir: "/d",
    bcVersion: "28.0.1.2",
    symbols: [],
    activeDir: "/a",
    testDir: "/t",
  };
  test("v3CallArgv passes --environment <value> when stated and nothing otherwise", () => {
    const on = v3CallArgv({ ...a, environment: "onprem" });
    expect(on[on.indexOf("--environment") + 1]).toBe("onprem");
    expect(v3CallArgv(a)).not.toContain("--environment");
  });
  test("the fingerprint holds the environment: saas, onprem and unstated all differ", () => {
    const f = {
      projectDir: "/p",
      testDir: "/t",
      backend: "al-runner-v3",
      skipKnownSurvivors: false,
      identityScheme: 1,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    };
    const keys = [
      sessionFingerprint(f),
      sessionFingerprint({ ...f, v3Environment: "saas" }),
      sessionFingerprint({ ...f, v3Environment: "onprem" }),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});
