# Running LethAL against Continia Document Output

The first real-product trial (2026-07-27). Written down because most of what it took is not
derivable from the code: every step below exists because something failed without it.

**Nothing here contains credentials.** The working config lives outside the repo (see
"Config"), and `continia env users --json` returns plaintext passwords — never paste its output
into a report, a commit, or a config that is tracked.

## What the trial measured

| | |
|---|---|
| target | `<DO>/DocumentOutput/Cloud` — 551 `.al`, 70 tables, 191 pages, 114 codeunits |
| tests | `<DO>/DocumentOutput/Test` — 78 test codeunits, ~1,246 `[Test]` methods |
| environment | a hosted Continia BC 28 DK sandbox, reached through `envTool` |
| mutant sites | 19,832 across 438 files (was 11,777 across 162 before R40) |

Frozen results for one codeunit (`Codeunit 6175297 CDO Send Cust. Statement Mgt.al`), stable
across four runs: **16 killed / 86 survived / 15 no-coverage / 21 error**, score 15.7%. Costs are
in `docs/benchmarks/runs.jsonl`; compare with `bun scripts/bench-record.ts compare --label <l>`.

## Environment setup, in order

Each step failed the first time for the reason given.

1. **Create and start the environment.** `env create` returns `Draft` — inert. `env start` is
   async too; poll `env get` until `status == Running`. Measured 191 s (the Layer-6C spec recorded
   390 s for the same shape, so treat both as observations rather than a constant).
2. **Install the test app's dependencies:** `continia deps install <envId> <DO>/DocumentOutput/Test`.
   Installs Continia Core, System Application, Delivery Network, Core Internal Activation App and
   Document Output; the Microsoft test libraries are already present on a BC 28 sandbox. ~218 s.
3. **Install the Cloud app's dependencies too** — `continia deps install <envId> .../Cloud` — or
   `Continia Connector App` is missing and any DO publish fails on symbols.
4. **Publish LethAL Control** (`extensions/lethal-control/lethal-control.app`).
5. **Publish a source-built DO before the test app.** The registry build `deps install` provides
   (28.4.x) is OLDER than the repo source, so the test app fails to compile against it
   (`Table 'CDO Output Profile Conflict' is missing`). Publish an instrumented or plain build of
   `Cloud` first.
6. **Build the test app against the environment's symbols, not the checked-in ones.** The prebuilt
   `.app` in the repo fails (`CTS-SYS Telemetry Dictionary` vs `CSC Telemetry Dictionary`).
   `deps download` into a SCRATCH copy of `Test` (an existing `.alpackages` makes it a no-op), then
   `continia deploy <envId> Test --workspace-root <scratch>`.
7. **`Src/Utilities/CDOTelemetryTests.Codeunit.al` does not compile** against the installed
   Continia System Application — a pre-existing mismatch in DO's own source, unrelated to LethAL.
   The trial excluded that one file from the scratch copy. Everything else compiles.

## Config

Not in the repo. Shape (an `envTool` section — the direct `bcdev` path cannot publish here,
because `altool` hardcodes port 7049 and the portal is path-routed HTTPS on 443):

```jsonc
{
  "bcdev": {
    "mcpCommand": ["bun", "run", "<bc-dev-mcp>/src/mcp/index.ts"],
    "company": "CRONUS Danmark A/S",
    "tenant": "default",
    "packageCachePath": "<a cache holding Continia + Microsoft symbols + lethal-control.app>",
    "controlSymbolPath": "<repo>/extensions/lethal-control/lethal-control.app",
    "alcPath": "<~/.continia/alc/17/.../alc.exe"        // R43 — see below
  },
  "envTool": {
    "toolPath": "<CLI>/continia.exe",
    "envId": "<envId>",
    "timeoutSeconds": 1800,
    "resolve": [
      { "command": ["env", "get", "{envId}", "--json"],
        "reads": { "baseUrl": "url", "expiresUtc": "expiresUtc" } },
      { "command": ["env", "users", "{envId}", "--json"],
        "reads": { "username": "0.username", "password": "0.password" } }
    ],
    "publish": { "command": ["publish", "{envId}", "{appFile}", "--sync-mode", "ForceSync", "--json"] }
  }
}
```

**`alcPath` is mandatory here (R43).** The AL VS Code extension's `alc 18.0.38.8509` writes OPC
part names with single-encoded spaces; BC 28 cannot find them and refuses the package with
`Specified part does not exist in the package.` `alc 17.0.29` (which `continia compile` downloads
to `~/.continia/alc/17/`) double-encodes and publishes fine. The trigger is a SPACE in a source
file name — every DO file has one, which is why fixtures and LethAL Control never hit it.

## Running

```sh
bun packages/runner/src/cli.ts run \
  --project "<DO>/DocumentOutput/Cloud" \
  --tests   "<scratch>/Test" \
  --backend bcdev --config <config.json> \
  --db <run.sqlite> --out <report.json> \
  --only       "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al" \
  --tests-only "Src/AutomaticDocuments/**" \
  --max-guards-per-batch 800 \
  --selector-id 6175469 --control-id 6175470 --table-id 6175471
```

- **selector ids** must sit inside DO's `idRanges` (6175271–6175490); 6175469–6175471 are free.
- **`--only`** (R41) narrows mutants. Without it the artifact carries 19,832 guards and cannot be
  published at all — see below.
- **`--tests-only`** (R45) narrows the BASELINE, which is otherwise ~78% of the run. It is the one
  narrowing that can change verdicts: exclude the killing test and you manufacture a survivor. The
  report flags it `tests-narrowed`.
- **`--max-guards-per-batch`** (R44) bounds each published artifact.

## Environment behaviours that will bite

- **nginx cuts any request at ~360 s** (`504 Gateway Time-out`); no client timeout changes it. BC
  keeps working after the cut and holds a tenant-wide extension lock, so a blind retry contends
  with the operation it is waiting on. Poll for the installed version instead.
- **Publish cost scales with injected guard count**, because BC recompiles the extension
  server-side: 163 guards published in 28 s, 11,777 hit the 504. This is what `--max-guards-per-batch`
  is for.
- **A long fenced call can quarantine the run.** One trial run latched
  `baseline test in-flight-unknown` and scored 0 of 138 mutants — correct behaviour (it refused to
  emit verdicts it could not vouch for), and it writes a durable quarantine. Clear it with
  `lethal clear-quarantine --server <origin> --instance <envId>`.
- **Repeated interrupted publishes drove the tenant to `503 The tenant 'default' is not accessible`.**
- **104 of 1,246 DO tests fail at baseline** on this environment. Pre-existing, not caused by
  LethAL, but it bounds what any run here can measure and makes 21 mutants unscoreable.

## Reading the result

`SessionReport.validity` states what the score is a score OF; do not quote `mutationScore` without
it. A narrowed, baseline-red run reports
`narrowed-degraded [baseline-red, narrowed, tests-narrowed]`.

Survivors carry `originalText`/`mutatedText`, `procedureName`, `coveringTests` and
`coverageAttribution`. Treat `exact` as actionable and `object`/`all-green` as approximate — the
tests ran the OBJECT, not necessarily the mutated member.

**The 86 survivors have never been individually verified against their intended killers.** R29
found 10 of 20 survivors false on a fixture; R32 had to drive each one. `coverageAttribution:
exact` is evidence about coverage, not about killability. Nobody should act on that list as fact
until it is checked.
