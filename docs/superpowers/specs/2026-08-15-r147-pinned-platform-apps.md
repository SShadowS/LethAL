# R147: pin the platform-app directory instead of re-provisioning on every al-runner invocation

Written 2026-08-15, before any code. Measurements first, design second, acceptance conditions last.
The roadmap row is `docs/roadmap/R147.md`.

This changes the argv that produces every verdict on the al-runner backend, so the spec exists to be
attacked before it is built. **Revision 2**, after the `spec-adversary` review. Ten findings came
back; §6 records what each one changed and the two it did not.

## 1. What was measured

All figures on **al-runner v2.1.2.0** (printed by `al-runner --version`), 2026-08-15, on
`fixtures/sandbox-app` + `fixtures/sandbox-tests`, this machine. The artifact cache held eight BC
build directories at the start.

| argv | wall clock | platform-app downloads | exit |
| --- | --- | --- | --- |
| `--auto-provision` (what LethAL sends today), first run of the day | 21.1 s | 2 x 115 MB | 0 |
| `--auto-provision`, immediately again, fully warm | 17.1 s | 2 x 115 MB | 0 |
| `--package-cache <artifacts>/28.0.46665.53671/platform-apps`, no `--auto-provision` | 6.8 s, 6.8 s | 0 | 0 |
| the same, three runs after a COLD provision | 7.9 s, 8.0 s, 7.8 s | 0 | 0 |
| the real config shape: the project's `.alpackages` AND the pin, two `--package-cache` entries | 8.0 s, 8.0 s | 0 | 0 |
| today's real config shape: `--auto-provision` AND the project's `.alpackages` | 24.7 s | 2 x 115 MB + 20 MB test toolkit | 0 |
| no flags at all | 1.3 s | 0 | **2**, refuses |
| `--package-cache <a directory that does not exist>`, no `--auto-provision` | 1.3 s | 0 | **2**, refuses |

Ten to seventeen seconds and 230 MB per invocation, on a cache that already holds every byte. LethAL
makes one invocation per (mutant x covering test), so it is paid on every one.

The prefix moved under us during the measurement session itself: R147 was filed against
`28.0.46665.53655` on 2026-08-14 and every run today resolved `28.0.46665.53671`. That is the
moving-target hazard the row names, observed rather than argued.

### 1.1 Unknown one: a declared dependency version that differs from the resolved build

The fixture's `.alpackages` carry Microsoft symbol apps at `28.0.46665.47126`. The provisioning pass
resolves the prefix `28.0` forward to `28.0.46665.53671` and fetches THAT. So the pin is thousands of
builds newer than the symbols the project declares.

Confirmed deliberately rather than inherited from one lucky run. The whole fixture suite was run
under both argv variants with no `--test` filter, and the two are identical:

- Both report `2P/0F/0E across 2 tests, 0 suite errors`, both envelopes
  `passed: 2, failed: 0, errors: 0, total: 2, exitCode: 0`, both name the same two qualified tests.
- Their stderr is line-for-line the same apart from the `[provision]` block: the same
  `[bc] selected BC 28.1.49838.50794`, the same `[layered]` line, the same per-bundle dependency
  resolution, and the same pre-existing `[dep]` warning about the fixture's stale
  `LethAL_LethAL Sandbox App_1.0.0.999.app` (now filed as `docs/roadmap/R148.md`).

The same comparison was then repeated in the shape a REAL config sends, with the project's own
`--package-cache <projectDir>/.alpackages` present alongside the pin. `diff` of the two stderr
streams, `[provision]` lines excluded, differs in exactly two places: the runner's own
`package caches: 2 dir(s)` versus `1 dir(s)`, and two elapsed-millisecond figures. Dependency
resolution, the `[layered]` decision, the `[dep]` warning and the test results are identical.

So the run resolves the same dependencies and executes the same tests either way. The mismatch is
what `--auto-provision` papers over today, and handing the runner the same directory by hand papers
over exactly as much.

### 1.2 Unknown two: the cold path, and R125's ruling

`28.0.46665.53671` was deleted outright (117 MB, one of eight build directories, and the only one
this measurement had created) and the flow re-run from cold. The engine artifact set
`28.1.49838.50794` was NOT touched: it is 358 MB and every al-runner gate on this machine selects it,
so deleting it would take the gate down for a measurement whose conclusion does not need it. R128
declined the same thing for the same reason.

