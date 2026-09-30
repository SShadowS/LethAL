import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * R358: a fresh temp directory per call, removed after the calling file's last test. Call it ONCE
 * at the top level of a test file (it registers that file's `afterAll`); the root test preload
 * fails the run if a file leaves a `lethal-*` temp entry behind. A directory that cannot be
 * removed (on Windows, usually a database or process the test never closed) fails the file,
 * after every other directory has been tried.
 */
export function scratchDirs(): (prefix: string) => string {
  const made: string[] = [];
  afterAll(() => {
    const failed: string[] = [];
    for (const d of made) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (err) {
        failed.push(`${d}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failed.length > 0) throw new Error(`R358: could not remove\n${failed.join("\n")}`);
  });
  return (prefix) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    made.push(d);
    return d;
  };
}
