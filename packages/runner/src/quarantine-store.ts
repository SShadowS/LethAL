import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** R417: the quarantine store path exists but is not a directory. A broken configuration, never
 *  "no record". */
export class QuarantineStoreNotADirectoryError extends Error {
  constructor(readonly path: string) {
    super(
      `the quarantine store ${path} exists but is not a directory, so no quarantine can be read or cleared there. Remove or move it, or point the quarantine dir somewhere else.`,
    );
    this.name = "QuarantineStoreNotADirectoryError";
  }
}

/** Bounded retry budget for `renameWithRetry`'s transient-EPERM ride-out (see its doc comment). */
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `rename()` to a shared destination path, with a small bounded retry on a transient
 * `EPERM`/`EACCES`. On Windows, two writers racing `rename()` onto the SAME target (e.g. two
 * concurrent `record()` calls for one tier — see the co-located concurrent-write test) can
 * intermittently observe the target file briefly held by the other writer's own in-flight
 * rename, surfacing as `EPERM` (occasionally `EACCES`) rather than succeeding or losing the
 * race cleanly — a transient contention window, not a real permission failure.
 *
 * Atomicity is unaffected: `rename` is still the ONLY write to `target`, and still the single
 * commit point — this just decides how many times to retry that SAME atomic rename, never
 * partial-writes or falls back to a non-atomic copy. A fixed retry count and fixed delay (no
 * `Date.now`/`Math.random` — this file's writes must stay trivially deterministic to reason
 * about) is enough to ride out the window; anything else, or persistent EPERM/EACCES after every
 * attempt, rethrows unchanged so the caller's existing "a write that cannot be made durable
 * throws" contract holds.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_MAX_ATTEMPTS || (code !== "EPERM" && code !== "EACCES")) throw err;
      await delay(RENAME_RETRY_DELAY_MS);
    }
  }
}

export interface QuarantineRecord {
  readonly resourceKey: string;
  readonly opKind: string;
  readonly detail: string;
  readonly recordedAtIso: string;
  readonly generation: number;
}

/**
 * Machine-local durable quarantine, one file per service tier under `baseDir` (spec §9).
 *
 * GUARANTEE (honest): best-effort durable across NON-overlapping processes on one host. It is
 * NOT concurrent-session-safe — two overlapping processes can still race (B reads before A
 * writes). Closing that race needs a pre-operation cross-process lease — 5C, not this module.
 *
 * Each write is atomic (temp file → rename) so a crash never leaves a partial record; a write
 * that cannot be made durable throws (the caller then fails the session loudly, never proceeds
 * unmarked). `generation` monotonically increases per tier and gates clears (Task 6).
 */
export class QuarantineStore {
  constructor(private readonly baseDir: string) {}

  private fileFor(resourceKey: string): string {
    const safe = createHash("sha256").update(resourceKey).digest("hex").slice(0, 32);
    return join(this.baseDir, `${safe}.json`);
  }

  async read(resourceKey: string): Promise<QuarantineRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(resourceKey), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      // R417: a MISSING store dir means no record. A store path that EXISTS but is not a
      // directory is a broken configuration, refused on every platform (Linux reports ENOTDIR
      // here, Windows ENOENT, R413). Reading it as "no record" would let `clear()` answer
      // "cleared" and the quarantine check report clean: empty-vs-empty on a safety latch.
      let isDir: boolean;
      try {
        isDir = (await stat(this.baseDir)).isDirectory();
      } catch (statErr) {
        const sc = (statErr as NodeJS.ErrnoException).code;
        if (sc === "ENOENT") return null;
        // The store dir's own parent is a file: the same broken configuration as a file at the
        // store path. Anything else (EACCES, EIO) is unknown, so it must not read as "no record".
        if (sc === "ENOTDIR") throw new QuarantineStoreNotADirectoryError(this.baseDir);
        throw statErr;
      }
      if (!isDir) throw new QuarantineStoreNotADirectoryError(this.baseDir);
      return null;
    }
    return JSON.parse(raw) as QuarantineRecord;
  }

  async record(rec: Omit<QuarantineRecord, "generation">): Promise<QuarantineRecord> {
    await mkdir(this.baseDir, { recursive: true });
    const prior = await this.read(rec.resourceKey);
    const next: QuarantineRecord = { ...rec, generation: (prior?.generation ?? 0) + 1 };
    const target = this.fileFor(rec.resourceKey);
    const tmp = `${target}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(next), "utf8");
    await renameWithRetry(tmp, target); // atomic same-dir rename, retried on a transient EPERM/EACCES
    return next;
  }

  /**
   * Remove the tier's quarantine ONLY if the caller holds the current generation. A clear
   * computed against an older generation (another session wrote a newer quarantine in between)
   * returns "stale" and leaves the newer record intact — a stale clear must never erase a newer
   * strand. Clearing an already-absent record is idempotent "cleared".
   */
  async clear(resourceKey: string, expectedGeneration: number): Promise<"cleared" | "stale"> {
    const current = await this.read(resourceKey);
    if (current === null) return "cleared";
    if (current.generation !== expectedGeneration) return "stale";
    await rm(this.fileFor(resourceKey), { force: true });
    return "cleared";
  }
}
