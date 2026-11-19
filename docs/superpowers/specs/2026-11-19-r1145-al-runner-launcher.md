# R1145: an al-runner launcher prefix (`alRunnerV3.launcher`) — spec-light, for the orchestrator's decision

lethal-preproc, 2026-11-19 (coord PR-239). No code yet; build only after the orchestrator's ruling.
- **Fixed by earlier rulings:** the gated binary stays the hashed path (`alRunnerV3.path`, `checkGated`), and a wrapper is
  never trusted for the binary's identity (PR-226's option (b) refused; R1145).
- **Evidence:** PERF-10's notes (lethal-bugs): `/coord/handoff/PR-217/wrapper.sh` (the abandoned shim),
  `/coord/handoff/PR-217/run-perf10b.sh` (what runs now), `docs/superpowers/specs/2026-11-19-pr217-perf10-precommitment.md`
  amendment 1; a read-only code survey (names below; this note cites names, not lines).

## 0a. Amendment 1 (2026-11-19, the spec-adversary on r1, before any code). Each item overrides the section it names.
1. **§3.2, serve daemon ONLY (was: also one-shot).** One-shot calls, R866 isolated baselines and R937 echoes always spawn
   `[path, ...args]` directly. A one-shot call exits before any readiness line, so it could never be identity-checked: a
   launcher that ignores `$1` and runs another al-runner would have its rows scored (a false kill). It also keeps
   `bunSpawn`'s abort bound intact (its SIGTERM reaches only the direct child; a forking launcher's grandchild would hold
   the stdout pipe open). The §3.6 one-shot test becomes: the one-shot argv never carries the launcher.
