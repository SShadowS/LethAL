# Releasing LethAL

LethAL ships as a **standalone compiled binary**, not an npm package.

The audience is Business Central AL developers on Windows who do not necessarily have Bun or Node
installed, and the internal `@lethal/*` workspace packages are implementation detail — a registry
publish would expose all six of them and commit us to their surfaces. Every package in
`packages/` is marked `"private": true` so a stray `npm publish` in one of those directories is
refused outright.

Everything below was executed on 2026-07-27 with Bun 1.3.14 on Windows 11 x64. Numbers are measured,
not estimated.

## Versioning

The **root `package.json` `version` is the single source of truth.** It is currently
`0.1.0-alpha.3`.

Workspace packages under `packages/` stay pinned at `0.0.0` and are never bumped. They are not
published and not independently consumable, so a version on them would be a number nobody reads and
six more places to forget to update. `scripts/build-binary.ts` reads the root version and stamps it
into each output filename; nothing else in the build consults a version field.

`lethal --version` prints three lines, and R88 is why it is three rather than one:

```
0.1.0-alpha.1
build: 9b87939… (DIRTY working tree — the commit does not describe this build) built 2026-08-07T19:44:27.927Z
operators (12): lethal.conditional-boundary, lethal.empty-block, …
```

The FIRST line is exactly the version, so `lethal --version | head -1` keeps working. The build line
is injected by `scripts/build-binary.ts` at compile time (`bun build --define`, never a runtime file
read — R50 measured that a runtime-computed path resolves against Bun's virtual root under
`--compile` and fails). The operator line is read at RUNTIME from `operatorTiers`, the same map
`generateMutationSet` walks, so it lists what the binary will actually apply rather than a
hand-maintained list that can drift.

The reason all three are needed: **measured 2026-08-04**, the local binary was 56 package-commits
stale and `grep -c` against it returned 0 for both `swap-call-arguments` and `remove-commit`, two
operators that shipped. A run driven by it silently measured a smaller operator set than the same
source would, and the filename — which carries only the package version — could not say so.

A DIRTY working tree does not fail the build; it is REPORTED, in capitals. A dirty build is a
legitimate thing to make while developing. A dirty build claiming a commit that describes something
else is not.

## Cutting a version

1. Update `version` in the root `package.json`.
2. Add the release's entry to [`CHANGELOG.md`](../CHANGELOG.md), Keep-a-Changelog style. Base it on
   the rows marked `done` since the last release — [`ROADMAP.md`](../ROADMAP.md) is the generated
   index (`grep -l '^status: "done' docs/roadmap/R*.md` enumerates them), and each row's own file
   under [`docs/roadmap/`](roadmap/) carries the evidence, so the changelog can be specific instead
   of generic. This is also when a row that has sat `done` for a release cycle gets its file
   deleted; re-run `bun scripts/roadmap-index.ts` afterwards.
3. Run the full local gate:
   ```bash
   bun run typecheck
   rm -rf packages/*/dist     # mandatory between the two — stale compiled *.test.js
   bun test                   # from dist otherwise produce ~21 phantom failures
   ```
4. Run the live integration gates (`/live-gate`). A differing verdict is a block, never
   "close enough" — unit tests are structurally blind to AL that cannot compile and to real BC
   behaviour. See `CLAUDE.md` for the frozen per-gate numbers.
