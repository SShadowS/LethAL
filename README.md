# LethAL

Mutation testing for Microsoft Dynamics 365 Business Central AL code — it tells you which of your AL tests actually catch bugs.

[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)
[![AL](https://img.shields.io/badge/target-Business%20Central-orange)](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-dev-overview)

## What it does

LethAL makes small, deliberate breakages in your AL code — flips a `<` to `<=`, empties a block, changes a return value — then runs your tests against each one. A test suite that stays green while the code is broken is not protecting you.

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
| Language | TypeScript (Bun workspaces) |
| Target | AL / Business Central, runtime 16 |
| Mutation operators | 5 (Tier 1) |
| Backends | `bcdev` (live BC, authoritative), `al-runner` |
| Concurrency safety | Machine-global lease + per-run fence |
| Unit tests | 618 |

## Features

| Feature | Description |
|---------|-------------|
| **Mutant schemata** | One instrumented artifact carries every mutation behind runtime guards — not N compiles |
| **AST-based mutation** | Operates on a real AL parse tree (tree-sitter-al), never on text |
| **Live BC execution** | Runs the covering test headlessly inside Business Central over OData |
| **Coverage-aware** | Distinguishes "no test caught it" from "no test runs it at all" |
| **Deployment identity** | Verifies the app under test is the artifact it compiled, and refuses to record a verdict otherwise |
| **Concurrency-safe** | A machine-global lease stops two runs on one container from interleaving and producing a false verdict |
| **Two-phase fence** | Every mutant run proves it holds the lease at claim *and* at result-recording, or the result is discarded |
| **Lost-ack recovery** | An unreadable response is reconciled against the server's own operation marker instead of assuming the worst |
| **Operator recovery** | `lethal force-reset-lease` clears a container stranded by a dead session |

## Prerequisites

- [Bun](https://bun.sh) 1.x
- A Business Central container or dev server, **single-tenant** (see Limits)
- The AL Language VS Code extension (supplies `alc.exe` and `altool.exe`)
- For the `bcdev` backend: a reachable `bc-dev-mcp` endpoint

## Installation

```bash
git clone <repo-url> LethAL
cd LethAL
bun install
bun run typecheck
bun test
```

## Usage

```bash
bun packages/runner/src/cli.ts run \
  --project path/to/your-al-app \
  --tests path/to/your-test-app \
  --backend bcdev \
  --config lethal.config.json
```

Recovery, when a session died mid-run and left the container held:

```bash
# clears the SERVER-side lease and operation marker
bun packages/runner/src/cli.ts force-reset-lease --server http://YourContainer --instance BC --config lethal.config.json

# clears the LOCAL durable quarantine record
bun packages/runner/src/cli.ts clear-quarantine --server http://YourContainer --instance BC
```

## Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--project` | *(required)* | AL project directory to mutate |
| `--backend` | *(required)* | `bcdev` or `al-runner` |
| `--tests` | — | Test project directory |
| `--config` | — | Config file with server, company and credentials |
| `--workers` | `1` | Parallel shards (rejected for the authoritative backend) |
| `--compile-concurrency` | — | Parallel compile limit |
| `--dry-run` | `false` | Plan mutants without executing them |
| `--server` / `--instance` | — | Target server and service instance |
| `--quarantine-dir` | `~/.lethal/quarantine` | Where durable quarantine records live |

## Architecture

```
    AL source
      |
      v  tree-sitter-al
    engine ............... AST, MutationSpec, semantic layer
      |
      v
    builtin-tier1 ........ operators: conditional-boundary, negate-conditional,
      |                    empty-block, return-value, void-method-call
      v
    schemata ............. ONE instrumented artifact, all mutants behind guards
      |
      v
    runner ............... orchestrator + backends + results store
      |
      |--- acquire machine-global lease ----------------+
      |--- beginPublish -> altool publish -> endPublish |
      |--- per mutant: phase 1 claim / run / phase 3 verify-and-clear
      |--- release (op-gated)                           |
      v                                                 |
    Business Central container <-------------------------+
      \__ LethAL Control extension (lease, fence, headless test invocation)
```

The `LethAL Control` AL extension owns the state a republish of your app cannot reset: the active-mutant row, the artifact registry, and the lease.

## Key Files

| File | Purpose |
|------|---------|
| `design.md` | Authoritative architecture |
| `packages/engine` | AL AST, `MutationSpec`, semantic analysis |
| `packages/builtin-tier1` | The Tier-1 mutation operators |
| `packages/schemata` | Instrumentation and compilation into one artifact |
| `packages/runner/src/orchestrator.ts` | Session lifecycle, lease, verdict recording |
| `packages/runner/src/lease.ts` | `LeaseClient` — acquire / renew / release / fence ops |
| `extensions/lethal-control` | The BC extension: lease table, two-phase fence, headless runner |
| `scripts/probe-5cb1.ts` | Standalone live proof of the lease + fence (21 checks) |
| `fixtures/README.md` | Live container setup and the recovery procedure |

## Testing

```bash
bun run typecheck          # tsc --build --force
rm -rf packages/*/dist     # AFTER typecheck, BEFORE bun test
bun test                   # unit suite
```

Integration suites are env-gated and run against a live container:

| Command | Proves |
|---------|--------|
| `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` | End-to-end verdicts against real BC |
| `LETHAL_ITEST_BCDEV=1 bun run itest:lease` | Lease lifecycle, contention, recovery |
| `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` | The al-runner backend |
| `LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish` | Publish serialization and staleness |

## Limits

Stated plainly, because a mutation-testing tool that overstates its guarantees is worse than none.

- **Single-tenant containers only.** App publication is service-instance-wide, so a second tenant publishing to the same instance is outside the lease entirely. This is documented, **not enforced** — AL cannot enumerate tenants from an extension. Verify out of band with `Get-BcContainerTenants`.
- **Proven at fixture scale.** The frozen baselines are 16 mutants in a sandbox app. It works end to end; it is not yet demonstrated on a large production extension.
- **Tier-1 operators only.** The five generic, evidence-based operators. AL-specific (Tier 2) and advanced (Tier 3) operators are designed but not built.
- **Procedure-level coverage** from the `bcdev` backend, so `no-coverage` means no test calls that procedure.
- **AL has no unit-test harness here.** Changes to the control extension are verified by an offline `alc` compile plus live probes.

---

**Author**: Torben Leth (sshadows@sshadows.dk)
**License**: none declared yet — add a `LICENSE` file before distributing.
