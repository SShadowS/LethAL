/**
 * The sandbox-tests app's own version, read from its `app.json` at run time.
 *
 * `test-app-publish.itest.ts` used to pin a literal copy of this (`TEST_APP_VERSION = "1.0.0.2"`)
 * and assert a published test app's version equals it. A fixture bump then breaks the gate
 * silently until someone chases the mismatch by hand: R269 was GH-09 bumping
 * `fixtures/sandbox-tests/app.json` to 1.0.0.3 without anyone touching the gate. Reading it here
 * means the fixture is the only place the version lives.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Thrown for a missing, unreadable, or malformed `app.json`. Never falls back silently. */
export class TestAppVersionError extends Error {}

/** Reads `<testDir>/app.json` and returns its `version` field. */
export async function expectedTestAppVersion(testDir: string): Promise<string> {
  const path = join(testDir, "app.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new TestAppVersionError(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TestAppVersionError(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const version =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string" || version === "") {
    throw new TestAppVersionError(`${path} has no non-empty string "version" field`);
  }
  return version;
}
