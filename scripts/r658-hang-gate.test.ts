import { test as bunTest, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { outOfUseRefusal } from "../packages/runner/itest/out-of-use";

// scripts/r658-hang-gate.sh with fake kraken, bun, git and openssl on PATH and a temp coord root.
// Nothing here touches /coord. Linux only, like al-runner-update.test.ts.
const script = resolve(import.meta.dir, "r658-hang-gate.sh");
const outOfUseModule = resolve(import.meta.dir, "../packages/runner/itest/out-of-use.ts");
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
  // Every fake but the gate logs the owner env it inherited, so a leak to any other child shows.
  const envTag = "owner-env=${LETHAL_OUT_OF_USE_OWNER:-}";
  const fake = (name: string, body: string, tag = envTag) =>
    writeFileSync(
      join(bin, name),
      `#!/bin/bash\necho "${name} $* ${tag}" >> "${calls}"\n${body}\n`,
      { mode: 0o755 },
    );
  // FAKE_RACE: the lease call writes a marker, as another session could between (a) and the write.
  fake(
    "kraken",
    `case "$2" in lease) [ -n "\${FAKE_RACE:-}" ] && printf '%s' "$FAKE_RACE" > "${oou}"; echo "leased bc2 token ${LEASE}" ;; esac; exit 0`,
  );
  fake("git", `case "$1" in rev-parse) echo deadbeef ;; esac; exit 0`);
  fake("openssl", `od -An -tx1 -N16 /dev/urandom | tr -d ' \\n'`);
  // `bun -e ...` is the offline target check; `bun run itest:hang` is the gate. The gate runs R-669's
  // real check with the real bun, which logs the marker body to stderr as printItestTarget does.
  const check = `import { outOfUseRefusal } from ${JSON.stringify(outOfUseModule)}; const r = outOfUseRefusal("bc2", { dir: ${JSON.stringify(join(coord, "machine", "out-of-use"))}, env: process.env, override: "owner" }); if (r) { console.error(r); process.exit(1); }`;
  fake(
    "bun",
    `case "$1" in *bc-host.ts) exec ${JSON.stringify(process.execPath)} "$@" ;; esac
if [ "$1" = -e ]; then echo "bun-e ${envTag}" >> "${calls}"; [ "\${FAKE_OFFLINE_FAIL:-}" = bare ] && exit 1; echo "\${FAKE_TARGET:-${TARGET}}"; [ -n "\${FAKE_OFFLINE_FAIL:-}" ] && exit 1; exit 0; fi
printf '%s' "\${LETHAL_OUT_OF_USE_OWNER:-}" > "${ownerSeen}"
cp "${oou}" "${markerSeen}" 2>/dev/null
${JSON.stringify(process.execPath)} -e '${check}' || exit 1
echo "\${FAKE_TARGET:-${TARGET}}"
[ -n "\${FAKE_LEG:-}" ] && echo "$FAKE_LEG" > "$LETHAL_ITEST_HANG_LEG_STATE"
exit "\${FAKE_GATE:-0}"`,
    "",
  );
  const run = (env: Record<string, string | undefined> = {}) => {
    const all: Record<string, string | undefined> = {
      PATH: bin + delimiter + (process.env.PATH ?? ""),
      HOME: root,
      LETHAL_COORD_ROOT: coord,
      R658_EVIDENCE_DIR: ev,
      R658_WORKTREE: wt,
      R658_BEAT_SECS: "0.05",
      R658_HOLD_MAX_BEATS: "3",
      ...env,
    };
    const r = Bun.spawnSync(["bash", script, "bc2"], {
      env: Object.fromEntries(
        Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined),
      ),
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const hangLog = () => read(join(ev, "hang.log"));
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
  return { run, log, read, oou, ownerSeen, markerSeen, ownerLines, leaseTxt, refusal, hangLog };
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

test("R783: WANT follows LETHAL_BC_HOST, in each direction, before any lease", () => {
  const docker1 =
    "[itest target] config=lethal.config.bc2.json server=192.168.2.77:7149 odata=7148 api=7148";
  // docker1 set, the config on docker1: the target check passes and the lease is taken.
  const a = setup();
  const ok = a.run({
    LETHAL_BC_HOST: "http://192.168.2.77",
    FAKE_TARGET: docker1,
    FAKE_GATE: "0",
    FAKE_LEG: "passed",
  });
  expect(ok.out).not.toContain("does not name");
  expect(a.log()).toContain("kraken coord lease bc2");
  // docker1 set, the config still on server1: refused by name, no lease.
  const b = setup();
  const bad = b.run({ LETHAL_BC_HOST: "http://192.168.2.77" });
  expect(bad.code).toBe(2);
  expect(bad.out).toContain("refused: target line does not name server=192.168.2.77:7149");
  expect(b.log()).not.toContain("kraken");
  // unset, a config on docker1: refused too (the default is server1).
  const c = setup();
  const def = c.run({ FAKE_TARGET: docker1 });
  expect(def.code).toBe(2);
  expect(def.out).toContain("refused: target line does not name server=192.168.2.157:7149");
});

test("R783: a malformed LETHAL_BC_HOST refuses by name, before any lease", () => {
  const t = setup();
  const r = t.run({ LETHAL_BC_HOST: "http://192.168.2.77:7049" });
  expect(r.code).toBe(2);
  expect(r.out).toContain("refused: the BC host is not readable");
  expect(t.log()).not.toContain("kraken");
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
  // the token never reaches stdout, lease.txt, hang.log, or any child but the gate. The gate ran
  // R-669's real check, which logged the marker body into hang.log.
  expect(t.hangLog()).toContain("owned by this run");
  expect(t.hangLog()).toContain("in use by an R-658 itest:hang run");
  expect(t.hangLog()).not.toContain(token ?? "missing");
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

test("refusing an existing marker prints it without its owner line", () => {
  const t = setup();
  const tok = "0123456789abcdef0123456789abcdef";
  mkdirSync(join(t.oou, ".."), { recursive: true });
  writeFileSync(t.oou, `# bc2 is OUT OF USE\nowner: ${tok}\n- **Reason:** in use\n`);
  const r = t.run();
  expect(r.code).toBe(2);
  expect(r.out).toContain("Reason:** in use");
  expect(r.out).not.toContain(tok);
});

test("a marker that appears between the check and the write (during the lease): exit 2, kept, released, no gate", () => {
  const t = setup();
  const theirs = "# bc2 is OUT OF USE\n- **Reason:** another session's STOP\n";
  const r = t.run({ FAKE_RACE: theirs });
  expect(r.code).toBe(2);
  expect(r.out).toContain(`refused: ${t.oou} appeared or could not be written`);
  expect(t.read(t.oou)).toBe(theirs);
  expect(existsSync(t.ownerSeen)).toBe(false);
  expect(t.log()).toContain(`kraken coord release bc2 ${LEASE}`);
});

test("an inherited LETHAL_OUT_OF_USE_OWNER reaches no child, and the gate gets a fresh token", () => {
  const t = setup();
  const stale = "fedcba9876543210fedcba9876543210";
  const r = t.run({ LETHAL_OUT_OF_USE_OWNER: stale, FAKE_GATE: "0", FAKE_LEG: "passed" });
  expect(r.code).toBe(0);
  expect(t.log()).toContain("bun-e owner-env=\n");
  expect(t.log()).not.toContain(stale);
  expect(t.read(t.ownerSeen)).toMatch(/^[0-9a-f]{32}$/);
  expect(t.read(t.ownerSeen)).not.toBe(stale);
});

test("the test-only knobs are refused without R658_EVIDENCE_DIR, before any lease", () => {
  for (const k of ["R658_HOLD_MAX_BEATS", "R658_WORKTREE"]) {
    const t = setup();
    const env: Record<string, string | undefined> = { R658_EVIDENCE_DIR: undefined };
    if (k === "R658_HOLD_MAX_BEATS") env.R658_WORKTREE = undefined;
    else env.R658_HOLD_MAX_BEATS = undefined;
    const r = t.run(env);
    expect({ k, code: r.code }).toEqual({ k, code: 2 });
    expect(r.out).toContain(`refused: ${k} is test-only and needs R658_EVIDENCE_DIR`);
    expect(t.log()).toBe("");
  }
});

test("R658_BEAT_SECS must be a number > 0 and <= 60, and the hold cap a count", () => {
  for (const [k, v] of [
    ["R658_BEAT_SECS", "0"],
    ["R658_BEAT_SECS", "0.0"],
    ["R658_BEAT_SECS", "61"],
    ["R658_BEAT_SECS", "60.5"],
    ["R658_BEAT_SECS", "-1"],
    ["R658_BEAT_SECS", "1e3"],
    ["R658_BEAT_SECS", "abc"],
    ["R658_HOLD_MAX_BEATS", "x"],
  ] as const) {
    const t = setup();
    const r = t.run({ [k]: v });
    expect({ k, v, code: r.code }).toEqual({ k, v, code: 2 });
    expect(r.out).toContain(`refused: ${k}='${v}'`);
    expect(t.log()).toBe("");
  }
  const ok = setup();
  // the edge 0.05 passes in every other test; a whole number does too
  expect(ok.run({ R658_BEAT_SECS: "1", FAKE_GATE: "0", FAKE_LEG: "passed" }).code).toBe(0);
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
