// R1077 (PR-72): heavy-slot's advisory when a job's declared --peak is far above what the same kind of command measured.
// Advisory only: heavy-slot.sh prints this line before the job queues or is admitted, and ignores this script's exit code, so the
// admission rule is unchanged (admitting by the measured peak would be an owner policy change; the declared peak is the job's
// promise over its whole life).
//
// The shape of a command: its class, the NAMES of the wrappers in front of it, its program and its `--project` value. The
// program is found past the wrappers (`timeout [opts] DURATION`, `/usr/bin/time [-v] [-o FILE]`): `bun <script>`, `bun run
// <name>`, or the executable's basename (with its first argument for `bash`). The wrappers' names stay in the shape, their
// arguments do not: on the ledger they are what tells a 3.5-hour DO window (`timeout ...`, measured 6-10.5 GiB) from a scoped DO
// run of the same --project (no wrapper, 3.2-3.9 GiB, PR-67's 54-minute wait), because the 160-character cut ends before
// `--only`. R1077's first-cut shape (class, program, --project) merged them, and the windows' 10.5 GiB hid PR-67's case.
// The ledger (<lock dir>/heavy-peaks.tsv, written by heavy-slot.sh's cleanup, R992) cuts each command to 160 characters, and
// heavy-slot.sh passes this script the same cut, so the shapes compare alike.
//
//   <command, cut as the ledger cuts it> | bun scripts/heavy-slot-advice.ts <lock dir> <class> <declared GiB>
// (stdin, never argv: see the note at the bottom)
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const LEDGER = "heavy-peaks.tsv";
/** The advisory fires when declared > RATIO x the largest measured peak of at least MIN_ROWS earlier jobs of the shape. */
export const RATIO = 2;
export const MIN_ROWS = 3;

/** `timeout`'s options that take a value (`-k 900`, `-s TERM`). */
const TIMEOUT_ARG = new Set(["-k", "--kill-after", "-s", "--signal"]);
/** GNU time's options that take a value (`-o FILE`, `-f FORMAT`). */
const TIME_ARG = new Set(["-o", "--output", "-f", "--format"]);

/** review r1: one script, one shape, whether called repo-relative (`packages/...`) or from a worktree's absolute path
 *  (`/work/lethal-wt/<wt>/packages/...`). */
export function scriptPath(p: string): string {
  const m = /(?:^|\/)((?:packages|scripts)\/.*)$/.exec(p);
  return m?.[1] ?? p;
}

export function shapeOf(cls: string, command: string): string {
  const t = command.trim().split(/\s+/);
  const wrappers: string[] = [];
  let i = 0;
  for (;;) {
    const w = t[i];
    if (w === "timeout") {
      wrappers.push("timeout");
      i++;
      while (t[i]?.startsWith("-")) i += TIMEOUT_ARG.has(t[i] ?? "") ? 2 : 1;
      i++; // the duration
    } else if (w !== undefined && basename(w) === "time") {
      wrappers.push("time");
      i++;
      while (t[i]?.startsWith("-")) i += TIME_ARG.has(t[i] ?? "") ? 2 : 1;
    } else if (w === "env") {
      // review r1: `env A=1 <cmd>` is a wrapper too; its assignments and options are not the program
      wrappers.push("env");
      i++;
      while (
        t[i] !== undefined &&
        (t[i]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i] ?? ""))
      )
        i++;
    } else break;
  }
  const exe = basename(t[i] ?? "");
  let program = exe;
  if (exe === "bun")
    program =
      t[i + 1] === "run" ? `bun run ${t[i + 2] ?? ""}` : `bun ${scriptPath(t[i + 1] ?? "")}`;
  else if (exe === "bash" || exe === "sh")
    // review r1: `bash -c <cmd>` keeps the command's first word, so unlike `bash -c` jobs do not merge
    program =
      t[i + 1] === "-c" ? `${exe} -c ${t[i + 2] ?? ""}` : `${exe} ${scriptPath(t[i + 1] ?? "")}`;
  const p = t.indexOf("--project", i);
  const project = p >= 0 ? (t[p + 1] ?? "") : "";
  return `${cls} | ${[...wrappers, program].join(" > ")} | ${project}`;
}

export interface Row {
  readonly started: string;
  readonly measuredGiB: number;
}

/** review r1: a job that exited non-zero within this many seconds died at its start (a bad flag, a missing tool); its tiny
 *  peak is no evidence of what the command needs. A long non-zero run (a DO window at its budget exits 7) still counts. */
export const FAILED_START_S = 60;

/** The ledger rows of the same shape that carry a measured peak (`?`, no sample, is left out, and so is a failed start). */
export function rowsOfShape(ledger: string, cls: string, command: string): Row[] {
  const want = shapeOf(cls, command);
  const out: Row[] = [];
  for (const line of ledger.split("\n")) {
    const f = line.split("\t");
    if (f.length < 9) continue;
    const [started, ended, , rowCls, , measured, rc, , cmd] = f;
    if (
      started === undefined ||
      rowCls === undefined ||
      measured === undefined ||
      cmd === undefined
    )
      continue;
    const m = Number(measured);
    if (measured === "?" || !Number.isFinite(m)) continue;
    const ranS = (Date.parse(ended ?? "") - Date.parse(started)) / 1000;
    if (rc !== "0" && !(ranS >= FAILED_START_S)) continue;
    if (shapeOf(rowCls, cmd) === want) out.push({ started, measuredGiB: m });
  }
  return out;
}

/** The advisory line, or undefined when there is nothing to say. */
export function advise(
  ledger: string,
  cls: string,
  declaredGiB: number,
  command: string,
): string | undefined {
  const rows = rowsOfShape(ledger, cls, command);
  if (rows.length < MIN_ROWS) return undefined;
  const largest = Math.max(...rows.map((r) => r.measuredGiB));
  if (!(declaredGiB > RATIO * largest)) return undefined;
  const dates = rows.map((r) => r.started).sort();
  const suggest = Math.max(1, Math.ceil(largest * 1.5));
  return (
    `heavy-slot: advisory (R1077): --peak ${declaredGiB} GiB is more than ${RATIO}x the largest measured peak ` +
    `(${largest.toFixed(2)} GiB) of ${rows.length} earlier job(s) of this shape [${shapeOf(cls, command)}], ` +
    `${dates[0]} to ${dates[dates.length - 1]}; a peak of about ${suggest} GiB would match them. Admission is unchanged.`
  );
}

if (import.meta.main) {
  // review r1: the command comes on STDIN, never as an argument. The guard's ps scan counts any process whose command line names
  // a corpus root as an unslotted heavy job (corpus-snapshot.ts, isHeavy); with the command in argv this helper would have been
  // one, and could have made another job's guard refuse it.
  const [dir, cls, declared] = process.argv.slice(2);
  if (dir === undefined || cls === undefined || declared === undefined) process.exit(0);
  const command = readFileSync(0, "utf8").replace(/\n$/, "");
  let ledger = "";
  try {
    ledger = readFileSync(join(dir, LEDGER), "utf8");
  } catch {
    process.exit(0); // no ledger yet: nothing to compare with
  }
  const line = advise(ledger, cls, Number(declared), command);
  if (line !== undefined) console.error(line);
}
