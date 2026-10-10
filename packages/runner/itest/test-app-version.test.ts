import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchDir } from "../tests/helpers/scratch";
import { TestAppVersionError, expectedTestAppVersion } from "./test-app-version";

describe("expectedTestAppVersion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lethal-testappver-"));
  });

  afterEach(() => {
    removeScratchDir(dir);
  });

  test("reads the version field from app.json", async () => {
    await writeFile(join(dir, "app.json"), JSON.stringify({ version: "1.0.0.3" }), "utf8");
    expect(await expectedTestAppVersion(dir)).toBe("1.0.0.3");
  });

  test("refuses a missing app.json", async () => {
    await expect(expectedTestAppVersion(dir)).rejects.toThrow(TestAppVersionError);
  });

  test("refuses malformed JSON", async () => {
    await writeFile(join(dir, "app.json"), "{ not json", "utf8");
    await expect(expectedTestAppVersion(dir)).rejects.toThrow(TestAppVersionError);
  });

  test("refuses a missing version field", async () => {
    await writeFile(join(dir, "app.json"), JSON.stringify({ name: "x" }), "utf8");
    await expect(expectedTestAppVersion(dir)).rejects.toThrow(TestAppVersionError);
  });

  test("refuses a non-string version field", async () => {
    await writeFile(join(dir, "app.json"), JSON.stringify({ version: 103 }), "utf8");
    await expect(expectedTestAppVersion(dir)).rejects.toThrow(TestAppVersionError);
  });
});
