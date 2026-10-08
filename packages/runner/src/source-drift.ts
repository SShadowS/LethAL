/**
 * R505: the project changed on disk during the run.
 *
 * al-runner v2.12.0-main.c39ad5de labels coverage with the object's file in the source project it
 * finds BESIDE THE TEST APP, re-read at every invocation and every `--server` `runTests`, while
 * the lines are the compiled batch's (measured, `/coord/handoff/R-505/plan.md`). LethAL builds the
 * batch from the session snapshot, so once the live project differs from it, a label can name
 * another object's file (coverage credited to the wrong object) or a file the batch does not have
 * (coverage dropped). Covering tests, and so verdicts, would change. Upstream fixed the labelling
 * in #5249 (`3c350f65`, after the pinned build); until the pin moves, coverage is read only while
 * the live project's build inputs still equal what the run started from.
 *
 * The inputs are every `.al` file and `app.json` (compared with the snapshot's bytes), and every
 * resource the batch copies (`isProjectResource`, compared with the bytes seen at the first
 * check), minus the run's own output files. A check is stat-gated: a file's bytes are re-read only
 * when its size, mtime or ctime moved, and a stat is trusted only once it is no longer "racily
 * clean" (git's rule): its mtime and ctime lie more than `RACY_MS` before the check that saw the
 * bytes equal. A file written within a timestamp's resolution of that check (a same-size edit
 * inside one mtime tick, or a Windows timestamp updated late) would otherwise keep a stat equal to
 * the cached one and never be re-read; such a file is re-read at every check until it ages.
 *
 * LIMIT, stated (R505): an edit undone between two checks is not seen. The checks bracket every
 * coverage-producing al-runner call, so such an edit must start and end inside one call.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isProjectResource, outputPathKey } from "./orchestrator";

/** Thrown, never turned into a verdict: the session stops, and `--resume` continues it. */
export class ProjectChangedDuringRunError extends Error {
  constructor(
    readonly projectDir: string,
    readonly changes: readonly string[],
  ) {
    const shown = changes.slice(0, 5).join("; ");
    const more = changes.length > 5 ? `; and ${changes.length - 5} more` : "";
    super(
      `the project ${projectDir} changed on disk during the run (${shown}${more}). al-runner labels coverage with the project's CURRENT files, so its coverage could be credited to the wrong object or dropped (R505); the session stops rather than read it. Undo the change, or let the run finish before editing; \`lethal run --resume\` continues this run from its last recorded verdict (a run stopped before its first verdict has nothing to carry: run it again). A changed file that is not a build input (something written into the project while the run was going) counts too: write it outside the project.`,
    );
    this.name = "ProjectChangedDuringRunError";
  }
}

/**
 * File names no AL build reads, which a run writes into the project as a matter of routine
 * (opus build review): a redirected log (`run.log`, `nohup.out`) and an office lock file (`~$...`,
 * while a report layout is open). They would stop the run for a reason that is not R505's.
 */
const NEVER_AN_INPUT = /\.log$|^nohup\.out$|^~\$/i;

export interface Seen {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/** Wider than any filesystem's timestamp granularity (FAT: 2 s) plus a late Windows update. */
const RACY_MS = 3000;

/** `undefined` when the file is gone. */
async function statOf(path: string): Promise<Seen | undefined> {
  const s = await stat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  return s === undefined ? undefined : { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
}

export interface ProjectInputWatch {
  /** Throws `ProjectChangedDuringRunError` when an input differs from the run's start. */
  check(): Promise<void>;
}

/**
 * `snapshot` is the session's (`readTargetSource`: every `.al` plus `app.json`, keyed by
 * project-relative path). `excludeOutputs` are the run's own output files (exact paths).
 * `statFile` is for tests, which must force a stat equal to the cached one.
 */
export function watchProjectInputs(
  projectDir: string,
  snapshot: ReadonlyMap<string, Buffer>,
  excludeOutputs: readonly string[] = [],
  statFile: (path: string) => Promise<Seen | undefined> = statOf,
): ProjectInputWatch {
  const excluded = new Set(excludeOutputs.map(outputPathKey));
  /** The bytes each input must still have. Resources are filled at the first check. */
  const expected = new Map<string, Buffer>(snapshot);
  let resourcesKnown = false;
  /** The stat at which an input was last seen equal to `expected`. */
  const seen = new Map<string, Seen>();

  const inputs = async (): Promise<string[]> => {
    const entries = await readdir(projectDir, { recursive: true, withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const rel = relative(projectDir, join(e.parentPath, e.name));
      const isAl = rel.toLowerCase().endsWith(".al");
      const isManifest = rel === "app.json";
      if (!isAl && !isManifest && !isProjectResource(rel)) continue;
      if (!isAl && !isManifest && NEVER_AN_INPUT.test(e.name)) continue;
      if (excluded.has(outputPathKey(join(projectDir, rel)))) continue;
      out.push(rel);
    }
    return out.sort();
  };

  return {
    async check() {
      const checkedAt = Date.now();
      const current = await inputs();
      if (!resourcesKnown) {
        for (const rel of current) {
          if (expected.has(rel) || rel.toLowerCase().endsWith(".al") || rel === "app.json")
            continue;
          expected.set(rel, await readFile(join(projectDir, rel)));
        }
        resourcesKnown = true;
      }
      const changes: string[] = [];
      const present = new Set(current);
      for (const rel of current) {
        const want = expected.get(rel);
        if (want === undefined) {
          changes.push(`added ${rel}`);
          continue;
        }
        const path = join(projectDir, rel);
        // A file can go between the listing and this read (an editor's atomic save, a delete):
        // that is a removal, named as one, never a raw ENOENT without R505's diagnosis.
        const now = await statFile(path);
        if (now === undefined) {
          changes.push(`removed ${rel}`);
          present.delete(rel);
          continue;
        }
        const last = seen.get(rel);
        if (
          last !== undefined &&
          last.size === now.size &&
          last.mtimeMs === now.mtimeMs &&
          last.ctimeMs === now.ctimeMs
        )
          continue;
        const bytes = await readFile(path).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return undefined;
          throw err;
        });
        if (bytes === undefined) {
          changes.push(`removed ${rel}`);
          present.delete(rel);
        } else if (now.size === want.length && bytes.equals(want)) {
          const settled = Math.max(now.mtimeMs, now.ctimeMs) < checkedAt - RACY_MS;
          if (settled) seen.set(rel, now);
          else seen.delete(rel);
        } else changes.push(`changed ${rel}`);
      }
      for (const rel of expected.keys())
        if (!present.has(rel) && !changes.includes(`removed ${rel}`))
          changes.push(`removed ${rel}`);
      if (changes.length > 0) throw new ProjectChangedDuringRunError(projectDir, changes.sort());
    },
  };
}
