import { test as bunTest, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { outOfUseRefusal } from "../packages/runner/itest/out-of-use";

// scripts/r658-hang-gate.sh with fake kraken, bun, git and openssl on PATH and a temp coord root.
// Nothing here touches /coord. Linux only, like al-runner-update.test.ts.
const script = resolve(import.meta.dir, "r658-hang-gate.sh");
const test = process.platform === "win32" ? bunTest.skip : bunTest;
const LEASE = "12345678-aaaa-bbbb-cccc-1234567890ab";
const TARGET =
  "[itest target] config=lethal.config.bc2.json server=192.168.2.157:7149 odata=7148 api=7148";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "r658-hang-gate-"));
  const bin = join(root, "bin");
  const coord = join(root, "coord");
  const wt = join(root, "wt");
  const ev = join(root, "ev");
  const calls = join(root, "calls.log");
  const ownerSeen = join(root, "owner-seen");
  const markerSeen = join(root, "marker-seen");
  for (const d of [bin, join(coord, "machine"), wt]) mkdirSync(d, { recursive: true });
  const oou = join(coord, "machine", "out-of-use", "bc2.md");
  const fake = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`, {
      mode: 0o755,
    });
  fake("kraken", `case "$2" in lease) echo "leased bc2 token ${LEASE}" ;; esac; exit 0`);
  fake("git", `case "$1" in rev-parse) echo deadbeef ;; esac; exit 0`);
  fake("openssl", `od -An -tx1 -N16 /dev/urandom | tr -d ' \\n'`);
  // `bun -e ...` is the offline target check; `bun run itest:hang` is the gate.
  fake(
    "bun",
    `if [ "$1" = -e ]; then [ "\${FAKE_OFFLINE_FAIL:-}" = bare ] && exit 1; echo "${TARGET}"; [ -n "\${FAKE_OFFLINE_FAIL:-}" ] && exit 1; exit 0; fi
