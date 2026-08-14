import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelectorConfig } from "@lethal/schemata";
import type { ActivationConfig } from "../src/activation";
import type { AlRunnerCanaryResult } from "../src/al-runner-canary";
import type { BcDevConfigSection, LethalConfigFile } from "../src/cli";
import {
  announceAlRunnerCanary,
  clearQuarantine,
  forceResetLeaseFromCli,
  leaseSessionFor,
  odataBaseUrl,
  odataCfgFor,
  parseCliConfig,
  performForceResetLease,
  permissionCanaryFor,
  prepareBcdevReadOnly,
  readOnlyEnvConfig,
  resolveForceResetLeaseConfig,
  resolveSelectorIds,
  resourceIdentityFor,
  validateAlRunnerConfig,
  validateBcDevConfig,
  validateSelectorIdsConfig,
  withAlRunnerCanary,
} from "../src/cli";
import { EnvToolClient } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import type { RunEvent } from "../src/events";
import { CONTROL_APP_ID, MIN_CONTROL_VERSION } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { QuarantineStore } from "../src/quarantine-store";
import { quarantineResourceKey } from "../src/resource-key";

/**
 * R89. `--resume` is a BOOLEAN flag, so `parseArgs` puts the next word in `positionals`, where
 * nothing read it. MEASURED before the fix: `lethal run --resume 3` — an operator asking for run 3
 * — parsed to `resume: "last"` and would have carried verdicts from whichever run happened to be
 * most recent. `--resume last` and `--resume total-garbage` behaved identically.
 *
 * That is the worst shape this flag has. `--resume` exists to reuse hours of prior work; reusing
 * the WRONG hours appears in no count, and the report would truthfully say it resumed — just from a
 * run the operator never named.
 *
 * These pin the refusal by VALUE (which argument was rejected, and whether the message names
 * `--resume-run`), not merely that something threw — a guard that rejected everything, including
 * the legitimate `campaign` verbs, would pass a presence-only assertion.
 */
describe("parseCliConfig — R89, a stray positional is refused, never ignored", () => {
  const base = ["--project", "P", "--tests", "T", "--backend", "bcdev"];

  test("`--resume 3` is refused, and the message says a run WAS being named", () => {
    // The dangerous one: silently became `--resume last` and resumed a run nobody asked for.
    expect(() => parseCliConfig(["run", "--resume", "3", ...base])).toThrow(/"3"/);
    // Asserted on text UNIQUE to the numeric branch. Both branches mention `--resume-run <id>`, so
    // a `/--resume-run/` match could not tell them apart — a red-check found exactly that: removing
    // the numeric branch left this test green. The sentence below exists only when the stray
    // argument looked like a run id, which is when the operator most needs to be told.
    expect(() => parseCliConfig(["run", "--resume", "3", ...base])).toThrow(
      /would have silently used that one instead/,
    );
  });

  test("a NON-numeric stray does NOT claim the operator was naming a run", () => {
    // The other side of the same branch: the numeric hint must not fire for `--resume last`, or it
    // would tell the operator to use `--resume-run last`, which is not a thing.
    expect(() => parseCliConfig(["run", "--resume", "last", ...base])).not.toThrow(
      /would have silently used that one instead/,
    );
  });

  test("`--resume last` is refused — the word was never read", () => {
    expect(() => parseCliConfig(["run", "--resume", "last", ...base])).toThrow(/"last"/);
  });

  test("a stray positional with no --resume at all is still refused", () => {
    expect(() => parseCliConfig(["run", "wat", ...base])).toThrow(/unexpected argument/);
  });

  test("bare `--resume` still means the most recent run", () => {
    const parsed = parseCliConfig(["run", "--resume", ...base]) as { resume?: unknown };
    expect(parsed.resume).toBe("last");
  });

  test("`--resume-run 3` still names a run — the guard must not eat the supported spelling", () => {
    const parsed = parseCliConfig(["run", "--resume-run", "3", ...base]) as { resume?: unknown };
    expect(parsed.resume).toBe(3);
  });

  test("`campaign` keeps its own positional verb", () => {
    // The allowlist half. A guard applied to every subcommand broke all eight campaign tests, which
    // is how the scope was found — recorded here so nobody re-widens it.
    expect(() => parseCliConfig(["campaign", "anchors", "--project", "P"])).not.toThrow(
      /unexpected argument/,
    );
  });
});

