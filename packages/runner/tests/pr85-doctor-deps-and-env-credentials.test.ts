// PR-85. R1087: `lethal doctor` reads each dependency's installed version on the server.
// R1086: `bcdev.credentialsEnv` reads the login from named environment variables.
// Fakes only: no server, nothing under /coord.
import { describe, expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BcDevConfigSection,
  type LethalConfigFile,
  buildDoctorDeps,
  doctorFromCli,
  doctorJson,
  initFromCli,
  parseCliConfig,
  refuseCredentialsEnvWithEnvTool,
  renderDoctorReport,
  validateBcDevConfig,
} from "../src/cli";
import { cliError } from "../src/cli-envelope";
import { checkServerDependencies, runDoctor } from "../src/doctor";
import { CONTROL_APP_ID, MIN_CONTROL_VERSION } from "../src/harness";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const TARGET = "dddddddd-0000-4000-8000-000000000004";

const row = (version: string, installed: string[]) => ({
  id: A,
  name: "Dep A",
  publisher: "Pub",
  version,
  installed,
});

// ---------------------------------------------------------------------------------------------
// R1087, the check itself
// ---------------------------------------------------------------------------------------------
describe("R1087 checkServerDependencies", () => {
  test("installed at the required version: ok; equal is ok", () => {
    const c = checkServerDependencies({ dependencies: [row("28.0.0.0", ["28.0.0.0"])] });
    expect(c.ok).toBe(true);
    expect(c.dependencies?.[0]?.status).toBe("ok");
    expect(c.detail).toContain("were not checked");
  });

  test("the comparison is numeric, part by part: 10.0 beats 9.0, 28.5 is below 30.0", () => {
    expect(checkServerDependencies({ dependencies: [row("9.0.0.0", ["10.0.0.0"])] }).ok).toBe(true);
    const old = checkServerDependencies({ dependencies: [row("30.0.0.0", ["28.5.0.0"])] });
    expect(old.ok).toBe(false);
    expect(old.dependencies?.[0]?.status).toBe("too-old");
    expect(old.detail).toContain("TOO OLD");
    expect(old.detail).toContain("Dep A");
    expect(old.detail).toContain("Pub");
    expect(old.detail).toContain(A);
    expect(old.detail).toContain("needs 30.0.0.0");
    expect(old.detail).toContain("installed 28.5.0.0");
  });

  test("a part above 65535 is compared, not refused", () => {
    expect(
      checkServerDependencies({ dependencies: [row("1.0.0.70000", ["1.0.0.80000"])] }).ok,
    ).toBe(true);
    expect(
      checkServerDependencies({ dependencies: [row("1.0.0.80000", ["1.0.0.70000"])] }).ok,
    ).toBe(false);
  });

  test("one installed version at or above is enough when two are installed", () => {
    expect(
      checkServerDependencies({ dependencies: [row("2.0.0.0", ["1.0.0.0", "2.1.0.0"])] }).ok,
    ).toBe(true);
  });

  test("no installed version: missing, named, and the check fails", () => {
    const c = checkServerDependencies({ dependencies: [row("1.0.0.0", [])] });
    expect(c.ok).toBe(false);
    expect(c.dependencies?.[0]?.status).toBe("missing");
    expect(c.detail).toContain("MISSING");
    expect(c.detail).toContain("not installed");
  });

  test("a mix names only the failing ones", () => {
    const c = checkServerDependencies({
      dependencies: [row("1.0.0.0", ["1.0.0.0"]), { ...row("1.0.0.0", []), id: B, name: "Gone" }],
    });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Gone");
    expect(c.detail).not.toContain("MISSING: Pub Dep A");
    expect(c.dependencies?.map((d) => d.status)).toEqual(["ok", "missing"]);
  });

  test("a skip is a skipped check that is not a failure", () => {
    const c = checkServerDependencies({ skip: "because" });
    expect(c).toMatchObject({ ok: true, skipped: true });
    expect(c.detail).toContain("because");
  });
});

// ---------------------------------------------------------------------------------------------
// R1087, the wiring in buildDoctorDeps
// ---------------------------------------------------------------------------------------------
const BCDEV = {
  mcpCommand: ["bun", "mcp"],
  server: "https://host",
  serverInstance: "BC",
  company: "CRONUS",
  username: "u",
  password: "p",
  controlSymbolPath: "C:/lethal-control.app",
};

