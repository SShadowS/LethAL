import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ITEST_CONFIG,
  DEFAULT_ITEST_LAUNCH,
  ItestConfigNameError,
  ItestLaunchPairError,
  assertLaunchMatchesConfig,
  itestConfigName,
  itestConfigPath,
  itestLaunchName,
  itestLaunchPath,
  itestTargetLine,
  printItestTarget,
} from "./config-path";

describe("the default is unchanged", () => {
  test("an unset variable gives the name every itest used before", () => {
    expect(itestConfigName({})).toBe(DEFAULT_ITEST_CONFIG);
    expect(itestConfigName({ LETHAL_ITEST_CONFIG: "" })).toBe(DEFAULT_ITEST_CONFIG);
  });

  test("the path is joined onto the fixture directory the caller chose", () => {
    const p = itestConfigPath("U:/Git/LethAL/fixtures/sandbox-data", {});
    expect(p.replace(/\\/g, "/")).toBe(
      "U:/Git/LethAL/fixtures/sandbox-data/lethal.config.local.json",
    );
  });
});

describe("selecting the agent config", () => {
  test("a sibling config name is honoured", () => {
    const p = itestConfigPath("U:/Git/LethAL/fixtures/sandbox-data", {
      LETHAL_ITEST_CONFIG: "lethal.config.agent.json",
    });
    expect(p.replace(/\\/g, "/")).toBe(
      "U:/Git/LethAL/fixtures/sandbox-data/lethal.config.agent.json",
    );
  });
});

