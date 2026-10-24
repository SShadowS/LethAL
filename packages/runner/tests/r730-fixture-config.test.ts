/**
 * R730: the live itests read their fixture config through `readFixtureConfig`, which refuses a
 * retired `alRunner` section (R654 F2) as `loadLethalConfigFile` does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFixtureConfig } from "../itest/config-path";
import { AlRunnerV2RetiredError } from "../src/v2-retired";
import { removeScratchDir } from "./helpers/scratch";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeScratchDir(d);
});

function write(config: object): string {
  const dir = mkdtempSync(join(tmpdir(), "r730-"));
  dirs.push(dir);
  const path = join(dir, "lethal.config.test.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("readFixtureConfig (R730)", () => {
  test.each([{ alRunner: { packagesDir: "x" } }, { alRunner: {} }])(
    "a fixture config with an alRunner section is refused, naming the file: %j",
    (section) => {
      const path = write({ bcdev: { server: "http://bc" }, ...section });
      expect(() => readFixtureConfig(path)).toThrow(AlRunnerV2RetiredError);
      expect(() => readFixtureConfig(path)).toThrow(path);
    },
  );

  test("the same config without the section is returned parsed", () => {
    const path = write({ bcdev: { server: "http://bc" } });
    expect(readFixtureConfig(path)).toEqual({ bcdev: { server: "http://bc" } });
  });
});