5. Build the binaries: `bun run build:binaries`.
6. Smoke-test the host binary against a fixture (see [Verifying a build](#verifying-a-build)).
7. Tag and publish the artifacts — see [Tagging a release](#tagging-a-release) below.

> **Corrected 2026-08-08.** This said the repository had no configured git remote, which was true
> on 2026-07-27 and is not now: `origin` is `https://github.com/SShadowS/LethAL.git`, and it is
> PUBLIC. What remains true is that **no release has been cut** — step 7 has never been run, and
> nothing below step 6 has been exercised. Scan for secrets before any push, not only before a
> release.

## Tagging a release

> The step-by-step procedure, including the Azure Trusted Signing setup and the order the pieces
> must be configured in, is `.claude/skills/release/SKILL.md` (`/release`). This section is the
> reference for what the workflow does; that skill is the order of operations.

Added 2026-08-16 with `.github/workflows/release.yml`. **This workflow has never run**, because no
tag has ever been pushed. Read it before trusting it: the first tag is as much a test of the
workflow as of the release. (`ci.yml`, its sibling, is verified — run 31961823874, 2430 pass on
`windows-latest` — but nothing that is specific to the release path has been exercised by it.)

```bash
git tag v0.1.0-alpha.3     # must equal the root package.json version
git push origin v0.1.0-alpha.3
```

The workflow refuses a tag that disagrees with `package.json`, builds and checks the native parser
on every target (see [The native parser](#the-native-parser-rust-03) below), runs typecheck and the
unit suite, builds all five targets, signs and verifies the Windows binary, runs every compiled
binary on its own platform, and only then opens a **draft** release. Its attachments are the five
binaries, each addon's `lethal-parser.<key>.provenance.json`, and
`packages/engine/native/THIRD-PARTY-NOTICES.md` (every crate compiled into the addon, with its full
license and copyright text).

**No release ships unless all five targets pass.** `publish` needs `smoke`, and through it `build`,
`native-darwin-x64` and all five `native-parser` jobs. A failing target blocks the release; there is
no per-target opt-out.

**Both `build` and `publish` run in the `release` GitHub environment.** `build` needs it for the
signing login: the Entra federated credential's subject is `repo:SShadowS/LethAL:environment:release`.
`publish` is there because it creates the release: before S2 that step lived inside `build`, so it
was gated by the environment, and moving it to its own job must not drop that gate. The environment
has no protection rules today, so this costs nothing; any it gains later (a reviewer, a tag policy)
then gate the release itself, not only the signing.

The workflow also has a `workflow_dispatch` trigger, for a trial run. On a dispatch the tag check is
replaced by a version-stamp check, and `publish` is skipped (it runs only on a pushed `v*` tag), so
a trial can never create a release or a draft. GitHub dispatches a workflow only if the trigger
exists on the default branch, so the trigger and the two guards land on `master` first.

Draft, not published, because two things still need a human:

1. **Attach `lethal-control.app` by hand.** Building it needs `alc` from the AL VS Code extension,
   which no hosted runner has, and `*.app` is gitignored so there is no committed copy to attach.
   Say in the release notes which control-app version it is: a user pointing `controlSymbolPath` at
   the wrong one gets a version mismatch at run time, not at publish time.
2. **Read the generated notes.** They come from commit subjects, which were written for this
   repository's own record rather than for a stranger.

`.github/workflows/ci.yml` runs the same typecheck-and-test gate on every push, on every branch,
and on every pull request. It does NOT run `biome check .` repo-wide (pre-existing format debt in
`engine`/`builtin-tier1` would fail every build) and it does NOT run the live integration gates,
which need a Business Central container. Those stay a local, human-invoked gate.

Its first run cost a fix worth knowing about: the trigger was `push: branches: [master]` plus
`pull_request`, so pushing a feature branch ran nothing at all, and a workflow that only fires
after a merge reports a problem that has already shipped. Corrected in `af0b056`.

## The native parser (RUST-03)

Each binary embeds a native tree-sitter-al addon (`packages/engine/native`, a Rust crate) built for
its own platform. Since the RUST-03 switch (`9f7cb5f0`) the product parses AL with this addon only;
there is no WASM fallback. The addon is built, checked and embedded on every target, so no release
can carry an addon that was not built and parse-tested there.

**Only CI-built addons ship, and no `.node` file is ever committed.** Release CI builds each addon,
uploads it, and `build` downloads all five into `packages/engine/vendor/native/` before it typechecks,
tests and compiles. `scripts/build-binary.ts` embeds one per target through a `require` whose path is
a template over the build-time define `__LETHAL_NATIVE_KEY__` (the target's platform key), which is
the only form `bun build --compile` embeds.

### The compiler for each target

Every addon's C code (the grammar and the tree-sitter runtime) is compiled by clang from **LLVM
23.1.2**, macOS included. `scripts/install-llvm.sh <key>` downloads the pinned official asset,
checks its sha256, and refuses any clang whose `--version` line is not exactly `clang version
23.1.2`. `build-native-parser.ts` and `build.rs` refuse the same way, and the version line is baked
into the addon (`nativeInfo().cCompiler`), where CI checks it again after the build.

| target | built on | runner arch | `nativeInfo().target` | C compiler | LLVM asset |
| --- | --- | --- | --- | --- | --- |
| win32-x64 | windows-latest | x64 | `x86_64-pc-windows-msvc` | clang-cl 23.1.2 | `LLVM-23.1.2-win64.msi` (administrative install, leaves the runner's own LLVM alone) |
| linux-x64 | ubuntu-22.04 | x64 | `x86_64-unknown-linux-gnu` | clang 23.1.2 | `LLVM-23.1.2-Linux-X64.tar.xz` |
| linux-arm64 | ubuntu-22.04-arm | arm64 | `aarch64-unknown-linux-gnu` | clang 23.1.2 | `LLVM-23.1.2-Linux-ARM64.tar.xz` |
| darwin-x64 | macos-14, CROSS-built | arm64 | `x86_64-apple-darwin` | clang 23.1.2 | `LLVM-23.1.2-macOS-ARM64.tar.xz` |
| darwin-arm64 | macos-14 | arm64 | `aarch64-apple-darwin` | clang 23.1.2 | `LLVM-23.1.2-macOS-ARM64.tar.xz` |

On macOS, `SDKROOT="$(xcrun --show-sdk-path)"` is exported for cc-rs. Each native job asserts the
runner's `process.arch` before building and `nativeInfo().target` and the compiler after.

**darwin-x64 is cross-built** (owner ruling): LLVM 23.1.2 publishes no macOS x64 build, and every
release addon must come from the same clang. So the arm64 Mac runs `bun scripts/build-native-parser.ts
--target darwin-x64` with the arm64 LLVM, and the `native-darwin-x64` job then checks that addon on
an Intel Mac (`macos-15-intel`, GitHub's last Intel macOS image, available until August 2027;
`macos-13` was retired 2025-12-04): compiler and target, `lethal native-check`, the fixture parse,
and it writes the addon's provenance there, since a cross-built addon cannot be loaded where it was
built. The native Rust tests (`--test`) run on the four native targets only: a cross-built test
binary cannot run on the arm64 runner.

The clang 23.1.2 guarantee covers COMPILATION on darwin-x64, not linking. The grammar and the
tree-sitter runtime (all the C) are compiled by the pinned clang with `--target=x86_64-apple-darwin`,
which is what `nativeInfo().cCompiler` records. rustc then LINKS the addon through the runner's
Apple `cc -arch x86_64`, as it does on every macOS build; no LLVM 23.1.2 linker is involved.

`KyleMayes/install-llvm-action` is not used: its asset list stops at 21.1.8 (CI run 36443811955).

### Checks per target

- `native-parser`: `bun scripts/native-parse-smoke.ts fixtures/sandbox-data/src --expect "files 32
  nodes 7382 errors 0"` parses every fixture file through the addon directly. `--expect` is
  required, and all five targets expect the same line (the parse does not depend on the platform).
  This checks the addon on its own, before any binary is compiled.
- `smoke`: runs each compiled binary from a directory with no `packages/` tree, so it cannot load a
  `.node` from disk. `--version` must not say DIRTY; the hidden `lethal native-check` must print
  `native <triple> clang version 23.1.2 ... nodes 56` (a missing embedded addon exits non-zero with
  `NativeParserMissingError`); and `run --project fixtures/sandbox-data --dry-run` must print the
  two count lines `dry run: 29 file(s), 407 mutant site(s), 387 deployed mutant(s), 1 batch(es)` and
  `batch 0 (407 mutant site(s), 387 deployed):`.

### Building from source

Building the addon locally needs **Rust 1.96** and **LLVM 23.1.2**:

```bash
bash scripts/install-llvm.sh win32-x64          # or install LLVM 23.1.2 yourself and set LLVM_BIN
bun scripts/build-native-parser.ts              # writes packages/engine/vendor/native/lethal-parser.<key>.node
bun scripts/build-native-parser.ts --test       # the Rust tests
```

A local `build:binary` needs only the host's addon; `build:binaries` needs all five, so it is a CI
job.

### Reproducibility

Measured 2026-09-28 on Windows (win32-x64, at `bc43a05`'s crate sources): two builds, each into a
fresh, empty `CARGO_TARGET_DIR` (two different directories), gave the same `.node` sha256
(`196686bbab708d358dab26583a09291b8b380b93c4df9d26384a4468784d3259`). So it is byte-reproducible on
one machine, whatever the target directory. Across machines and platforms it was not measured, so
the claim there is "reproducible in behaviour, not bytes" until someone measures it.

## What the build produces

`bun run build:binary` builds for the machine you are on. `bun run build:binaries` builds all five
targets. Output goes to `build/`, which is gitignored — binaries are ~100 MB and are never
committed.

Measured for `0.1.0-alpha.1`:

| Target | Output | Size |
|---|---|---|
| `bun-windows-x64` | `lethal-0.1.0-alpha.1-windows-x64.exe` | 102.7 MiB |
| `bun-linux-x64` | `lethal-0.1.0-alpha.1-linux-x64` | 99.0 MiB |
| `bun-linux-arm64` | `lethal-0.1.0-alpha.1-linux-arm64` | 98.1 MiB |
| `bun-darwin-x64` | `lethal-0.1.0-alpha.1-darwin-x64` | 74.8 MiB |
| `bun-darwin-arm64` | `lethal-0.1.0-alpha.1-darwin-arm64` | 69.4 MiB |

With the native parser embedded (RUST-03 S2, `0.1.0-alpha.3`), the Windows binary is **118.1 MiB**
(123,790,848 bytes, built at `2ec3884`'s tree). The other four were not built locally:
`build:binaries` needs all five addons, which only release CI has.

Each was confirmed to be a genuine executable for its platform (`file`: PE32+, ELF x86-64, ELF
aarch64, Mach-O x86_64, Mach-O arm64). Most of the size is the embedded Bun runtime; roughly 8 MB
of it is LethAL's own embedded assets.

### Cross-compiling needs a seeding step on Windows

`bun build --compile --target=bun-linux-x64` fails on a Windows host with:

```
Failed to extract executable for 'bun-linux-x64-v1.3.14'. The download may be incomplete.
```

The message blames the network and the network is fine — the tarball returns HTTP 200 and
`bun add --dry-run` resolves it. The real cause is npm's platform gate: `@oven/bun-linux-x64`
declares `"os": ["linux"], "cpu": ["x64"]`, Bun's installer honours that, so on Windows the package
resolves but never lands on disk and there is nothing to extract.

`scripts/build-binary.ts` handles this automatically. It always attempts the plain build first, and
only on failure does it `bun install --os=<os> --cpu=<cpu>` the runtime into a throwaway directory
under the OS temp dir (never into this repo, which would rewrite `bun.lock` for a foreign platform)
and copy the extracted executable to `<bun pm cache>/<package>-v<bun version>` — a flat file, which
is where `--compile` actually looks. Installing alone is not enough; the seeded `node_modules` is
somewhere the compile step never consults.

This happens once per target per machine. The `seed` lines in the build output mark it.

## Runtime assets: the thing that breaks compiled binaries

LethAL parses AL with a native tree-sitter-al addon (RUST-03), one `.node` file per platform under
`packages/engine/vendor/native/`. The compiled binary must carry the one for its own target.

`packages/engine/src/ast/native-parser.ts` reaches it through a `require` whose path is a template
over the build-time define `__LETHAL_NATIVE_KEY__`, which `scripts/build-binary.ts` sets per target.
That is the only form `bun build --compile` embeds: a literal `require` per platform fails the build,
because Bun treats every literal `require` of an absent file as a hard resolve error (R314). Under
`bun run` the define is absent and the loader reads the addon for the running platform from disk.

The WASM grammar (`packages/engine/vendor/tree-sitter-al.wasm`) and web-tree-sitter's runtime are no
longer runtime assets. They stay in the repository as the reference parser for the equivalence
scripts, and product code must not import them (`no-wasm-in-product.test.ts`).

**If you add a non-TS runtime asset, make sure `bun build --compile` embeds it, and re-run the check
below.** A missing asset does not fail the build; it fails the first time a user runs the tool.

## Verifying a build

`--dry-run` exercises the whole parse and instrumentation path, executes no tests and needs no
container, so it is the cheapest real check that the binary's assets survived compilation. Run it
from a directory that is **not** the repo, so a relative path cannot accidentally rescue a
mislocated asset:

This smoke test runs the Windows `.exe`, so it is host-only: ask the owner.

```bash
cd /c
U:/Git/LethAL/build/lethal-0.1.0-alpha.1-windows-x64.exe run \
  --project U:/Git/LethAL/fixtures/sandbox-app --dry-run
```

Expected — and byte-identical to `bun packages/runner/src/cli.ts run --project fixtures/sandbox-app
--dry-run`:

```
dry run: 2 file(s), 19 mutant site(s), 19 deployed mutant(s), 1 batch(es)
...
batch 0 (19 mutant site(s), 19 deployed):
  src\SandboxLogic.Codeunit.al:6  lethal.empty-block
  ...
```

19 sites (the count `itest:bcdev` freezes) and exit 0. Anything less means the grammar did not make it into the binary.

## What a user downloads and runs

One file. No Bun, no Node, no npm, no install step — download, optionally rename to `lethal`, run.

What the binary does **not** carry, because these are properties of the user's machine and target
server rather than of LethAL:

- **`alc.exe`** (the AL compiler) is always required — compilation is local on every path, env-tool
  or not. It is found under the AL Language VS Code extension
  (`~/.vscode/extensions/ms-dynamics-smb.al-*/bin/win32/`; `bin/linux/` in the kraken container, named by `LETHAL_ALC_DIR`), or pinned with `bcdev.alcPath`.
- **`altool.exe`**, from the same extension, is required only on the direct-container publish path.
- **The `LethAL Control` BC extension** (`extensions/lethal-control`) must be published to the target
  server. The runner talks to it over OData.
- **A `lethal.config.json`** naming the backend, server and credentials. See `fixtures/README.md`.

Invocation is by subcommand — `run`, `clear-quarantine`, `force-reset-lease`:

```
lethal run --project <dir> --tests <dir> --backend bcdev
lethal run --project <dir> --dry-run
```

## Known gaps in the distribution path

> Both `--help` and `--version` used to be listed here as missing. They are not: R49 added the
> usage text and the version flag, and R88 added the build stamp and operator set to the latter.
> This note is kept rather than deleted because the two claims sat here, false, for several
> releases — which is the same rot the citations rule (R117) is about, one level up.
- **Binaries are unsigned.** SmartScreen will warn on Windows, and macOS Gatekeeper will refuse the
  Darwin builds until they are notarised or the quarantine attribute is cleared.
- **The macOS and Linux builds have never been executed** on this machine, only built and
  format-checked. Since RUST-03 S2 the release workflow's `smoke` job runs each one on its own
  platform before anything is published, but that workflow has not yet run.
- **No release has been cut.** `origin` exists (`https://github.com/SShadowS/LethAL.git`, public) as of 2026-08-08, so there IS somewhere to upload to — but step 7 has never been run, so the upload half of this document is still unexercised.
