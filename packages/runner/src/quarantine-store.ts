import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
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
    await rename(tmp, target); // atomic same-dir rename
    return next;
  }
}
