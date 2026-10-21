// R586: drive `alrunner serve` (al-runtime-rs) over its JSON-lines wire and log every line.
// Measures: ready line, runTests shape, warm reuse (`cached`/`incremental`), whether a changed AL
// source and a changed RESOURCE file (R222's selector channel) are seen, test selection and
// per-test coverage. Measurement tool only; works on a COPY of the probe projects.
// Usage: bun scripts/r586-probe/serve-probe.ts <alrunner> <out dir>
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [alrunner, out] = process.argv.slice(2);
if (alrunner === undefined || out === undefined)
  throw new Error("usage: serve-probe.ts <alrunner> <out>");
const here = import.meta.dir;
const work = join(out, "serve-work");
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await cp(join(here, "probe-app"), join(work, "probe-app"), { recursive: true });
await cp(join(here, "probe-tests"), join(work, "probe-tests"), { recursive: true });
const app = join(work, "probe-app");
const tst = join(work, "probe-tests");
const log: string[] = [];
const note = (s: string) => {
  log.push(s);
  console.log(s);
};

const proc = Bun.spawn([alrunner, "serve", "--test-timeout", "3", "--define", "LETHALA"], {
  cwd: work,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, ALRUNNER_CACHE: "/work/tools/al-runtime-rs/cache" },
});
const reader = proc.stdout.getReader();
let buf = "";
async function nextLine(): Promise<string> {
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      return line;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("serve closed stdout");
    buf += new TextDecoder().decode(value);
  }
}
async function request(
  label: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const t0 = performance.now();
  proc.stdin.write(`${JSON.stringify(body)}\n`);
  proc.stdin.flush();
  const lines: Record<string, unknown>[] = [];
  for (;;) {
    const raw = await nextLine();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    lines.push(obj);
    if (
      obj.type === "summary" ||
      obj.error !== undefined ||
      (obj.status !== undefined && obj.type === undefined)
    )
      break;
  }
  const ms = Math.round(performance.now() - t0);
  note(`### ${label} (${ms} ms) request=${JSON.stringify(body)}`);
  for (const l of lines) {
    const { coverage, perTestCoverage, ...rest } = l as Record<string, unknown>;
    note(
      `  ${JSON.stringify(rest)}${coverage !== undefined ? " +coverage" : ""}${perTestCoverage !== undefined ? ` +perTestCoverage=${JSON.stringify(perTestCoverage)}` : ""}`,
    );
  }
  return lines;
}

note(`ready line: ${await nextLine()}`);
const base = { command: "runTests", sourcePaths: [app, tst], testIsolation: "test" };
await request("1 first", { ...base, test: "Codeunit50650.ResourceIs" });
await request("2 repeat unchanged", { ...base, test: "Codeunit50650.ResourceIs" });
await writeFile(join(app, "ProbeResources", "active.txt"), "M0002", "utf8");
await request("3 resource file changed to M0002", { ...base, test: "Codeunit50650.ResourceIs" });
await request("4 define LETHALA (daemon-wide)", { ...base, test: "Codeunit50650.ArmIs" });
const logic = join(app, "src", "ProbeLogic.Codeunit.al");
const src = await readFile(logic, "utf8");
await writeFile(logic, src.replace("exit(A + B);", "exit(A - B);"), "utf8");
await request("5 source changed (Add mutated to A - B)", { ...base, test: "Codeunit50650.Passes" });
await writeFile(logic, src, "utf8");
await request("6 source restored", { ...base, test: "Codeunit50650.Passes" });
await request("7 exclude sibling", {
  ...base,
  test: "Codeunit50650.Passes",
  excludeTests: ["Codeunit50650.PassesToo"],
});
await request("8 quoted name", { ...base, test: "Codeunit50650.Space Step" });
await request("9 per-test coverage", {
  ...base,
  test: "Codeunit50652.",
  coverage: true,
  perTestCoverage: true,
});
await request("10 hang under daemon --test-timeout 3", { ...base, test: "Codeunit50651.CpuHang" });
await request("11 unknown field", { ...base, bogus: 1 });
await request("12 whole suite, no selection", { ...base });
proc.stdin.write(`${JSON.stringify({ command: "shutdown" })}\n`);
proc.stdin.flush();
note(`shutdown answer: ${await nextLine()}`);
note(`exit: ${await proc.exited}`);
note(`stderr:\n${await new Response(proc.stderr).text()}`);
await writeFile(join(out, "serve-probe.log"), `${log.join("\n")}\n`, "utf8");
