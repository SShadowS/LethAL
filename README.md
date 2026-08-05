# LethAL

Mutation testing for Microsoft Dynamics 365 Business Central AL code. It tells you which of your AL tests actually catch bugs.

[![Release](https://img.shields.io/badge/release-0.1.0--alpha.1-orange)](CHANGELOG.md)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)
[![AL](https://img.shields.io/badge/target-Business%20Central-orange)](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-dev-overview)

> **Alpha.** The tool is honest about its limits rather than complete. See [Limits](#limits) before
> quoting a score. Read [`CHANGELOG.md`](CHANGELOG.md) for what shipped and what did not.

## What it does

LethAL makes small, deliberate breakages in your AL code (flips a `<` to `<=`, empties a block, drops a `TestField`, changes a return value), then runs your tests against each one. A test suite that stays green while the code is broken is not protecting you.

Each mutant comes back as one of three verdicts:

| Verdict | Meaning |
|---------|---------|
| **killed** | A test failed. That code path is genuinely covered. |
| **survived** | Every test still passed. Nothing checks that behaviour. |
| **no-coverage** | No test *reachable by coverage attribution* executes that code. Sometimes an under-report; see [Limits](#limits). |

## A worked example

**1. Your app code** (`--project`). The only thing LethAL ever mutates. One procedure, one comparison:

```al
codeunit 50100 "Pricing"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
```

**2. Your test code** (`--tests`), which LethAL never touches. It is not mutated and not rewritten.
LethAL does not even publish it: publishing the test app stays your own workflow, and LethAL only
discovers the tests inside it and asks the server to run them.

```al
codeunit 50101 "Pricing Tests"
{
    Subtype = Test;

    var
        Pricing: Codeunit "Pricing";

    [Test]
    procedure TestOverBudget()
    begin
        if not Pricing.IsOverBudget(101, 100) then
            Error('101 vs 100 must be over budget');
        if Pricing.IsOverBudget(99, 100) then
            Error('99 vs 100 must not be over budget');
    end;
}
```

**3. Three operators claim a site in the app code.** The test app contributes none. That is the whole
mutant set for this procedure:

| Mutant | Operator | Change |
|--------|----------|--------|
| `M0001` | `lethal.empty-block` | the procedure body becomes `begin end` |
| `M0002` | `lethal.return-value` | `exit(Amount > Budget)` becomes `exit(not (Amount > Budget))` |
| `M0003` | `lethal.conditional-boundary` | `Amount > Budget` becomes `Amount >= Budget` |

**4. All three ship in ONE published app**, each behind a runtime guard, not three
compile-and-publish cycles. This is what LethAL emits (reformatted here for reading; the emitter
does not indent, and nothing human ever has to):

```al
codeunit 50100 "Pricing"
{
  var
    MutationSelector: Codeunit "Mutation Selector";

  procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
      if MutationSelector.Active('M0001') then begin
        begin end;
      end else if MutationSelector.Active('M0002') then begin
        begin
            exit(not (Amount > Budget));
        end;
      end else if MutationSelector.Active('M0003') then begin
        begin
            exit(Amount >= Budget);
        end;
      end else begin
        begin
            exit(Amount > Budget);
        end;
      end;
    end;
}
```

**You never see this code, and it never enters your repo.** LethAL copies your project into a scratch
directory under the OS temp dir, mutates the copy there, compiles that, and publishes it. Your source
tree is not modified and there is nothing to revert. The AL above is a throwaway build artifact, a
petri dish. The only output you read is the report in step 5. What *does* persist is on the server: the
instrumented build stays published until you republish your own app, which is why LethAL is for a
sandbox or dev container, never a production tenant.

The final `else` is your original code, so with no mutant active that published app behaves exactly as
yours does. Mutants that overlap the same statement become **siblings in one flat chain**, never
nested guards: N mutants cost N+1 branches, not 2^N. The `Mutation Selector` codeunit reads which
mutant is active from a table the `LethAL Control` extension owns, so activating the next mutant is a
table write, with no republish.

**5. LethAL activates one mutant at a time** and runs the tests coverage says reach it:

```
mutant   file:line                          operator                     verdict          killing test
M0001    src/Pricing.Codeunit.al:5          lethal.empty-block           killed           Pricing Tests.TestOverBudget
M0002    src/Pricing.Codeunit.al:5          lethal.return-value          killed           Pricing Tests.TestOverBudget
M0003    src/Pricing.Codeunit.al:5          lethal.conditional-boundary  survived
score: 66.7%  (killed 2, survived 1, no-coverage 0, ...)
SURVIVORS BY PROCEDURE (1 with survivors):
    1 survived  Pricing.IsOverBudget  (2 killed, 0 no-coverage)
```

`M0003` is the finding, and you can read it straight off the test in step 2. That test pins the answer
at 101 vs 100 and at 99 vs 100, but never at 100 vs 100, and `>` differs from `>=` only when the two
are equal. So no assertion it makes can tell the mutant from your code. The other two mutants both
change the answer at 101 vs 100, where the first `Error` catches them. The report carries enough to act
on that without re-deriving anything:

```json
{
  "mutantCode": "M0003",
  "operatorName": "lethal.conditional-boundary",
  "verdict": "survived",
  "file": "src/Pricing.Codeunit.al",
  "line": 5,
  "procedureName": "IsOverBudget",
  "originalText": "Amount > Budget",
  "mutatedText": "Amount >= Budget",
  "coveringTests": ["Pricing Tests.TestOverBudget"],
  "coverageAttribution": "exact",
  "guardObserved": true
}
```

`coverageAttribution: "exact"` means that test genuinely executed *this* procedure, not merely
something in the same object; `guardObserved: true` means an instrumented guard fired while it ran.
Together they separate "your test reaches this code and does not check it" from "nothing ran it at
all", which is the distinction the [Limits](#limits) section is about.

Here that first reading is right, so the fix is one more assertion in the test that already covers the
procedure:

```al
        if Pricing.IsOverBudget(100, 100) then
            Error('equal amounts must not be over budget');
```

*(The AL in steps 1, 2 and 4 is real: both source snippets compile under `alc`, and step 4 is this
repo's own emitter output for step 1. The step 5 verdicts follow from the step 2 test by inspection
rather than from a recorded run, so read them as worked through, not measured. The frozen live-gate
figures under [Testing](#testing) are the measured ones.)*

## Overview

| Metric | Value |
|--------|-------|
| Release | 0.1.0-alpha.1 |
| Language | TypeScript (Bun workspaces) |
| Target | AL / Business Central, control extension runtime 16 |
| Mutation operators | 9 total: 5 Tier-1 (generic), 4 Tier-2 (AL-specific) |
| Object kinds instrumented | codeunit, table, page, report, pageextension, tableextension |
| Backends | `bcdev` (live BC, authoritative), `al-runner` (offline, **not** authoritative) |
| Concurrency safety | Machine-global lease + per-run two-phase fence |
| Unit tests | 1,486 |
| Largest project measured | 19,832 mutation sites across 438 files (a real commercial extension) |

## Features

| Feature | Description |
|---------|-------------|
| **Mutant schemata** | One instrumented artifact carries every mutation behind runtime guards, not N compiles |
| **AST-based mutation** | Operates on a real AL parse tree (tree-sitter-al), never on text |
| **Live BC execution** | Runs the covering test headlessly inside Business Central over OData |
| **Coverage-aware** | Distinguishes "no test caught it" from "no test runs it at all", and records which attribution path decided |
| **Actionable survivors** | Each survivor carries its original and mutated text, procedure, covering tests, and a per-procedure rollup, enough for a human or an agent to act without re-deriving anything |
| **Scoped runs** | `--only` narrows mutants, `--tests-only` narrows the baseline, `--max-guards-per-batch` bounds each published artifact |
| **Resumable** | An aborted run is continued with `--resume`; verdicts already measured are not thrown away |
| **Deployment identity** | Verifies the app under test is the artifact it compiled, and refuses to record a verdict otherwise |
| **Concurrency-safe** | A machine-global lease stops two runs on one container from interleaving and producing a false verdict |
| **Two-phase fence** | Every mutant run proves it holds the lease at claim *and* at result-recording, or the result is discarded |
| **Lost-ack recovery** | An unreadable response is reconciled against the server's own operation marker instead of assuming the worst |
| **External environments** | A hosted environment owned by a third-party CLI is driven through config-declared commands, with no vendor knowledge in LethAL |
| **Named refusals** | A test BC refused — permissions, or a `TestPage` the session cannot create — is reported with its cause and BC's own words, not as an unexplained baseline failure |
| **Runner provenance** | Every verdict records which session type produced it, and the report states each execution context it actually used rather than asserting one |
| **Operator recovery** | `lethal force-reset-lease` and `lethal clear-quarantine` recover a container stranded by a dead session |
| **Diagnostics** | `lethal doctor` runs every pre-flight check it can answer read-only (environment status, quarantine, control-app version, `alc`/`altool`) all at once, instead of `lethal run` discovering them one at a time — and states plainly what it cannot check yet |

## Prerequisites

Running the released binary needs **no Bun, Node or npm**. You do need:

- A Business Central container, dev server, or hosted sandbox, which must be **single-tenant** (see [Limits](#limits))
- The AL Language VS Code extension, which supplies `alc` and `altool` (LethAL picks the `bin/`
  build matching your host — Windows, Linux or macOS)
  - or `bcdev.alcPath` / `bcdev.altoolPath` in your config pointing at any `alc` / `altool`, if
    your server needs specific tool builds. The two are independent: they may name different
    builds, and together they replace the extension install entirely
- For the `bcdev` backend: a reachable `bc-dev-mcp` endpoint
- The `LethAL Control` extension published on the target server (built from `extensions/lethal-control`)

Building from source additionally needs [Bun](https://bun.sh) 1.x.

## Installation

Download the binary for your platform from the releases page, then:

```bash
lethal --help
```

Or from source:

```bash
git clone <repo-url> LethAL
cd LethAL
bun install
bun run typecheck
rm -rf packages/*/dist     # AFTER typecheck, BEFORE bun test
bun test
bun run build:binary       # optional: produce a standalone executable in build/
```

See [`docs/releasing.md`](docs/releasing.md) for how a release is cut.

## Usage

Start with a dry run. It tells you how big the job is without touching a server:

```bash
lethal run --project path/to/your-al-app --dry-run
```

A first real run should be **scoped**. An unscoped run on a real project is refused by default,
because it costs days and usually cannot even publish (see [Limits](#limits)):

```bash
lethal run \
  --project path/to/your-al-app \
  --tests   path/to/your-test-app \
  --backend bcdev \
  --config  lethal.config.json \
  --only       "src/Posting/**" \
  --tests-only "src/Posting/**" \
  --out        report.json
```

If a run aborts partway, continue it instead of starting over:

```bash
lethal run ... --resume
```

`lethal run` discovers a stopped environment, a stale control app, a quarantined tier, or a
missing `alc`/`altool` one at a time, each only after whatever ran before it. Check all of them at
once, read-only, before spending time on a real run:

```bash
lethal doctor --config lethal.config.json
```

Recovery, when a session died mid-run and left the container held:

```bash
# clears the SERVER-side lease and operation marker
lethal force-reset-lease --server http://YourContainer --instance BC --config lethal.config.json

# clears the LOCAL durable quarantine record
lethal clear-quarantine --server http://YourContainer --instance BC
```

From a source checkout, replace `lethal` with `bun packages/runner/src/cli.ts`.

## Configuration

`lethal --help` is the authoritative list. The flags that change what a run **measures**:

| Flag | Default | Description |
|------|---------|-------------|
| `--project` | *(required)* | AL project directory to mutate |
| `--tests` | *(required)* | Test project directory (omit only with `--dry-run`) |
| `--backend` | *(required)* | `bcdev` or `al-runner` |
| `--only <glob>` | *(all files)* | Only these files contribute mutants. Repeatable. Cannot change a verdict, because every file is still parsed, compiled and published |
| `--tests-only <glob>` | *(whole suite)* | Only these test files run at baseline. Repeatable. **Can change a verdict**: excluding a killing test manufactures a survivor. Flagged `tests-narrowed` in the report |
| `--skip-known-survivors` | `false` | Skip mutants a prior finished run recorded as survivors |
| `--dry-run` | `false` | Plan mutants without executing them |

Cost and recovery:

| Flag | Default | Description |
|------|---------|-------------|
| `--max-guards-per-batch <n>` | *(unbounded)* | Guards per published artifact. Publish cost scales with guard count, since BC recompiles server-side |
| `--mutant-timeout-ms <n>` | `30000` | Floor for a mutant's time budget. The budget is `max(2 × that test's baseline, this)` |
| `--resume` / `--resume-run <id>` | *(none)* | Continue an aborted run, reusing verdicts it already measured |
| `--retry-stranded` | `false` | On resume, retry mutants that stranded the tier. Skipped by default: a mutant that never terminates blocks every mutant behind it |
| `--allow-large-run` | `false` | Run more than 1,000 mutation sites |
| `--workers <n>` | `1` | Parallel shards (rejected for the authoritative backend) |

Environment and output:

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | `<project>/lethal.config.json` | Server, company, credentials, optional `envTool` section |
| `--db <path>` | `<project>/lethal.sqlite` | Results database |
| `--out <path>` | *(none)* | Write the JSON report here |
| `--progress-out <path>` | *(none)* | Stream events to this file as NDJSON, one object per line, flushed as each arrives — a crash diagnostic and a structured feed for agents/CI. Verdict lines are provisional until `session-finished`: a later `batch-invalidated` event can supersede one already written |
| `--selector-id` / `--control-id` / `--table-id` | `79197` to `79199` | Override the injected object ids, e.g. when your `idRanges` exclude the defaults |
| `--keep-env` / `--allow-expiring-env` | `false` | Env-tool session controls |

Exit codes: `0` ok, `1` error, `3` quarantined, meaning the run refused to vouch for its own verdicts.

## Architecture

```
    AL source
      |
      v  tree-sitter-al
    engine ............... AST, MutationSpec, semantic layer
      |
      +-- builtin-tier1 .. conditional-boundary, negate-conditional, empty-block,
      |                    return-value, void-method-call
      +-- builtin-tier2 .. remove-testfield, remove-setrange, remove-calcfields,
      |                    swap-modify-flag  (AL-specific; reach table triggers)
      v
    schemata ............. ONE instrumented artifact, all mutants behind guards
      |
      v
    runner ............... orchestrator + backends + results store
      |
      |--- acquire machine-global lease ----------------+
      |--- beginPublish -> publish -> endPublish        |
      |--- per mutant: phase 1 claim / run / phase 3 verify-and-clear
      |--- release (op-gated)                           |
      v                                                 |
    Business Central <-----------------------------------+
      \__ LethAL Control extension (lease, fence, headless test invocation)
```

The `LethAL Control` AL extension owns the state a republish of your app cannot reset: the active-mutant row, the artifact registry, and the lease.

## Key Files

| File | Purpose |
|------|---------|
| `design.md` | Authoritative architecture |
| `ROADMAP.md` | Open work, measured-but-unclosed risks, and known product gaps |
| `CHANGELOG.md` | What shipped in each release |
| `packages/engine` | AL AST, `MutationSpec`, semantic analysis |
| `packages/builtin-tier1` / `-tier2` | The mutation operators |
| `packages/schemata` | Instrumentation and compilation into one artifact |
| `packages/runner/src/orchestrator.ts` | Session lifecycle, lease, verdict recording |
| `packages/runner/src/lease.ts` | `LeaseClient`: acquire / renew / release / fence ops |
| `packages/runner/src/resume.ts` | Which prior verdicts a `--resume` may reuse, and why |
| `extensions/lethal-control` | The BC extension: lease table, two-phase fence, headless runner |
| `docs/do-trial-runbook.md` | Reproducing the run against a real commercial product |
| `docs/measurements/` | Probes behind claims about BC behaviour, so they can be re-checked |
| `fixtures/README.md` | Live container setup and the recovery procedure |

## Testing

```bash
bun run typecheck          # tsc --build --force
rm -rf packages/*/dist     # AFTER typecheck, BEFORE bun test
bun test                   # unit suite
```

Integration suites are env-gated, take minutes, and run against a live server. Each has a **frozen
per-mutant baseline**, where a differing verdict is a regression, never "close enough":

| Command | Proves | Frozen |
|---------|--------|--------|
| `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` | End-to-end verdicts against real BC | 3 killed / 10 survived / 3 no-coverage |
| `LETHAL_ITEST_TABLES=1 bun run itest:tables` | Tier-2 operators, table-trigger and extension-object mutation | 69 / 9 / 6 |
| `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` | An externally-owned environment, reached through config | 3 / 10 / 3 |
| `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` | The al-runner backend | 3 / 13 / 0 |
| `LETHAL_ITEST_BCDEV=1 bun run itest:lease` | Lease lifecycle, contention, recovery | n/a |
| `LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish` | Publish serialization and staleness | n/a |

## Limits

Stated plainly, because a mutation-testing tool that overstates its guarantees is worse than none.

Several entries below cite measurements taken against one real commercial extension, **Continia
Document Output** (438 of its 551 `.al` files carry mutation sites; 19,832 sites when the earlier
entries below were measured, 19,850 on 2026-07-31 — the app and the grammar both move), because that
is where these failure modes were actually observed rather than reasoned about. "Document Output" always means that app; it is not
a LethAL feature or a mode.

- **Coverage and verdicts come from one runner** (the fenced `RunMutant` session, since the R58
  rollout made `coverageMode: "fenced"` the default). The older failure this replaces is worth
  remembering because it is what the legacy `coverageMode: "procedure"` still does if selected:
  the baseline ran on a different session type than the mutants, 12 of 56 Document Output tests
  failed on that runner and took their coverage out of the green set (14 mutants misreported
  `no-coverage`), and a coverage-attribution defect (R63) credited tests with procedures they
  could not execute, so 77 mutants scored `survived` against tests that never ran the mutated
  code. Under the default, `no-coverage` means exactly "no green test executed this on the
  runner that produces verdicts".

  That mode is not dead, though, and the `TestPage` entry below is why: it is currently the only way
  to keep a run alive when the suite contains a test that opens a real page. Choosing it means
  accepting the dual-runner disagreement described above — the report names any test that disagrees.
- **Every verdict describes your app's NON-GUI branch** (R60). LethAL executes every mutant in a
  `GuiAllowed=No`, `ClientType=ODataV4` session, while a developer running the same suite from VS
  Code runs GUI-allowed. A handler-less `Confirm` returns its default silently instead of raising
  `Unhandled UI`, and code guarded by `GuiAllowed` or branching on `Confirm`/`Message`/
  `Page.RunModal` takes the non-interactive path, so a mutant inside a GUI-only branch can never be
  killed here, and reads as `survived` or `no-coverage` when the truth is that LethAL never ran it.
  Measured on Document Output: nine statement-generation procedures are executed by NO test on
  either runner, because the tests flip the customer to Manual at an earlier guard. That is a
  test-suite finding, not a tool finding, but the tool cannot tell the two apart for you yet.

  **How much AL this affects, measured** (`scripts/measure-gui-guarded.ts`, 2026-07-31, whole app):
  **62 of 19,850 mutation sites — 0.3% — sit lexically inside a `GuiAllowed`- or `Confirm`-guarded
  branch.** That is a lower bound (it does not follow calls into procedures invoked only from a
  guarded branch), but it is not hiding a large category: the `if not GuiAllowed then exit;` shape,
  which guards a whole procedure without any site being lexically inside the `if`, occurs **3 times
  in 551 files**. The same script reports 5.7% as an upper bound, but that figure counts every site
  in any procedure merely *mentioning* an interactive construct, and it is dominated by `Message`,
  which is a no-op under `GuiAllowed=No` and causes no unreachability at all.

  The three constructs are not interchangeable, and the difference decides what you should worry
  about: `Message` is a no-op; `Confirm` does not skip its branch but **forces the default answer**,
  so it is the non-default arm that becomes unreachable; `Page.RunModal` **errors**, which can fail
  a test for a reason unrelated to the mutant (95 uses in Document Output). Every report states the
  execution context in `validity.executionContext` and on the console, on every run.
- **A survivor is a lead, not a proven test-suite gap.** What *has* been established, on a real
  commercial product: coverage selection does not hide kills. Two runs of one Continia Document
  Output codeunit, identical except for coverage mode, compared per-mutant across all 138 mutants:
  **no mutant reported `survived` or `no-coverage` under selection was killable by the full suite.**
  That is the failure mode that once made 10 of 20 fixture survivors false, and it is empty here.
  What is still **not** established is that any individual survivor is non-equivalent: some
  survivors are unkillable by any test. Read `validity` before quoting `mutationScore`.
- **Unscoped runs on a real project are refused by default.** 19,832 mutation sites is days of
  execution, and the artifact carrying every guard is typically rejected by a hosting proxy before
  it publishes. Use `--only`; `--allow-large-run` overrides.
- **Single-tenant servers only.** App publication is service-instance-wide, so a second tenant
  publishing to the same instance is outside the lease entirely. Documented, **not enforced**, since
  AL cannot enumerate tenants from an extension. Verify out of band with `Get-BcContainerTenants`.
- **`al-runner` is not authoritative.** Measured: its `asserterror` never fails a test, so mutants
  killable only that way come back survived there while `bcdev` kills them. Under-reporting only,
  never a false kill; a startup canary measures the actual binary each session and says so. Use it
  for offline smoke-testing, not for a score.
- **A mutant that never terminates is stepped over, not scored.** AL cannot preempt a running loop,
  so LethAL sees only its own abort and cannot tell it from "the server is still working". Such a
  mutant is recorded as an unmeasured error; `--resume` skips it so the run completes rather than
  dying on it forever.
- **Tier 3 not built.** Nine operators across two tiers today; the advanced set is designed only.
  (Tier-2 operators *do* now claim sites inside `tableextension` and `pageextension` bodies — that
  limit was closed. A `pageextension`'s implicit `Rec` is still refused deliberately: it resolves to
  the extended page's `SourceTable`, which the project usually cannot see, and guessing would claim
  sites wrongly. Measured on a real extension: zero sites would have been gained by guessing.)
- **A test that opens a `TestPage` cannot be scored, and on the default path one can end your whole
  run.** The default fenced session (`GuiAllowed=No`, `ClientType=ODataV4`) cannot create the test
  service a `TestPage` needs. What happens next depends on the page, which is the part worth
  knowing:

  | Page | Fenced (default) | Hub (`coverageMode: "procedure"`) |
  |------|------------------|-----------------------------------|
  | Trivial, no logic | refused in ~87 ms; run completes | opens fine |
  | Real (triggers, FlowFields, a `pageextension` writing on open) | **hangs — the session quarantines and the ENTIRE run scores nothing** | opens and passes in ~451 ms; run completes |

  Both rows are measured, repeatedly, on real containers. The hang is the severe case: one such test
  at baseline takes every other test and every mutant down with it, not just its own. `--stop-hung-sessions`
  does **not** rescue it — it makes the failure faster, not survivable, because the baseline loop
  quarantines on the forced-stop result exactly as it does on a hang.

  **Mitigation that works today:** run with `coverageMode: "procedure"`, which routes baseline
  discovery to the bcdev hub. Measured: the run completes and everything else gets scored. Note the
  trade R58 made deliberately when it moved off that mode — the hub runs `GuiAllowed=Yes`, so it can
  disagree with the fenced runner about a test's outcome.

  **What is still not recovered:** mutant *verdicts* always execute on the fenced path regardless of
  coverage mode, so a mutant covered only by `TestPage` tests still receives no verdict — it is
  reported unscoreable with the refusal named, never guessed at. Recovering those verdicts is built
  but deliberately not wired; see ROADMAP R69/R74/R75.
- **Procedure-level coverage** from the `bcdev` backend, so `no-coverage` means no test calls that
  procedure. Coverage for extension objects is object-level only.
- **A red baseline bounds what any run can measure.** Tests that fail before mutation are named in
  the report, and their mutants are reported unscoreable rather than silently counted.
- **AL has no unit-test harness here.** Changes to the control extension are verified by an offline
  `alc` compile plus the live gates.

---

**Author**: Torben Leth (sshadows@sshadows.dk)
**License**: none declared yet. Add a `LICENSE` file before distributing.
