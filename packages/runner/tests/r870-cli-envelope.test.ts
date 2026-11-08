/**
 * R870 (GitHub #27): with `--json`, stdout is one bc-toolbox CLI envelope; without it, nothing a
 * user sees moves. The schema is `@sshadows/bc-toolbox-envelope` 0.1.0's, vendored byte for byte.
 * The three failure classes of the issue (bad input, missing configuration, a failing operation)
 * run through the real CLI as a child process, so stdout, stderr and the exit code are the ones a
 * caller gets.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UncommittedPathError } from "../src/campaign-git";
import { refusalLine } from "../src/cli";
import {
  INVALID_ARGUMENT,
  LETHAL_ERROR_CODES,
  TOOLBOX_CORE_ERROR_CODES,
  classify,
  cliError,
  cliOk,
} from "../src/cli-envelope";
import { unknownKeywords, violations } from "./helpers/json-schema-subset";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SCHEMA_PATH = join(ROOT, "schemas", "cli-envelope-v1.schema.json");
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
const CLI = join(ROOT, "packages", "runner", "src", "cli.ts");

describe("R870: the vendored schema", () => {
  test("is @sshadows/bc-toolbox-envelope 0.1.0's cli-envelope.schema.json, byte for byte", () => {
    const sha = createHash("sha256").update(readFileSync(SCHEMA_PATH)).digest("hex");
    expect(sha).toBe("39d672263d631046b3ff05befd472c9fa6bb0fc1b94598506f1d9675dd84705b");
  });

  test("uses only keywords the test's validator knows, so none is silently ignored", () => {
    expect(unknownKeywords(SCHEMA)).toEqual([]);
  });

  test("the validator fails what it should fail: otherwise every pass below is empty", () => {
    const good = cliError(new Error("x"));
    expect(violations(SCHEMA, good)).toEqual([]);
    const err = (good as unknown as { error: Record<string, unknown> }).error;
    const bad: unknown[] = [
      { ...good, error: { ...err, nextSteps: [] } },
      { ...good, error: { ...err, code: "lower_case" } },
      { ...good, error: { ...err, category: "other" } },
      { ...good, error: { ...err, details: { n: [1] } } },
      { ...good, error: { ...err, tool: "lethal" } },
      { ...good, extra: 1 },
      { ...cliOk(1), schemaVersion: "2" },
      { schemaVersion: "1", status: "ok", warnings: [] },
    ];
    for (const b of bad) expect(violations(SCHEMA, b), JSON.stringify(b)).not.toEqual([]);
  });
});

describe("R870: the envelope LethAL builds", () => {
  test("ok and error envelopes validate", () => {
    expect(violations(SCHEMA, cliOk({ a: 1 }, ["w"]))).toEqual([]);
    expect(violations(SCHEMA, cliError(new UncommittedPathError("p", ["f"])))).toEqual([]);
  });

  test("extension codes are well formed and never a core code", () => {
    for (const c of [...TOOLBOX_CORE_ERROR_CODES, ...LETHAL_ERROR_CODES]) {
      expect(c).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    for (const c of LETHAL_ERROR_CODES) {
      expect((TOOLBOX_CORE_ERROR_CODES as readonly string[]).includes(c)).toBe(false);
    }
  });

  test("an unclassed error is INTERNAL_ERROR; an uncommitted pre-commitment is LethAL's own code", () => {
    expect(cliError(new Error("x"))).toMatchObject({
      status: "error",
      error: {
        code: "INTERNAL_ERROR",
        category: "internal",
        message: "x",
        details: { name: "Error" },
      },
    });
    expect(cliError(new UncommittedPathError("p", ["f"]))).toMatchObject({
      error: { code: "UNCOMMITTED_PRECOMMITMENT", category: "state" },
    });
  });

  test("a mark is invisible: name, message, keys and the stderr line stay as they were", () => {
    const plain = new Error("same words");
    const marked = classify(new Error("same words"), INVALID_ARGUMENT) as Error;
    expect(marked.name).toBe(plain.name);
    expect(marked.message).toBe(plain.message);
    expect(Object.keys(marked)).toEqual(Object.keys(plain));
    expect(refusalLine(marked)).toBe(refusalLine(plain));
    expect(cliError(marked)).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });
});

/** The real CLI, as a child: what a caller sees. */
function lethal(args: readonly string[], home: string) {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });
  return { exit: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("R870: --json through the real CLI, on the issue's three failure classes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lethal-r870-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "v3.json");
  writeFileSync(
    config,
    JSON.stringify({
      alRunnerV3: {
        packagesDir: dir,
        bcVersion: "28.0.1.2",
        path: join(dir, "no-al-runner"),
        alcPath: join(dir, "no-alc"),
      },
    }),
  );
  const cases: ReadonlyArray<{
    name: string;
    args: string[];
    exit: number;
    status: "ok" | "error";
    code?: string;
  }> = [
    {
      name: "bad input",
      args: ["doctor", "--config", config, "--bogus"],
      exit: 1,
      status: "error",
      code: "INVALID_ARGUMENT",
    },
    {
      name: "missing configuration",
      args: ["doctor", "--config", join(dir, "missing.json")],
      exit: 1,
      status: "error",
      code: "CONFIGURATION_ERROR",
    },
    // A check that fails is a result: the operation ran, so the envelope is "ok" and the data says.
    { name: "a failing operation", args: ["doctor", "--config", config], exit: 1, status: "ok" },
  ];

  for (const c of cases) {
    test(`${c.name}: stdout is one envelope, stderr is unchanged, the exit code is unchanged`, () => {
      const plain = lethal(c.args, dir);
      const json = lethal([...c.args, "--json"], dir);
      expect(json.exit).toBe(c.exit);
      expect(plain.exit).toBe(c.exit);
      const envelope = JSON.parse(json.stdout) as Record<string, unknown>;
      expect(violations(SCHEMA, envelope)).toEqual([]);
      expect(envelope.status).toBe(c.status);
      if (c.code !== undefined) {
        expect((envelope.error as { code: string }).code).toBe(c.code);
        // Logs only on stderr, and the same ones: the envelope adds stdout, it takes nothing away.
        expect(json.stderr).toBe(plain.stderr);
      } else {
        expect((envelope.data as { ok: boolean }).ok).toBe(false);
      }
    });
  }

  test("without --json nothing moves: the same lines, and no envelope anywhere", () => {
    const bad = lethal(cases[0]?.args ?? [], dir);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toStartWith("TypeError: Unknown option '--bogus'.");
    expect(bad.stderr).toEndWith("\n(set LETHAL_DEBUG=1 for the stack trace)\n");
    const missing = lethal(cases[1]?.args ?? [], dir);
    expect(missing.stdout).toBe("");
    expect(missing.stderr.split(dir).join("<dir>")).toBe(
      "cannot read config file at <dir>/missing.json: ENOENT: no such file or directory, open '<dir>/missing.json'\n(set LETHAL_DEBUG=1 for the stack trace)\n",
    );
    const failing = lethal(cases[2]?.args ?? [], dir);
    expect(failing.stdout).toStartWith("FAIL: at least one check failed\n  [FAIL] al-runner-v3:");
    for (const r of [bad, missing, failing])
      expect(r.stdout + r.stderr).not.toContain('"schemaVersion"');
  });
});
