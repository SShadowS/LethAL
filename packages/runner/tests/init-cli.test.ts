import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpText, initFromCli, parseCliConfig } from "../src/cli";

/**
 * `lethal init` exists for one field a first-time user cannot guess: the three object ids LethAL
 * injects must fall inside an idRange the target's own app.json declares, and a wrong one fails at
 * PUBLISH time naming an id they never chose. So the tests that matter are about the ids, not about
 * the templating.
 */

async function project(appJson: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-init-"));
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
  extra: { outPath?: string; force?: boolean } = {},
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
  });
});
