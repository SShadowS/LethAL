import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import { helpText, initFromCli, parseCliConfig } from "../src/cli";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

/**
 * `lethal init` exists for one field a first-time user cannot guess: the three object ids LethAL
 * injects must fall inside an idRange the target's own app.json declares, and a wrong one fails at
 * PUBLISH time naming an id they never chose. So the tests that matter are about the ids, not about
 * the templating.
 */

async function project(appJson: Record<string, unknown>): Promise<string> {
  const dir = scratch("lethal-init-");
  await writeFile(join(dir, "app.json"), JSON.stringify(appJson), "utf8");
  return dir;
}

const APP = (idRanges: unknown): Record<string, unknown> => ({
  id: "0e0f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b",
  name: "Test App",
  publisher: "Tester",
  version: "1.0.0.0",
  idRanges,
});

async function runInit(
  dir: string,
  extra: {
    outPath?: string;
    force?: boolean;
    backendKind?: "bcdev" | "al-runner-v3";
  } = {},
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    const code = await initFromCli({ mode: "init", projectDir: dir, ...extra });
    return { code, out: lines.join("\n") };
  } finally {
    log.mockRestore();
  }
}

describe("lethal init", () => {
  test("picks selector ids inside the target's OWN declared range", async () => {
    const dir = await project(APP([{ from: 60000, to: 60099 }]));
    const { code } = await runInit(dir);
    expect(code).toBe(0);
    const written = JSON.parse(await readFile(join(dir, "lethal.config.json"), "utf8")) as {
      selectorIds: { selectorId: number; controlId: number; tableId: number };
    };
    expect(written.selectorIds).toEqual({ selectorId: 60099, controlId: 60098, tableId: 60097 });
  });

  test("the config it writes carries every field a run needs, so only unknowables are left", async () => {
    const dir = await project(APP([{ from: 60000, to: 60099 }]));
    await runInit(dir);
    const written = JSON.parse(await readFile(join(dir, "lethal.config.json"), "utf8")) as {
      bcdev: Record<string, unknown>;
    };
    for (const key of [
      "mcpCommand",
      "server",
      "serverInstance",
      "company",
      "username",
      "password",
      "packageCachePath",
      "controlSymbolPath",
      "env",
    ]) {
      expect(written.bcdev[key], `bcdev.${key} missing`).toBeDefined();
    }
    // `env` is the field the README has to explain is "not optional in practice" — bc-dev-mcp reads
    // credentials from the environment, not from parameters. A generated config that omitted it
    // would fail with "Missing connection settings: username", which names nothing useful.
    expect(written.bcdev.env).toEqual({ BC_DEV_USER: "admin", BC_DEV_PASSWORD: "pw" });
  });

  test("REFUSES a project whose ranges hold fewer than three free ids, naming the fix", async () => {
    // The alternative is writing an out-of-range id that fails at publish time inside a live run,
    // which is the round trip this command exists to remove.
    const dir = await project(APP([{ from: 70000, to: 70001 }]));
    await expect(runInit(dir)).rejects.toThrow(/three free ids|Widen idRanges/);
  });

  test("REFUSES to overwrite an existing config without --force", async () => {
    const dir = await project(APP([{ from: 60000, to: 60099 }]));
    await writeFile(join(dir, "lethal.config.json"), '{"mine":true}', "utf8");
    await expect(runInit(dir)).rejects.toThrow(/already exists/);
    // And the file is untouched — a refusal that had already written would be worse than none.
    expect(await readFile(join(dir, "lethal.config.json"), "utf8")).toBe('{"mine":true}');
  });

  test("--force overwrites, because replacing it is sometimes what you meant", async () => {
    const dir = await project(APP([{ from: 60000, to: 60099 }]));
    await writeFile(join(dir, "lethal.config.json"), '{"mine":true}', "utf8");
    const { code } = await runInit(dir, { force: true });
    expect(code).toBe(0);
    expect(await readFile(join(dir, "lethal.config.json"), "utf8")).toContain("selectorIds");
  });

  test("--out writes elsewhere and leaves the default path alone", async () => {
    const dir = await project(APP([{ from: 60000, to: 60099 }]));
    const out = join(dir, "custom.config.json");
    await runInit(dir, { outPath: out });
    expect(await readFile(out, "utf8")).toContain("selectorIds");
    await expect(readFile(join(dir, "lethal.config.json"), "utf8")).rejects.toThrow();
  });

  test("the printed next steps name what is left, rather than implying the config is ready", async () => {
    const dir = await project(APP([{ from: 60000, to: 60099 }]));
    const { out } = await runInit(dir);
    expect(out).toContain("Still yours to fill in");
    expect(out).toContain("lethal doctor --config");
  });

  test("parses its flags, and --project is required", () => {
    expect(parseCliConfig(["init", "--project", "p"])).toEqual({ mode: "init", projectDir: "p" });
    expect(parseCliConfig(["init", "--project", "p", "--out", "o", "--force"])).toEqual({
      mode: "init",
      projectDir: "p",
      outPath: "o",
      force: true,
    });
    expect(() => parseCliConfig(["init"])).toThrow(/--project/);
  });

  test("help documents it", () => {
    const text = helpText("0.0.0");
    expect(text).toContain("lethal init");
    expect(text).toContain("--force");
    expect(text).toContain("[--backend <bcdev|al-runner-v3>]");
  });
});

