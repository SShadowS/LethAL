# Changelog

All notable changes to LethAL are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, the CLI surface,
the `lethal.config.json` schema and the JSON report shape may all change between releases.

Entries cite the `R<n>` id from the roadmap; `docs/roadmap/R<nnn>.md` carries the full evidence for
each one, and [`ROADMAP.md`](ROADMAP.md) indexes them.

## [Unreleased]

## [0.1.0-alpha.2] — 2026-08-17

The first release with a machine-readable surface for agents and CI, a demo application you can
point the tool at, and a licence. Roughly thirty roadmap rows closed since alpha.1; the ones a user
can see are below, each citing its `R<n>` for the evidence.

### Added

- **A licence.** MIT. There was none, so nobody could legally use a binary they downloaded.
- **`lethal explain --top <n>`** (R150), because the projection built for agents did not fit one:
  a 473-mutant report projects to 243 KB. The output now always carries `survivorSelection`
  (`total`, `shown`, `omitted`, `rankedBy`), present even when nothing was capped, so a truncated
  list can never read as a complete one. A cap ranks survivors by how much evidence each carries,
  in a total order, so the same report and cap give the same rows on any machine.
- **`lethal doctor --json`** (R151). The read-only pre-flight was the one surface an agent could not
  parse. Emits `doctorSchemaVersion`, `ok`, per-check `name`/`ok`/`detail`, `notChecked` tokens for
  what a GREEN report does not cover, and a caveat with a machine `kind`. Same exit code; only the
  rendering changes. `--json` is refused elsewhere rather than ignored.
- **An agent contract** (R153): `docs/using-lethal-from-an-agent.md` and a copyable skill at
  `skills/lethal-mutation-testing/SKILL.md`, both checked against the code by a test — every flag
  they name must exist, and the exit codes and schema versions they promise must match the
  constants.
- **Published JSON Schemas** for the `explain` projection and `doctor --json`, under `schemas/`
  (R152). Pinned against the TypeScript declarations in both directions, with every enum asserted
  equal to its runtime constant. The report and the event stream do not have one yet.
- **A demo application**, `examples/gift-card` (R155): a small store-credit extension whose eight
  tests are green and do not notice that deleting one `SetRange` makes a card's balance the whole
  store's liability. Measured live: 36 mutants, 20 killed / 9 survived / 7 no-coverage, 13.8 s, and
  all 36 verdicts were pre-committed before the run and all 36 matched. Its rehearsal report ships
  too, so `lethal explain` can be exercised with no server.
- **`--operator <name>`** (R127) to scope a run by operator, so measuring one operator on a real
  project no longer costs every other operator's mutants in the same files.
- **Four Tier-2 operators and one extension**: `flip-filter-literal` (R134, the first operator that
  mutates a filter string BC re-parses at runtime rather than AL that `alc` compiles),
  `swap-find-direction`, `validate-to-assign`, and `swap-modify-flag` extended from `Modify` to
  `Insert`/`Delete` (R136). Every one landed with its per-mutant verdicts pre-committed and matched
  against a live container.
- **`declarativeSites` in the report** (R144). Sites LethAL declines to mutate because they are
  declarative properties were counted and then thrown away in a warning; the report now carries
  them.
- **The BC build that produced the verdicts** is recorded on the al-runner path (R129).
- **`lethal doctor` works for an al-runner-only project** (R146) instead of refusing it.
- A source-overlay renderer, `scripts/render-overlay.ts`: a run drawn on the code it measured, with
  "ran" at procedure granularity (which is all coverage knows) and "checked" per site.
- CI and release workflows (R154).
- **`validity.executionContext` on every report** (R60). LethAL executes every mutant headlessly,
  so every verdict describes your app's NON-interactive branch, while a developer running the same
  suite from VS Code runs GUI-allowed — the two are not measuring the same code, and nothing said
  so. Required rather than optional, and printed on every run including a clean one, because the
  reader most likely to quote a score without qualification is the one whose run had no other
  caveats. Measured before it was written (`scripts/measure-gui-guarded.ts`, Continia Document
  Output, 551 `.al` files): **62 of 19,850 mutation sites — 0.3% — sit inside a
  `GuiAllowed`/`Confirm`-guarded branch**, which is why this is a stated limit rather than a
  per-site signal. Note the three constructs differ: `Message` is a no-op, `Confirm` forces its
  DEFAULT answer (so the non-default arm is the unreachable one), and `Page.RunModal` errors.