Cold result: the provisioning invocation, which keeps `--auto-provision`, recreated the directory in
12.1 s and named it in its own output. The three pinned invocations that followed ran green in
7.9 / 8.0 / 7.8 s with zero downloads, and the directory ended at 117 MB with six `.app` files, its
state before the deletion.

One thing this cold test does NOT separate, and the caveat belongs here rather than in a footnote:
the surviving `28.1.49838.50794/test-apps` toolkit could have served the run instead of a restored
`28.0.46665.53671/test-apps`. R128 measured that al-runner resolves the toolkit at the binary's
version in at least one code path. A later measurement in the real config shape settles it in the
other direction: with the project's `.alpackages` also on the command line, the provisioning run
printed `[provision] Downloaded 107 test .app file(s) (20 MB) to
...\28.0.46665.53671\test-apps`, so the toolkit does land beside the platform apps at the resolved
build. Either way the toolkit is not what this change pins, and pinning `platform-apps` leaves
al-runner's default scan of the artifact root in place to find it.

**R125's ruling stands and this design does not touch it.** `--auto-provision` stays on the
provisioning invocation. What is dropped is `--auto-provision` on the per-mutant invocations, which
happen only after provisioning has already reported where it put the apps.

### 1.3 Unknown three: is the answer reliably readable

Two `[provision]` lines name the directory, and each appears twice per invocation because of R130's
double pass. All four agreed on `28.0.46665.53671` in every run measured.

```
[provision] fetching Microsoft platform R2R apps for BC 28.0.46665.53671 <SUB> C:\...\28.0.46665.53671\platform-apps
[provision] Downloaded 6 app(s) (115 MB total) to C:\...\28.0.46665.53671\platform-apps
```

**Only the second is used, and the reason is not cosmetic.**

- The `fetching` line is an INTENT sentence, printed before the download starts. Pinning on it means
  pinning on a directory that may be half written.
- It also carries a control character: an `od -c` shows byte `0x1A` (SUB) where an arrow glyph was
  mangled by the console code page. Keying a parse on that separator would bind LethAL to whatever
  encoding the console happened to use.
- Its wording moved within one week. R130's transcript on 2.1.1.0 reads `[provision] fetching
  Microsoft platform R2R apps for BC 28.0.46665.53508 ...` with a literal `...` and **no path at
  all**. The path only appeared in 2.1.2.0.

The `Downloaded N app(s) (S MB total) to <dir>` line is plain ASCII, is a COMPLETION sentence, and
**states its own count**. That count is the check §2.2 needs and did not have: reading a number the
runner printed is the same principle as reading a path it printed, where deciding the number six
ourselves would be a guess.

A neighbouring line proves the parse has to be specific rather than merely present. The same
provisioning run also prints `[provision] Downloaded 107 test .app file(s) (20 MB) to
...\28.0.46665.53671\test-apps`. Different noun phrase, different directory. Requiring both the
`N app(s)` shape and a directory whose last component is `platform-apps` rejects it twice over.

A weaker alternative was rejected: parsing `[provision] Resolved: 28.0 -> 28.0.46665.53671` and
joining it onto an artifact root LethAL guesses. That would hard-code al-runner's directory layout in
a second place (`defaultAlRunnerCacheDir` already encodes it once) and would construct a path rather
than read one.

### 1.4 Is the pin the provisioning run names the pin a mutant run needs

This is the load-bearing assumption, and it was measured rather than assumed. `provisionOnce` sends a
DIFFERENT bundle set from a mutant invocation: the test bundle alone, with a filter that matches no
test, where a mutant sends the instrumented target plus the test bundle. al-runner resolves the BC
version prefix from the bundles it is given, so the two could in principle name different
directories.

Measured today, both on 2.1.2.0, both against the same fixture:

- the `provisionOnce` argv (`--test Codeunit0.__lethal_provision_only__ --auto-provision
  fixtures/sandbox-tests`) named `...\28.0.46665.53671\platform-apps`;
- the mutant-shaped argv (`--test Codeunit79100.OverBudgetDetected --auto-provision
  fixtures/sandbox-app fixtures/sandbox-tests`) named `...\28.0.46665.53671\platform-apps`.

Identical, on the cold run and on the warm ones. R128's choice of the test bundle is left alone
rather than widened to the project directory, which would be a change to a closed row's step for no
measured gain.

And the failure direction if they ever diverged is safe rather than silent: a pin from a different
build is still a complete platform-app set, and §1.1 measured that a set thousands of builds away
from the project's declared symbols runs green. A pin that is not a usable set at all fails loud, per
§1.5.

### 1.5 The safety property that makes this acceptable at all

A wrong pin cannot produce a wrong verdict.

Measured: `--package-cache` pointed at a directory that does not exist is silently dropped from the
scan (`package caches: 0 dir(s)`) and the run then hits the same provisioning-gap refusal as no flags
at all: **exit 2, empty stdout**. `OneShotTransport` maps every exit code other than 0 and 1 to
`kind: "error"`, so the mutant is scored `error`, never `survived`.

Traced through the code rather than only observed: exit 2 and 3 become `kind: "error"` directly; exit
1 with empty stdout makes `parseAlRunnerPayload` throw, which the transport's own catch turns into
`kind: "error"`; a readable envelope with an empty `tests` array misses the `find` on the requested
name and `AlRunnerBackend.run` answers `outcome: "error"` with `operation: "pre-dispatch-rejected"`.
There is no route from a missing platform app to `status: "fail"`, because a missing platform app is
a missing SYMBOL and the bundle fails to compile before any test runs.

That is the whole argument for allowing a verdict-producing argv to change. If a bad pin could return
a green empty envelope, none of this would be worth ten seconds.

## 2. What is built

### 2.1 `parseAlRunnerPlatformAppsDir(output)`

In `al-runner-transport.ts`, beside `parseAlRunnerBcBuild`, and pure. Returns a discriminated result
so that "no pin" always carries a REASON, never silence:

```ts
type AlRunnerPlatformAppsParse =
  | { kind: "found"; dir: string; appCount: number }
  | { kind: "no-completion-line" }
  | { kind: "conflicting"; dirs: readonly string[] };