describe("lethal init --backend (PR-71)", () => {
  const RANGE = APP([{ from: 60000, to: 60099 }]);
  const writtenOf = async (dir: string) =>
    JSON.parse(await readFile(join(dir, "lethal.config.json"), "utf8")) as {
      alRunnerV3?: Record<string, unknown>;
      bcdev?: unknown;
      selectorIds: unknown;
    };

  test("bcdev output is byte-identical to the pre-flag output, with or without --backend bcdev", async () => {
    const dir = await project(RANGE);
    const expected = `${JSON.stringify(
      {
        bcdev: {
          mcpCommand: ["bun", "x", "bc-dev-mcp"],
          server: "http://YourContainer",
          serverInstance: "BC",
          company: "CRONUS",
          username: "admin",
          password: "pw",
          packageCachePath: join(dir, ".alpackages"),
          controlSymbolPath: "C:/path/to/LethAL/extensions/lethal-control/lethal-control.app",
          env: { BC_DEV_USER: "admin", BC_DEV_PASSWORD: "pw" },
        },
        selectorIds: { selectorId: 60099, controlId: 60098, tableId: 60097 },
      },
      null,
      2,
    )}\n`;
    await runInit(dir);
    expect(await readFile(join(dir, "lethal.config.json"), "utf8")).toBe(expected);
    await runInit(dir, { force: true, backendKind: "bcdev" });
    expect(await readFile(join(dir, "lethal.config.json"), "utf8")).toBe(expected);
  });

  test("al-runner-v3 writes an alRunnerV3 section and the same picked ids, no bcdev", async () => {
    const dir = await project(RANGE);
    const { out } = await runInit(dir, { backendKind: "al-runner-v3" });
    const w = await writtenOf(dir);
    expect(w.bcdev).toBeUndefined();
    expect(w.selectorIds).toEqual({ selectorId: 60099, controlId: 60098, tableId: 60097 });
    expect(w.alRunnerV3?.packagesDir).toBe(join(dir, ".alpackages"));
    expect(w.alRunnerV3).not.toHaveProperty("path");
    expect(out).toContain("alRunnerV3.bcVersion");
    expect(out).toContain("lethal doctor --config");
    expect(out).toContain("must hold the BC symbols");
    expect(out).toContain("fetch-ms-symbols");
    expect(out).toContain("alc (the AL compiler)");
    expect(out).toContain("fetch-alc");
    expect(out).toContain("Fill in both placeholders");
  });

  test("an unusable launch.json is named in the next steps, not called 'no environmentType'", async () => {
    const dir = await project(RANGE);
    await mkdir(join(dir, ".vscode"));
    await writeFile(join(dir, ".vscode", "launch.json"), "{ not json", "utf8");
    const { out } = await runInit(dir, { backendKind: "al-runner-v3" });
    expect(out).toContain("could not be parsed");
    expect(out).not.toContain("names no environmentType");
    expect((await writtenOf(dir)).alRunnerV3?.environment).toBe("<onprem or saas>");
  });

  test("the bcVersion placeholder is refused by name, and a real build passes", async () => {
    const dir = await project(RANGE);
    await runInit(dir, { backendKind: "al-runner-v3" });
    const section = (await writtenOf(dir)).alRunnerV3;
    expect(() => validateAlRunnerV3Config({ ...section, environment: "onprem" })).toThrow(
      /alRunnerV3\.bcVersion/,
    );
    expect(() =>
      validateAlRunnerV3Config({ ...section, bcVersion: "28.4.1.2", environment: "onprem" }),
    ).not.toThrow();
  });

  test("environment is omitted when launch.json gives it, else a placeholder the validator refuses", async () => {
    const withLaunch = await project(RANGE);
    await mkdir(join(withLaunch, ".vscode"));
    await writeFile(
      join(withLaunch, ".vscode", "launch.json"),
      '{ "configurations": [ { "environmentType": "Sandbox" } ] }',
      "utf8",
    );
    const { out } = await runInit(withLaunch, { backendKind: "al-runner-v3" });
    expect((await writtenOf(withLaunch)).alRunnerV3).not.toHaveProperty("environment");
    expect(out).toContain("launch.json gives environmentType");

    const without = await project(RANGE);
    await runInit(without, { backendKind: "al-runner-v3" });
    const section = (await writtenOf(without)).alRunnerV3;
    expect(section?.environment).toBe("<onprem or saas>");
    expect(() => validateAlRunnerV3Config({ ...section, bcVersion: "28.4.1.2" })).toThrow(
      /alRunnerV3\.environment/,
    );
  });

  test("an unknown backend is refused by name; the flag parses and the config round-trips", () => {
    expect(() => parseCliConfig(["init", "--project", "p", "--backend", "al-runner"])).toThrow(
      /--backend/,
    );
    expect(() => parseCliConfig(["init", "--project", "p", "--backend", "nope"])).toThrow(
      'unknown --backend "nope"',
    );
    expect(parseCliConfig(["init", "--project", "p", "--backend", "al-runner-v3"])).toEqual({
      mode: "init",
      projectDir: "p",
      backendKind: "al-runner-v3",
    });
    expect(parseCliConfig(["init", "--project", "p", "--backend", "bcdev"])).toEqual({
      mode: "init",
      projectDir: "p",
      backendKind: "bcdev",
    });
  });
});
