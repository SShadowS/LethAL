# LethAL

Mutation testing for Microsoft Dynamics 365 Business Central AL code. It tells you which of your AL tests actually catch bugs.

[![Release](https://img.shields.io/badge/release-0.1.0--alpha.2-orange)](CHANGELOG.md)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)
[![AL](https://img.shields.io/badge/target-Business%20Central-orange)](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-dev-overview)

> **Alpha.** The tool is honest about its limits rather than complete. See [Limits](#limits) before
> quoting a score. Read [`CHANGELOG.md`](CHANGELOG.md) for what shipped and what did not.

## What it does

LethAL makes small, deliberate breakages in your AL code (flips a `<` to `<=`, empties a block, drops a `TestField`, changes a return value), then runs your tests against each one. A test suite that stays green while the code is broken is not protecting you.

The technique is called **mutation testing**, and it is long established outside the BC world; what
is new here is the AL implementation, not the idea. It answers a question a coverage report cannot:
coverage tells you a line **ran**, mutation tells you a line is **checked**. If the line's behaviour
can change and every test still passes, running it proved less than the coverage number suggested.

LethAL calls each deliberate change a **mutant**. A mutant is **killed** when one of your tests
fails. Your suite caught it, which is the good outcome. It **survives** when every test still
passes, which means nothing you have written notices that behaviour. It is **no-coverage** when no
test runs that code at all. The share your tests killed is the **mutation score**.

**Your source tree is never modified.** LethAL copies your project into a scratch directory under
the OS temp dir, changes the copy there, compiles that, and publishes it. There is nothing to
revert. What *does* persist is on the server: the modified build stays published until you
republish your own app, which is why LethAL is for a **sandbox or dev container, never a production
tenant**. Your test project is never touched at all: LethAL does not even publish it.

## Prerequisites

Running the released binary needs **no Bun, Node or npm**. You do need:

- A Business Central container, dev server, or hosted sandbox, which must be **single-tenant** (see [Limits](#limits))
- The AL Language VS Code extension, which supplies `alc` and `altool` (LethAL picks the `bin/`
  build matching your host: Windows, Linux or macOS)
  - or `bcdev.alcPath` / `bcdev.altoolPath` in your config pointing at any `alc` / `altool`, if
    your server needs specific tool builds. The two are independent: they may name different
    builds, and together they replace the extension install entirely
- For the `bcdev` backend: `bc-dev-mcp`. You do not host or start anything. LethAL runs it for you.
  You name the command in your config (`bcdev.mcpCommand`, e.g. `["bun", "x", "bc-dev-mcp"]`) and
  each run spawns its own
- The `LethAL Control` extension published on your server. It is a small AL app that lives in this
  repo; step 2 of [Quick start](#quick-start) builds and publishes it

Building from source additionally needs [Bun](https://bun.sh) 1.x.

## Installation

There is no published release yet, so build it yourself. This produces a standalone `lethal`
executable in `build/` that needs no Bun, Node or npm to run:

```bash
git clone <repo-url> LethAL
cd LethAL
bun install
bun run build:binary
```

Check what you built. `--version` reports the commit it came from and the mutation operators it
can actually apply, so a stale binary cannot pass for a current one:

```bash
./build/lethal-0.1.0-alpha.2-windows-x64.exe --version
```

Everywhere below, `lethal` means that executable. From a source checkout you can skip the build and
run `bun packages/runner/src/cli.ts` instead. See [`docs/releasing.md`](docs/releasing.md) for how a
release is cut.

## Quick start

Four steps from a checkout to a first result. Do them against a **sandbox or dev container**, never
a production tenant, for the reason in step 3.

**1. Write `lethal.config.json` next to your AL app.** `lethal init --project path/to/your-al-app`
writes one for you, including the three injected object ids picked from your own app.json id ranges
(the one field nobody can guess, and the one whose absence fails at publish time). Fill in the
server and credentials it leaves as placeholders.

To write it by hand instead, every field below is required; LethAL refuses to start and names any
that are missing. The user and password are placeholders, so put your own in:

```json
{
  "bcdev": {
    "mcpCommand": ["bun", "x", "bc-dev-mcp"],
    "server": "http://YourContainer",
    "serverInstance": "BC",
    "company": "CRONUS",
    "username": "admin",
    "password": "pw",
    "packageCachePath": "C:/path/to/your-al-app/.alpackages",
    "controlSymbolPath": "C:/path/to/LethAL/extensions/lethal-control/lethal-control.app",
    "env": {
      "BC_DEV_USER": "admin",
      "BC_DEV_PASSWORD": "pw"
    }
  }
}
```

`env` is not optional in practice: `bc-dev-mcp` reads credentials from `BC_DEV_USER` /
`BC_DEV_PASSWORD` rather than from parameters, and the process LethAL spawns inherits only a fixed
allowlist of variables from your shell, so without this block it fails with *"Missing connection
settings: username"*. `tenant` defaults to `default`.

**2. Build and publish `LethAL Control`.** This is the one thing you install on the server. It owns
the state a republish of your own app cannot reset, which is how LethAL knows which change is
currently switched on:

```bash
# from the LethAL checkout. alc comes with the AL Language VS Code extension
alc "/project:./extensions/lethal-control" \
    "/packagecachepath:./extensions/lethal-control/.alpackages" \
    "/out:./extensions/lethal-control/lethal-control.app"
```

Publish the resulting `lethal-control.app` to your server the way you publish any other app:
`Publish-BcContainerApp -containerName <name> -appFile <path> -skipVerification -sync -upgrade`
for a container, or the VS Code publish command. Point `controlSymbolPath` at that same file.

**3. Check the setup before spending any time on a run:**

```bash
lethal doctor --config lethal.config.json
```

This changes nothing. It reports the server, the control-app version, `alc`/`altool`, and whether
anything still holds the server from an earlier run, all at once, rather than letting a real run
discover them one at a time.

**4. See how big the job is, then run a slice of it:**

```bash
lethal run --project path/to/your-al-app --dry-run

lethal run --project path/to/your-al-app \
           --tests   path/to/your-test-app \
           --backend bcdev \
           --config  lethal.config.json \
           --only       "src/Posting/**" \
           --tests-only "src/Posting/**" \
           --out        report.json

lethal explain report.json
```

Start scoped. An unscoped run on a real project is refused by default: it costs days and usually
cannot even publish (see [Limits](#limits)).

**Not ready to point it at your own app?** There are two complete BC extensions to run it against,
both of which have a green test suite that misses something real. Each runs in seconds and shows
what a survivor, a `no-coverage` row and a killed mutant look like on code you can read in one
sitting.

- [`examples/gift-card`](examples/gift-card/README.md) — one planted bug in a balance calculation,
  and the shortest path to seeing the point. 45 mutants, 70.3%.
- [`examples/credit-limit`](examples/credit-limit/README.md) — three gaps rather than one, and the
  only demo that can show `remove-calcfields`: it reads a FlowField through `CalcFields`, which the
  gift-card app deliberately does not. 32 mutants, 70.8%.

Both are frozen per mutant, so you can check a re-run against the committed baseline rather than
against a total:

```bash
lethal campaign compare --manifest examples/credit-limit/campaign.json \
                        --stage demo --report your-rerun.json
```

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

**2. Your test code** (`--tests`). LethAL discovers the tests inside it and asks the server to run
them; publishing the test app stays your own workflow.

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

**You never see this code.** It is a throwaway build, a petri dish. See
[What it does](#what-it-does) for what is and is not touched.

The final `else` is your original code, so with no change switched on that published app behaves
exactly as yours does. Switching to the next change is a table write, not another publish, which is
why one build can carry them all.

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

**6. `lethal explain report.json` states that reading rather than leaving you to derive it.** It
reads the report file and nothing else (no server, no database, no config), and for each survivor
says whether a test provably ran that procedure or only something in the same object, with a
pointer to the evidence for each claim.

What it will **not** tell you is which test to write. That is deliberate: a surviving change may be
a missing assertion, a change no test can or should catch, or behaviour nobody ever specified, and
only the first is a test problem. It states what is proven and what is not, and leaves the
judgement where the domain knowledge is.

Here the first reading is right, so the fix is one more assertion in the test that already covers the
procedure:

```al
        if Pricing.IsOverBudget(100, 100) then
            Error('equal amounts must not be over budget');
```

*(The AL above is real and compiles; the step 5 verdicts are worked through from the step 2 test
rather than recorded from a run. The frozen figures under [Development](#development) are measured.)*

## Reading the report

Beyond killed, survived and no-coverage, three verdicts show up on longer runs:

| Verdict | Meaning |
|---------|---------|
| **timeout-killed** | The change ran past its time budget and BC confirmed it stopped the session. A kill resting on a stopped session rather than a failing assertion, and the weakest evidence there is |
| **known-survivor** | Recorded as surviving by an earlier finished run and skipped this time via `--skip-known-survivors`. Carried, not re-measured |
| **error** | No verdict could be obtained. Never counted as a kill or a survivor |

**A survivor is not automatically a finding**, and this is the single most useful thing to
understand about the output. LethAL records *how* it decided which tests cover a change, in a field
called `coverageAttribution` (`attribution` in `lethal explain`), and the answer changes what
"survived" is worth:

- `"exact"`: a test provably executed **that procedure**. "These tests ran this code and did not
  notice the change" is a real gap in your tests.
- `"object"`: the tests executed *something in that object*; whether they ever reached the changed
  line is **unknown**. Treating these as weak tests sends you rewriting tests that may never have
  run it.

On a real 148-mutant run this was **19 exact against 88 object**. Reading all 107 as findings would
have meant roughly 87 pointless tests. `lethal explain` exists to make that distinction impossible
to miss.

Two more fields worth knowing. `operatorName` names the rule that produced a change. For example,
`lethal.conditional-boundary` turns `>` into `>=`. `basis` values like `R29` point at a numbered
entry under [`docs/roadmap/`](docs/roadmap/) holding the evidence for a claim, so nothing in the
output asserts something you cannot go and check.

## Commands

Each command in one line, then the detail. [Quick start](#quick-start) has the first-run sequence.

| Command | What it does | Why you'd reach for it |
|---------|--------------|------------------------|
| `lethal run` | Changes a temporary copy of your app, publishes it, and runs your tests against each change | To find the places a real bug would slip past your tests |
| `lethal run --dry-run` | Lists every change a run would try, touching no server | To see how big the job is before spending container time |
| `lethal explain <report>` | For each change your tests missed, says whether a test actually ran that code or only came near it | So you fix real gaps instead of strengthening a test that never ran the line |
| `lethal doctor` | Checks the whole setup in one read-only pass | `run` finds these problems one at a time; `doctor` lists them all first |
| `lethal clear-quarantine` | Removes LethAL's local "do not trust this server" record | It refuses to reuse that server until you say it is safe |
| `lethal clear-ceiling` | Forgets a recorded "this file is too big to publish" limit | A publish that failed once for a passing reason would otherwise block files that size forever |
| `lethal force-reset-lease` | Frees the lock a crashed run left on the server | When the next run says the server is held but you know nothing is running |
| `lethal campaign` | Freezes a baseline, checks a run against expectations committed beforehand, diffs later runs | Repeat measurement of one codebase. Not a first-afternoon feature |

If a run aborts partway, continue it instead of starting over:

```bash
lethal run ... --resume
```

`lethal run` discovers a stopped environment, a stale control app, a quarantined server, or a
missing `alc`/`altool` one at a time, each only after whatever ran before it. Check all of them at
once, read-only, before spending time on a real run:

```bash
lethal doctor --config lethal.config.json
```

A finished report states what happened; `lethal explain` states what it MEANS. It reads the JSON
file and nothing else (no server, no database, no config):

```bash
lethal explain report.json
```

The output states its own contract, in a `contract` block at the top. Read that rather than this
paragraph, which is deliberately not a second copy of it. In outline: **structure** is versioned
(`explainSchemaVersion`, plus the `derivedFromReportSchemaVersion` it came from) and **prose is
not**, because every machine-usable value is already its own field beside the sentence explaining
it. A report from another schema version, or carrying a value this build cannot interpret, is
**refused** rather than explained with the unrecognised value quietly dropped.

Measuring a real codebase is a campaign, not a run: you state what you expect in a file, **commit
it**, and only then run. `lethal campaign` is what enforces that. Each verb reads a campaign
manifest (`{"recordsDir": ..., "campaignId": ...}`), resolves the records directory it names, and
**refuses unless that stage's committed records are clean in git** before it reads a report:

```bash
lethal campaign freeze  --manifest docs/campaign/2026-08-03-do/campaign.json \
                        --stage rung1 --report report.json --expect-mutants 148
lethal campaign anchors --manifest docs/campaign/2026-08-03-do/campaign.json \
                        --stage rung1 --report report.json
lethal campaign compare --manifest docs/campaign/2026-08-03-do/campaign.json \
                        --stage rung1 --report report.json
```

| Verb | What it does | Exit |
|------|--------------|------|
| `freeze` | Archives the report and freezes its per-mutant verdicts under `<recordsDir>/<stage>.*`. Cardinality is asserted **before** anything is written, because the baseline guard *records* a baseline when none exists; a truncated report freezing itself would then agree with itself forever | `0`, or throws |
| `anchors` | Runs the stage's pre-committed anchor gate over the report. **The exit code is the gate**, not the printed text | `0` all passed, `1` a failure |
| `compare` | Diffs a report against the stage's committed per-mutant baseline, **writing nothing**. A missing baseline is refused rather than recorded, which is the whole difference from `freeze` | `0` identical, `1` differs |

`--stage <name>` names the committed files (`<stage>.precommit.md`, `<stage>.anchors.json`,
`<stage>.baseline.json`); you pick the name. A pre-commitment that is untracked, ignored,
uncommitted, modified or simply missing is refused. The whole point is that you cannot write down
what you expected after seeing the answer.

Recovery, when a session died mid-run and left the container held:

```bash
# clears the SERVER-side lease and operation marker
lethal force-reset-lease --server http://YourContainer --instance BC --config lethal.config.json

# clears the LOCAL durable quarantine record
lethal clear-quarantine --server http://YourContainer --instance BC
```

If a publish failed once for a reason that had nothing to do with size (a container restarting,
say), LethAL will keep refusing files that size. `lethal clear-ceiling` forgets that measurement:

```bash
lethal clear-ceiling --project path/to/your-al-app \n                     --server http://YourContainer --instance BC [--file Big.Codeunit.al]
```

It clears the whole server unless `--file` narrows it, prints every record it removed, and **exits
non-zero when it removed nothing**. You ran it because a file was refused, so "cleared nothing"
is a failure, not a success. The refusal message itself pre-fills this command for you.

From a source checkout, replace `lethal` with `bun packages/runner/src/cli.ts`.

## Driving it from an agent, a script or CI

LethAL is built to be called by a program: one binary, flags rather than prompts, distinct exit
codes (`0` ok, `1` error, `3` quarantined), a read-only pre-flight in `lethal doctor --json`, a
versioned JSON report, an NDJSON event stream flushed per event, and `lethal explain`, whose whole
purpose is telling a consumer what the data means rather than making it guess.

Two documents collect that contract so nobody has to derive it from the source:

- [`docs/using-lethal-from-an-agent.md`](docs/using-lethal-from-an-agent.md) — the reference: argv,
  exit codes, which of the three output surfaces answers which question, and the four rules that
  stop a caller reaching a confident wrong conclusion.
- [`skills/lethal-mutation-testing/SKILL.md`](skills/lethal-mutation-testing/SKILL.md) — the same
  contract as a copyable agent skill. Drop it into your own agent's skills directory.

Both are checked against the code by `packages/runner/tests/agent-contract.test.ts`: a flag either
document names must exist, and the exit codes and schema versions they promise must be the ones
this build returns.

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
| `--max-guards-per-batch <n>` | *(unbounded)* | Guards per published build. Publish cost scales with guard count, since BC recompiles server-side |
| `--mutant-timeout-ms <n>` | `180000` | Floor for a mutant's time budget, applied as `max(2 × that test's baseline, floor)`. An explicit value **replaces** the floor rather than stacking with it. The default is deliberately generous: too low leaves the server stuck and blocks every mutant behind it, while too high only makes a genuine hang take longer to score `timeout-killed` |
| `--resume` / `--resume-run <id>` | *(none)* | Continue an aborted run, reusing verdicts it already measured |
| `--retry-stranded` | `false` | On resume, retry mutants that left the server stuck. Skipped by default: a mutant that never terminates blocks every mutant behind it |
| `--allow-large-run` | `false` | Run more than 1,000 mutation sites |
| `--workers <n>` | `1` | Parallel shards (rejected for the authoritative backend) |

Environment and output:

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | `<project>/lethal.config.json` | Server, company, credentials, optional `envTool` section |
| `--db <path>` | `<project>/lethal.sqlite` | Results database |
| `--out <path>` | *(none)* | Write the JSON report here |
| `--progress-out <path>` | *(none)* | Stream events to this file as NDJSON, one object per line, flushed as each arrives: a crash diagnostic and a structured feed for agents/CI. Verdict lines are provisional until `session-finished`: a later `batch-invalidated` event can supersede one already written |
| `--selector-id` / `--control-id` / `--table-id` | `79197` to `79199` | Override the injected object ids, e.g. when your `idRanges` exclude the defaults |
| `--keep-env` / `--allow-expiring-env` | `false` | Env-tool session controls |

Exit codes: `0` ok, `1` error, `3` quarantined, meaning the run refused to vouch for its own verdicts.

## How it works, in short

**Measuring**

- Every change ships in **one published build**, switched on one at a time, not one compile and
  publish per change, which is what makes a run on a real project finish at all.
- Changes are made on a real AL parse tree, never by editing text, and run headlessly inside
  Business Central over OData.
- It tells "no test caught it" apart from "no test runs it at all", and records which of the two it
  decided and why.
- Runs can be narrowed (`--only`, `--tests-only`), bounded (`--max-guards-per-batch`), and continued
  after an abort (`--resume`) without discarding what was already measured.

**Why a verdict is worth believing**

- It refuses to record a result unless it can prove the build under test is the one it compiled.
- Two runs cannot share one server and corrupt each other's results.
- When it cannot get a trustworthy answer it reports an error rather than guessing, including when
  BC refuses a test outright, which is reported with BC's own words rather than as an unexplained
  failure.

**Reading and recovering**

- Every survivor carries its original and changed text, the procedure, and the tests that covered
  it, enough to act on without going back to the code.
- `lethal explain` says what a finished report *means*; `lethal doctor` checks your setup before a
  run rather than during one.
- A file too large for your server to publish is refused *before* compiling, against a limit that
  server actually demonstrated, never a hardcoded number.
- `lethal force-reset-lease` and `lethal clear-quarantine` recover a server left stuck by a dead
  run.

Design detail for all of the above lives in [`design.md`](design.md).

## The changes it makes

Fifteen operators, in two tiers. **Tier 1** is the conservative set the mutation-testing literature
has evidence for; **Tier 2** exploits AL and Business Central semantics to plant bugs a generic tool
cannot express. Where both claim the same site, Tier 2 wins.

Scope a run to a subset with `--operator <name>` (repeatable; the `lethal.` prefix is optional).
That selects which mutants run and cannot change a verdict.

### Tier 1, generic

<!-- operators: tier1 -->
| Operator | Version | Example | What weak test it catches |
|---|---|---|---|
| `lethal.conditional-boundary` | 1.0.0 | `A > 0` → `A >= 0` | an off-by-one at a boundary no test pins |
| `lethal.negate-conditional` | 1.0.0 | `A = 0` → `A <> 0` | a branch that is taken but never checked |
| `lethal.negate-guard` | 1.0.0 | `Cust.Get('X')` → `not (Cust.Get('X'))` | a plain `if Rec.Get(...) then` guard nobody tests the other side of |
| `lethal.void-method-call` | 1.1.0 | `DoThing()` → _(deleted)_ | a call whose effect nothing observes |
| `lethal.return-value` | 1.0.0 | `exit(42)` → `exit(0)` | a return value the caller never asserts |
| `lethal.empty-block` | 1.0.0 | `begin DoThing(); end` → `begin end` | a whole body nothing depends on |
| `lethal.swap-call-arguments` | 1.0.0 | `Foo(A, B)` → `Foo(B, A)` | two same-typed arguments passed in the wrong order |
| `lethal.remove-not` | 1.0.0 | `not Cust.IsEmpty()` → `Cust.IsEmpty()` | a negated guard whose two branches nobody tells apart |
| `lethal.swap-additive` | 1.0.0 | `A + B` → `A - B` | a sum or difference whose value no test checks |
<!-- /operators: tier1 -->

### Tier 2, AL-specific

<!-- operators: tier2 -->
| Operator | Version | Example | What weak test it catches |
|---|---|---|---|
| `lethal.remove-testfield` | 1.1.0 | `Rec.TestField("No.")` → _(deleted)_ | validation tests with weak assertions |
| `lethal.remove-setrange` | 1.1.0 | `Cust.SetRange("No.", 'A')` → _(deleted)_ | tests that never verify the filter |
| `lethal.remove-calcfields` | 1.1.0 | `Rec.CalcFields("No.")` → _(deleted)_ | no assertion on a computed FlowField |
| `lethal.swap-modify-flag` | 1.2.0 | `Cust.Modify(true)` → `Cust.Modify(false)` | trigger execution that no test checks |
| `lethal.remove-commit` | 1.1.0 | `Commit()` → _(deleted)_ | reliance on an implicit commit |
| `lethal.swap-rec-xrec` | 1.0.0 | `xRec.Amount` → `Rec.Amount` | before-value gaps in `OnValidate` and `OnRename` |
| `lethal.swap-find-direction` | 1.0.0 | `Cust.FindFirst()` → `Cust.FindLast()` | a suite whose fixture only ever holds one row |
| `lethal.validate-to-assign` | 1.1.0 | `Rec.Validate(Name, NewName)` → `Rec.Name := NewName` | the field value asserted, the `OnValidate` side effect not |
| `lethal.flip-filter-literal` | 1.0.0 | `Cust.SetFilter("No.", '<>%1', No)` → `Cust.SetFilter("No.", '=%1', No)` | a filter string BC re-parses at run time, never asserted |
| `lethal.swap-enum-member` | 1.0.0 | `"S"::Open` → `"S"::Released` | a state machine whose resulting state nothing asserts |
<!-- /operators: tier2 -->

The tables are generated from the operator registry, and every example is taken from the operator's
own conformance suite, which runs at registration. The one to understand is `validate-to-assign`:
the assignment leaves the field's **value correct** and deletes only the `OnValidate` trigger chain,
so a test that checks the field still passes and a test that checks the side effect does not. It is
the only operator that separates those two.

## Limits

The short version, before the evidence:

- **Sandbox or dev container only.** The changed build stays published until you republish your own
  app. Never point this at a production tenant.
- **Tests run without a GUI**, so code behind a `Confirm` or a dialog may be unmeasurable.
- **A test that opens a `TestPage` cannot be scored**, and one kind of them can stall a whole run.
- **Big apps must be run in slices** (`--only`). An unscoped run on a real project is refused by
  default.
- **One tenant per server.** LethAL cannot fence a second tenant publishing to the same instance.
- **The `al-runner` backend is not authoritative**. Use `bcdev` for any number you intend to quote.

The rest of this section is the evidence for each, with the measurements behind it.

Stated plainly, because a mutation-testing tool that overstates its guarantees is worse than none.

Several entries below cite measurements taken against one real commercial extension, **Continia
Document Output** (438 of its 551 `.al` files carry mutation sites; 19,832 sites when the earlier
entries below were measured, 19,850 on 2026-07-31, since the app and the grammar both move), because that
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
  accepting the dual-runner disagreement described above. The report names any test that disagrees.
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
  **62 of 19,850 mutation sites (0.3%) sit lexically inside a `GuiAllowed`- or `Confirm`-guarded
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
  execution, and the build carrying every guard is typically rejected by a hosting proxy before
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
- **The advanced operator set is not built.** Twelve operators today, in two groups: six generic
  ones (Tier-1: comparisons, return values, empty blocks) and six AL-specific ones (Tier-2:
  `TestField`, `SetRange`, `CalcFields`, `Commit` and friends). A third, more aggressive group is
  designed only.
  (Tier-2 operators *do* now claim sites inside `tableextension` and `pageextension` bodies; that
  limit was closed. A `pageextension`'s implicit `Rec` is still refused deliberately: it resolves to
  the extended page's `SourceTable`, which the project usually cannot see, and guessing would claim
  sites wrongly. Measured on a real extension: zero sites would have been gained by guessing.)
- **A test that opens a `TestPage` cannot be scored, and on the default path one can end your whole
  run.** LethAL runs tests in a locked-down session with no GUI and a web-service client
  (`GuiAllowed=No`, `ClientType=ODataV4`), and that session cannot create the test service a
  `TestPage` needs. What happens next depends on the page, which is the part worth
  knowing:

  | Page | Fenced (default) | Hub (`coverageMode: "procedure"`) |
  |------|------------------|-----------------------------------|
  | Trivial, no logic | refused in ~87 ms; run completes | opens fine |
  | Real (triggers, FlowFields, a `pageextension` writing on open) | **hangs; the session quarantines and the ENTIRE run scores nothing** | opens and passes in ~451 ms; run completes |

  Both rows are measured, repeatedly, on real containers. The hang is the severe case: one such test
  at baseline takes every other test and every mutant down with it, not just its own. `--stop-hung-sessions`
  does **not** rescue it: it makes the failure faster, not survivable, because the baseline loop
  quarantines on the forced-stop result exactly as it does on a hang.

  **Mitigation that works today:** run with `coverageMode: "procedure"`, which routes baseline
  discovery to the bcdev hub. Measured: the run completes and everything else gets scored. Note the
  trade R58 made deliberately when it moved off that mode. The hub runs `GuiAllowed=Yes`, so it can
  disagree with the fenced runner about a test's outcome.

  **What is still not recovered:** mutant *verdicts* always execute on the fenced path regardless of
  coverage mode, so a mutant covered only by `TestPage` tests still receives no verdict; it is
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
**License**: MIT. See [`LICENSE`](LICENSE).

## Architecture

```
    AL source
      |
      v  tree-sitter-al
    engine ............... AST, MutationSpec, semantic layer
      |
      +-- builtin-tier1 .. conditional-boundary, negate-conditional, empty-block,
      |                    return-value, void-method-call, swap-call-arguments
      +-- builtin-tier2 .. remove-testfield, remove-setrange, remove-calcfields,
      |                    remove-commit, swap-modify-flag, swap-rec-xrec
      |                    (AL-specific; reach table triggers)
      v
    schemata ............. ONE instrumented build, all mutants behind guards
      |
      v
    runner ............... orchestrator + backends + results store
      |
      v
    Business Central
      \__ LethAL Control extension (owns which change is switched on, and the lock a run holds)
```

The `LethAL Control` AL extension owns the state a republish of your app cannot reset: the active-mutant row, the artifact registry, and the lease.

## Development

### Key files

| File | Purpose |
|------|---------|
| `design.md` | Authoritative architecture |
| `docs/roadmap/` | Open work, measured-but-unclosed risks, and known product gaps, one file per item |
| `ROADMAP.md` | Generated index of the above (`bun scripts/roadmap-index.ts`) |
| `CHANGELOG.md` | What shipped in each release |
| `packages/engine` | AL AST, `MutationSpec`, semantic analysis |
| `packages/builtin-tier1` / `-tier2` | The mutation operators |
| `packages/schemata` | Instrumentation and compilation into one build |
| `packages/runner/src/orchestrator.ts` | Session lifecycle, lease, verdict recording |
| `packages/runner/src/lease.ts` | `LeaseClient`: acquire / renew / release / fence ops |
| `packages/runner/src/resume.ts` | Which prior verdicts a `--resume` may reuse, and why |
| `extensions/lethal-control` | The BC extension: lease table, two-phase fence, headless runner |
| `docs/do-trial-runbook.md` | Reproducing the run against a real commercial product |
| `docs/measurements/` | Probes behind claims about BC behaviour, so they can be re-checked |
| `fixtures/README.md` | Live container setup and the recovery procedure |

### Testing

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
| `LETHAL_ITEST_TABLES=1 bun run itest:tables` | Tier-2 operators, table-trigger and extension-object mutation | 109 / 17 / 10 over 136 deployed |
| `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` | An externally-owned environment, reached through config | 3 / 10 / 3 |
| `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` | The al-runner backend | 3 / 13 / 0 |
| `LETHAL_ITEST_BCDEV=1 bun run itest:lease` | Lease lifecycle, contention, recovery | n/a |
| `LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish` | Publish serialization and staleness | n/a |