```

- Reads ONLY lines of the shape `[provision] Downloaded <N> app(s)<anything> to <dir>` where `<dir>`
  runs to end of line and its last component is `platform-apps`. `<dir>` must be rooted: a drive
  letter, a slash, or a leading `~`. `~` is accepted deliberately rather than ignored, because this
  runner is known to print `~`-rooted paths (`parseAlRunnerBcBuild`'s own doc comment records one);
  accepting it means the directory check below reports "does not exist" instead of the parse
  reporting "nothing was printed", and the difference is what a reader needs.
- Collects every match. Compares them NORMALISED (separators unified, trailing separator stripped,
  case-folded on win32) so that two spellings of one directory are one directory. Returns the last
  match's raw path and the LARGEST count any of them claimed.
- More than one distinct normalised directory returns `conflicting` with all of them. Two provisioning
  passes that disagree about where the platform apps live means LethAL has no basis for picking one,
  and picking one anyway is the invented-plausible-default this repo refuses. Today they always
  agree, so this is a guard rather than a behaviour, and it is REPORTED when it fires.
- Never guesses, never defaults, never constructs.

### 2.2 `provisionOnce()` reports the directory it was told about, or why not

`AlRunnerProvisionResult` gains `platformAppsDir?: string` and `platformAppsRefusal?: string`.
Exactly one of the two is always present, so the caller can never mistake "not pinned" for "nobody
looked". The directory is set only when ALL of:

1. the process exited on a code IT chose: `0 <= exitCode < 128`. NOT the existing `ran` field, which
   is `exitCode >= 0` and therefore true for a signal kill. `defaultSpawn` RESOLVES on an aborted or
   killed child with `128 + signal` and whatever partial output the child had written, which
   `al-runner-contract.ts` already measured and already guards with `isChildChosenExit`. That
   predicate moves to `al-runner-transport.ts` so there is one spelling of it, and
   `al-runner-contract.ts` imports it. `ran` is left alone: it exists for R128's warning and means
   what it says there.
2. `parseAlRunnerPlatformAppsDir` returned `found`;
3. the directory exists and holds **at least `appCount`** files matching `*.app`.

Condition 3 is IO and lives in `provisionOnce`, not in the parser. Condition 1 plus a completion
sentence plus a count is what makes a half-written directory unpinnable: a provisioning killed
mid-download has no completion line to read, and one that lied about finishing is caught by the count.

Absent any of the three, `platformAppsRefusal` names which one and everything downstream keeps
today's behaviour, `--auto-provision` on every invocation.

### 2.3 The pin reaches every backend instance that will run a mutant, or the session refuses

`AlRunnerBackend` gains `usePlatformAppsDir(dir: string): void`, which sets a private field that
`run()` forwards into the transport request.

`provisionOnce` deliberately does NOT set the field on itself. It reports, `runSession` decides,
because `runSession` must apply the same pin to the WORKER backends. Those are separate instances:
`cli.ts` builds all of them up front, before `runSession` is entered, and `cfg.backendFactory(i)`
merely hands back an already-built one. `runSession` calls the factory after the provisioning step,
so by the time it holds a worker instance the pin is known, and the pin is a setter on an instance
rather than a constructor argument, which is what makes that ordering work at all.

**It is a loud contract, not an optional structural call.** If a pin was established and any backend
`runSession` will execute mutants on does not accept `usePlatformAppsDir`, `runSession` THROWS. The
alternative is the failure this repo has a rule against: the baseline runs on `cfg.backend` under the
frozen pin while mutants run on worker backends under `--auto-provision`, whose prefix resolves
forward on every invocation, so a mid-session Microsoft publish moves the platform apps under the
mutants and not under the baseline. The report would not say so either, because `observedBcBuild` is
read from `cfg.backend` alone, so it would name the build that produced the BASELINE and present it
as the build that produced the verdicts.

### 2.4 `buildAlRunnerArgv` makes the two mutually exclusive

`AlRunnerRequest` gains `platformAppsDir?: string`.

- When it is absent: `--auto-provision`, exactly as today. No caller that does not opt in changes.
- When it is present: `--package-cache <platformAppsDir>` and **no** `--auto-provision`.

Encoded in the one function that builds the argv, so a caller cannot get a half configuration.
Sending both would keep paying the ten seconds the flag costs, which is the entire point of the pin,
so a combination that is merely pointless is made impossible rather than discouraged.

`--package-cache` is repeatable (al-runner's own `--help`: "Extra directory to scan for .app
dependencies (repeatable)"), so this ADDS to the existing `packagesDir` entry rather than replacing
it, and it adds to al-runner's default scan rather than replacing that. §1.1 measured the two-entry
shape against the real binary: `package caches: 2 dir(s)`, exit 0, same dependency resolution.

### 2.5 The run says which it did, in both directions

This is not decoration. Ask what a reader would see if the feature silently stopped working: without
this, the answer is nothing at all. Every unit test green, `itest:alrunner` green at 3/13/0 per
mutant, no line anywhere. And a silent stop is likely rather than hypothetical, because the wording
this parse reads has already moved once inside a week.

- Pinned: a new `al-runner-platform-apps` event carrying the directory, folded onto
  `ReportValidity.executionContexts[].platformAppsDir` beside R129's `bcBuild`, under the same two
  gates R129 uses (non-carried entries, non-authoritative backend only). `itest:alrunner` asserts
  that field is populated. That is a live assertion of the MECHANISM and not a timing assertion, so
  §3's ruling against timing gates stands.
- Not pinned: a `warning` event, code `al-runner-platform-apps-unpinned`, naming which of the checks
  refused and what it saw.

Recording the pin in the report also closes the resume hole. `sessionFingerprint` covers
`projectDir`, `testDir`, `backend`, `skipKnownSurvivors`, `selectorIds`, `only`, `operators` and
`testsOnly`, and it is deliberately NOT widened here: adding the pin would break every `--resume`
the moment Microsoft publishes, which is worse than the problem. What the field does is make a
resumed report SAY that this run's verdicts were produced against a given platform-app build, next
to carried verdicts whose entries never receive the field. The row's stated side benefit, that a
mid-session publish cannot move the platform apps under a running campaign, holds within a session
and not across a resume, and now the report shows the seam instead of hiding it.

## 3. What is deliberately NOT built

- **No `--bc-version` pin.** R129 argued this out: pinning makes the choice ours and reintroduces
  R125's failure mode. This pins a DIRECTORY the runner itself chose, not a version LethAL chose.
- **No cleaning of the artifact cache.** R131's ruling stands; nothing here deletes.
- **No change to the provisioning invocation's own argv, or its bundle set.** R125 and R128.
- **No timing assertion anywhere.** The wall-clock improvement is the reason to do this and it is not
  a property a gate can hold: it depends on the network, on Microsoft's publish cadence, and on
  whether the AL output cache is warm.
- **No pin on the R123 contract probe or the R7/R8 canary.** Four invocations at session start keep
  `--auto-provision` and keep paying roughly ten seconds each, so session start does not get faster.
  Worse, the contract probe's own promise is that it sends "the SAME argv the transport sends", and
  after this change it measures `--auto-provision` while the verdicts come from `--package-cache`.
  That is a real gap and it is FILED rather than smuggled in here: `docs/roadmap/R149.md`. A note in
  `al-runner-contract.ts`'s doc comment points at it so the promise is not left reading as true.
- **No `packagesDir` added to `itest:alrunner`'s backend config.** The gate would then run the shape
  real configs run, which is a genuine gain, but it also changes what the gate resolves and this is
  not the change to find that out under. Measured by hand instead, in §1.1.

## 4. Acceptance

- `bun run typecheck`, `rm -rf packages/*/dist`, `bun test` green.
- Parser tests: reads the ASCII `Downloaded N app(s) ... to <dir>` line and its count; ignores the
  `fetching` intent line even with the raw `0x1A` byte present; ignores the neighbouring
  `Downloaded 107 test .app file(s) ... to <...>/test-apps` line; returns `no-completion-line` for
  output with no such line; returns `conflicting` when two lines name different directories; treats
  two spellings of one directory (case, separators, trailing separator) as ONE; is not fooled by a
  `platform-apps` path on a line that does not begin with `[provision]`.
- `provisionOnce` tests: no pin when the exit code is 143 even though output names a directory; no
  pin when the directory holds fewer than the claimed count; no pin and a NAMED refusal in each case;
  a pin when all three conditions hold.
- Argv tests: with a pin, `--package-cache <pin>` present and `--auto-provision` absent; without a
  pin, `--auto-provision` present and no extra `--package-cache`; with both a pin and a configured
  `packagesDir`, BOTH `--package-cache` entries present.
- A control test that passes with the feature on and off alike: an unpinned request's argv is exactly
  what it was before this change.
- Worker contract test: a pin plus a worker backend that cannot accept it THROWS, naming the problem.
- Red-check, each producing the RIGHT failure: reverting "omit `--auto-provision` when pinned" turns
  a named argv test red; reverting the worker throw turns the worker contract test red; reverting the
  `isChildChosenExit` gate turns the signal-kill test red.
- Live: `itest:alrunner` frozen at **3 / 13 / 0**, per-mutant identical to the committed baseline,
  the al-runner build printed as the gate's first line, and `platformAppsDir` populated on the
  execution context. Judged per mutant, never on counts.

The live expectation is pre-committed separately before the gate runs.

## 5. Revision log

Revision 1 was reviewed by the `spec-adversary` subagent, which returned ten findings and the verdict
"not safe to implement as specified". What each changed:

| finding | what it said | what changed |
| --- | --- | --- |
| F1 | `ran` is `exitCode >= 0`, so a signal-killed provisioning passes condition 1 | §2.2 condition 1 now uses `isChildChosenExit`, moved into the transport so there is one spelling |
| F2 | "exists and holds at least one `.app`" does not catch the partial directory the spec names as the hazard | §2.2 condition 3 reads the runner's OWN count off the completion sentence, and the intent sentence is no longer read at all |
| F3 | the pin is read from one bundle set and applied to another, and only the second was measured | measured; §1.4 is new, and both shapes name the same directory |
| F4 | no emit when unpinned means the feature can die silently, which is the signature bug applied to its own success signal | §2.5 is new: a report field the live gate asserts, plus a named warning carrying the refusal |
| F5 | the R123 contract probe stops measuring the argv that produces verdicts | out of scope by the row's own rule; filed as R149 and noted in the probe's doc comment (§3) |
| F6 | §2.3's claim about worker construction order was wrong, and an optional structural call can silently no-op | §2.3 rewritten and the propagation made a throwing contract |
| F7 | `--resume` merges verdicts produced under different pins with nothing recording it | §2.5: the pin goes in the report, and deliberately NOT in the fingerprint |
| F8 | three benign ways the "one distinct path" rule fires: `~` roots, two spellings of one path, an extra `[provision]` line | §2.1: `~` accepted, normalised comparison, and the conflict is reported rather than silent |
| F9 | the two-`--package-cache` shape every real config sends was never measured | measured; the last two rows of §1's table and the second paragraph of §1.1 |
| F10 | the canary and the contract probe still pay the cost | stated in §3 rather than fixed |

Two findings were accepted as correct and deliberately not acted on in code: **F5**, because fixing
it means moving or duplicating the R123 probe, which the row does not ask for and which the "file a
new row, do not widen" rule covers; and **F9**'s second half, because giving the gate a `packagesDir`
changes what the gate resolves and this is not the change to discover that under.

The review also independently confirmed three things this design leans on, which is worth recording
because they were checked against the code rather than argued: a bad pin cannot produce `killed`,
`timeout-killed` or `survived`; the faster baseline cannot squeeze a mutant's budget, because
`MIN_MUTANT_BUDGET_MS` floors it at 180 s; and a bad pin's cause reaches the reader verbatim through
`noGreenBaselineNote`.