- **`bcdev.altoolPath` config override** (R64) to pin the publish tool, alongside the existing
  `bcdev.alcPath` (R43) for the compiler. The publish tool build is not interchangeable either: the
  AL extension's bundled `altool` 17.0.2273547 silently ignores `BC_SERVER_USERNAME`/
  `BC_SERVER_PASSWORD` for `publishapp` and its `auth login` is AAD-only, while the
  `microsoft.dynamics.businesscentral.development.tools` 18.x dotnet tool reads them and publishes.
  The two overrides are independent, so compile and publish can run on different builds — and,
  set together, they now satisfy the "no AL extension installed" gate on the container path as
  well, which previously demanded the extension no matter what the config named.

### Changed
- **Vendored tree-sitter-al 3.2.1 to 4.0.1** (R133), a breaking grammar release that moves named
  trees LethAL hashes. Thirty-two empty-block identity hashes were re-keyed with per-site proof and
  all six live gates re-measured unchanged.
- **al-runner stops re-downloading 230 MB of platform apps per invocation** (R147, R130): the
  platform-app directory is pinned with `--package-cache`, and the double provisioning inside a
  single invocation is gone. 17.1 s per invocation became 6.8 s.
- The platform-artifact screen no longer tags every `Insert` mutant (R143): the tag is dropped when
  the receiver's `OnInsert` provably does not assign the primary key, so the screen stops
  over-reporting. A receiver that cannot be resolved keeps the tag.

### Fixed
- **A trigger mutant could score `survived` when its only covering test was red** (R140), where
  member-level attribution correctly declines to score at all.
- **A stale published TEST app was indistinguishable from genuinely failing tests** (R139) and cost
  a full gate run to diagnose.
- **Conformance refusals that asserted nothing** (R137, R142): an empty expectation passed on any
  input, and a non-empty one never checked for extra specs.
- **Two more `error` shapes recorded no `cause`**, one of them labelled `deadline-exceeded` when it
  was not one (R122).
- Eight `scripts/` files did not compile under the repo's own strict flags, and two had produced
  numbers a roadmap decision was made on (R120).
- **A permissions refusal at baseline discovery no longer reads as an unsupported test type**
  (R35). R27 taught LethAL to name the `TestPermissions` cause, but only on the `unstable` path.
  A test BC refused at *baseline discovery* never reaches it: the test was dropped from the green
  set and the mutants it alone covered were recorded `error` with the note "unsupported test
  type", pointing the reader at their test's type when the fix is one property
  (`TestPermissions = Disabled`) in their own source. Those mutants now carry a note naming the
  permissions cause and quoting BC verbatim, the report gains `permissionsRefused` and a
  `tests-permission-refused` caveat, and the same refusal recognised on the `unstable` path feeds
  the same field — so a run can no longer disagree with itself about whether it hit one.
  **Known limitation:** the detector matches BC's English refusal text, so a non-English server
  still gets a silent miss (never a wrong answer) — tracked as R66 and pinned by a test.
- **A failed tool spawn could report nothing at all** (R65). A Bun spawn `ENOENT` arrives with an
  EMPTY `message`, so catches that stringified `err.message` reported a blank cause — how R64's
  wrong-platform binary presented, and why it took a long external session to trace. `alc`,
  `altool` and the configured environment tool now report the OS error code, syscall and path.

