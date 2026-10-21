#!/usr/bin/env bun
/**
 * R-587: run a gate with every output line timestamped, and sample the memory of its WHOLE process
 * tree (bun plus every al-runner / dotnet child) every few seconds. Linux only (reads /proc).
 *
 *   bun scripts/itest-timeline.ts run <outDir> [--every <s>] -- <command> [args...]
 *   bun scripts/itest-timeline.ts legs <outDir>        # al-runner gate: per-leg time and peak
 *
 * `run` writes, as it goes, so a killed session leaves evidence behind:
 *   <outDir>/log.txt         `<elapsed s> <ISO time> <out|err> <line>` per output line
 *   <outDir>/samples.ndjson  one JSON object per sample: tree RSS and PSS sums, and every process
 *
 * RSS summed over a tree counts shared pages once per process, so it overstates; PSS (from
 * /proc/<pid>/smaps_rollup) splits shared pages and its sum is the better "how much does this tree
 * cost" number. Both are recorded. A short-lived child that starts and ends between two samples is
 * missed: the figures are a lower bound on the true peak.
 *
 * `legs` cuts the log at each leg's own `leg <id>: start` and `leg <id>: done in <s>s` lines
 * (R-587 M5), so it reads a sequential run and a `--parallel` run alike. In a parallel run a leg's
 * memory is the subtree of its group's `--worker` process, not the whole tree.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
  readonly pssKb: number;
  readonly cmd: string;
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined; // the process exited between listing and reading
  }
}

/** Every live descendant of `root`, `root` included. */
export function processTree(root: number): Proc[] {
  const parent = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid)) continue;
    const stat = readOr(`/proc/${pid}/stat`);
    if (stat === undefined) continue;
    // `pid (comm) state ppid ...`; comm may hold spaces and parens, so split after the LAST ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    parent.set(pid, Number(fields[1]));
  }
  const inTree = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent) {
      if (!inTree.has(pid) && inTree.has(ppid)) {
        inTree.add(pid);
        grew = true;
      }
    }
  }
  const out: Proc[] = [];
  for (const pid of inTree) {
    const status = readOr(`/proc/${pid}/status`);
    if (status === undefined) continue;
    const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    const pssKb = Number(
      /^Pss:\s+(\d+)/m.exec(readOr(`/proc/${pid}/smaps_rollup`) ?? "")?.[1] ?? 0,
    );
    const cmd = (readOr(`/proc/${pid}/cmdline`) ?? "").split("\0").join(" ").trim().slice(0, 300);
    out.push({ pid, ppid: parent.get(pid) ?? 0, rssKb, pssKb, cmd });
  }
  return out;
}