describe("parseCliConfig", () => {
  test("missing --project throws a clear error", () => {
    expect(() => parseCliConfig(["run", "--tests", "t", "--backend", "al-runner"])).toThrow(
      "missing required --project",
    );
  });

  test("--dry-run only requires --project (no --tests/--backend)", () => {
    const parsed = parseCliConfig(["run", "--project", "proj", "--dry-run"]);
    // R90: `dbPath`/`configPath` default exactly as they do for a real run, so a dry run can
    // report the tier's MEASURED publish bracket. Both are read best-effort and never created —
    // a dry run in a project with neither file still works, it just has no bracket to report.
    expect(parsed).toEqual({
      mode: "dry-run",
      projectDir: "proj",
      dbPath: join("proj", "lethal.sqlite"),
      configPath: join("proj", "lethal.config.json"),
    });
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
      keepEnv: false,
      allowExpiringEnv: false,
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
      keepEnv: false,
      allowExpiringEnv: false,
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

/**
 * `lethal campaign freeze | anchors | compare` — argument marshaling only. The gates themselves,
 * and the git wiring they rest on, are exercised against a REAL repository in
 * `campaign-subcommands.test.ts`.
 */
describe("parseCliConfig — lethal campaign (subsystem D)", () => {
  const BASE = [
    "--manifest",
    "docs/campaign/x/campaign.json",
    "--stage",
    "rung1",
    "--report",
    "r.json",
  ];

  test("freeze parses into a campaign config carrying every field", () => {
    expect(parseCliConfig(["campaign", "freeze", ...BASE, "--expect-mutants", "148"])).toEqual({
      mode: "campaign",
      action: "freeze",
      manifestPath: "docs/campaign/x/campaign.json",
      stage: "rung1",
      reportPath: "r.json",
      expectedMutantCount: 148,
    });
  });

  test("anchors and compare parse without an expected count", () => {
    expect(parseCliConfig(["campaign", "anchors", ...BASE])).toEqual({
      mode: "campaign",
      action: "anchors",
      manifestPath: "docs/campaign/x/campaign.json",
      stage: "rung1",
      reportPath: "r.json",
    });
    expect(parseCliConfig(["campaign", "compare", ...BASE])).toEqual({
      mode: "campaign",
      action: "compare",
      manifestPath: "docs/campaign/x/campaign.json",
      stage: "rung1",
      reportPath: "r.json",
    });
  });

  test("anchors carries --project through for the notInstrumented reconciliation", () => {
    const parsed = parseCliConfig(["campaign", "anchors", ...BASE, "--project", "proj"]);
    expect(parsed).toMatchObject({ mode: "campaign", action: "anchors", projectDir: "proj" });
  });

  test("an unknown or missing verb is rejected, naming the three", () => {
    expect(() => parseCliConfig(["campaign", "frobnicate", ...BASE])).toThrow(
      /expected one of: freeze, anchors, compare/,
    );
    expect(() => parseCliConfig(["campaign", ...BASE])).toThrow(/no verb/);
  });

  test("each required flag is refused by name when absent", () => {
    expect(() =>
      parseCliConfig(["campaign", "anchors", "--stage", "rung1", "--report", "r.json"]),
    ).toThrow(/--manifest/);
    expect(() =>
      parseCliConfig(["campaign", "anchors", "--manifest", "m.json", "--report", "r.json"]),
    ).toThrow(/--stage/);
    expect(() =>
      parseCliConfig(["campaign", "anchors", "--manifest", "m.json", "--stage", "rung1"]),
    ).toThrow(/--report/);
  });

  test("an empty flag value is refused, not treated as absent", () => {
    // `--manifest "$M"` with an unset shell variable must not reach `readCampaignManifest("")`.
    expect(() =>
      parseCliConfig([
        "campaign",
        "anchors",
        "--manifest",
        "",
        "--stage",
        "r",
        "--report",
        "r.json",
      ]),
    ).toThrow(/--manifest/);
    expect(() =>
      parseCliConfig([
        "campaign",
        "anchors",
        "--manifest",
        "m",
        "--stage",
        "",
        "--report",
        "r.json",
      ]),
    ).toThrow(/--stage/);
    expect(() =>
      parseCliConfig(["campaign", "anchors", "--manifest", "m", "--stage", "r", "--report", ""]),
    ).toThrow(/--report/);
  });

  test("freeze REQUIRES --expect-mutants, as a positive integer", () => {
    expect(() => parseCliConfig(["campaign", "freeze", ...BASE])).toThrow(/--expect-mutants/);
    for (const bad of ["0", "-1", "2.5", "many", ""]) {
      expect(() =>
        parseCliConfig(["campaign", "freeze", ...BASE, "--expect-mutants", bad]),
      ).toThrow(/--expect-mutants/);
    }
  });

  test("a flag that does not apply to the verb is REFUSED, never silently ignored", () => {
    // The count anchors/compare gate against is the pre-committed one in the committed anchor
    // config or baseline. Accepting --expect-mutants here would look like it constrained that.
    expect(() =>
      parseCliConfig(["campaign", "anchors", ...BASE, "--expect-mutants", "148"]),
    ).toThrow(/--expect-mutants applies to/);
    expect(() =>
      parseCliConfig(["campaign", "compare", ...BASE, "--expect-mutants", "148"]),
    ).toThrow(/--expect-mutants applies to/);
    expect(() =>
      parseCliConfig(["campaign", "freeze", ...BASE, "--expect-mutants", "148", "--project", "p"]),
    ).toThrow(/--project applies to/);
    expect(() => parseCliConfig(["campaign", "compare", ...BASE, "--project", "p"])).toThrow(
      /--project applies to/,
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
    controlSymbolPath: "C:/lethal-control.app",
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

// t7 (5C-B2): buildBackend's HarnessVerifier and leaseSessionFor's own separate one used to build
// this object inline, independently — the two could silently drift if either grew a field. Both
// now call this single helper; these tests pin its own shape down directly (buildBackend itself
// is not unit-tested — it needs a real alc.exe/AL-extension install — so this is the closest
// direct seam for the extraction).
describe("odataCfgFor (t7: the shared OData config both buildBackend and leaseSessionFor build from)", () => {
  const FULL_SECTION: BcDevConfigSection = {
    mcpCommand: ["bun", "x", "bc-dev-mcp"],
    server: "http://Cronus281",
    serverInstance: "BC",
    tenant: "default",
    company: "CRONUS Danmark A/S",
    username: "u",
    password: "p",
    packageCachePath: "C:/.alpackages",
    controlSymbolPath: "C:/lethal-control.app",
  };

  test("builds baseUrl (via odataBaseUrl) + company/username/password/tenant", () => {
    expect(odataCfgFor(FULL_SECTION)).toEqual({
      baseUrl: "http://cronus281:7048/BC",
      company: "CRONUS Danmark A/S",
      username: "u",
      password: "p",
      tenant: "default",
    });
  });

  test("omits the tenant key entirely when absent (exactOptionalPropertyTypes)", () => {
    const { tenant: _tenant, ...withoutTenant } = FULL_SECTION;
    const cfg = odataCfgFor(withoutTenant);
    expect(cfg).not.toHaveProperty("tenant");
    expect(cfg).toEqual({
      baseUrl: "http://cronus281:7048/BC",
      company: "CRONUS Danmark A/S",
      username: "u",
      password: "p",
    });
  });

  // item 6 (6c fix wave 1): the baseUrl preference is exercised only indirectly by the tests
  // above (FULL_SECTION never sets it) — these two make the preference itself the assertion.
  test("uses baseUrl verbatim when present, instead of the derived container URL", () => {
    const withBaseUrl: BcDevConfigSection = {
      ...FULL_SECTION,
      baseUrl: "https://host/env-4711",
    };
    expect(odataCfgFor(withBaseUrl).baseUrl).toBe("https://host/env-4711");
  });

  test("derives the port-7048 container URL from server/serverInstance when baseUrl is absent", () => {
    expect(FULL_SECTION).not.toHaveProperty("baseUrl");
    expect(odataCfgFor(FULL_SECTION).baseUrl).toBe("http://cronus281:7048/BC");
  });
});

describe("parseCliConfig — worker flags", () => {
  test("defaults to a single worker", () => {
    const p = parseCliConfig(["run", "--project", "p", "--tests", "t", "--backend", "al-runner"]);
    if (p.mode !== "run") throw new Error("expected a run config");
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
    if (p.mode !== "run") throw new Error("expected a run config");
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
    if (p.mode !== "run") throw new Error("expected a run config");
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
    if (p.mode !== "run") throw new Error("expected a run config");
    expect(p.workers).toBe(1);
  });
});

// R3: --selector-id/--control-id/--table-id override the three injected object ids
// (DEFAULT_SELECTOR_IDS) independently.
describe("parseCliConfig — selector id flags", () => {
  test("no flags given: selectorIdOverrides is absent entirely", () => {
    const p = parseCliConfig(["run", "--project", "p", "--tests", "t", "--backend", "al-runner"]);
    if (p.mode !== "run") throw new Error("expected a run config");
    expect(p.selectorIdOverrides).toBeUndefined();
    expect("selectorIdOverrides" in p).toBe(false);
  });

  test("all three flags populate selectorIdOverrides", () => {
    const p = parseCliConfig([
      "run",
      "--project",
      "p",
      "--tests",
      "t",
      "--backend",
      "al-runner",
      "--selector-id",
      "50002",
      "--control-id",
      "50001",
      "--table-id",
      "50000",
    ]);
    if (p.mode !== "run") throw new Error("expected a run config");
    expect(p.selectorIdOverrides).toEqual({
      selectorId: 50002,
      controlId: 50001,
      tableId: 50000,
    });
  });

  test("a single flag overrides only that one id", () => {
    const p = parseCliConfig([
      "run",
      "--project",
      "p",
      "--tests",
      "t",
      "--backend",
      "al-runner",
      "--selector-id",
      "50002",
    ]);
    if (p.mode !== "run") throw new Error("expected a run config");
    expect(p.selectorIdOverrides).toEqual({ selectorId: 50002 });
  });

  test("rejects a non-positive --selector-id", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "p",
        "--tests",
        "t",
        "--backend",
        "al-runner",
        "--selector-id",
        "0",
      ]),
    ).toThrow(/--selector-id must be a positive integer/);
  });

  test("rejects a non-numeric --control-id", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "p",
        "--tests",
        "t",
        "--backend",
        "al-runner",
        "--control-id",
        "not-a-number",
      ]),
    ).toThrow(/--control-id must be a positive integer/);
  });

  test("rejects a non-integer --table-id", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "p",
        "--tests",
        "t",
        "--backend",
        "al-runner",
        "--table-id",
        "1.5",
      ]),
    ).toThrow(/--table-id must be a positive integer/);
  });
});

