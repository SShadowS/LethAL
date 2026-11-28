// PR-479: a FAKE bcdev-client sidecar. It speaks the real driver's protocol (see src/client-driver.ts) and can misbehave.
// Usage: bun fake-client-driver.ts <mode> <logFile>. Every stdin line it receives is appended to <logFile>.
// It touches no server and reads no login.
import { appendFileSync } from "node:fs";

const [mode = "ok", logFile = ""] = process.argv.slice(2);
const lines: string[] = [];
let wake: (() => void) | undefined;
let closed = false;
void (async () => {
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of Bun.stdin.stream()) {
    rest += dec.decode(chunk, { stream: true });
    for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
      const l = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (logFile !== "") appendFileSync(logFile, `${l}\n`);
      lines.push(l);
      wake?.();
    }
  }
  closed = true;
  wake?.();
})();

async function read(): Promise<string> {
  while (lines.length === 0) {
    if (closed) process.exit(7);
    await new Promise<void>((r) => {
      wake = r;
    });
  }
  return lines.shift() ?? "";
}
const out = (step: string, ok: boolean, detail?: unknown) =>
  console.log(JSON.stringify({ step, ok, ms: 1, ...(detail !== undefined ? { detail } : {}) }));
const fail = (error: string, message: string, code: number): never => {
  out("error", false, { error, message });
  process.exit(code);
};
async function waitGo(go: string): Promise<void> {
  const l = JSON.parse(await read()) as { go?: string };
  if (l.go !== go) fail("unexpected-go", `wanted ${go}, got ${JSON.stringify(l)}`, 3);
}

await read(); // the command
if (mode === "bad-json") {
  console.log("this is not json");
  await Bun.sleep(100);
  process.exit(0);
}
if (mode === "die-before-opened") {
  console.error("first-chance System.IO.FileNotFoundException: System.ServiceModel");
  process.exit(9);
}
if (mode === "bad-command") fail("bad-command", "webClientBaseUrl", 5);
if (mode === "stall-open") await Bun.sleep(60_000);
if (mode === "open-session-error") fail("session-error", "open session: session state InError", 6);
out("opened", true, { companyParameter: { reflectedProperties: [], via: "url-query" } });
// The read-back refusals come BEFORE ready and before go:bind: no op exists yet, so nothing wedges.
if (mode === "wrong-company")
  fail("company-mismatch", "CurrentCompanyName reads OTHER, wanted CRONUS", 3);
if (mode === "run-false") fail("run-flag-false", "Run is not set on: M2", 3);
if (mode === "missing-row")
  fail("methods-mismatch", "page lines [M1] differ from declared [M1, M2]", 3);
if (mode === "missing-control")
  fail("control-missing", "control 'CurrentCompanyName' not on 'Test Tool'", 3);
out("readback", true, { methods: ["M1", "M2"] });
out("ready", true);
await waitGo("bind");
if (mode === "bind-refused") fail("bind-refused", "Bound=No, Reason=not registered", 3);
out("bound", true, { bound: "Yes", reason: "" });
if (mode === "stall-before-ran") await Bun.sleep(60_000);
if (mode === "driver-deadline") fail("deadline", "no 'All tests executed.' within 1s", 4);
const M1 = '{"name":"M1","result":"Success"}';
const M2 = '{"name":"M2","result":"Success"}';
const M2_FAIL = '{"name":"M2","result":"Failure","message":"Assert.AreEqual failed"}';
const ON_RUN = '{"name":"OnRun","result":"Success"}';
const results: Record<string, string[]> = {
  "fail-m2": [M1, M2_FAIL],
  "empty-results": [],
  onrun: [ON_RUN, M1, M2],
};
out("ran", true, { results: results[mode] ?? [M1, M2] });
await waitGo("end");
out("ended", true, { ended: "Yes", reason: "" });
if (mode === "chatty-after-end") {
  out("closed", true, { state: "Closed", ended: true });
  await Bun.sleep(5000);
  process.exit(0);
}
await waitGo("close");
out("closed", true, { state: "Closed", ended: true });
process.exit(0);