2. **New §3.3a, a launcher never scores a timeout.** With a launcher set, a mutant's `timeout` outcome is never scored: it
   becomes `error` with "stopped under a launcher; never scored" (R586c's pattern). A launcher can slow the binary's CPU
   (an LD_PRELOAD profiler on some daemons only), and v3's in-run stop counts CPU time, so a correct slow test would read
   `timeout-killed`.
3. **§3.3, check what runs, not only which file:** after the match, refuse by name when the daemon's
   `/proc/<pid>/cmdline` after argv[0] differs from the argv LethAL passed after `path` (a launcher that drops
   `--test-timeout` or a define), or when its `/proc/<pid>/environ` holds `LD_PRELOAD` or `LD_AUDIT` that LethAL's own
   environment does not.
4. **§3.3, pid reuse:** at the match, record the daemon's `starttime` (`/proc/<pid>/stat` field 22) with its exe; every pid
   reader and writer (R952/R987/PR-88 memory reads, PR-88's `clear_refs` WRITE, the lane gate's `daemonPids()`) re-checks
   both first, and treats a mismatch as unreadable. Today the daemon is Bun's own child, unreaped until `wait`; under a
   launcher the launcher reaps it, so its pid can be reused.
5. **§3.3, the group kill:** spawn with `detached: true` (the pgid is the launcher's pid) and assert the launcher's pgrp
   equals its pid before any `kill(-pgid)`, so a signal never reaches LethAL's own group. After the group SIGKILL, also
   SIGKILL the matched daemon pid (after item 4's check); still present after the grace: refused by name (a launcher that
   `setsid`s or double-forks). LethAL's SIGINT path group-kills the daemons itself (they leave the terminal's group).
6. **§3.3, the search:** ONE scan of the launcher's descendants AFTER the readiness line (never a poll before it: a Rust
   spawn's vfork child shows the binary's exe until it execs). The rule: exactly one matching descendant whose parent
   does not match; otherwise refused by name. Descendants only, never all of `/proc` (other lanes' daemons).
7. **§2/§3.3 corrections:** the stderr file is named by the LAUNCHER's pid (it opens at spawn, before the match); the report
   records the daemon pid beside it. `cpuMs` leaves the list (only the probe uses it, which never gets the launcher).
8. **Launcher output:** its stderr joins the daemon's tail and file, which `refuseDependencySkip`, `exit6Kind` and R612's
   keep words scan; the spec states a launcher must not print al-runner's diagnostic phrases. Any stdout line from a
   launcher after the readiness line is a named refusal (`al-runner-v3-launcher-stdout`), not a parse error.
- **Checked sound by the adversary:** identity reads and the probe stay off the launcher; the probe cache key cannot replay
  a stale entry; resume and the snapshot are gated by the digest; descendant scoping keeps lanes apart; a copied,
  hardlinked or `ld.so`-run binary fails the match (the safe direction).
- **Q3 (sampling) under item 1:** `LETHAL_V3_DAEMON_ORDINAL` stays; with item 2, a sampled launcher can no longer change a
  verdict through timing.

## 1. What PERF-10 hit, from outside (bugs' notes)
- **A shim at `alRunnerV3.path` broke identity:** LethAL hashed the shim, so the pin, `.gated` and the probe cache were
  keyed on the wrong bytes, and every shim copy hashes the same (one sha for three builds). Abandoned.
- **Now:** the whole `lethal run` under `taskset`, and a watcher attaching `perf stat -p` to every 10th `al-runner serve`
  pid. Costs:
  - pinning the whole run also pins LethAL, alc and one-shots, so only a same-pinned control is comparable;
  - `perf -p` attaches late (misses the first ~2 s, the warm-up compile);
  - pid reuse is a theoretical race.
- **Already solved inside LethAL since R1145 was filed:** full daemon stderr to files (PR-227, `daemonStderrDir`) and
  `--timings` (PR-237, `serveTimings`). A launcher no longer needs to carry either; it only changes how the process is
  launched.

## 2. What the code does today (the survey)
- **Spawns that RUN tests:** the serve daemon (`AlRunnerServer.start`, argv `[path, "serve", ...]`) and the one-shot test
  call (`v3CallArgv` → the backend's spawn). A prefix fits both cleanly.
- **Identity reads:** `resolveV3Binary` (realpath), `--version`, `checkGated` (hash + `.gated` beside the path),
  `test --help` (capabilities). These must go to the binary directly.
- **The contract probe** (R762): its own `--version`, test and serve legs; cached in `.probe-cache-<digest>.json` beside the
  binary, keyed on the binary's sha, version, probe code and the run's inputs, with no launcher part.
- **Process identity, the real hazard:**
  - `AlRunnerServer.pid` is the spawned process's pid; `terminate()` sends SIGTERM to it alone; no process group is used.
  - The memory guards (R948/R952/R987: VmRSS, RssAnon, VmHWM) and PR-227's stderr file name read that pid.
  - One-shot `cpuMs` assumes the child is the binary ("taskset execs into its command").
  - So a launcher that does not `exec` makes the kill miss the daemon (an orphan holding memory) and makes every memory
    guard read the launcher: they fail OPEN, silently. `perf stat --` forks: the daemon is perf's child.
- **stdio:** the serve protocol is JSON lines on stdin/stdout; a launcher that prints to stdout breaks the readiness line
  (already refused by name). stderr output from the launcher (perf's report) lands in the tail and the stderr file.
- **cwd:** v3 writes `coverage.cobertura.xml` into the spawn's cwd; a launcher must keep it.
- v3 refuses Windows (`al-runner-v3-windows-unsupported`), so a launcher is Linux-only by construction.

## 3. Proposal
1. **Config:** `alRunnerV3.launcher`, an array of non-empty strings; the first an absolute path to an existing executable
   file. Anything else is refused by name (`al-runner-v3-config-refused: launcher ...`). Absent = spawning unchanged.
2. **Where it applies:** ONLY the serve daemon's spawn and the one-shot test call: `[...launcher, path, ...args]`, through
   one helper. NEVER to `--version`, `test --help`, hashing or `.gated`, and NOT to the contract probe (it measures the
   binary's behaviour, and its cache stays keyed as today; a launcher must not change behaviour, only how the process
   runs). The update gate and every `itest:*` never read a launcher; a gate run that sees one set is refused by name.
3. **Process identity, made safe without trusting the launcher:**
   - spawn a launched process in its OWN process group, and stop it by signalling the group (SIGTERM, then SIGKILL after
     the existing grace), so a forking launcher cannot orphan the daemon;
   - find the DAEMON pid: the descendant whose `/proc/<pid>/exe` resolves to the gated binary's realpath (polled until the
     readiness line, bounded). Every pid reader (memory guards, HWM, the stderr file name, `cpuMs`) uses that pid;
   - **none found, or more than one: refused by name** (`al-runner-v3-launcher-no-gated-child`). That is also the
     identity check R1145 called out of scope: the launcher must actually run the gated binary, or the run stops.
4. **Report and resume:** the report records the launcher argv; a new caveat `al-runner-launcher` says a launcher wrapped
   every test-running spawn (timings include its overhead). The resume digest gains the launcher only when one is set
   (the R907/R956 pattern), so a run cannot resume or lend across a launcher change silently; runs without one keep
   their digests. (Adding the report field and caveat follows CLAUDE.md's SessionReport ripple list.)
5. **Sampling (bugs' "every Nth"):** not in LethAL. LethAL passes `LETHAL_V3_DAEMON_ORDINAL=<n>` (and the lane) in the
   launched process's environment, so a launcher script can choose to wrap every Nth daemon itself and `exec` the rest.
6. **Tests, each red-checked:** spawn argv with and without a launcher; identity reads never get it; `checkGated` still
   hashes `path`; the group kill reaps a forking launcher's daemon (a fixture launcher that forks); the exe-matched pid is
   used by the memory guard; a launcher that never runs the gated binary is refused by name; config refusals; the resume
   digest moves only when set; the probe cache key is unchanged.

## 4. Decisions for the orchestrator
- **Q1, the contract probe:** without the launcher (recommended; identity and behaviour are the binary's), or with it?
- **Q2, process identity:** group kill + exe-matched daemon pid + refuse-if-absent (recommended), or require an
  `exec`-style launcher and trust the direct child (simpler, fails open if the user's launcher forks)?
- **Q3, sampling:** the ordinal env var only (recommended), or an `every` option in LethAL?
- **Q4, resume:** the launcher enters the resume digest when set (recommended), or report-only?

## 5. Not covered
- A launcher that changes the binary's behaviour (environment, LD_PRELOAD) is the user's responsibility; the caveat and
  report name it. LethAL checks only that the gated binary is what runs.
- PERF-10 itself does not change: it runs on its current method; this is for the next performance measurement (R1145's
  trigger).
