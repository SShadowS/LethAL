/**
 * R1241: a gate's handle on a fixture's SHARED results store (`fixtures/<f>/lethal.sqlite`, persistent, one per
 * worktree). Two servers' gates once ran at once in one worktree and each read the store's newest run
 * (`SELECT MAX(id) FROM runs`) as its own, so R206's liveness check and R582's reproduction check read the OTHER gate's
 * half-written run. Two guards close it:
 * - **the holder file:** `<store>.itest-holder` names the gate process holding the store. Opening refuses while a
 *   live process holds it, and names that process. A holder whose process is gone is taken over.
 * - **the run's own id:** the mark is the store's newest run id at open. `ownRunId()` requires EXACTLY one run after
 *   it, so a run some other writer added (one the holder file cannot see, such as a hand `lethal run` on the
 *   fixture) is refused by name, never read.
 *
 * A process-private store (a `mkdtemp` scratch directory) needs neither; `latestRunId` stays for those.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { ResultsStore } from "../src/store";

export class FixtureStoreHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureStoreHeldError";
  }
}

interface Holder {
  readonly pid: number;
  readonly since: string;
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

function readHolder(path: string): Holder | null {
  try {
    const h = JSON.parse(readFileSync(path, "utf8")) as Partial<Holder>;
    return typeof h.pid === "number" ? { pid: h.pid, since: String(h.since ?? "") } : null;
  } catch {
    return null;
  }
}

function claim(holderPath: string, storePath: string, alive: (pid: number) => boolean): void {
  const me: Holder = { pid: process.pid, since: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(holderPath, JSON.stringify(me), { flag: "wx" });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const other = readHolder(holderPath);
    if (other !== null && alive(other.pid)) {
      const advice =
        "Two gates in one store read each other's runs; run the other server's gate from its own worktree, or wait for it to finish.";
      throw new FixtureStoreHeldError(
        `R1241: the fixture store ${storePath} is held by another live gate, pid ${other.pid} (since ${other.since}): ${commandOf(other.pid)}. ${advice}`,
      );
    }
    // the holder is gone (or the file is unreadable): take it over
    unlinkSync(holderPath);
  }
  throw new FixtureStoreHeldError(
    `R1241: could not claim ${holderPath}: another process claimed it at the same time`,
  );
}

export interface FixtureStore {
  readonly store: ResultsStore;
  /** The one run this gate's session made: exactly one run newer than the open's mark, else a throw naming them. */
  ownRunId(): number;
  /** Closes the store, then removes the holder file if it still names this process. */
  close(): void;
}

export function openFixtureStore(
  storePath: string,
  alive: (pid: number) => boolean = processAlive,
): FixtureStore {
  const holderPath = `${storePath}.itest-holder`;
  claim(holderPath, storePath, alive);
  let store: ResultsStore;
  let mark: number;
  try {
    store = new ResultsStore(storePath);
    mark = (store.db.query("SELECT COALESCE(MAX(id), 0) AS id FROM runs").get() as { id: number })
      .id;
  } catch (e) {
    unlinkSync(holderPath);
    throw e;
  }
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
    close() {
      store.close();
      if (readHolder(holderPath)?.pid === process.pid) unlinkSync(holderPath);
    },
  };
}
