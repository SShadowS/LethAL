import { afterAll } from "bun:test";
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const errCode = (err: unknown): string => {
  const code = (err as { code?: unknown }).code;
  return code !== undefined ? String(code) : errText(err);
};

/**
 * R358/R375: remove a test's temp folder, retrying a few times. If it still cannot be removed, it
 * throws `R358: could not remove <dir>: <error>` as before, and now also names the files still
 * locked (`still locked: lethal.sqlite-wal (EBUSY)`): it walks what is left and tries each file
 * on its own, so a Windows lock points at its holder instead of only at the folder. `rm` is a seam
 * for the test that simulates a lock; callers leave it alone.
 */
export function removeScratchDir(dir: string, rm: typeof rmSync = rmSync): void {
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    const locked: string[] = [];
    try {
      for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
        const p = join(dir, rel);
        try {
          if (lstatSync(p).isDirectory()) continue;
          rm(p, { force: true });
        } catch (fileErr) {
          locked.push(`${rel} (${errCode(fileErr)})`);
        }
      }
    } catch {
      // The folder could not be listed: the original error is all there is to report.
    }
    const tail = locked.length > 0 ? `; still locked: ${locked.join(", ")}` : "";
    throw new Error(`R358: could not remove ${dir}: ${errText(err)}${tail}`);
  }
}

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
        removeScratchDir(d);
      } catch (err) {
        failed.push(errText(err));
      }
    }
    if (failed.length > 0) throw new Error(failed.join("\n"));
  });
  return (prefix) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    made.push(d);
    return d;
  };
}

/**
 * R358/R360: `lethal run` removes its `<tmp>/lethal-XXXXXX` session folder after a clean report,
 * and KEEPS it on purpose when the run throws or is quarantined, since its files name the cause.
 * A test file that drives `runFromCli` down such a path calls this once at the top level; it
 * removes those folders after the file's last test. A file whose runs all succeed does not need
 * it, and the R358 preload fails a file that leaves one behind. The temp folder is the test
 * process's private one (scripts/test-preload.ts), so nothing another process made can match.
 */
export function removeRunScratchAfterAll(): void {
  afterAll(() => {
    for (const e of readdirSync(tmpdir())) {
      if (/^lethal-[A-Za-z0-9]{6}$/.test(e)) {
        removeScratchDir(join(tmpdir(), e));
      }
    }
  });
}
