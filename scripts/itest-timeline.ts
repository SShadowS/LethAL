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
 * `legs` cuts the log at the al-runner gate's leg-end markers (ALRUNNER_LEGS). The gate runs its
 * legs one after another, so a leg starts where the previous one ended.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Proc {
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
        // By executable, not by any mention: the bun command line names `al-runner.itest.ts`.
        alRunnerProcs: procs.filter((p) =>
          /(^|\/)(al-runner|dotnet)$/.test(p.cmd.split(" ")[0] ?? ""),
        ).length,
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

/** One leg of the al-runner gate: the marker that its END prints, and the how-many-th match. */
interface LegMarker {
  readonly leg: string;
  readonly pattern: RegExp;
  readonly nth: number;
}

/** Leg-end markers of `al-runner.itest.ts`, in run order (the table each leg prints when it ends). */
export const ALRUNNER_LEGS: readonly LegMarker[] = [
  { leg: "sandbox A one-shot", pattern: /^ {2}verdicts: killed=/, nth: 1 },
  { leg: "sandbox B one-shot (determinism)", pattern: /^ {2}verdicts: killed=/, nth: 2 },
  { leg: "sandbox C --server", pattern: /^ {2}verdicts: killed=/, nth: 3 },
  { leg: "sandbox D resource", pattern: /^ {2}verdicts: killed=/, nth: 4 },
  { leg: "layout one-shot", pattern: /^ {2}R353 layout one-shot:/, nth: 1 },
  { leg: "layout --server", pattern: /^ {2}R353 layout --server:/, nth: 1 },
  { leg: "multiobject one-shot", pattern: /^ {2}R407 multi-object one-shot:/, nth: 1 },
  { leg: "multiobject --server", pattern: /^ {2}R407 multi-object --server:/, nth: 1 },
  { leg: "multiobject resource", pattern: /^ {2}R407 multi-object --server \+ resource:/, nth: 1 },
  { leg: "wrapped one-shot", pattern: /^ {2}R-300b wrapped one-shot:/, nth: 1 },
  { leg: "wrapped --server", pattern: /^ {2}R-300b wrapped --server:/, nth: 1 },
  { leg: "wrapped resource", pattern: /^ {2}R-300b wrapped resource:/, nth: 1 },
  { leg: "names A1 one-shot al-runner", pattern: /^ {2}R557 names A1-/, nth: 1 },
  { leg: "names A2 one-shot none", pattern: /^ {2}R557 names A2-/, nth: 1 },
  { leg: "names A3 server al-runner", pattern: /^ {2}R557 names A3-/, nth: 1 },
  { leg: "names A4 server none", pattern: /^ {2}R557 names A4-/, nth: 1 },
  { leg: "symbols LETHALA one-shot", pattern: /^ {4}one-shot \[LETHALA\] /, nth: 1 },
  { leg: "symbols LETHALA --server", pattern: /^ {4}--server \[LETHALA\] /, nth: 1 },
  { leg: "symbols LETHALA resource", pattern: /^ {4}resource \[LETHALA\] /, nth: 1 },
  { leg: "symbols LETHALB one-shot", pattern: /^ {4}one-shot \[LETHALB\] /, nth: 1 },
  { leg: "symbols LETHALB --server", pattern: /^ {4}--server \[LETHALB\] /, nth: 1 },
  { leg: "symbols LETHALB resource", pattern: /^ {4}resource \[LETHALB\] /, nth: 1 },
  { leg: "cli-default (buildBackend)", pattern: /^ {2}cli-default leg: killed=/, nth: 1 },
];

interface LogLine {
  readonly elapsed: number;
  readonly text: string;
}

/** The elapsed time each leg ENDED at, or undefined where its marker never printed. */
export function legEnds(
  lines: readonly LogLine[],
  legs: readonly LegMarker[],
): (number | undefined)[] {
  return legs.map((m) => lines.filter((l) => m.pattern.test(l.text))[m.nth - 1]?.elapsed);
}

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
          alRunnerProcs: number;
        },
    );
  const ends = legEnds(lines, ALRUNNER_LEGS);
  const mb = (kb: number) => Math.round(kb / 1024);
  const rows = [
    "| # | leg | start s | end s | wall s | peak tree RSS MB | peak tree PSS MB | max al-runner procs |",
    "|---|---|---|---|---|---|---|---|",
  ];
  let start = lines.find((l) => l.text.includes("al-runner build under test"))?.elapsed ?? 0;
  ALRUNNER_LEGS.forEach((m, i) => {
    const end = ends[i];
    if (end === undefined) {
      rows.push(`| ${i + 1} | ${m.leg} | ${start.toFixed(0)} | (no marker) | | | | |`);
      return;
    }
    const inLeg = samples.filter((s) => s.elapsed >= start && s.elapsed <= end);
    const peak = (k: "treeRssKb" | "treePssKb") => mb(Math.max(0, ...inLeg.map((s) => s[k])));
    rows.push(
      `| ${i + 1} | ${m.leg} | ${start.toFixed(0)} | ${end.toFixed(0)} | ${(end - start).toFixed(0)} | ${peak("treeRssKb")} | ${peak("treePssKb")} | ${Math.max(0, ...inLeg.map((s) => s.alRunnerProcs))} |`,
    );
    start = end;
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
