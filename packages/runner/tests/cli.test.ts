import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  odataBaseUrl,
  parseCliConfig,
  validateAlRunnerConfig,
  validateBcDevConfig,
} from "../src/cli";

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
      workers: 1,
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
      workers: 1,
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

describe("odataBaseUrl", () => {
  // Verified against a real BC server (2026-07-18): the OData/web-service endpoint listens on
  // port 7048, not whatever port (or none, i.e. 80) `server` carries — 80 returns 404, 7048
  // serves OData. Mirrors bc-mcp's already-working `deriveODataUrl`.
  test("injects port 7048 when the server URL has none", () => {
    expect(odataBaseUrl("http://Cronus28", "BC")).toBe("http://cronus28:7048/BC");
  });

  test("replaces an explicit non-7048 port", () => {
    expect(odataBaseUrl("http://Cronus28:80", "BC")).toBe("http://cronus28:7048/BC");
  });

  test("leaves an already-correct port 7048 alone", () => {
    expect(odataBaseUrl("http://Cronus28:7048", "BC")).toBe("http://cronus28:7048/BC");
  });
});

describe("parseCliConfig — worker flags", () => {
  test("defaults to a single worker", () => {
    const p = parseCliConfig(["run", "--project", "p", "--tests", "t", "--backend", "al-runner"]);
    if (p.mode === "dry-run") throw new Error("expected a run config");
    expect(p.workers).toBe(1);
  });

  test("accepts --workers and --compile-concurrency", () => {
    const p = parseCliConfig([
      "run",
      "--project",
      "p",
      "--tests",
      "t",
      "--backend",
      "al-runner",
      "--workers",
      "4",
      "--compile-concurrency",
      "2",
    ]);
    if (p.mode === "dry-run") throw new Error("expected a run config");
    expect(p.workers).toBe(4);
    expect(p.compileConcurrency).toBe(2);
  });

  test("rejects a non-positive worker count with a clear message", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "p",
        "--tests",
        "t",
        "--backend",
        "al-runner",
        "--workers",
        "0",
      ]),
    ).toThrow(/--workers must be a positive integer/);
  });

  test("rejects --backend bcdev with --workers > 1", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "p",
        "--tests",
        "t",
        "--backend",
        "bcdev",
        "--workers",
        "2",
      ]),
    ).toThrow(/--workers > 1 is not supported with --backend bcdev/);
  });

  test("accepts --backend bcdev with --workers 1 (default)", () => {
    const p = parseCliConfig(["run", "--project", "p", "--tests", "t", "--backend", "bcdev"]);
    if (p.mode === "dry-run") throw new Error("expected a run config");
    expect(p.workers).toBe(1);
  });

  test("accepts --backend bcdev with an explicit --workers 1", () => {
    const p = parseCliConfig([
      "run",
      "--project",
      "p",
      "--tests",
      "t",
      "--backend",
      "bcdev",
      "--workers",
      "1",
    ]);
    if (p.mode === "dry-run") throw new Error("expected a run config");
    expect(p.workers).toBe(1);
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
