/**
 * R1241: a gate's handle on a fixture's SHARED results store (`fixtures/<f>/lethal.sqlite`, persistent, one per
 * worktree). Two servers' gates once ran at once in one worktree and each read the store's newest run
 * (`SELECT MAX(id) FROM runs`) as its own, so R206's liveness check and R582's reproduction check read the OTHER gate's
 * half-written run. Two guards close it:
 * - **the hold** (`holdFixtureStore`, taken once at the start of a gate, before any leg or environment is set up):
 *   `<store>.itest-holder` names the gate process (pid and, on Linux, its start time, so a reused pid is not taken
 *   for the holder). A second gate is refused while the holder lives, naming it. A holder whose process is gone is
 *   taken over. An unreadable holder file is refused by name, never guessed at.
 * - **the run's own id** (`openFixtureStore`, per leg, only under this process's hold): the mark is the store's newest
 *   run id at open. `ownRunId()` requires EXACTLY one run after it, so a run some other writer added (one the hold
 *   cannot see, such as a hand `lethal run` on the fixture) is refused by name, never read.
 *
 * A process-private store (a `mkdtemp` scratch directory) needs neither; `latestRunId` stays for those.
 */
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { ResultsStore } from "../src/store";

export class FixtureStoreHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureStoreHeldError";
  }
}

interface Holder {
  readonly pid: number;
  /** `/proc/<pid>/stat` field 22 (start time in clock ticks); `null` where `/proc` is absent. */
  readonly start: string | null;
  readonly since: string;
}

/** A process's start time from `/proc/<pid>/stat` (field 22, after the `(comm)` field), or `null`. */
export function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null; // field 22 overall = index 19 after pid, comm and the two removed
  } catch {
    return null;
  }
}

/** The holder's command line, read when it is refused (Linux `/proc`); elsewhere only the pid names it. */
function commandOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    return "(command line not readable)";
  }
}

/** `true` when a process with this pid exists (EPERM: it exists, owned by someone else). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The holder still runs: its pid exists and, when both start times are known, it is the same process. */
export function holderAlive(h: Holder): boolean {
  if (!processAlive(h.pid)) return false;
  const now = startTimeOf(h.pid);
  return h.start === null || now === null || now === h.start;
}

type Read =
  | { kind: "missing" }
  | { kind: "unreadable"; text: string }
  | { kind: "holder"; holder: Holder; text: string };

function readHolder(path: string): Read {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw e;
  }
  try {
    const h = JSON.parse(text) as Partial<Holder>;
    if (typeof h.pid !== "number") return { kind: "unreadable", text };
    return {
      kind: "holder",
      holder: {
        pid: h.pid,
        start: typeof h.start === "string" ? h.start : null,
        since: String(h.since ?? ""),
      },
      text,
    };
  } catch {
    return { kind: "unreadable", text };
  }
}

const me = (): Holder => ({
  pid: process.pid,
  start: startTimeOf(process.pid),
  since: new Date().toISOString(),
});
const isMe = (r: Read): boolean =>
  r.kind === "holder" &&
  r.holder.pid === process.pid &&
  r.holder.start === startTimeOf(process.pid);

export interface FixtureStoreHold {
  /** Removes the holder file if it still names this process. */
  release(): void;
}

/**
 * Takes the hold on `storePath` for this process, for the whole gate. The holder file is written complete to a temp
 * file and LINKED into place, so another process never reads it half-written; a dead holder is renamed aside (one
 * process wins the rename) and checked to be the one read before it is deleted.
 */
export function holdFixtureStore(
  storePath: string,
  alive: (h: Holder) => boolean = holderAlive,
): FixtureStoreHold {
  const holderPath = `${storePath}.itest-holder`;
  const tmp = `${holderPath}.${process.pid}.tmp`;
  const deleteAdvice = `If no gate runs on this store, delete ${holderPath} by hand.`;
  writeFileSync(tmp, JSON.stringify(me()));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, holderPath);
        return {
          release: () => isMe(readHolder(holderPath)) && rmSync(holderPath, { force: true }),
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const other = readHolder(holderPath);
      if (other.kind === "missing") continue; // released between our link and our read
      if (other.kind === "unreadable")
        throw new FixtureStoreHeldError(
          `R1241: the fixture store ${storePath} has a holder file that cannot be read (${JSON.stringify(other.text.slice(0, 80))}). ${deleteAdvice}`,
        );
      const h = other.holder;
      if (alive(h))
        throw new FixtureStoreHeldError(
          `R1241: the fixture store ${storePath} is held by another live gate, pid ${h.pid} (since ${h.since}): ${commandOf(h.pid)}. ` +
            `Two gates in one store read each other's runs; run the other server's gate from its own worktree, or wait for it to finish. ${deleteAdvice}`,
        );
      // the holder is gone: move it aside (only one process can), and delete it only if it is the one we read
      const aside = `${holderPath}.stale.${process.pid}`;
      try {
        renameSync(holderPath, aside);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // another process took it over first
        throw e;
      }
      const moved = readHolder(aside);
      if (moved.kind === "holder" && moved.text === other.text) {
        rmSync(aside, { force: true });
        continue;
      }
      // we moved a NEWER holder (another process claimed it just now): put it back and stop
      try {
        linkSync(aside, holderPath);
      } finally {
        rmSync(aside, { force: true });
      }
      break;
    }
    throw new FixtureStoreHeldError(
      `R1241: could not take the hold on ${storePath}: another process claimed it at the same time.`,
    );
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface FixtureStore {
  readonly store: ResultsStore;
  /** The one run this gate's session made: exactly one run newer than the open's mark, else a throw naming them. */
  ownRunId(): number;
  close(): void;
}

/** Opens the store for one leg. Refuses unless this process holds it (`holdFixtureStore`): no gate skips the hold. */
export function openFixtureStore(storePath: string): FixtureStore {
  if (!isMe(readHolder(`${storePath}.itest-holder`)))
    throw new Error(
      `R1241: ${storePath} is opened without this process's hold: call holdFixtureStore at the start of the gate.`,
    );
  const store = new ResultsStore(storePath);
  const mark = (
    store.db.query("SELECT COALESCE(MAX(id), 0) AS id FROM runs").get() as { id: number }
  ).id;
  return {
    store,
    ownRunId() {
      const ids = (
        store.db.query("SELECT id FROM runs WHERE id > ? ORDER BY id").all(mark) as { id: number }[]
      ).map((r) => r.id);
      const [only, ...more] = ids;
      if (only === undefined || more.length > 0) {
        const found = `${ids.length} (${ids.join(", ") || "none"})`;
        throw new Error(
          `R1241: expected exactly one run after run ${mark} in ${storePath}, found ${found}: another writer shares this store, so no run here can be read as this gate's own.`,
        );
      }
      return only;
    },
    close: () => store.close(),
  };
}