- **The bcdev backend on Linux and macOS hosts** (R64). `defaultAlToolPaths()` hardcoded `bin/win32/`
  regardless of `process.platform`, so every non-Windows run spawned a Windows PE `alc.exe`/
  `altool.exe` that cannot execute — including anyone using the released Linux and macOS binaries,
  for which the bcdev backend could never have worked. The failure surfaced many layers up as an
  opaque, message-less `Error`. The AL Language extension ships per-RID builds side by side
  (`bin/win32/{alc,altool}.exe`, `bin/linux/{alc,altool}`, `bin/darwin/{alc,altool}`, verified
  2026-07-31 against `ms-dynamics-smb.al-18.0.2498801`); LethAL now picks the one matching the host,
  and refuses loudly on a host the extension ships no build for instead of guessing a RID.
  Reproduced the frozen `itest:bcdev` baseline exactly — **3 killed / 10 survived / 3 no-coverage**,
  `authoritative`, `baselineGreen` — against a live Linux Docker BC 28.1 container, with the run
  costs recorded in `docs/benchmarks/runs.jsonl` (the ledger's first plain-container rows).

### Security
- **Six committed campaign reports carried 1,857 fields of a third party's AL source** in this
  public repository. They predate the redaction ruling and were never swept. Redacted, and the
  guard now discovers the report set by glob instead of naming two paths by hand, which is how it
  missed them.

## [0.1.0-alpha.1] — 2026-07-27

First distributable build. LethAL has run against live Business Central servers throughout
development; this is the first release that someone other than its authors can download and run.

Alpha means the tool is honest about its own limits rather than complete: the al-runner backend is
measurably not authoritative, individual survivors are still not proven non-equivalent, and several
classes of AL construct are never mutated. Known gaps are listed at the bottom of this entry.

What this release *can* now claim, and could not before: **coverage selection does not hide kills.**
Two runs of one Continia Document Output codeunit, identical except for `coverageMode`, compared
per-mutant across all 138 mutants — no mutant reported `survived` or `no-coverage` under selection
turned out killable by the full suite (R37). That is the failure mode (R29) that once produced 10
false survivors out of 20 on a fixture, and on a real product it is empty.

### Added

- **Standalone binaries** for Windows x64, Linux x64/arm64 and macOS x64/arm64, built with
  `bun build --compile`. No Bun, Node or npm install required on the target machine. The tree-sitter
  AL grammar and the web-tree-sitter runtime are embedded in the executable.
- **`lethal --help` and `--version`** (R49), and usage for a bare `lethal`. Both are intercepted
  before `parseArgs`, which runs in strict mode and previously turned `--help` — the first flag a
  new user types — into a raw `TypeError` with a stack trace into the bundled binary. The version
  is bundled by a static JSON import, not read from disk, for the reason R50 measured.
- **Tier-2 mutation operators** (R10) — `RemoveTestField`, `RemoveSetRange`, `RemoveCalcFields`
  and `SwapModifyFlag`, over a shared `claimsRecordMethod` receiver predicate. These mutate table
  triggers, which Tier 1 never reached.
- **Page, report, `pageextension` and `tableextension` instrumentation** (R40). Previously only
  codeunits and tables could carry the injected selector variable, and the stated reason for that
  turned out to be wrong: the constraint is *where* in the object the `var` is anchored, not which
  object kind. On a real app (Continia Document Output) this took mutant sites from **11,777 to
  19,832** and instrumented files from **162 to 438** — app coverage 59% → 90%.
- **`--only <glob>`** (R41), repeatable, to scope which files contribute mutants, so a large project
  has a cheap first run. Narrows spec generation only: every file is still parsed into the
  project-wide semantic context, compiled and published, because narrowing the parse set would
  silently change verdicts through the Tier-2 shadowing guard.
- **`--tests-only <glob>`** (R45), repeatable, to narrow the baseline test suite. On Document Output
  this cut the baseline from **744.8 s to 25.0 s** and the total run from **953.8 s to 231.2 s**,
  with identical verdicts. Unlike `--only` this *can* change a verdict — excluding a killing test
  turns a kill into a survivor — so it carries its own `tests-narrowed` report caveat and degrades
  `validity.reliability`.
- **`--max-guards-per-batch <n>`** (R44) to bound how many injected guards go into one published
  artifact. Publish cost scales with guard count because BC recompiles the extension server-side:
  163 guards published in 28 s, 11,777 hit a hosting proxy's `504 Gateway Time-out` at 362 s.
- **`--selector-id` / `--control-id` / `--table-id` flags and a `selectorIds` config section** (R3).
  The three injected object ids were hardcoded to 79197–79199, so a project whose `app.json`
  `idRanges` excluded them could not be instrumented at all. Resolution is CLI > config file >
  default, decided independently per id, and validated against the target's declared `idRanges`,
  against already-declared codeunit ids, and pairwise — all before any `alc` invocation.
- **Two instrumented projects can now share one BC container** (R4), a direct consequence of R3.
  Verified live with two apps simultaneously installed on one container.
- **`bcdev.alcPath` config override** (R43) to pin the AL compiler. `alc 18` writes OPC part names
  with single-encoded spaces, producing a package BC 28 refuses with `Specified part does not exist
  in the package.`, while `alc 17` builds the same source successfully. Both compilers exit 0 — the
  defect surfaces only at publish. The encoding difference itself is upstream in Microsoft's `alc`.
- **Custom environment tool support** (R15/R16) — run against environments owned by an external CLI,
  described purely in config (tool path plus command templates for create / resolve / symbols /
  publish / delete). LethAL's fenced `RunMutant` path still decides every verdict. Gate frozen at
  3 killed / 10 survived / 3 no-coverage, identical to the direct-container gate on the same
  fixture.
- **`notInstrumented` on the session report** (R5) — how many files and mutation sites were never
  measured because their object kind could not carry the selector variable. Without it a page-heavy
  project got a confident-looking score computed over a fraction of its code.
- **`guardObserved` per mutant** (R46) — whether any instrumented guard actually fired for a
  mutant's runs. Deliberately asymmetric: `false` is decisive (the mutation was never in play, so
  the mutant belongs with `no-coverage`, not with findings), `true` is weak (some selector fired
  somewhere in the artifact), and absent means not measured. First measurement on Document Output:
  86 of 86 survivors `true`.