describe("resolveSelectorIds", () => {
  test("no overrides at all: falls back to DEFAULT_SELECTOR_IDS", () => {
    expect(resolveSelectorIds({}, undefined)).toEqual({
      selectorId: 79199,
      controlId: 79198,
      tableId: 79197,
    });
  });

  test("CLI override wins over config file and default", () => {
    expect(resolveSelectorIds({ selectorId: 1 }, { selectorId: 2, controlId: 3 })).toEqual({
      selectorId: 1,
      controlId: 3,
      tableId: 79197,
    });
  });

  test("config file wins over the default when no CLI override is given", () => {
    expect(resolveSelectorIds({}, { selectorId: 2, controlId: 3, tableId: 4 })).toEqual({
      selectorId: 2,
      controlId: 3,
      tableId: 4,
    });
  });

  test("per-field resolution: each id picks its own source independently", () => {
    expect(resolveSelectorIds({ tableId: 9 }, { selectorId: 2 })).toEqual({
      selectorId: 2,
      controlId: 79198,
      tableId: 9,
    });
  });
});

describe("validateSelectorIdsConfig", () => {
  test("undefined section is fine — returned as-is", () => {
    expect(validateSelectorIdsConfig(undefined)).toBeUndefined();
  });

  test("a well-formed section (partial) is returned unchanged", () => {
    const section = { selectorId: 79150 };
    expect(validateSelectorIdsConfig(section)).toEqual(section);
  });

  test("a well-formed section (all three) is returned unchanged", () => {
    const section = { selectorId: 79150, controlId: 79151, tableId: 79152 };
    expect(validateSelectorIdsConfig(section)).toEqual(section);
  });

  test("rejects a non-object section, naming what was actually given", () => {
    // A malformed lethal.config.json — bare JSON.parse means this compiles fine at the type level
    // (`as LethalConfigFile`) but is wrong at runtime, exactly the shape validateBcDevConfig etc.
    // already guard against.
    expect(() => validateSelectorIdsConfig("nope" as unknown as Partial<SelectorConfig>)).toThrow(
      /"selectorIds" section must be an object/,
    );
  });

  test("rejects an array section", () => {
    expect(() => validateSelectorIdsConfig([] as unknown as Partial<SelectorConfig>)).toThrow(
      /"selectorIds" section must be an object/,
    );
  });

  test("rejects a non-integer field, naming it", () => {
    expect(() => validateSelectorIdsConfig({ selectorId: 1.5 } as Partial<SelectorConfig>)).toThrow(
      /invalid field\(s\).*selectorId/s,
    );
  });

  test("rejects a non-positive field, naming it", () => {
    expect(() => validateSelectorIdsConfig({ controlId: 0 })).toThrow(
      /invalid field\(s\).*controlId/s,
    );
  });

  test("names every invalid field at once", () => {
    expect(() =>
      validateSelectorIdsConfig({ selectorId: -1, controlId: 0, tableId: 79150 }),
    ).toThrow(/selectorId, controlId/);
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

  // al-runner v2 removed --stubs entirely and rejects it as an unknown option. Accepting the
  // field and dropping it would leave an operator believing their hand-written dependency stubs
  // were in play while every compile ran without them — a config that lies quietly. The refusal
  // must name the version, because "unknown field" alone tells nobody what to do about it.
  test('a config still setting "stubsDir" is REFUSED, naming v2 and the removed flag', () => {
    expect(() =>
      validateAlRunnerConfig({ alRunnerPath: "al-runner", stubsDir: "C:/stubs" } as never),
    ).toThrow(/stubsDir/);
    expect(() =>
      validateAlRunnerConfig({ alRunnerPath: "al-runner", stubsDir: "C:/stubs" } as never),
    ).toThrow(/v2/);
    expect(() =>
      validateAlRunnerConfig({ alRunnerPath: "al-runner", stubsDir: "C:/stubs" } as never),
    ).toThrow(/--stubs/);
  });
});

describe("parseCliConfig — clear-quarantine subcommand (Task 13)", () => {
  test("parses --server/--instance", () => {
    const parsed = parseCliConfig([
      "clear-quarantine",
      "--server",
      "http://Cronus281",
      "--instance",
      "BC",
    ]);
    expect(parsed).toEqual({
      mode: "clear-quarantine",
      server: "http://Cronus281",
      serverInstance: "BC",
    });
  });

  test("missing --server throws a clear error", () => {
    expect(() => parseCliConfig(["clear-quarantine", "--instance", "BC"])).toThrow(
      "missing required --server",
    );
  });

  test("missing --instance throws a clear error", () => {
    expect(() => parseCliConfig(["clear-quarantine", "--server", "http://Cronus281"])).toThrow(
      "missing required --instance",
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// 5C-B2: `lethal force-reset-lease` — design §8 step 2 of the operator recovery procedure
// (fixtures/README.md's "Recovering from container-needs-recycle"). Mirrors clear-quarantine's
// --server/--instance flag handling, plus a --config it needs (unlike clear-quarantine) to
// authenticate the live HarnessInfo/ForceResetLease OData calls.
// ————————————————————————————————————————————————————————————————————————
describe("parseCliConfig — force-reset-lease subcommand (5C-B2)", () => {
  test("parses --server/--instance/--config", () => {
    const parsed = parseCliConfig([
      "force-reset-lease",
      "--server",
      "http://Cronus281",
      "--instance",
      "BC",
      "--config",
      "lethal.config.json",
    ]);
    expect(parsed).toEqual({
      mode: "force-reset-lease",
      server: "http://Cronus281",
      serverInstance: "BC",
      configPath: "lethal.config.json",
    });
  });

  // Minor 3, fix round 1: without a --project flag, an operator whose envTool.resolve command
  // references {projectDir} had no way to unblock themselves mid-recovery — resolveForceResetLeaseConfig
  // fell back to "" and renderCommand throws. Mirrors doctor's own optional --project (cli.ts).
  test("parses an optional --project, threaded as projectDir", () => {
    const parsed = parseCliConfig([
      "force-reset-lease",
      "--server",
      "http://Cronus281",
      "--instance",
      "BC",
      "--config",
      "lethal.config.json",
      "--project",
      "C:/proj",
    ]);
    expect(parsed).toEqual({
      mode: "force-reset-lease",
      server: "http://Cronus281",
      serverInstance: "BC",
      configPath: "lethal.config.json",
      projectDir: "C:/proj",
    });
  });

  test("omitting --project leaves projectDir absent, not an empty string", () => {
    const parsed = parseCliConfig([
      "force-reset-lease",
      "--server",
      "http://Cronus281",
      "--instance",
      "BC",
      "--config",
      "lethal.config.json",
    ]);
    expect(parsed).not.toHaveProperty("projectDir");
  });

  test("missing --server throws a clear error", () => {
    expect(() =>
      parseCliConfig(["force-reset-lease", "--instance", "BC", "--config", "c.json"]),
    ).toThrow("missing required --server");
  });

  test("missing --instance throws a clear error", () => {
    expect(() =>
      parseCliConfig(["force-reset-lease", "--server", "http://Cronus281", "--config", "c.json"]),
    ).toThrow("missing required --instance");
  });

  test("missing --config throws a clear error naming why it's needed", () => {
    expect(() =>
      parseCliConfig(["force-reset-lease", "--server", "http://Cronus281", "--instance", "BC"]),
    ).toThrow(/missing required --config/);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 13 folded fix (Task 11 review, Important-1): `runSession`'s quarantine consult only fires
// when `SessionConfig.resourceServer`/`resourceServerInstance` are BOTH present, but `cli.ts` did
// not source them from the loaded config file — so quarantine was silently INERT for every real
// CLI-driven bcdev session (a stranded tier would never be detected, and a new strand could never
// be durably recorded). `resourceIdentityFor` is the smallest separable seam that maps the loaded
// config file to those two `SessionConfig` fields; these tests pin the fix down directly, without
// exercising `main()`/`runFromCli` end to end (which would need a live/mocked backend).
// ————————————————————————————————————————————————————————————————————————
describe("resourceIdentityFor (Task 13 folded fix — cli.ts sources quarantine identity)", () => {
  const bcdevRunConfig = {
    mode: "run" as const,
    projectDir: "proj",
    testDir: "t",
    backendKind: "bcdev" as const,
    dbPath: "db",
    configPath: "cfg",
    skipKnownSurvivors: false,
    workers: 1,
    keepEnv: false,
    allowExpiringEnv: false,
  };

  test("bcdev session sources resourceServer/resourceServerInstance from the bcdev config section", () => {
    const configFile = {
      bcdev: {
        mcpCommand: ["bun", "x", "bc-dev-mcp"],
        server: "http://Cronus281",
        serverInstance: "BC",
        company: "CRONUS",
        username: "u",
        password: "p",
        packageCachePath: "C:/.alpackages",
        controlSymbolPath: "C:/lethal-control.app",
      },
    };
    expect(resourceIdentityFor(bcdevRunConfig, configFile)).toEqual({
      resourceServer: "http://Cronus281",
      resourceServerInstance: "BC",
    });
  });

  test("al-runner session has no shared tier — returns no identity fields", () => {
    const configFile = { alRunner: { alRunnerPath: "al-runner" } };
    expect(
      resourceIdentityFor({ ...bcdevRunConfig, backendKind: "al-runner" }, configFile),
    ).toEqual({});
  });

  test("bcdev session with an incomplete bcdev config section throws (same validation as buildBackend)", () => {
    const configFile = { bcdev: { server: "http://Cronus281" } };
    expect(() => resourceIdentityFor(bcdevRunConfig, configFile)).toThrow(/missing required field/);
  });

  // Layer 5C-B1 Task 8: the exact same "wired in the orchestrator but never sourced by cli.ts"
  // shape as the fix above, one layer up — a bcdev session with no `SessionConfig.lease` takes no
  // machine-global lease at all, and `BcDevMcpBackend.run()` then fails loudly on the first
  // mutant ("no lease bound"). al-runner publishes nothing to a shared container and gets none.
  test("bcdev session is given a lease client + serverGeneration reader; al-runner is not", () => {
    const configFile = {
      bcdev: {
        mcpCommand: ["bun", "x", "bc-dev-mcp"],
        server: "http://Cronus281",
        serverInstance: "BC",
        company: "CRONUS",
        username: "u",
        password: "p",
        packageCachePath: "C:/.alpackages",
        controlSymbolPath: "C:/lethal-control.app",
      },
      alRunner: { alRunnerPath: "al-runner" },
    };
    const wired = leaseSessionFor(bcdevRunConfig, configFile);
    expect(wired.lease?.client).toBeInstanceOf(LeaseClient);
    expect(typeof wired.lease?.serverGeneration).toBe("function");
    expect(leaseSessionFor({ ...bcdevRunConfig, backendKind: "al-runner" }, configFile)).toEqual(
      {},
    );
  });

  // R26: the same "wired in the orchestrator but never sourced by cli.ts" shape once more — a
  // bcdev session with no `SessionConfig.permissionCanary` silently never measures whether the
  // permission mock is stripping its test bodies, and the report says nothing at all about it.
  test("bcdev session is given a permission canary; al-runner is not (no fenced path to measure)", () => {
    const configFile = {
      bcdev: {
        mcpCommand: ["bun", "x", "bc-dev-mcp"],
        server: "http://Cronus281",
        serverInstance: "BC",
        company: "CRONUS",
        username: "u",
        password: "p",
        packageCachePath: "C:/.alpackages",
        controlSymbolPath: "C:/lethal-control.app",
      },
      alRunner: { alRunnerPath: "al-runner" },
    };
    const wired = permissionCanaryFor(bcdevRunConfig, configFile);
    expect(typeof wired.permissionCanary).toBe("function");
    expect(
      permissionCanaryFor({ ...bcdevRunConfig, backendKind: "al-runner" }, configFile),
    ).toEqual({});
  });

  test("bcdev session with an incomplete bcdev config section throws, same as the lease wiring", () => {
    expect(() => permissionCanaryFor(bcdevRunConfig, { bcdev: { server: "http://x" } })).toThrow(
      /missing required field/,
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 13: `clear-quarantine` (spec §10) — operator-proven clear via `store.clear(key, gen)`.
// ————————————————————————————————————————————————————————————————————————
describe("clearQuarantine (Task 13)", () => {
  async function freshStore(): Promise<QuarantineStore> {
    const dir = await mkdtemp(join(tmpdir(), "lethal-cli-quarantine-"));
    return new QuarantineStore(dir);
  }

  test("clearing a recorded tier removes it and reports cleared, then a second run reports not-quarantined", async () => {
    const store = await freshStore();
    const key = quarantineResourceKey({ server: "http://Cronus281", serverInstance: "BC" });
    await store.record({
      resourceKey: key,
      opKind: "test-run",
      detail: "prior strand",
      recordedAtIso: "2026-07-20T10:00:00.000Z",
    });

    expect(await clearQuarantine(store, key)).toBe("cleared");
    expect(await store.read(key)).toBeNull();

    expect(await clearQuarantine(store, key)).toBe("not-quarantined");
  });

  test("a tier that was never quarantined reports not-quarantined", async () => {
    const store = await freshStore();
    const key = quarantineResourceKey({ server: "http://Cronus281", serverInstance: "BC" });
    expect(await clearQuarantine(store, key)).toBe("not-quarantined");
  });

  // The "stale" outcome (a clear computed against a generation the store no longer holds because
  // a NEWER strand was recorded in between) is exercised at the `QuarantineStore.clear` level in
  // quarantine-store.test.ts ("a stale clear (older generation) does NOT erase a newer record")
  // — `clearQuarantine` above is a thin, race-free pass-through of whatever `store.clear` returns
  // (it always clears against the generation it JUST read), so re-asserting that outcome here
  // would only re-test `QuarantineStore` through an extra layer of indirection, not this seam.
});

// ————————————————————————————————————————————————————————————————————————
// 5C-B2: `performForceResetLease` — the actual read-then-reset mechanics behind
// `lethal force-reset-lease` (design §8 step 2). Kept separate from the CLI I/O wrapper (like
// `clearQuarantine`/`clearQuarantineFromCli` above) specifically so THIS — reading the CURRENT
// serverGeneration live and echoing exactly that value into ForceResetLease — is directly
// unit-testable against an injected fetchFn, without a real config file or process.argv.
// ————————————————————————————————————————————————————————————————————————
describe("performForceResetLease (5C-B2)", () => {
  const CFG: ActivationConfig = {
    baseUrl: "http://bc:7048/BC",
    company: "CRONUS Danmark A/S",
    username: "u",
    password: "p",
    tenant: "default",
  };

  /** Routes to a HarnessInfo response carrying `serverGeneration`, or a ForceResetLease response
   *  carrying `resetBody` — mirrors harness.test.ts's `info()` shape (protocol v2, the two fixed
   *  Codeunit/codeunit arrays) so `HarnessVerifier.verify()` inside `performForceResetLease`
   *  actually succeeds. Captures the `expectedGeneration` the ForceResetLease call was sent, so a
   *  test can assert it against the LIVE generation the HarnessInfo leg returned — the exact
   *  property that makes the generation echo meaningful rather than decorative. */
  function routerFetch(opts: {
    serverGeneration: string;
    resetBody: Record<string, unknown>;
    onForceReset?: (expectedGeneration: string) => void;
  }): typeof fetch {
    return (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("LethALControl_HarnessInfo")) {
        return new Response(
          JSON.stringify({
            value: JSON.stringify({
              appId: CONTROL_APP_ID,
              // R28: tracks the client's own minimum, so this fake never has to be revisited when
              // the minimum moves — and never fails the version gate for a reason no test here is
              // about.
              semver: MIN_CONTROL_VERSION,
              protocolVersion: 2,
              serverGeneration: opts.serverGeneration,
              tenantCountReachable: false,
              isolationModes: ["Codeunit"],
              testTypes: ["codeunit"],
            }),
          }),
          { status: 200 },
        );
      }
      if (u.includes("LethALControl_ForceResetLease")) {
        const body = JSON.parse(String(init?.body)) as { expectedGeneration?: unknown };
        opts.onForceReset?.(
          typeof body.expectedGeneration === "string" ? body.expectedGeneration : "",
        );
        return new Response(JSON.stringify({ value: JSON.stringify(opts.resetBody) }), {
          status: 200,
        });
      }
      throw new Error(`performForceResetLease test: unexpected URL ${u}`);
    }) as typeof fetch;
  }

  // THE load-bearing property: ForceResetLease's whole authorization is an echo of the CURRENT
  // serverGeneration, read live immediately before the reset. This is the assertion the
  // red-check must prove is load-bearing (see the task report) — a version that hardcodes or
  // caches the echo instead of threading the HarnessInfo read through would still return a
  // plausible "reset" outcome here (the fake server doesn't validate the echo), but `echoed`
  // would silently diverge from `liveGen`.
  test("echoes the LIVE serverGeneration read from HarnessInfo into ForceResetLease", async () => {
    const liveGen = "a".repeat(32);
    let echoed: string | undefined;
    const fetchFn = routerFetch({
      serverGeneration: liveGen,
      resetBody: { reset: true, serverGeneration: "b".repeat(32), epoch: 9 },
      onForceReset: (g) => {
        echoed = g;
      },
    });
    const result = await performForceResetLease(CFG, fetchFn);
    expect(echoed).toBe(liveGen);
    expect(result).toEqual({
      outcome: "reset",
      oldGeneration: liveGen,
      newGeneration: "b".repeat(32),
      newEpoch: 9,
    });
  });

  test("a refused reset (stale generation) surfaces as a typed 'refused' outcome, not a throw", async () => {
    const liveGen = "c".repeat(32);
    const fetchFn = routerFetch({
      serverGeneration: liveGen,
      resetBody: { reset: false, reason: "generation-changed" },
    });
    const result = await performForceResetLease(CFG, fetchFn);
    expect(result).toEqual({
      outcome: "refused",
      oldGeneration: liveGen,
      reason: "generation-changed",
    });
  });
});

// ————————————————————————————————————————————————————————————————————————
// R51 follow-on: `resolveForceResetLeaseConfig` — `forceResetLeaseFromCli` used to call
// `validateBcDevConfig(configFile.bcdev)` DIRECTLY, which throws on an envTool config (server/
// serverInstance/username/password are legitimately absent — the tool resolves them at runtime).
// A real campaign had to hand-materialise a resolved copy with a one-off script mid-recovery.
// Mirrors `buildDoctorDeps`'s `resolvedBcdev` (doctor-cli.test.ts) — same algorithm, same hard
// read-only boundary (ONLY `envTool.resolve` blocks; never create/start/publish/downloadSymbols).
// ————————————————————————————————————————————————————————————————————————
describe("resolveForceResetLeaseConfig (R51 follow-on)", () => {
  const BCDEV_RAW = {
    mcpCommand: ["bun", "mcp"],
    company: "CRONUS",
    controlSymbolPath: "C:/lethal-control.app",
    // Deliberately NO server/username/password/packageCachePath — an env-tool config never
    // spells these out on disk; the tool resolves them at runtime.
  };

  function envToolConfigFixture(): LethalConfigFile {
    return {
      bcdev: BCDEV_RAW,
      envTool: {
        toolPath: "tool.exe",
        envId: "env-4711",
        resolve: [
          { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
          {
            command: ["env", "users", "{envId}", "--json"],
            reads: { username: "u", password: "p" },
          },
        ],
        publish: { command: ["publish", "{envId}", "{appFile}"] },
        // No packageCachePath declared above, so validateEnvToolConfig requires this.
        downloadSymbols: { command: ["env", "download-symbols", "{envId}"] },
      },
    };
  }

  function fakeSpawn(spawned: string[]) {
    return async (argv: readonly string[]) => {
      const line = argv.join(" ");
      spawned.push(line);
      if (line.includes("env get")) {
        return { exitCode: 0, stdout: '{"url":"https://host/env-4711"}', stderr: "" };
      }
      if (line.includes("env users")) {
        return { exitCode: 0, stdout: '{"u":"admin","p":"hunter2"}', stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
  }

  // The task brief's own Step 1 pinning test.
  test("force-reset-lease resolves an envTool config the way run does", async () => {
    const cfg = envToolConfigFixture();
    const spawned: string[] = [];
    await expect(
      resolveForceResetLeaseConfig(cfg, {
        makeEnvToolClient: (c) => new EnvToolClient(c, { spawn: fakeSpawn(spawned) }),
      }),
    ).resolves.toMatchObject({
      server: expect.any(String),
      serverInstance: expect.any(String),
    });
  });

  test("resolves the actual connection fields, not placeholders", async () => {
    const cfg = envToolConfigFixture();
    const spawned: string[] = [];
    const resolved = await resolveForceResetLeaseConfig(cfg, {
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn: fakeSpawn(spawned) }),
    });
    expect(resolved.server).toBe("https://host");
    expect(resolved.serverInstance).toBe("env-4711");
    expect(resolved.username).toBe("admin");
    expect(resolved.password).toBe("hunter2");
    expect(resolved.baseUrl).toBe("https://host/env-4711");
  });

  // The provisioning-boundary claim, proven rather than asserted: spawns EXACTLY the two
  // configured `resolve` blocks and nothing shaped like create/start/publish/downloadSymbols —
  // this function must never be able to provision or bill as a side effect of a recovery command.
  test("spawns ONLY the configured resolve blocks — never create/start/publish/downloadSymbols", async () => {
    const cfg = envToolConfigFixture();
    const spawned: string[] = [];
    await resolveForceResetLeaseConfig(cfg, {
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn: fakeSpawn(spawned) }),
    });
    expect(spawned).toEqual([
      "tool.exe env get env-4711 --json",
      "tool.exe env users env-4711 --json",
    ]);
    for (const cmd of spawned) {
      expect(cmd).not.toMatch(/download-symbols|publish|create|start/);
    }
  });

  // A direct (non-envTool) config is unchanged — delegates straight to the SAME validator `run`
  // uses, never a second parse.
  test("a config with no envTool section delegates straight to validateBcDevConfig", async () => {
    const resolvedBcdev: BcDevConfigSection = {
      mcpCommand: ["bun", "mcp"],
      server: "http://Cronus281",
      serverInstance: "BC",
      company: "CRONUS",
      username: "admin",
      password: "hunter2",
      packageCachePath: "C:/pkg",
      controlSymbolPath: "C:/lethal-control.app",
    };
    const configFile: LethalConfigFile = { bcdev: resolvedBcdev };
    await expect(resolveForceResetLeaseConfig(configFile)).resolves.toEqual(resolvedBcdev);
  });

  test("a bcdev section missing required fields (no envTool) throws exactly as validateBcDevConfig does", async () => {
    const configFile: LethalConfigFile = {};
    await expect(resolveForceResetLeaseConfig(configFile)).rejects.toThrow(
      /missing the "bcdev" section/,
    );
  });

  // Important 2, fix round 1: `packageCachePath` is structurally required by `validateBcDevConfig`
  // but this recovery command never dereferences it — the fixture above already omits a static
  // `packageCachePath` (legal, since `downloadSymbols` is declared), so every test in this
  // describe block already exercises the default. Pinned explicitly here so a future change to
  // `packageCachePathDefault` (shared with `buildDoctorDeps`'s `resolvedBcdev`) is caught by name.
  test("packageCachePath defaults to <projectDir>/.alpackages when the config leaves it to downloadSymbols", async () => {
    const cfg = envToolConfigFixture();
    const spawned: string[] = [];
    const resolved = await resolveForceResetLeaseConfig(cfg, {
      projectDir: "C:/proj",
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn: fakeSpawn(spawned) }),
    });
    expect(resolved.packageCachePath).toBe(join("C:/proj", ".alpackages"));
  });

  // Minor 3, fix round 1: without --project, {projectDir} placeholders in a resolve block have no
  // value and `renderCommand` throws BY NAME — proven here, then proven UNBLOCKED once a
  // projectDir is supplied, so the flag genuinely closes the gap rather than merely parsing.
  test("--project unblocks a resolve block that references {projectDir}; omitting it throws by name", async () => {
    const cfg: LethalConfigFile = {
      bcdev: {
        mcpCommand: ["bun", "mcp"],
        company: "CRONUS",
        controlSymbolPath: "C:/lethal-control.app",
      },
      envTool: {
        toolPath: "tool.exe",
        envId: "env-4711",
        resolve: [
          {
            command: ["env", "get", "{envId}", "--json", "--cwd", "{projectDir}"],
            reads: { baseUrl: "url", username: "u", password: "p" },
          },
        ],
        publish: { command: ["publish", "{envId}", "{appFile}"] },
        downloadSymbols: { command: ["env", "download-symbols", "{envId}"] },
      },
    };
    const spawn = async () => ({
      exitCode: 0,
      stdout: '{"url":"https://host/env-4711","u":"admin","p":"hunter2"}',
      stderr: "",
    });

    await expect(
      resolveForceResetLeaseConfig(cfg, {
        makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
      }),
    ).rejects.toThrow(/no value available for placeholder \{projectDir\}/);

    await expect(
      resolveForceResetLeaseConfig(cfg, {
        projectDir: "C:/proj",
        makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
      }),
    ).resolves.toMatchObject({ server: expect.any(String) });
  });

  // Minor 4, fix round 1: the two fail-loudly EnvToolError guards had no test of their own.
  //
  // Reaching them is not as simple as omitting a `reads` key: `EnvToolClient.run` itself throws
  // if a block's DECLARED `reads` key fails to resolve to a non-empty string/number
  // (env-tool.ts's `run`), and `validateEnvToolConfig`'s "envTool.resolve must produce X" check
  // (env-tool.ts, `blocksOf`) already refuses a config where NO block anywhere — including
  // `createEnv`/`startEnv`/`readyWhen`, which count toward "produced" but are never spawned by
  // this READ-ONLY resolver — declares a `reads` for it. So the only way `resolveForceResetLeaseConfig`'s
  // OWN post-loop `undefined` check can fire is a create-mode config (`envId` absent) where the
  // key is declared as produced by `createEnv` (a block this resolver correctly never spawns,
  // by design — the provisioning boundary) rather than by any `resolve[]` block: structurally
  // valid per `validateEnvToolConfig`, genuinely unresolved by a resolver that spawns ONLY
  // `resolve`.
  describe("fail-loudly guards", () => {
    const CREATE_MODE_BCDEV = {
      mcpCommand: ["bun", "mcp"],
      company: "CRONUS",
      controlSymbolPath: "C:/lethal-control.app",
      packageCachePath: "C:/pkg", // sidesteps the unrelated downloadSymbols requirement
    };

    test("baseUrl declared as produced by createEnv (never spawned here) throws 'produced no baseUrl'", async () => {
      const cfg: LethalConfigFile = {
        bcdev: CREATE_MODE_BCDEV,
        envTool: {
          toolPath: "tool.exe",
          // No envId => create mode, which is what makes createEnv/startEnv/readyWhen/
          // publishApps/deleteEnv all required below — none of them is ever spawned by
          // resolveForceResetLeaseConfig; only the fixture needs them, to pass validateEnvToolConfig.
          createEnv: { command: ["env", "create"], reads: { envId: "id", baseUrl: "url" } },
          startEnv: { command: ["env", "start", "{envId}"] },
          readyWhen: {
            command: ["env", "get", "{envId}"],
            reads: { status: "status" },
            equals: "Running",
          },
          publishApps: ["TestApp"],
          deleteEnv: { command: ["env", "delete", "{envId}"] },
          // The ONLY block this resolver actually spawns — produces username/password, not baseUrl.
          resolve: [{ command: ["fetch-creds"], reads: { username: "u", password: "p" } }],
          publish: { command: ["publish", "{envId}", "{appFile}"] },
        },
      };
      const spawn = async () => ({
        exitCode: 0,
        stdout: '{"u":"admin","p":"hunter2"}',
        stderr: "",
      });
      await expect(
        resolveForceResetLeaseConfig(cfg, {
          makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
        }),
      ).rejects.toThrow(/envTool\.resolve produced no baseUrl/);
    });

    test("username/password declared as produced by createEnv (never spawned here) throws 'produced no username/password'", async () => {
      const cfg: LethalConfigFile = {
        bcdev: CREATE_MODE_BCDEV,
        envTool: {
          toolPath: "tool.exe",
          createEnv: {
            command: ["env", "create"],
            reads: { envId: "id", username: "u", password: "p" },
          },
          startEnv: { command: ["env", "start", "{envId}"] },
          readyWhen: {
            command: ["env", "get", "{envId}"],
            reads: { status: "status" },
            equals: "Running",
          },
          publishApps: ["TestApp"],
          deleteEnv: { command: ["env", "delete", "{envId}"] },
          // The ONLY block this resolver actually spawns — produces baseUrl, not credentials.
          resolve: [{ command: ["fetch-url"], reads: { baseUrl: "url" } }],
          publish: { command: ["publish", "{envId}", "{appFile}"] },
        },
      };
      const spawn = async () => ({
        exitCode: 0,
        stdout: '{"url":"https://host/env-4711"}',
        stderr: "",
      });
      await expect(
        resolveForceResetLeaseConfig(cfg, {
          makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
        }),
      ).rejects.toThrow(/envTool\.resolve produced no username\/password/);
    });
  });
});

// ————————————————————————————————————————————————————————————————————————
// R51 follow-on, continued: `forceResetLeaseFromCli`'s OWN wiring. The tests above call
// `resolveForceResetLeaseConfig` DIRECTLY and never exercise the one line inside
// `forceResetLeaseFromCli` that actually calls it — a red-check on that call site alone found
// zero test coverage. This closes the gap: a REAL config file on disk (envTool-shaped, no
// server/username/password), a fake env-tool spawn, and a fake HarnessInfo/ForceResetLease
// router — driving the exact path `lethal force-reset-lease --config <envtool.json>` takes.
// Reverting `forceResetLeaseFromCli`'s `resolveConfig(configFile)` call back to the old direct
// `validateBcDevConfig(configFile.bcdev)` makes THIS test reject with "missing required
// field(s): server, serverInstance, username, password" instead of completing the reset.
// ————————————————————————————————————————————————————————————————————————
describe("forceResetLeaseFromCli — the wiring (R51 follow-on)", () => {
  test("resolves an envTool config file end-to-end and completes the reset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-force-reset-envtool-"));
    const configPath = join(dir, "lethal.config.json");
    const configFile: LethalConfigFile = {
      bcdev: {
        mcpCommand: ["bun", "mcp"],
        company: "CRONUS",
        controlSymbolPath: "C:/lethal-control.app",
      },
      envTool: {
        toolPath: "tool.exe",
        envId: "env-4711",
        resolve: [
          { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
          {
            command: ["env", "users", "{envId}", "--json"],
            reads: { username: "u", password: "p" },
          },
        ],
        publish: { command: ["publish", "{envId}", "{appFile}"] },
        downloadSymbols: { command: ["env", "download-symbols", "{envId}"] },
      },
    };
    await writeFile(configPath, JSON.stringify(configFile), "utf8");

    const spawn = async (argv: readonly string[]) => {
      const line = argv.join(" ");
      if (line.includes("env get")) {
        return { exitCode: 0, stdout: '{"url":"https://host/env-4711"}', stderr: "" };
      }
      if (line.includes("env users")) {
        return { exitCode: 0, stdout: '{"u":"admin","p":"hunter2"}', stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    const liveGen = "d".repeat(32);
    const fetchFn = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("LethALControl_HarnessInfo")) {
        return new Response(
          JSON.stringify({
            value: JSON.stringify({
              appId: CONTROL_APP_ID,
              semver: MIN_CONTROL_VERSION,
              protocolVersion: 2,
              serverGeneration: liveGen,
              tenantCountReachable: false,
              isolationModes: ["Codeunit"],
              testTypes: ["codeunit"],
            }),
          }),
          { status: 200 },
        );
      }
      if (u.includes("LethALControl_ForceResetLease")) {
        return new Response(
          JSON.stringify({
            value: JSON.stringify({ reset: true, serverGeneration: "e".repeat(32), epoch: 3 }),
          }),
          { status: 200 },
        );
      }
      throw new Error(`forceResetLeaseFromCli wiring test: unexpected URL ${u}`);
    }) as typeof fetch;

    const exitCode = await forceResetLeaseFromCli(
      {
        mode: "force-reset-lease",
        server: "https://host",
        serverInstance: "env-4711",
        configPath,
      },
      {
        makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
        fetchFn,
      },
    );
    expect(exitCode).toBe(0);
  });
});

// ————————————————————————————————————————————————————————————————————————
// R7/R8: `announceAlRunnerCanary` — the exact branch `runFromCli` takes for an al-runner
// session, extracted so it's testable without mocking config-file I/O, resolveEnvToolSession,
// buildBackend, and runSession all at once (see the `resourceIdentityFor` describe block above
// for the same reasoning applied to an earlier fix). Reverting this branch to unconditionally
// call the static `warnAlRunnerNotAuthoritative()` fallback (its pre-canary behaviour) would
// fail every test below that asserts a canary-shaped line landed in `console.warn`.
// ————————————————————————————————————————————————————————————————————————
describe("announceAlRunnerCanary (R7/R8)", () => {
  function fakeCanary(result: AlRunnerCanaryResult, calls: string[]) {
    return async (alRunnerPath: string) => {
      calls.push(alRunnerPath);
      return result;
    };
  }

  test("runs the canary, prints its warnings, and RETURNS the measured result when alRunnerPath is configured", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }) as typeof console.warn;
    const canned: AlRunnerCanaryResult = {
      asserterror: "defect-confirmed",
      tableGlobalVar: "defect-not-reproduced",
    };
    let result: AlRunnerCanaryResult | undefined;
    try {
      result = await announceAlRunnerCanary(
        { alRunner: { alRunnerPath: "C:/al-runner.exe" } },
        fakeCanary(canned, calls),
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(calls).toEqual(["C:/al-runner.exe"]);
    expect(warnings.some((l) => l.includes("R7") && l.includes("CONFIRMED"))).toBe(true);
    expect(warnings.some((l) => l.includes("R8") && l.includes("did NOT"))).toBe(true);
    // R7/R8 report-persistence fix: the caller (runFromCli) needs this value back to attach it
    // to the SessionReport via withAlRunnerCanary — printing it was never enough on its own.
    expect(result).toEqual(canned);
  });

  test("falls back to the static warning WITHOUT running the canary, and returns undefined, when alRunnerPath is not yet configured", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }) as typeof console.warn;
    let result: AlRunnerCanaryResult | undefined;
    try {
      result = await announceAlRunnerCanary(
        {},
        fakeCanary({ asserterror: "defect-confirmed", tableGlobalVar: "defect-confirmed" }, calls),
      );
    } finally {
      console.warn = originalWarn;
    }
    // The canary must never run against an unconfigured/undefined path — buildBackend's own
    // validateAlRunnerConfig throws the targeted "missing alRunnerPath" error moments later.
    expect(calls).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("al-runner is NOT authoritative");
    expect(result).toBeUndefined();
  });
});

// ————————————————————————————————————————————————————————————————————————
// R7/R8 report-persistence fix: `withAlRunnerCanary` — the plain merge `runFromCli` applies to
// its final `SessionReport` before returning it, extracted so it's testable without a real
// backend/runSession producing a `SessionReport`. Reverting `runFromCli` to drop this call (i.e.
// return `report` as-is) would leave a `--out` JSON report or any CI that discards stderr with
// no record of the canary's measured verdict — exactly the gap review flagged, since only the
// console.warn lines from `announceAlRunnerCanary` would carry it.
// ————————————————————————————————————————————————————————————————————————
describe("withAlRunnerCanary (R7/R8 report persistence)", () => {
  const baseReport = {
    schemaVersion: 2,
    validity: {
      reliability: "full" as const,
      caveats: [],
      scoreDescribes: "test fixture",
      baselineTests: { total: 0, failing: 0 },
      scoredMutants: { scored: 0, recorded: 0 },
      // R60/R69 Phase 2: one entry per execution path actually used; always non-empty.
      executionContexts: [
        {
          runner: "fenced" as const,
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: 0,
        },
      ],
    },
    survivorsByProcedure: [],
    testFiles: {},
    backend: "al-runner",
    authoritative: false,
    baselineGreen: true,
    batches: 1,
    counts: {
      killed: 0,
      survived: 0,
      noCoverage: 0,
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 0,
      deadlineExceeded: 0,
    },
    mutationScore: null,
    mutants: [],
    unsupportedTests: [],
    notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
    declarativeSites: { siteCount: 0, fileCount: 0, files: [] },
    timings: {
      totalMs: 0,
      generateMutationSetMs: 0,
      deployMs: 0,
      baselineMs: 0,
      mutantsMs: 0,
      perMutant: { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 },
    },
    preprocessorSymbols: [],
    untargetedTriggerCount: 0,
  };

  test("attaches the measured result under alRunnerCanary, leaving every other field untouched", () => {
    const canary: AlRunnerCanaryResult = {
      asserterror: "defect-confirmed",
      tableGlobalVar: "defect-confirmed",
    };
    const result = withAlRunnerCanary(baseReport, canary);
    expect(result).toEqual({ ...baseReport, alRunnerCanary: canary });
  });

  test("undefined canary (bcdev session, or the no-alRunnerPath fallback) leaves the report exactly as given, with no alRunnerCanary key at all", () => {
    const result = withAlRunnerCanary(baseReport, undefined);
    expect(result).toEqual(baseReport);
    expect("alRunnerCanary" in result).toBe(false);
  });
});

// ————————————————————————————————————————————————————————————————————————
/**
 * R111 — the ONE read-only env-tool resolution. Two commands used to carry ~50 near-identical
 * lines each, and the two copies had already drifted once (`packageCachePath`, which made
 * `lethal doctor` throw on configs `run` accepted).
 *
 * The property that matters is that a read-only caller can never provision or bill. These tests
 * assert it STRUCTURALLY — on the config the client is handed, not just on what got spawned —
 * because a spawn assertion only proves what today's code does, while a config with no `publish`
 * block cannot grow a publish call at all.
 */
describe("prepareBcdevReadOnly — R111", () => {
  function envToolCfg(): LethalConfigFile {
    return {
      bcdev: {
        mcpCommand: ["bun", "mcp"],
        company: "CRONUS",
        controlSymbolPath: "c.app",
      } as unknown as BcDevConfigSection,
      envTool: {
        toolPath: "tool.exe",
        envId: "env-4711",
        resolve: [
          { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
          {
            command: ["env", "users", "{envId}", "--json"],
            reads: { username: "u", password: "p" },
          },
        ],
        publish: { command: ["publish", "{envId}", "{appFile}"] },
        createEnv: { command: ["env", "create"] },
        startEnv: { command: ["env", "start", "{envId}"] },
        deleteEnv: { command: ["env", "delete", "{envId}"] },
        downloadSymbols: { command: ["env", "download-symbols", "{envId}"] },
      },
    };
  }

  function spawnStub(spawned: string[]) {
    return async (argv: readonly string[]) => {
      const line = argv.join(" ");
      spawned.push(line);
      if (line.includes("env get")) {
        return { exitCode: 0, stdout: '{"url":"https://host/env-4711"}', stderr: "" };
      }
      if (line.includes("env users")) {
        return { exitCode: 0, stdout: '{"u":"admin","p":"hunter2"}', stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
  }

  test("readOnlyEnvConfig strips every MUTATING block and keeps everything else", () => {
    const full = envToolCfg().envTool;
    if (full === undefined) throw new Error("fixture has no envTool section");
    const stripped = readOnlyEnvConfig(full as EnvToolConfigSection);
    expect(stripped.publish).toBeUndefined();
    expect(stripped.createEnv).toBeUndefined();
    expect(stripped.startEnv).toBeUndefined();
    expect(stripped.deleteEnv).toBeUndefined();
    expect(stripped.downloadSymbols).toBeUndefined();
    expect(stripped.readyWhen).toBeUndefined();
    // Everything a resolve still needs survives — a strip that took `toolPath` or `resolve` with
    // it would make every read-only command fail rather than be safe.
    expect(stripped.toolPath).toBe("tool.exe");
    expect(stripped.envId).toBe("env-4711");
    expect(stripped.resolve).toHaveLength(2);
  });

  test("the CLIENT is built from the stripped config — the boundary is data, not a comment", async () => {
    // The structural half. A spawn assertion says what today's code does; this says what a future
    // edit inside the helper COULD do, which is the property the row asked to make structural.
    const seen: EnvToolConfigSection[] = [];
    const spawned: string[] = [];
    await prepareBcdevReadOnly(envToolCfg(), {
      runId: "doctor",
      makeEnvToolClient: (c) => {
        seen.push(c);
        return new EnvToolClient(c, { spawn: spawnStub(spawned) });
      },
    }).bcdev();
    expect(seen).toHaveLength(1);
    const handed = seen[0];
    expect(handed?.publish).toBeUndefined();
    expect(handed?.createEnv).toBeUndefined();
    expect(handed?.startEnv).toBeUndefined();
    expect(handed?.deleteEnv).toBeUndefined();
    expect(handed?.downloadSymbols).toBeUndefined();
  });

  test("spawns ONLY the resolve blocks", async () => {
    const spawned: string[] = [];
    await prepareBcdevReadOnly(envToolCfg(), {
      runId: "doctor",
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn: spawnStub(spawned) }),
    }).bcdev();
    expect(spawned).toEqual([
      "tool.exe env get env-4711 --json",
      "tool.exe env users env-4711 --json",
    ]);
  });

  test("memoizes: two consumers of the resolution spawn the tool once", async () => {
    // `runDoctor` runs several checks concurrently and each needs the resolved identity.
    const spawned: string[] = [];
    const r = prepareBcdevReadOnly(envToolCfg(), {
      runId: "doctor",
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn: spawnStub(spawned) }),
    });
    await Promise.all([r.resolved(), r.bcdev(), r.resolved()]);
    expect(spawned).toHaveLength(2); // the two resolve blocks, once each
  });

  test("carries the caller's runId into placeholder substitution", async () => {
    // The ONE thing the two callers differ in, so a tool that names things after `{runId}` can
    // tell a diagnostic probe from a recovery.
    const cfg = envToolCfg();
    const withRunId: LethalConfigFile = {
      ...cfg,
      envTool: {
        ...(cfg.envTool as EnvToolConfigSection),
        resolve: [
          {
            command: ["env", "get", "{envId}", "--tag", "{runId}", "--json"],
            reads: { baseUrl: "url" },
          },
          {
            command: ["env", "users", "{envId}", "--json"],
            reads: { username: "u", password: "p" },
          },
        ],
      },
    };
    const spawned: string[] = [];
    await prepareBcdevReadOnly(withRunId, {
      runId: "force-reset-lease",
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn: spawnStub(spawned) }),
    }).bcdev();
    expect(spawned[0]).toContain("--tag force-reset-lease");
  });

  test("force-reset-lease reaches the tool through the STRIPPED config too", async () => {
    // The call site, not the helper: `resolveForceResetLeaseConfig` delegating is what makes the
    // boundary real for that command, and asserting it here is what would catch a future rewrite
    // that quietly went back to building its own client.
    const seen: EnvToolConfigSection[] = [];
    const spawned: string[] = [];
    await resolveForceResetLeaseConfig(envToolCfg(), {
      makeEnvToolClient: (c) => {
        seen.push(c);
        return new EnvToolClient(c, { spawn: spawnStub(spawned) });
      },
    });
    expect(seen[0]?.publish).toBeUndefined();
    expect(seen[0]?.downloadSymbols).toBeUndefined();
  });
});
