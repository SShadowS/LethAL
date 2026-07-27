# LethAL

Mutation testing for Microsoft Dynamics 365 Business Central AL code — it tells you which of your AL tests actually catch bugs.

[![Release](https://img.shields.io/badge/release-0.1.0--alpha.1-orange)](CHANGELOG.md)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)
[![AL](https://img.shields.io/badge/target-Business%20Central-orange)](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-dev-overview)

> **Alpha.** The tool is honest about its limits rather than complete — see [Limits](#limits) before
> quoting a score. Read [`CHANGELOG.md`](CHANGELOG.md) for what shipped and what did not.

## What it does

LethAL makes small, deliberate breakages in your AL code — flips a `<` to `<=`, empties a block, drops a `TestField`, changes a return value — then runs your tests against each one. A test suite that stays green while the code is broken is not protecting you.

Each mutant comes back as one of three verdicts:

| Verdict | Meaning |
|---------|---------|
| **killed** | A test failed. That code path is genuinely covered. |
| **survived** | Every test still passed. Nothing checks that behaviour. |
| **no-coverage** | No test executes that code at all. |

It compiles **one** instrumented copy of your app with every mutation baked in behind runtime guards, publishes it once, then activates mutants one at a time — instead of one compile-and-publish cycle per mutant.

## Overview

| Metric | Value |
|--------|-------|
| Release | 0.1.0-alpha.1 |
| Language | TypeScript (Bun workspaces) |
| Target | AL / Business Central, control extension runtime 16 |
| Mutation operators | 9 — 5 Tier-1 (generic), 4 Tier-2 (AL-specific) |
| Object kinds instrumented | codeunit, table, page, report, pageextension, tableextension |
| Backends | `bcdev` (live BC, authoritative), `al-runner` (offline, **not** authoritative) |
| Concurrency safety | Machine-global lease + per-run two-phase fence |
| Unit tests | 1,223 |
| Largest project measured | 19,832 mutation sites across 438 files (a real commercial extension) |

## Features

| Feature | Description |
|---------|-------------|
| **Mutant schemata** | One instrumented artifact carries every mutation behind runtime guards — not N compiles |
| **AST-based mutation** | Operates on a real AL parse tree (tree-sitter-al), never on text |
| **Live BC execution** | Runs the covering test headlessly inside Business Central over OData |
| **Coverage-aware** | Distinguishes "no test caught it" from "no test runs it at all", and records which attribution path decided |
| **Actionable survivors** | Each survivor carries its original and mutated text, procedure, covering tests, and a per-procedure rollup — enough for a human or an agent to act without re-deriving anything |
| **Scoped runs** | `--only` narrows mutants, `--tests-only` narrows the baseline, `--max-guards-per-batch` bounds each published artifact |
| **Resumable** | An aborted run is continued with `--resume`; verdicts already measured are not thrown away |
| **Deployment identity** | Verifies the app under test is the artifact it compiled, and refuses to record a verdict otherwise |
| **Concurrency-safe** | A machine-global lease stops two runs on one container from interleaving and producing a false verdict |
| **Two-phase fence** | Every mutant run proves it holds the lease at claim *and* at result-recording, or the result is discarded |
| **Lost-ack recovery** | An unreadable response is reconciled against the server's own operation marker instead of assuming the worst |
| **External environments** | A hosted environment owned by a third-party CLI is driven through config-declared commands, with no vendor knowledge in LethAL |
| **Operator recovery** | `lethal force-reset-lease` and `lethal clear-quarantine` recover a container stranded by a dead session |

## Prerequisites

Running the released binary needs **no Bun, Node or npm**. You do need:

- A Business Central container, dev server, or hosted sandbox — **single-tenant** (see [Limits](#limits))
- The AL Language VS Code extension, which supplies `alc.exe` and `altool.exe`
  - or a `bcdev.alcPath` in your config pointing at any `alc.exe`, if your server needs a specific compiler build
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

Start with a dry run — it tells you how big the job is without touching a server:

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
| `--only <glob>` | *(all files)* | Only these files contribute mutants. Repeatable. Cannot change a verdict — every file is still parsed, compiled and published |
| `--tests-only <glob>` | *(whole suite)* | Only these test files run at baseline. Repeatable. **Can change a verdict**: excluding a killing test manufactures a survivor. Flagged `tests-narrowed` in the report |
| `--skip-known-survivors` | `false` | Skip mutants a prior finished run recorded as survivors |
| `--dry-run` | `false` | Plan mutants without executing them |

Cost and recovery:

| Flag | Default | Description |
|------|---------|-------------|
| `--max-guards-per-batch <n>` | *(unbounded)* | Guards per published artifact. Publish cost scales with guard count — BC recompiles server-side |
| `--mutant-timeout-ms <n>` | `30000` | Floor for a mutant's time budget. The budget is `max(2 × that test's baseline, this)` |
| `--resume` / `--resume-run <id>` | — | Continue an aborted run, reusing verdicts it already measured |
| `--allow-large-run` | `false` | Run more than 1,000 mutation sites |
| `--workers <n>` | `1` | Parallel shards (rejected for the authoritative backend) |

Environment and output:

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | `<project>/lethal.config.json` | Server, company, credentials, optional `envTool` section |
| `--db <path>` | `<project>/lethal.sqlite` | Results database |
| `--out <path>` | — | Write the JSON report here |
| `--selector-id` / `--control-id` / `--table-id` | `79197`–`79199` | Override the injected object ids, e.g. when your `idRanges` exclude the defaults |
| `--keep-env` / `--allow-expiring-env` | `false` | Env-tool session controls |

Exit codes: `0` ok, `1` error, `3` quarantined — the run refused to vouch for its own verdicts.

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
| `packages/runner/src/lease.ts` | `LeaseClient` — acquire / renew / release / fence ops |
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
per-mutant baseline** — a differing verdict is a regression, never "close enough":

| Command | Proves | Frozen |
|---------|--------|--------|
| `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` | End-to-end verdicts against real BC | 3 killed / 10 survived / 3 no-coverage |
| `LETHAL_ITEST_TABLES=1 bun run itest:tables` | Tier-2 operators and table-trigger mutation | 63 / 10 / 2 |
| `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` | An externally-owned environment, reached through config | 3 / 10 / 3 |
| `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` | The al-runner backend | 3 / 13 / 0 |
| `LETHAL_ITEST_BCDEV=1 bun run itest:lease` | Lease lifecycle, contention, recovery | — |
| `LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish` | Publish serialization and staleness | — |

## Limits

Stated plainly, because a mutation-testing tool that overstates its guarantees is worse than none.

- **A survivor is a lead, not a proven test-suite gap.** Survivors have been individually verified
  *on the fixture* — all ten genuine, after an earlier defect made 10 of 20 false. They have **not**
  been individually verified on a real project. Read `validity` in the JSON report before quoting
  `mutationScore`, and treat `coverageAttribution: exact` as evidence about coverage, not about
  killability.
- **Unscoped runs on a real project are refused by default.** 19,832 mutation sites is days of
  execution, and the artifact carrying every guard is typically rejected by a hosting proxy before
  it publishes. Use `--only`; `--allow-large-run` overrides.
- **Single-tenant servers only.** App publication is service-instance-wide, so a second tenant
  publishing to the same instance is outside the lease entirely. Documented, **not enforced** — AL
  cannot enumerate tenants from an extension. Verify out of band with `Get-BcContainerTenants`.
- **`al-runner` is not authoritative.** Measured: its `asserterror` never fails a test, so mutants
  killable only that way come back survived there while `bcdev` kills them. Under-reporting only,
  never a false kill; a startup canary measures the actual binary each session and says so. Use it
  for offline smoke-testing, not for a score.
- **Tier 3 not built.** Nine operators across two tiers today; the advanced set is designed only.
  Tier-2 operators also do not yet claim sites inside `tableextension`/`pageextension` bodies.
- **Procedure-level coverage** from the `bcdev` backend, so `no-coverage` means no test calls that
  procedure. Coverage for extension objects is object-level only.
- **A red baseline bounds what any run can measure.** Tests that fail before mutation are named in
  the report, and their mutants are reported unscoreable rather than silently counted.
- **AL has no unit-test harness here.** Changes to the control extension are verified by an offline
  `alc` compile plus the live gates.

---

**Author**: Torben Leth (sshadows@sshadows.dk)
**License**: none declared yet — add a `LICENSE` file before distributing.