- **Stale-test-app detection** (R31). The runner discovers tests from source while the server holds
  an older published set; mutants then fall to `no-coverage` and read as a scoring problem rather
  than "your published test app is older than your source". Cost two debugging sessions before it
  was detected. Reported as `staleTestApp.missingTests` with a `stale-test-app` caveat.
- **al-runner startup canary** (R7/R8) — the two known al-runner defects are now re-measured against
  the binary actually configured, every session, instead of repeating a claim frozen at the date
  someone last checked by hand. The verdict is attached to the report, not only printed to stderr.
- **Permission canary** (R26/R27) reporting whether the fenced path can write, plus a targeted
  diagnosis when a test is refused: the failure note names the likely missing
  `TestPermissions = Disabled`, quotes BC's own refusal text, and says what to declare.
- **Env-tool crash-recovery records are now read** (R17). `~/.lethal/env-state/<runId>.json` had a
  writer and no reader, so the recovery story for a leaked environment was a file nobody looked at.
- **Resource files reach the compiler** (R39). The batch project copied only `*.al`, so a real app's
  logo, translations, layouts and permission XML never arrived and `alc` stopped at
  `AL1001: Source file 'Images\Logo.png' could not be found` before compiling a line. Basename
  collisions among `.al` sources are now detected and refused naming both files, instead of silently
  dropping one.

- **`--mutant-timeout-ms`, `--resume` and `--resume-run`** (R47). One slow or hanging
  (mutant, test) pair used to cost the entire run: the per-mutant budget was a hardcoded floor with
  no config surface, and exceeding it is indistinguishable from "the server may still be executing
  this", so the session quarantines. `--resume` recovers an aborted run by skipping only the
  execution of mutants already scored — verdicts are carried by IDENTITY, so an edited site stops
  matching and re-batching is survivable, while coverage attribution and covering-test lists still
  come from the resumed run.
- **`--retry-stranded`** (R53), and skipping stranded mutants by default. A mutant that never
  terminates — measured: `until Rec.Next() = 0;` negated to `<> 0` — reproduces its own quarantine
  on every retry and blocks every mutant behind it. It is now recorded as an unmeasured error and
  stepped over, so the run completes.
- **`--allow-large-run`** and a pre-flight size refusal (R48). An unscoped run on a real project
  costs days and usually cannot publish at all, so it is refused before anything is deployed, naming
  every narrowing lever. `--dry-run` prints the same limit instead of refusing.
- **`envTool.requireStatus`** (R34). A reused environment that has idled is refused by name rather
  than resolving a dead endpoint and failing minutes later inside the transport. The expectation is
  config-declared; no vendor's status vocabulary lives in LethAL.
- **`MutantOutcome.carried`** (R54) — provenance for a verdict a resume reused rather than measured.

### Fixed

- **False survivors from coverage attribution** (R29) — the worst output a mutation tool can
  produce, and it was live. BC does report table-trigger coverage, but `SymbolReference.json`
  records no trigger, so the lookup missed, the fallback scanned *local* procedures (empty for a
  table whose procedures are public), and the observation was dropped entirely. Measured on the
  Phase-1 fixture: **10 of 20 survivors were false**. Each was driven through the fenced path
  against its intended killer and killed — 53/20/2 became the honest 63/10/2. Perversely, a table
  with public procedures scored *worse* than one with none, and every real app is in the losing
  category.
- **Instrumented codeunits that declare object properties did not compile** (R38). The selector
  variable was anchored before the object's properties; AL requires properties before any `var`
  section, so `alc` read `Permissions` as a variable name and never recovered. On Document Output:
  **19 of 162 instrumented files, 246 alc errors, whole-app compile fails, zero mutants runnable**.
  Note tree-sitter recovers from the bad ordering with no ERROR node, so the error-node count was
  structurally blind to it — `alc` is the authority here.
- **Declarative page properties were claimed as mutation sites** (R40). An AL page property parses
  with statement syntax (`SubPageLink` reads `"No." = field("Customer No.")`), so
  `negate-conditional` / `conditional-boundary` matched 204 sites that are not executable AL at
  all; one aborted a whole session. Now filtered once at spec generation, counted and warned rather
  than dropped silently.
- **Coverage keyed on `(objectType, objectId)`** rather than the bare id — a table and a codeunit
  sharing an id sent a trigger mutant at the wrong object's tests.
