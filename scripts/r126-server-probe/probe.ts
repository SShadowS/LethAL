/**
 * R126 probe: is ONE al-runner server call per MUTANT actually possible, and does it pay?
 *
 * R126 says server mode "only pays if the backend can make ONE call per MUTANT instead of one per
 * TEST", and that the first deliverable is whether that condition holds. Three things decide it,
 * and none had been measured:
 *
 *   1. Does a warm server RE-READ the source bundle on every request? LethAL activates a mutant by
 *      REWRITING `MutationSelector.Codeunit.al` in the source dir (`AlRunnerBackend.activate`). If
 *      the server compiles once and serves a cached module afterwards, then every mutant after the
 *      first would be scored against the FIRST mutant's code — a silent wrong-verdict machine, and
 *      the single most dangerous thing this protocol could do.
 *   2. What does one warm whole-suite call cost after a source change, against the CLI's cost for
 *      the same work?
 *   3. Does the protocol expose isolation at all?
 *
 * Read-only with respect to the repo: it copies the fixture into a scratch directory and mutates
 * only that copy. It needs al-runner's artifacts already cached (`--server` has no
 * `--auto-provision`), which is what the CLI warm-up step below guarantees.
 *
 *   bun scripts/r126-server-probe/probe.ts <scratch-dir> [al-runner path]
 *
 * `<scratch-dir>` must already hold `app/` and `tests/` copies of `fixtures/sandbox-app` and
 * `fixtures/sandbox-tests`.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const scratch = process.argv[2];
const alRunner = process.argv[3] ?? "C:/Users/SShadowS/.dotnet/tools/al-runner.exe";
if (scratch === undefined) {
  console.error("usage: bun scripts/r126-server-probe/probe.ts <scratch-dir> [al-runner path]");
  process.exit(2);
}
const appDir = join(scratch, "app");
const testDir = join(scratch, "tests");
const logicFile = join(appDir, "src", "SandboxLogic.Codeunit.al");

interface ServerLine {
  readonly type?: string;
  readonly ready?: boolean;
  readonly error?: string;
  readonly name?: string;
  readonly status?: string;
  readonly total?: number;
  readonly passed?: number;
  readonly failed?: number;
  readonly cached?: boolean;
  readonly protocolVersion?: number;
}

/** One request/response round-trip against a resident server, timed. */
class Server {
  private readonly child = spawn(alRunner, ["--server"], { stdio: ["pipe", "pipe", "pipe"] });
  private buffer = "";
  private waiters: ((line: ServerLine) => void)[] = [];
  readonly stderr: string[] = [];

  constructor() {
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line !== "") {
          const parsed = JSON.parse(line) as ServerLine;
          const waiter = this.waiters.shift();
          if (waiter !== undefined) waiter(parsed);
        }
        nl = this.buffer.indexOf("\n");
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr.push(chunk);
    });
  }

  nextLine(): Promise<ServerLine> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Send one request and collect lines until the `summary` line (or an `error`). */
  async request(payload: Record<string, unknown>): Promise<{
    readonly lines: ServerLine[];
    readonly elapsedMs: number;
  }> {
    const started = Date.now();
    const lines: ServerLine[] = [];
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    for (;;) {
      const line = await this.nextLine();
      lines.push(line);
      if (line.type === "summary" || line.error !== undefined) break;
    }
    return { lines, elapsedMs: Date.now() - started };
  }

  kill(): void {
    this.child.kill();
  }
}

function summaryOf(lines: readonly ServerLine[]): ServerLine | undefined {
  return lines.find((l) => l.type === "summary");
}