async function run(outDir: string, everyS: number, argv: string[]): Promise<number> {
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, "log.txt");
  const samplesPath = join(outDir, "samples.ndjson");
  writeFileSync(logPath, "");
  writeFileSync(samplesPath, "");
  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)} ${new Date().toISOString()}`;
  appendFileSync(logPath, `${stamp()} meta start ${JSON.stringify(argv)} cwd=${process.cwd()}\n`);

  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const pump = async (stream: ReadableStream<Uint8Array>, tag: "out" | "err") => {
    const decoder = new TextDecoder();
    let rest = "";
    const emit = (line: string) => {
      appendFileSync(logPath, `${stamp()} ${tag} ${line}\n`);
      (tag === "out" ? process.stdout : process.stderr).write(`${line}\n`);
    };
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) emit(line);
    }
    if (rest !== "") emit(rest);
  };

  const sample = () => {
    const procs = processTree(child.pid);
    const sum = (k: "rssKb" | "pssKb") => procs.reduce((n, p) => n + p[k], 0);
    const anon = /^anon (\d+)/m.exec(readOr("/sys/fs/cgroup/memory.stat") ?? "")?.[1];
    appendFileSync(
      samplesPath,
      `${JSON.stringify({
        elapsed: (Date.now() - t0) / 1000,
        time: new Date().toISOString(),
        treeRssKb: sum("rssKb"),
        treePssKb: sum("pssKb"),
        alRunnerProcs: procs.filter(isAlRunner).length,
        ...(anon !== undefined ? { cgroupAnonKb: Math.round(Number(anon) / 1024) } : {}),
        procs,
      })}\n`,
    );
  };
  sample();
  const timer = setInterval(sample, everyS * 1000);
  await Promise.all([pump(child.stdout, "out"), pump(child.stderr, "err"), child.exited]);
  clearInterval(timer);
  appendFileSync(logPath, `${stamp()} meta exit ${child.exitCode}\n`);
  return child.exitCode ?? 1;
}

export interface LogLine {
  readonly elapsed: number;
  readonly text: string;
}

/** One leg's window, from its own `leg <id>: start` and `leg <id>: done in <s>s` lines (M5). */
export interface LegWindow {
  readonly leg: string;
  /** The `[<group>] ` prefix a `--parallel` supervisor puts on its workers' lines. */
  readonly group?: string;
  readonly start: number;
  /** Absent when the leg never printed its done line (it failed, or the run was cut). */
  end?: number;
}

const MARKER = /^(?:\[([\w-]+)\] )?leg ([\w-]+): (start|done in )/;

/** Every leg window in the log, in start order. Works for a sequential and a parallel run. */
export function legWindows(lines: readonly LogLine[]): LegWindow[] {
  const out: LegWindow[] = [];
  for (const l of lines) {
    const m = MARKER.exec(l.text);
    if (m === null) continue;
    const [, group, leg = "", what] = m;
    if (what === "start") {
      out.push({ leg, ...(group !== undefined ? { group } : {}), start: l.elapsed });
    } else {
      const open = out.findLast((w) => w.leg === leg && w.end === undefined);
      if (open !== undefined) open.end = l.elapsed;
    }
  }
  return out;
}

/**
 * The processes a leg owns in one sample: the subtree of its group's `--worker` process in a
 * parallel run, or every process in a sequential one (no group).
 */
export function legProcs(procs: readonly Proc[], group: string | undefined): Proc[] {
  if (group === undefined) return [...procs];
  const worker = procs.find((p) => new RegExp(`--worker --legs ${group}(\\s|$)`).test(p.cmd));
  if (worker === undefined) return [];
  const inTree = new Set([worker.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!inTree.has(p.pid) && inTree.has(p.ppid)) {
        inTree.add(p.pid);
        grew = true;
      }
    }
  }
  return procs.filter((p) => inTree.has(p.pid));
}

/** By executable, not by any mention: the bun command line names `al-runner.itest.ts`. */
const isAlRunner = (p: Proc) => /(^|\/)(al-runner|dotnet)$/.test(p.cmd.split(" ")[0] ?? "");

function legs(outDir: string): void {
  const lines: LogLine[] = readFileSync(join(outDir, "log.txt"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [elapsed = "0", , , ...rest] = l.split(" ");
      return { elapsed: Number(elapsed), text: rest.join(" ") };
    });
  const samples = readFileSync(join(outDir, "samples.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map(
      (l) =>
        JSON.parse(l) as {
          elapsed: number;
          treeRssKb: number;
          treePssKb: number;
          procs: Proc[];
        },
    );
  const mb = (kb: number) => Math.round(kb / 1024);
  const rows = [
    "| # | leg | group | start s | end s | wall s | peak RSS MB | peak PSS MB | max al-runner procs |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  legWindows(lines).forEach((w, i) => {
    const g = w.group ?? "";
    if (w.end === undefined) {
      rows.push(`| ${i + 1} | ${w.leg} | ${g} | ${w.start.toFixed(0)} | (no done line) | | | | |`);
      return;
    }
    const end = w.end;
    const owned = samples
      .filter((s) => s.elapsed >= w.start && s.elapsed <= end)
      .map((s) => legProcs(s.procs, w.group));
    const peak = (k: "rssKb" | "pssKb") =>
      mb(Math.max(0, ...owned.map((ps) => ps.reduce((n, p) => n + p[k], 0))));
    rows.push(
      `| ${i + 1} | ${w.leg} | ${g} | ${w.start.toFixed(0)} | ${end.toFixed(0)} | ${(end - w.start).toFixed(0)} | ${peak("rssKb")} | ${peak("pssKb")} | ${Math.max(0, ...owned.map((ps) => ps.filter(isAlRunner).length))} |`,
    );
  });
  const last = lines.at(-1);
  rows.push(
    "",
    `whole run: ${last?.elapsed.toFixed(0)} s; ${samples.length} samples; overall peak tree RSS ${mb(Math.max(0, ...samples.map((s) => s.treeRssKb)))} MB, PSS ${mb(Math.max(0, ...samples.map((s) => s.treePssKb)))} MB; last line: ${last?.text}`,
  );
  const table = rows.join("\n");
  writeFileSync(join(outDir, "legs.md"), `${table}\n`);
  console.log(table);
}

if (import.meta.main) {
  const [mode, outDir, ...rest] = process.argv.slice(2);
  if (mode === "run" && outDir !== undefined) {
    const dash = rest.indexOf("--");
    const everyIdx = rest.indexOf("--every");
    const every = everyIdx >= 0 && everyIdx < dash ? Number(rest[everyIdx + 1]) : 5;
    if (dash < 0 || dash === rest.length - 1)
      throw new Error("usage: itest-timeline.ts run <outDir> [--every <s>] -- <command...>");
    process.exit(await run(outDir, every, rest.slice(dash + 1)));
  } else if (mode === "legs" && outDir !== undefined) {
    legs(outDir);
  } else {
    throw new Error(
      "usage: itest-timeline.ts run <outDir> [--every <s>] -- <command...> | legs <outDir>",
    );
  }
}