describe("the launch file follows the selected config (R589)", () => {
  const dir = "/repo/fixtures/sandbox-app";
  const posix = (p: string) => p.replace(/\\/g, "/");

  test("unset keeps launch.local.json, as before", () => {
    expect(itestLaunchName({})).toBe(DEFAULT_ITEST_LAUNCH);
    expect(itestLaunchName({ LETHAL_ITEST_CONFIG: "lethal.config.local.json" })).toBe(
      "launch.local.json",
    );
    expect(posix(itestLaunchPath(dir, {}, () => false))).toBe(`${dir}/.vscode/launch.local.json`);
  });

  test("lethal.config.bc1.json pairs with launch.bc1.json", () => {
    const env = { LETHAL_ITEST_CONFIG: "lethal.config.bc1.json" };
    expect(itestLaunchName(env)).toBe("launch.bc1.json");
    expect(posix(itestLaunchPath(dir, env, () => true))).toBe(`${dir}/.vscode/launch.bc1.json`);
  });

  test("no itest joins a fixed launch filename itself", () => {
    const here = import.meta.dir;
    const fixed = readdirSync(here)
      .filter((f) => f.endsWith(".itest.ts"))
      .filter((f) => /"\.vscode",\s*"launch\./.test(readFileSync(join(here, f), "utf8")));
    expect(fixed).toEqual([]);
  });

  test("STRICT: a selected config whose launch file is missing refuses, naming both and the fix", () => {
    const tmp = mkdtempSync(join(tmpdir(), "launch-pair-"));
    mkdirSync(join(tmp, ".vscode"));
    writeFileSync(join(tmp, ".vscode", "launch.local.json"), '{"configurations":[{}]}');
    const env = { LETHAL_ITEST_CONFIG: "lethal.config.bc1.json" };
    let message = "";
    try {
      itestLaunchPath(tmp, env);
    } catch (e) {
      expect(e).toBeInstanceOf(ItestLaunchPairError);
      message = (e as Error).message;
    }
    expect(message).toContain("launch.bc1.json");
    expect(message).toContain("launch.local.json");
    expect(message).toContain("copy");
    writeFileSync(join(tmp, ".vscode", "launch.bc1.json"), '{"configurations":[{}]}');
    expect(posix(itestLaunchPath(tmp, env))).toBe(posix(join(tmp, ".vscode", "launch.bc1.json")));
  });

  test("unset, an empty fixture still gets launch.local.json and no refusal", () => {
    const tmp = mkdtempSync(join(tmpdir(), "launch-pair-"));
    expect(posix(itestLaunchPath(tmp, {}))).toBe(posix(join(tmp, ".vscode", "launch.local.json")));
  });
});

describe("the launch file and the lethal config must name one server (R589)", () => {
  const bc1 = { server: "http://192.168.2.157:7049", port: 7049 };

  test("a matching pair passes (host, and dev port where both state it)", () => {
    expect(() =>
      assertLaunchMatchesConfig({ server: "http://192.168.2.157", port: 7049 }, bc1, "l.json"),
    ).not.toThrow();
    expect(() =>
      assertLaunchMatchesConfig({ server: "http://Cronus28" }, { server: "http://cronus28" }, "l"),
    ).not.toThrow();
    // A launch file naming no server has nothing to compare.
    expect(() => assertLaunchMatchesConfig({}, bc1, "l.json")).not.toThrow();
  });

  test("a bc1 config paired with a launch file naming another server refuses", () => {
    expect(() =>
      assertLaunchMatchesConfig({ server: "http://Cronus28", port: 7049 }, bc1, "l.json"),
    ).toThrow(ItestLaunchPairError);
  });

  test("the same host on another dev port (bc2's) refuses", () => {
    expect(() =>
      assertLaunchMatchesConfig({ server: "http://192.168.2.157", port: 7149 }, bc1, "l.json"),
    ).toThrow(ItestLaunchPairError);
  });
});

describe("the target line an itest prints first (R589)", () => {
  test("a bc2 config: host + dev port, its own OData and API roots, no login", () => {
    const line = itestTargetLine("lethal.config.bc2.json", {
      server: "http://192.168.2.157:7149",
      serverInstance: "BC",
      port: 7149,
      baseUrl: "http://192.168.2.157:7148/BC",
      apiBaseUrl: "http://192.168.2.157:7152/BC",
    });
    expect(line).toBe(
      "[itest target] config=lethal.config.bc2.json server=192.168.2.157:7149 odata=http://192.168.2.157:7148/BC api=http://192.168.2.157:7152/BC",
    );
  });

  test("a Cronus28 config with no ports shows the defaults it will use", () => {
    expect(
      itestTargetLine("lethal.config.local.json", {
        server: "http://Cronus28",
        serverInstance: "BC",
      }),
    ).toBe(
      "[itest target] config=lethal.config.local.json server=cronus28:7049 (default) odata=http://cronus28:7048/BC api=http://cronus28:7048/BC",
    );
  });

  test("printing reads a synthetic config and never prints its login", () => {
    const tmp = mkdtempSync(join(tmpdir(), "target-line-"));
    const path = join(tmp, "lethal.config.bc1.json");
    writeFileSync(
      path,
      JSON.stringify({
        bcdev: {
          server: "http://192.168.2.157:7049",
          serverInstance: "BC",
          port: 7049,
          username: "SYNTH-USER",
          password: "synth-pass!",
          env: { BC_DEV_USER: "SYNTH-USER", BC_DEV_PASSWORD: "synth-pass!" },
        },
      }),
    );
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      printItestTarget(path);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("config=lethal.config.bc1.json server=192.168.2.157:7049");
    expect(lines[0]).not.toContain("SYNTH-USER");
    expect(lines[0]).not.toContain("synth-pass");
  });
});

describe("the value is a basename, never a path", () => {
  // A live itest publishes to whatever server its config names, so this value decides which
  // machine gets written to. An env var must not be able to aim that outside the fixture.
  const bad = [
    "../sandbox-app/lethal.config.local.json",
    "..\\sandbox-app\\lethal.config.local.json",
    "/etc/lethal.config.x.json",
    "C:/tmp/lethal.config.x.json",
    "lethal.config.a/b.json",
    "lethal.config.json",
    "config.json",
    "lethal.config.agent.json.bak",
    "LETHAL.CONFIG.AGENT.JSON",
    " lethal.config.agent.json",
  ];

  for (const v of bad) {
    test(`refuses ${JSON.stringify(v)}`, () => {
      expect(() => itestConfigName({ LETHAL_ITEST_CONFIG: v })).toThrow(ItestConfigNameError);
    });
  }

  test("a refusal names the variable and what was expected, and does not fall back", () => {
    // Falling back to the default on a malformed value is the dangerous behaviour: the run would
    // quietly use the owner's containers while its report said it was the agent's.
    try {
      itestConfigName({ LETHAL_ITEST_CONFIG: "../elsewhere.json" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ItestConfigNameError);
      expect((e as Error).message).toContain("LETHAL_ITEST_CONFIG");
      expect((e as Error).message).toContain("lethal.config.agent.json");
    }
  });
});