const server = new Server();
try {
  const ready = await server.nextLine();
  console.log(`ready line: ${JSON.stringify(ready)}`);

  // 1. First warm request — the AL-output cache is already hot from the CLI warm-up.
  const first = await server.request({ command: "runTests", sourcePaths: [appDir, testDir] });
  console.log(
    `request 1 (unchanged sources): ${first.elapsedMs} ms, summary ${JSON.stringify(summaryOf(first.lines))}`,
  );

  // 2. Change a SOURCE file the way `activate()` does, then ask again. The verdict must change:
  //    `IsOverBudget` becomes `>=`, which `OverBudgetDetected` asserts against ("equal amounts must
  //    not be over budget"), so the verdict MUST flip to fail. A server that still answers "pass"
  //    here is serving a stale module, and one call per mutant would score every mutant against
  //    whichever one happened to compile first.
  const original = await readFile(logicFile, "utf8");
  const mutated = original.replace("exit(Amount > Budget);", "exit(Amount >= Budget);");
  if (mutated === original) {
    throw new Error(
      `probe fixture drift: could not find the IsOverBudget comparison in ${logicFile}; edit the probe rather than trusting its answer`,
    );
  }
  await writeFile(logicFile, mutated, "utf8");
  const second = await server.request({ command: "runTests", sourcePaths: [appDir, testDir] });
  console.log(
    `request 2 (source CHANGED): ${second.elapsedMs} ms, summary ${JSON.stringify(summaryOf(second.lines))}`,
  );
  for (const l of second.lines.filter((x) => x.type === "test")) {
    console.log(`   ${l.name}: ${l.status}`);
  }

  // 3. Restore, ask again: the verdict must come back. Proves the change in 2 was the source and
  //    not a one-way state change inside the server.
  await writeFile(logicFile, original, "utf8");
  const third = await server.request({ command: "runTests", sourcePaths: [appDir, testDir] });
  console.log(
    `request 3 (source RESTORED): ${third.elapsedMs} ms, summary ${JSON.stringify(summaryOf(third.lines))}`,
  );

  // 4. Does the protocol take an isolation setting, or a field that forces a RELOAD? Guessed field
  //    names cannot prove absence, but they are what a caller has — the same method R97 used for
  //    the missing test filter. The reload candidates are sent while the source is MUTATED, so a
  //    field that works announces itself by flipping the verdict to fail.
  await writeFile(logicFile, mutated, "utf8");
  for (const [field, value] of [
    ["isolation", "test"],
    ["testIsolation", "test"],
    ["isolationMode", "test"],
    ["noCache", true],
    ["reload", true],
    ["forceRebuild", true],
    ["rebuild", true],
    ["invalidate", true],
  ] as const) {
    const res = await server.request({
      command: "runTests",
      sourcePaths: [appDir, testDir],
      [field]: value,
    });
    const sum = summaryOf(res.lines);
    console.log(`field ${field}=${String(value)}: failed=${sum?.failed} ${JSON.stringify(sum)}`);
  }
  await writeFile(logicFile, original, "utf8");

  // 5. An unknown command still answers rather than dying — the R97 shape, re-checked.
  const bogus = await server.request({ command: "bogusCommand" });
  console.log(`unknown command: ${JSON.stringify(bogus.lines[0])}`);
} finally {
  server.kill();
}

// 6. The control for step 2. Mutate the source FIRST, then start a FRESH server and ask once. If
//    this one reports the failure that step 2 missed, the staleness is a property of a RESIDENT
//    server rather than of the mutation, the fixture, or the AL-output cache — which is the
//    difference between "al-runner cannot see this edit" and "a warm server does not act on it".
{
  const original = await readFile(logicFile, "utf8");
  await writeFile(
    logicFile,
    original.replace("exit(Amount > Budget);", "exit(Amount >= Budget);"),
    "utf8",
  );
  const fresh = new Server();
  try {
    console.log(`
fresh server, sources ALREADY mutated: ${JSON.stringify(await fresh.nextLine())}`);
    const res = await fresh.request({ command: "runTests", sourcePaths: [appDir, testDir] });
    console.log(`   ${res.elapsedMs} ms, summary ${JSON.stringify(summaryOf(res.lines))}`);
    for (const l of res.lines.filter((x) => x.type === "test")) {
      console.log(`   ${l.name}: ${l.status}`);
    }
    // And now RESTORE while this server is resident, and ask again: if it keeps reporting the
    // mutated verdict, the staleness is symmetric and the first answer a resident server gives is
    // the only one it will ever give for that bundle.
    await writeFile(logicFile, original, "utf8");
    const after = await fresh.request({ command: "runTests", sourcePaths: [appDir, testDir] });
    console.log(`   after RESTORE: summary ${JSON.stringify(summaryOf(after.lines))}`);
    for (const l of after.lines.filter((x) => x.type === "test")) {
      console.log(`   ${l.name}: ${l.status}`);
    }
  } finally {
    fresh.kill();
    await writeFile(logicFile, original, "utf8");
  }
}
