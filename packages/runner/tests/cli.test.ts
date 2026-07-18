import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCliConfig, validateAlRunnerConfig, validateBcDevConfig } from "../src/cli";

describe("parseCliConfig", () => {
  test("missing --project throws a clear error", () => {
    expect(() => parseCliConfig(["run", "--tests", "t", "--backend", "al-runner"])).toThrow(
      "missing required --project",
    );
  });

  test("--dry-run only requires --project (no --tests/--backend)", () => {
    const parsed = parseCliConfig(["run", "--project", "proj", "--dry-run"]);
    expect(parsed).toEqual({ mode: "dry-run", projectDir: "proj" });
  });

  test("missing --tests (non-dry-run) throws a clear error", () => {
    expect(() => parseCliConfig(["run", "--project", "proj", "--backend", "al-runner"])).toThrow(
      "missing required --tests",
    );
  });

  test("missing --backend (non-dry-run) throws a clear error", () => {
    expect(() => parseCliConfig(["run", "--project", "proj", "--tests", "t"])).toThrow(
      "missing required --backend",
    );
  });

  test("unknown --backend value throws a clear error", () => {
    expect(() =>
      parseCliConfig(["run", "--project", "proj", "--tests", "t", "--backend", "nope"]),
    ).toThrow('unknown --backend "nope"');
  });

  test("valid al-runner args fill in defaults for db/config/skip-known-survivors", () => {
    const parsed = parseCliConfig([
      "run",
      "--project",
      "proj",
      "--tests",
      "t",
      "--backend",
      "al-runner",
    ]);
    expect(parsed).toEqual({
      mode: "run",
      projectDir: "proj",
      testDir: "t",
      backendKind: "al-runner",
      dbPath: join("proj", "lethal.sqlite"),
      configPath: join("proj", "lethal.config.json"),
      skipKnownSurvivors: false,
    });
  });

  test("explicit --db/--out/--config/--skip-known-survivors are honored", () => {
    const parsed = parseCliConfig([
      "run",
      "--project",
      "proj",
      "--tests",
      "t",
      "--backend",
      "bcdev",
      "--db",
      "custom.sqlite",
      "--out",
      "report.json",
      "--config",
      "custom.config.json",
      "--skip-known-survivors",
    ]);
    expect(parsed).toEqual({
      mode: "run",
      projectDir: "proj",
      testDir: "t",
      backendKind: "bcdev",
      dbPath: "custom.sqlite",
      configPath: "custom.config.json",
      skipKnownSurvivors: true,
      outPath: "report.json",
    });
  });

  test("run subcommand is accepted (C1)", () => {
    const parsed = parseCliConfig(["run", "--project", "proj", "--dry-run"]);
    expect(parsed.mode).toBe("dry-run");
  });

  test("unknown subcommand is rejected with a clear error (C1)", () => {
    expect(() => parseCliConfig(["frobnicate", "--project", "proj", "--dry-run"])).toThrow(
      /unknown subcommand: got "frobnicate", expected one of: run/,
    );
  });

  test("missing subcommand is rejected with a clear error (C1)", () => {
    expect(() => parseCliConfig(["--project", "proj", "--dry-run"])).toThrow(
      /unknown subcommand: got none, expected one of: run/,
    );
  });
});

describe("validateBcDevConfig", () => {
  const full = {
    mcpCommand: ["bun", "x", "bc-dev-mcp"],
    server: "http://bc",
    serverInstance: "BC",
    company: "CRONUS",
    username: "u",
    password: "p",
    packageCachePath: "C:/.alpackages",
  };

  test("passes through a complete section", () => {
    expect(validateBcDevConfig(full)).toEqual(full);
  });

  test("missing section entirely throws", () => {
    expect(() => validateBcDevConfig(undefined)).toThrow('missing the "bcdev" section');
  });

  test("reports every missing field by name", () => {
    const { username, password, ...partial } = full;
    expect(() => validateBcDevConfig(partial)).toThrow(/username, password/);
  });

  test("empty mcpCommand array counts as missing", () => {
    expect(() => validateBcDevConfig({ ...full, mcpCommand: [] })).toThrow(/mcpCommand/);
  });
});

describe("validateAlRunnerConfig", () => {
  test("passes through a complete section", () => {
    const section = { alRunnerPath: "al-runner" };
    expect(validateAlRunnerConfig(section)).toEqual(section);
  });

  test("missing section entirely throws", () => {
    expect(() => validateAlRunnerConfig(undefined)).toThrow('missing the "alRunner" section');
  });

  test("missing alRunnerPath throws", () => {
    expect(() => validateAlRunnerConfig({})).toThrow("alRunnerPath");
  });
});
