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
  chooseV3Environment,
  describeV3Environment,
  resolveV3Environment,
} from "../src/al-runner-v3-environment";
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
  test("configurations that disagree give no answer, and the note names the disagreement", async () => {
    const c = await chooseV3Environment(await project(launchOf("OnPrem", "Sandbox")), undefined);
    expect(c.value).toBeUndefined();
    expect(c.source).toBe("unstated");
    expect(c.note).toContain("disagree");
    expect(describeV3Environment(c)).toContain("not stated");
  });
  test("no launch.json, no configurations and no environmentType give no answer", async () => {
    for (const launch of [undefined, "{}", '{ "configurations": [ { "name": "x" } ] }', "not json"])
      expect((await chooseV3Environment(await project(launch), undefined)).value).toBeUndefined();
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
  test("the decision itself: config, then launch.json, then unstated", () => {
    expect(resolveV3Environment({ config: "onprem", launch: { value: "saas" } }).source).toBe(
      "config",
    );
    expect(resolveV3Environment({ launch: { value: "saas" } }).source).toBe("launch.json");
    expect(resolveV3Environment({ launch: {} })).toEqual({ value: undefined, source: "unstated" });
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
