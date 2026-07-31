#!/usr/bin/env bun
/**
 * PostToolUse(Edit|Write) hook: after touching `extensions/lethal-control/**`, say what is now
 * stale — and check the version lockstep while we are here.
 *
 * TWO failure modes, both observed, both landing minutes later and pointing somewhere unhelpful:
 *
 * 1. STALE ARTIFACT. `extensions/lethal-control/lethal-control.app` is gitignored — a LOCAL build
 *    every machine makes for itself, which no pull refreshes. Editing the AL does not rebuild it,
 *    and the runner publishes whatever `.app` is on disk. So the source says one thing and the
 *    container runs another, and the first symptom is a live gate refusing, or worse, passing
 *    against an older build.
 *
 * 2. BROKEN LOCKSTEP. `MIN_CONTROL_VERSION` (packages/runner/src/harness.ts) must equal
 *    `app.json`'s `version` — a test pins it (R28), but that test runs when someone runs the suite,
 *    whereas this fires at the edit. Raising the minimum without bumping app.json makes a FRESHLY
 *    BUILT control app fail its own gate, which reads as an unfixable error.
 *
 * ADVISORY (exit 0), unlike `compile-fixtures-touched.ts` which blocks. The difference is
 * deliberate: a broken fixture makes a gate lie, while a stale control app makes a gate REFUSE with
 * an accurate message naming the fix. Refusing an edit here would also make routine AL work
 * (comments, doc changes) needlessly painful.
 *
 * Exits 0 always.
 */
let raw = "";
try {
  raw = await Bun.stdin.text();
} catch {
  process.exit(0);
}

let file = "";
try {
  file = (JSON.parse(raw)?.tool_input?.file_path ?? "") as string;
} catch {
  process.exit(0);
}

const normalized = file.replace(/\\/g, "/");
if (!/\/extensions\/lethal-control\//i.test(normalized)) process.exit(0);
// Only source and manifest matter — a README edit changes nothing about what is deployed.
if (!/\.(al|json)$/i.test(normalized)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

async function readText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

const notes: string[] = [
  `${normalized} changed — extensions/lethal-control/lethal-control.app is now STALE.`,
  "It is gitignored (a local build), and the runner publishes whatever .app is on disk, so the",
  "container will keep running the previous build until it is rebuilt AND republished. Use",
  "/control-app, or expect a live gate to refuse with a version mismatch.",
];

// Lockstep check — only when app.json's version is readable; never guess.
const appJson = await readText(`${root}/extensions/lethal-control/app.json`);
const harness = await readText(`${root}/packages/runner/src/harness.ts`);
const appVersion = /"version"\s*:\s*"([^"]+)"/.exec(appJson)?.[1];
const minVersion = /MIN_CONTROL_VERSION\s*=\s*"([^"]+)"/.exec(harness)?.[1];

if (appVersion !== undefined && minVersion !== undefined && appVersion !== minVersion) {
  notes.push(
    "",
    `LOCKSTEP BROKEN: app.json version is ${appVersion}, MIN_CONTROL_VERSION is ${minVersion}.`,
    "These are pinned equal by a test (R28). Bumping one without the other either makes a freshly",
    "built control app fail its own gate (minimum ahead), or lets a stale build pass unnoticed",
    "(minimum behind). Update packages/runner/src/harness.ts to match.",
  );
}

console.error(notes.join("\n"));
process.exit(0);