async function appFolder(app: Record<string, unknown>): Promise<string> {
  const dir = scratch("lethal-pr85-app-");
  await writeFile(join(dir, "app.json"), JSON.stringify(app), "utf8");
  return dir;
}
const dep = (id: string, name: string, version: string) => ({
  id,
  name,
  publisher: "Pub",
  version,
});

describe("R1087 server-dependencies wiring", () => {
  async function probe(
    installed: Record<string, readonly string[] | Error>,
    over: { noProject?: boolean; noTests?: boolean; envTool?: boolean } = {},
  ) {
    const project = await appFolder({
      id: TARGET,
      dependencies: [dep(A, "Dep A", "28.0.0.0"), dep(B, "Dep B", "1.0.0.0")],
    });
    const tests = await appFolder({
      dependencies: [
        dep(TARGET, "The Target", "1.0.0.0"), // LethAL publishes the target: skipped
        dep(A, "Dep A", "28.0.0.0"), // already read for the target
        dep(C, "Dep C", "2.0.0.0"),
      ],
    });
    const reads: string[] = [];
    const { deps } = await buildDoctorDeps(
      {
        // an envTool resolves the connection: the file holds none of it
        bcdev: over.envTool
          ? {
              mcpCommand: BCDEV.mcpCommand,
              company: BCDEV.company,
              controlSymbolPath: BCDEV.controlSymbolPath,
              packageCachePath: scratch("lethal-pr85-cache-"),
            }
          : { ...BCDEV, packageCachePath: scratch("lethal-pr85-cache-") },
        ...(over.envTool
          ? {
              envTool: {
                toolPath: "tool.exe",
                envId: "env-1",
                resolve: [
                  { command: ["env", "get", "{envId}"], reads: { baseUrl: "u" } },
                  { command: ["env", "u", "{envId}"], reads: { username: "u", password: "p" } },
                ],
                publish: { command: ["publish", "{envId}", "{appFile}"] },
              },
            }
          : {}),
      } as LethalConfigFile,
      {
        alToolPaths: async () => ({ alcPath: "alc", altoolPath: "altool" }),
        alcSpawn: async () => ({
          exitCode: 0,
          stdout: "AL Compiler version 18.0.1.1\n",
          stderr: "",
        }),
        ...(over.noProject ? {} : { projectDir: project }),
        ...(over.noTests ? {} : { testsDir: tests }),
        installedVersions: async (id) => {
          reads.push(id);
          const v = installed[id];
          if (v instanceof Error) throw v;
          return v ?? [];
        },
      },
    );
    const serverDependencies = deps.serverDependencies;
    if (serverDependencies === undefined) throw new Error("no serverDependencies dep");
    const report = await runDoctor({}, { serverDependencies });
    const check = report.checks.find((c) => c.name === "server-dependencies");
    if (check === undefined) throw new Error("no check");
    return { check, reads };
  }

  test("one read per distinct id, the test app's dependency on the target is skipped", async () => {
    const { check, reads } = await probe({ [A]: ["28.1.0.0"], [B]: ["1.0.0.0"], [C]: ["2.0.0.0"] });
    expect(check.ok).toBe(true);
    expect(reads).toEqual([A, B, C]); // A once; TARGET never; each by id
    expect(check.dependencies?.map((d) => d.id)).toEqual([A, B, A, C]);
  });

  test("missing and too old are named; the target is never reported", async () => {
    const { check } = await probe({ [A]: ["27.0.0.0"], [B]: [], [C]: ["2.0.0.0"] });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Dep A");
    expect(check.detail).toContain("Dep B");
    expect(check.detail).not.toContain("The Target");
    expect(check.detail).not.toContain("Dep C (");
  });

  test("a read error fails the check, names the id, and is not read as missing", async () => {
    const { check } = await probe({
      [A]: ["28.0.0.0"],
      [B]: new Error("HTTP 500 from the server"),
      [C]: ["2.0.0.0"],
    });
    expect(check.ok).toBe(false);
    expect(check.skipped).toBeUndefined();
    expect(check.detail).toContain(B);
    expect(check.detail).toContain("HTTP 500");
    expect(check.detail).not.toContain("MISSING");
  });

  test("no --project: skipped with a reason, and nothing is read", async () => {
    const { check, reads } = await probe({}, { noProject: true });
    expect(check).toMatchObject({ ok: true, skipped: true });
    expect(check.detail).toContain("--project");
    expect(reads).toEqual([]);
  });

  test("an envTool config: skipped with a reason, and nothing is read", async () => {
    const { check, reads } = await probe({}, { envTool: true });
    expect(check).toMatchObject({ ok: true, skipped: true });
    expect(check.detail).toContain("envTool");
    expect(reads).toEqual([]);
  });

  test("with --project only, the target's dependencies are read", async () => {
    const { reads } = await probe({ [A]: ["28.0.0.0"], [B]: ["1.0.0.0"] }, { noTests: true });
    expect(reads).toEqual([A, B]);
  });

  test("the real reader: by app id (a $filter), one request per id, never a list of all extensions", async () => {
    const project = await appFolder({ id: TARGET, dependencies: [dep(A, "Dep A", "28.0.0.0")] });
    const urls: string[] = [];
    const fetchFn = (async (url: unknown) => {
      const u = decodeURIComponent(String(url));
      urls.push(u);
      if (u.includes("/extensions")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                isInstalled: true,
                versionMajor: 28,
                versionMinor: 4,
                versionBuild: 0,
                versionRevision: 1,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ value: [{ id: "co-1", name: "CRONUS" }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const { deps } = await buildDoctorDeps(
      { bcdev: { ...BCDEV, packageCachePath: scratch("lethal-pr85-cache-") } },
      {
        projectDir: project,
        fetchFn,
        alToolPaths: async () => ({ alcPath: "alc", altoolPath: "altool" }),
      },
    );
    const sd = deps.serverDependencies;
    if (sd === undefined) throw new Error("no dep");
    const report = await runDoctor({}, { serverDependencies: sd });
    expect(report.checks[0]?.ok).toBe(true);
    const ext = urls.filter((u) => u.includes("/extensions"));
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatch(new RegExp(`\\$filter=id[+ ]eq[+ ]${A}`));
  });
});

// ---------------------------------------------------------------------------------------------
// R1086
// ---------------------------------------------------------------------------------------------
const CANARY_USER = "CANARY-user-Qw7!x";
const CANARY_PASS = "CANARY-p@ss-Zx9#k";
const ENV = { LETHAL_T_USER: CANARY_USER, LETHAL_T_PASS: CANARY_PASS };
const CE = { username: "LETHAL_T_USER", password: "LETHAL_T_PASS" };
const BASE: Partial<BcDevConfigSection> = {
  mcpCommand: ["bun", "mcp"],
  server: "https://host",
  serverInstance: "BC",
  company: "CRONUS",
  controlSymbolPath: "C:/lethal-control.app",
  packageCachePath: "C:/cache",
};

function refusal(raw: Partial<BcDevConfigSection>, env: Record<string, string | undefined>) {
  try {
    validateBcDevConfig(raw, env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("R1086 credentialsEnv resolution", () => {
  test("username, password and both env entries come from the variables", () => {
    const c = validateBcDevConfig({ ...BASE, credentialsEnv: CE }, ENV);
    expect(c.username).toBe(CANARY_USER);
    expect(c.password).toBe(CANARY_PASS);
    expect(c.env).toEqual({ BC_DEV_USER: CANARY_USER, BC_DEV_PASSWORD: CANARY_PASS });
  });

  test("other env entries are kept", () => {
    const c = validateBcDevConfig({ ...BASE, credentialsEnv: CE, env: { OTHER: "x" } }, ENV);
    expect(c.env).toEqual({
      OTHER: "x",
      BC_DEV_USER: CANARY_USER,
      BC_DEV_PASSWORD: CANARY_PASS,
    });
  });

  test("the environment parameter defaults to the process environment", () => {
    process.env.LETHAL_T_USER = "u-from-process";
    process.env.LETHAL_T_PASS = "p-from-process";
    try {
      expect(validateBcDevConfig({ ...BASE, credentialsEnv: CE }).username).toBe("u-from-process");
    } finally {
      Reflect.deleteProperty(process.env, "LETHAL_T_USER");
      Reflect.deleteProperty(process.env, "LETHAL_T_PASS");
    }
  });

  test("without credentialsEnv nothing changes", () => {
    const full = { ...BASE, username: "a", password: "b" };
    expect(validateBcDevConfig(full, ENV)).toEqual(full as never);
  });

  for (const [field, patch] of [
    ["username", { username: "x" }],
    ["password", { password: "x" }],
    ["env.BC_DEV_USER", { env: { BC_DEV_USER: "x" } }],
    ["env.BC_DEV_PASSWORD", { env: { BC_DEV_PASSWORD: "x" } }],
  ] as const) {
    test(`refused together with ${field}, naming it`, () => {
      const m = refusal({ ...BASE, credentialsEnv: CE, ...patch }, ENV);
      expect(m).toContain(`"${field}"`);
      expect(m).toContain("credentialsEnv");
      expect(m).not.toContain(CANARY_PASS);
      expect(m).not.toContain(CANARY_USER);
    });
  }

  test("a missing or empty variable name is refused, naming the field", () => {
    for (const bad of [
      { username: "LETHAL_T_USER" },
      { username: "LETHAL_T_USER", password: "" },
      { password: "LETHAL_T_PASS" },
    ]) {
      const m = refusal({ ...BASE, credentialsEnv: bad as never }, ENV);
      expect(m).toMatch(/credentialsEnv\.(username|password)/);
    }
    expect(refusal({ ...BASE, credentialsEnv: "X" as never }, ENV)).toContain("credentialsEnv");
  });

  test("a bad variable name is refused and NEVER echoed (it may be the password itself)", () => {
    for (const bad of [CANARY_PASS, "1ABC", "A-B", "A B"]) {
      const m = refusal(
        { ...BASE, credentialsEnv: { username: "LETHAL_T_USER", password: bad } },
        ENV,
      );
      expect(m).toContain("credentialsEnv.password");
      expect(m).toContain("not a valid environment variable name");
      expect(m).not.toContain(bad);
    }
  });

  test("an unset variable is refused, naming the VARIABLE and not any value", () => {
    const m = refusal({ ...BASE, credentialsEnv: CE }, { LETHAL_T_USER: CANARY_USER });
    expect(m).toContain("LETHAL_T_PASS");
    expect(m).toContain("not set");
    expect(m).not.toContain(CANARY_USER);
  });

  test("an empty variable is refused, naming the VARIABLE", () => {
    const m = refusal({ ...BASE, credentialsEnv: CE }, { LETHAL_T_USER: "", LETHAL_T_PASS: "x" });
    expect(m).toContain("LETHAL_T_USER");
    expect(m).toContain("set but empty");
  });

  test("envTool together with credentialsEnv is refused by name", () => {
    expect(() =>
      refuseCredentialsEnvWithEnvTool({
        bcdev: { credentialsEnv: CE },
        envTool: { toolPath: "t" },
      } as LethalConfigFile),
    ).toThrow(/envTool.*credentialsEnv/);
    expect(() => refuseCredentialsEnvWithEnvTool({ envTool: { toolPath: "t" } })).not.toThrow();
    expect(() => refuseCredentialsEnvWithEnvTool({ bcdev: { credentialsEnv: CE } })).not.toThrow();
  });
});

describe("R1086 lethal init --credentials-env", () => {
  async function init(extra: Record<string, unknown>) {
    const dir = scratch("lethal-pr85-init-");
    await writeFile(
      join(dir, "app.json"),
      JSON.stringify({ id: TARGET, name: "T", idRanges: [{ from: 60000, to: 60099 }] }),
      "utf8",
    );
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await initFromCli({ mode: "init", projectDir: dir, ...extra } as never);
    } finally {
      log.mockRestore();
    }
    const written = JSON.parse(await readFile(join(dir, "lethal.config.json"), "utf8")) as {
      bcdev: Record<string, unknown>;
    };
    return { written, out: lines.join("\n") };
  }

  test("writes credentialsEnv instead of the login placeholders and the env pair", async () => {
    const { written, out } = await init({
      credentialsEnv: { username: "BC_USER", password: "BC_PASS" },
    });
    expect(written.bcdev.credentialsEnv).toEqual({ username: "BC_USER", password: "BC_PASS" });
    expect(written.bcdev.username).toBeUndefined();
    expect(written.bcdev.password).toBeUndefined();
    expect(written.bcdev.env).toBeUndefined();
    expect(out).toContain("BC_USER");
    // the file validates once the variables exist
    expect(
      validateBcDevConfig(written.bcdev as Partial<BcDevConfigSection>, {
        BC_USER: "a",
        BC_PASS: "b",
      }).env,
    ).toEqual({ BC_DEV_USER: "a", BC_DEV_PASSWORD: "b" });
  });

  test("without the flag the old placeholders are written", async () => {
    const { written } = await init({});
    expect(written.bcdev.username).toBe("admin");
    expect(written.bcdev.credentialsEnv).toBeUndefined();
    expect(written.bcdev.env).toBeDefined();
  });

  test("the flag parses on init, is refused elsewhere, and a bad value is refused without echo", () => {
    const ok = parseCliConfig(["init", "--project", "P", "--credentials-env", "A_USER,A_PASS"]);
    expect(ok).toMatchObject({
      mode: "init",
      credentialsEnv: { username: "A_USER", password: "A_PASS" },
    });
    expect(() =>
      parseCliConfig(["run", "--project", "P", "--tests", "T", "--credentials-env", "A,B"]),
    ).toThrow(/only accepted by `lethal init`/);
    for (const bad of ["ONLY_ONE", "A,B,C", `A,${CANARY_PASS}`]) {
      let msg = "";
      try {
        parseCliConfig(["init", "--project", "P", "--credentials-env", bad]);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain("--credentials-env");
      expect(msg).not.toContain(CANARY_PASS);
    }
  });

  test("with --backend al-runner-v3 it is refused by name", async () => {
    await expect(
      init({ backendKind: "al-runner-v3", credentialsEnv: { username: "A", password: "B" } }),
    ).rejects.toThrow(/credentials-env/);
  });
});

// ---------------------------------------------------------------------------------------------
// R1086, the canary scan over every output surface reachable with fakes
// ---------------------------------------------------------------------------------------------
describe("R1086 the canary never appears in an output", () => {
  function info(): Record<string, unknown> {
    return {
      appId: CONTROL_APP_ID,
      semver: MIN_CONTROL_VERSION,
      protocolVersion: 2,
      serverGeneration: "b".repeat(32),
      databaseId: "f".repeat(32),
      tenantCountReachable: false,
      isolationModes: ["Codeunit"],
      testTypes: ["codeunit"],
      leaseOwner: "",
      leaseOpKind: "none",
      leaseExpiresAt: "",
      leaseTokenPresent: false,
    };
  }
  const fetchFn = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/v2.0/companies")) {
      return new Response(JSON.stringify({ value: [{ id: "co-1", name: "CRONUS" }] }), {
        status: 200,
      });
    }
    if (u.includes("/extensions")) {
      return new Response(
        JSON.stringify({
          value: [
            {
              isInstalled: true,
              versionMajor: 28,
              versionMinor: 4,
              versionBuild: 0,
              versionRevision: 1,
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ value: JSON.stringify(info()) }), { status: 200 });
  }) as typeof fetch;

  async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(env)) Reflect.deleteProperty(process.env, k);
    }
  }

  async function configPath(file: LethalConfigFile): Promise<string> {
    const p = join(scratch("lethal-pr85-cfg-"), "lethal.config.json");
    await writeFile(p, JSON.stringify(file), "utf8");
    return p;
  }

  async function capture(fn: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await fn();
    } catch (e) {
      lines.push(JSON.stringify(cliError(e))); // the --json error envelope
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    return lines.join("\n");
  }

  const bcdev = (extra: Record<string, unknown> = {}) => ({
    ...BASE,
    packageCachePath: scratch("lethal-pr85-cache-"),
    credentialsEnv: CE,
    ...extra,
  });
  const io = {
    fetchFn,
    quarantineDir: "",
    alToolPaths: async () => ({ alcPath: "alc", altoolPath: "altool" }),
    alcSpawn: async () => ({ exitCode: 0, stdout: "AL Compiler version 18.0.1.1\n", stderr: "" }),
  };

  test("doctor, text and --json, with the variables set: names shown, values never", async () => {
    const project = await appFolder({ id: TARGET, dependencies: [dep(A, "Dep A", "28.0.0.0")] });
    const path = await configPath({ bcdev: bcdev() } as LethalConfigFile);
    const text = await withEnv(ENV, () =>
      capture(() =>
        doctorFromCli(
          { mode: "doctor", configPath: path, projectDir: project },
          { ...io, quarantineDir: scratch("lethal-pr85-q-") },
        ),
      ),
    );
    const json = await withEnv(ENV, () =>
      capture(() =>
        doctorFromCli(
          { mode: "doctor", configPath: path, projectDir: project, json: true },
          { ...io, quarantineDir: scratch("lethal-pr85-q-") },
        ),
      ),
    );
    for (const out of [text, json]) {
      expect(out).toContain("credentials-env");
      expect(out).toContain("LETHAL_T_USER");
      expect(out).toContain("LETHAL_T_PASS");
      expect(out).toContain("server-dependencies");
      expect(out).not.toContain(CANARY_USER);
      expect(out).not.toContain(CANARY_PASS);
    }
  });

  test("doctor with one variable unset: a failed check naming the variable, no abort, no value", async () => {
    const path = await configPath({ bcdev: bcdev() } as LethalConfigFile);
    const out = await withEnv({ LETHAL_T_USER: CANARY_USER }, () =>
      capture(() =>
        doctorFromCli(
          { mode: "doctor", configPath: path },
          { ...io, quarantineDir: scratch("lethal-pr85-q-") },
        ),
      ),
    );
    expect(out).toContain("credentials-env");
    expect(out).toContain("LETHAL_T_PASS");
    expect(out).toContain("not set");
    expect(out).not.toContain(CANARY_USER);
  });

  test("the error envelope of every refusal holds no value", async () => {
    const bads: Partial<BcDevConfigSection>[] = [
      { ...BASE, credentialsEnv: CE, password: CANARY_PASS },
      { ...BASE, credentialsEnv: { username: "LETHAL_T_USER", password: CANARY_PASS } },
      { ...BASE, credentialsEnv: { username: "NOT_SET_ANYWHERE", password: "LETHAL_T_PASS" } },
    ];
    for (const raw of bads) {
      const out = await capture(async () => validateBcDevConfig(raw, ENV));
      expect(out).toContain('"status":"error"');
      expect(out).toContain("credentialsEnv");
      expect(out).not.toContain(CANARY_USER);
      expect(out).not.toContain(CANARY_PASS);
    }
  });

  test("doctor on an envTool config with credentialsEnv: refused by name, envelope clean", async () => {
    const path = await configPath({
      bcdev: bcdev(),
      envTool: { toolPath: "t" },
    } as LethalConfigFile);
    const out = await withEnv(ENV, () =>
      capture(() => doctorFromCli({ mode: "doctor", configPath: path, json: true }, io)),
    );
    expect(out).toContain("CONFIGURATION_ERROR");
    expect(out).toContain("credentialsEnv");
    expect(out).not.toContain(CANARY_USER);
    expect(out).not.toContain(CANARY_PASS);
  });

  test("the doctor report objects themselves hold no value", async () => {
    const project = await appFolder({ id: TARGET, dependencies: [dep(A, "Dep A", "28.0.0.0")] });
    const configFile = { bcdev: bcdev() } as LethalConfigFile;
    const built = await withEnv(ENV, () =>
      buildDoctorDeps(configFile, {
        ...io,
        quarantineDir: scratch("lethal-pr85-q-"),
        projectDir: project,
      }),
    );
    const report = await withEnv(ENV, () => runDoctor(built.cfg, built.deps));
    const rendered = JSON.stringify(doctorJson(report, undefined)) + renderDoctorReport(report);
    expect(rendered).not.toContain(CANARY_USER);
    expect(rendered).not.toContain(CANARY_PASS);
  });
});