printf '%s' "\${LETHAL_OUT_OF_USE_OWNER:-}" > "${ownerSeen}"
cp "${oou}" "${markerSeen}" 2>/dev/null
echo "${TARGET}"
[ -n "\${FAKE_LEG:-}" ] && echo "$FAKE_LEG" > "$LETHAL_ITEST_HANG_LEG_STATE"
exit "\${FAKE_GATE:-0}"`,
  );
  const run = (env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bash", script, "bc2"], {
      env: {
        PATH: bin + delimiter + (process.env.PATH ?? ""),
        HOME: root,
        LETHAL_COORD_ROOT: coord,
        R658_EVIDENCE_DIR: ev,
        R658_WORKTREE: wt,
        R658_BEAT_SECS: "0.05",
        R658_HOLD_MAX_BEATS: "3",
        ...env,
      },
    });
    return { code: r.exitCode, out: r.stdout.toString() };
  };
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const log = () => read(calls);
  const ownerLines = (s: string) => s.split("\n").filter((l) => /^owner:/i.test(l.trim()));
  const leaseTxt = () => read(join(ev, "lease.txt"));
  const refusal = (owner: string) =>
    outOfUseRefusal("bc2", {
      dir: join(coord, "machine", "out-of-use"),
      env: { LETHAL_OUT_OF_USE_OWNER: owner },
      override: "owner",
      log: () => {},
    });
  return { run, log, read, oou, ownerSeen, markerSeen, ownerLines, leaseTxt, refusal };
}

test("an existing marker refuses with exit 2 before any lease", () => {
  const t = setup();
  mkdirSync(join(t.oou, ".."), { recursive: true });
  writeFileSync(t.oou, "# bc2 is OUT OF USE\n- **Reason:** STOP\n");
  const r = t.run();
  expect(r.code).toBe(2);
  expect(r.out).toContain(`refused: ${t.oou} exists`);
  expect(r.out).toContain("Reason:** STOP");
  expect(t.log()).not.toContain("kraken");
  expect(t.read(t.oou)).toBe("# bc2 is OUT OF USE\n- **Reason:** STOP\n");
});

// "bare": exit 1 with no line. "line": the matching target line, THEN exit 1, so only the exit
// status check stops it (the case match alone would pass it on to the lease).
for (const mode of ["bare", "line"])
  test(`a failing offline target check (${mode}) refuses with exit 2 before any lease`, () => {
    const t = setup();
    const r = t.run({ FAKE_OFFLINE_FAIL: mode });
    expect(r.code).toBe(2);
    expect(r.out).toContain("refused: the offline target check failed");
    expect(t.log()).toContain("bun -e");
    expect(t.log()).not.toContain("kraken");
    expect(existsSync(t.oou)).toBe(false);
  });

test("a missing <root>/machine refuses before any lease", () => {
  const t = setup();
  const r = t.run({ LETHAL_COORD_ROOT: join(tmpdir(), "r658-no-such-root") });
  expect(r.code).toBe(2);
  expect(r.out).toContain("does not exist");
  expect(t.log()).toBe("");
});

test("the in-use marker carries exactly one owner line, and the gate gets the same token; a pass removes the marker and releases", () => {
  const t = setup();
  const r = t.run({ FAKE_GATE: "0", FAKE_LEG: "passed" });
  expect(r.code).toBe(0);
  const inUse = t.read(t.markerSeen);
  expect(inUse).toContain("Reason:** in use by an R-658 itest:hang run");
  const owners = t.ownerLines(inUse);
  expect(owners.length).toBe(1);
  const m = /^owner: ([0-9a-f]{32})$/.exec(owners[0] ?? "");
  const token = m?.[1];
  expect(token).toBeDefined();
  expect(t.read(t.ownerSeen)).toBe(token ?? "missing");
  // the token never reaches stdout or lease.txt
  expect(r.out).not.toContain(token ?? "missing");
  expect(t.leaseTxt()).not.toContain(token ?? "missing");
  expect(t.log()).not.toContain(token ?? "missing");
  // clean pass
  expect(existsSync(t.oou)).toBe(false);
  expect(t.log()).toContain(`kraken coord release bc2 ${LEASE}`);
  expect(t.leaseTxt()).toContain("released bc2");
});

test("two runs get different owner tokens", () => {
  const a = setup();
  const b = setup();
  a.run({ FAKE_GATE: "0", FAKE_LEG: "passed" });
  b.run({ FAKE_GATE: "0", FAKE_LEG: "passed" });
  const ta = a.read(a.ownerSeen);
  const tb = b.read(b.ownerSeen);
  expect(ta).toMatch(/^[0-9a-f]{32}$/);
  expect(tb).toMatch(/^[0-9a-f]{32}$/);
  expect(ta).not.toBe(tb);
});

test("a STOP rewrites the marker with no owner line, the original token is refused, and the hold does not release", () => {
  const t = setup();
  const r = t.run({ FAKE_GATE: "5", FAKE_LEG: "stop" });
  expect(r.code).toBe(4); // the test cap ended the hold
  const token = t.read(t.ownerSeen);
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  // in use, the token passes R-669's reader ...
  expect(t.ownerLines(t.read(t.markerSeen)).length).toBe(1);
  // ... after the STOP it is refused
  const stop = t.read(t.oou);
  expect(stop).toContain("Reason:** STOP or hold: leg marker stop, gate exit 5");
  expect(t.ownerLines(stop)).toEqual([]);
  expect(stop).not.toContain(token);
  expect(t.refusal(token)).toContain("bc2 is OUT OF USE");
  expect(r.out).toContain("STOP: bc2 coord lease HELD");
  expect(r.out).not.toContain(token);
  expect(t.leaseTxt()).not.toContain(token);
  expect(t.log()).not.toContain("coord release");
  expect(t.log()).toContain(`kraken coord heartbeat bc2 ${LEASE}`);
});

test("the in-use marker passes R-669's reader with its own token (the other direction)", () => {
  const t = setup();
  t.run({ FAKE_GATE: "5", FAKE_LEG: "armed" });
  const token = t.read(t.ownerSeen);
  const inUse = t.read(t.markerSeen);
  writeFileSync(t.oou, inUse);
  expect(t.refusal(token)).toBeUndefined();
});

test("'released, believed clean' (exit 1, leg passed) leaves a marker with no owner line, and releases", () => {
  const t = setup();
  const r = t.run({ FAKE_GATE: "1", FAKE_LEG: "passed" });
  expect(r.code).toBe(1);
  const m = t.read(t.oou);
  expect(m).toContain("released, believed clean");
  expect(t.ownerLines(m)).toEqual([]);
  expect(t.refusal(t.read(t.ownerSeen))).toContain("bc2 is OUT OF USE");
  expect(t.log()).toContain(`kraken coord release bc2 ${LEASE}`);
});