- **Per-mutant time budget floored at 30 s** — an unfloored `2 x baseline` quarantined a cold start
  as in-flight-unknown.
- **Stale `LethAL Control` builds are named** (R25). A control app older than its AL source
  published fine and then failed harness verification with BC's confusing
  `the parameter 'clientProtocol' ... is not a valid parameter` — confusing precisely because the
  endpoint exists and answers, it just rejects an argument added later.
- **A configured `envTool` section is no longer silently ignored under `--backend al-runner`** (R18),
  and env-tool mode no longer hard-requires `altool.exe` on a path that never uses it (R21).
- **`itest:tables` runs its session twice** and asserts run-to-run equality (R9), matching the other
  gates, so cross-run nondeterminism surfaces as a determinism failure rather than a confusing
  per-mutant baseline mismatch.

- **The compiled binary could not parse a single line of AL** (R50). Both wasm assets resolved
  relative to `import.meta.url`, which under `bun build --compile` is Bun's virtual root. The unit
  suite is structurally blind to this — it runs interpreted, where the relative resolve is correct —
  so it was caught by running the produced binary from a foreign cwd, not by a test.
- **`lethal --help` exited 1 with a `TypeError`** (R49), for the first flag a new user types.
- **`force-reset-lease` could not reach an env-tool environment** (R51). It built its URL with
  port-7048 injection and ignored `bcdev.baseUrl`, so the documented recovery procedure was
  unreachable on the one setup that most needs it — a proxy-severed run. The instance must now match
  a path SEGMENT of the configured URL, because a substring check passes a one-character instance
  against almost any hostname.
- **A stale `LethAL Control` build was undetectable** (R28). `HarnessInfo` reported a hardcoded
  version, so every new client action failed in its own way instead of the harness saying once that
  the control app predates the client.
- **`--resume` preferred an empty aborted run over one holding verdicts** (R52), which is the
  situation recovery is for.
- **A resumed run's phase clocks did not add up** (R54): `mutantsMs` counted durations carried from
  a prior run, and `overhead`'s clamp hid the resulting contradiction as a plausible `0.0s`.
- **Verdicts from an unattested artifact were corrected in memory only** (R47). The fail-closed
  attestation gate relied on a quarantined run never being marked finished; `--resume` selects on
  exactly that condition, so the correction is now durable.

### Known limitations

- **The al-runner backend is not authoritative.** `asserterror` never fails a test there (R7), so
  a mutant killable only by an `asserterror` assertion is reported as survived. Under-reporting
  only, never a false kill. A table global written by a trigger is also dropped (R8). Re-confirm
  survivors under `--backend bcdev` before acting on them.
- **`--workers > 1` is refused with `--backend bcdev`.** Mutant activation is a single server-side
  record shared by every worker, so concurrent workers would overwrite each other's active mutant.
  Real parallelism needs per-container isolation.
- **Single-tenant containers only, unenforced** (R2). AL cannot enumerate tenants from an extension,
  so the lease cannot fence a second tenant. Verify single-tenancy out of band.
- **A file declaring two AL objects** is handled only when every object in it is injectable (R6).
- **Enums and queries are still never mutated**, and `xmlport` remains uninstrumented (R40 covered
  page, report, `pageextension` and `tableextension`).
- **A mutant that never terminates is not scored, only stepped over** (R53). AL cannot preempt a
  running loop, so LethAL sees only its own client-side abort, which it must treat as "the server
  may still be executing this". Such a mutant arguably SHOULD count as killed (a timeout is
  observable misbehaviour), but scoring it needs `RunMutant` to return a terminal timed-out result —
  an AL change plus a protocol bump. Today it is recorded as an unmeasured error, and `--resume`
  steps over it so the rest of the run completes.
- **Coverage collection makes some tests fail, which under-reports what the suite exercises**
  (R55). Measured on Document Output: with the default `coverageMode`, 12 of 56 tests fail and the
  baseline goes red; with coverage off the same tests on the same environment all pass. The knock-on
  is that 14 mutants are reported `no-coverage` when the suite does execute them — which tells a
  reader to write a new test when the real answer is to strengthen an existing one. Safe direction
  (no false kill, no false survivor), but the mechanism is not yet established.
- **Hosted environments can time out on publish** (R44). The proxy cap is real and unraisable from
  the client; `--max-guards-per-batch` is what keeps LethAL from asking it to swallow an unbounded
  artifact.

<!-- No link-reference definitions for the version headings yet: this repository has no configured
     git remote (`git remote -v` is empty as of 2026-07-27), so there is no release page or compare
     view to point at. Add them when a remote exists — see docs/releasing.md. -->
