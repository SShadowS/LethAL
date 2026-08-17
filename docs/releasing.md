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
`0.1.0-alpha.2`.

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
git tag v0.1.0-alpha.2     # must equal the root package.json version
git push origin v0.1.0-alpha.2
```

The workflow refuses a tag that disagrees with `package.json`, runs typecheck and the unit suite,
builds all five targets, smoke-tests the Windows binary with `--version`, and opens a **draft**
release with the binaries attached and generated notes.

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

## Runtime assets — the thing that breaks compiled binaries

LethAL parses AL with tree-sitter, which needs **two** WebAssembly files at runtime:

- `packages/engine/vendor/tree-sitter-al.wasm` — the vendored AL grammar (7.9 MB, see R14).
- `web-tree-sitter/tree-sitter.wasm` — web-tree-sitter's own emscripten runtime (205 KB).

Both are reached through Bun's `file` loader in `packages/engine/src/ast/parser.ts`:

```ts
import alGrammarWasmPath from "../../vendor/tree-sitter-al.wasm" with { type: "file" };
import treeSitterRuntimeWasmPath from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
```

A **static** import is what tells `bun build` to carry the asset into the binary at all. A path
computed at runtime is invisible to the bundler and cannot be embedded. Before this, `parser.ts`
resolved the grammar relative to `import.meta.url`; under `--compile` that is Bun's virtual root, so
every parse died before reading a byte of AL:

```
failed to asynchronously prepare wasm: Error: ENOENT: no such file or directory,
open 'B:\~BUN\root\tree-sitter.wasm'
```

The `file` loader yields a **path**, and that path works in both modes: the real absolute path under
`bun run`, and Bun's virtual root (`B:/~BUN/root/tree-sitter-al-pgb865xw.wasm`) in a compiled
binary, which `node:fs` reads out of the embedded blob store. The hashed basename is Bun's — never
parse or construct these paths.

**If you add a non-TS runtime asset, import it the same way and re-run the check below.** A missing
asset does not fail the build; it fails the first time a user runs the tool.

## Verifying a build

`--dry-run` exercises the whole parse and instrumentation path, executes no tests and needs no
container, so it is the cheapest real check that the binary's assets survived compilation. Run it
from a directory that is **not** the repo, so a relative path cannot accidentally rescue a
mislocated asset:

```bash
cd /c
U:/Git/LethAL/build/lethal-0.1.0-alpha.1-windows-x64.exe run \
  --project U:/Git/LethAL/fixtures/sandbox-app --dry-run
```

Expected — and byte-identical to `bun packages/runner/src/cli.ts run --project fixtures/sandbox-app
--dry-run`:

```
dry run: 2 file(s), 16 mutant site(s), 1 batch(es)

batch 0 (16 mutant site(s)):
  src\SandboxLogic.Codeunit.al:4  lethal.empty-block
  ...
```

16 sites and exit 0. Anything less means the grammar did not make it into the binary.

## What a user downloads and runs

One file. No Bun, no Node, no npm, no install step — download, optionally rename to `lethal`, run.

What the binary does **not** carry, because these are properties of the user's machine and target
server rather than of LethAL:

- **`alc.exe`** (the AL compiler) is always required — compilation is local on every path, env-tool
  or not. It is found under the AL Language VS Code extension
  (`~/.vscode/extensions/ms-dynamics-smb.al-*/bin/win32/`), or pinned with `bcdev.alcPath`.
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
- **The macOS and Linux builds have never been executed**, only built and format-checked, because
  this is a Windows machine. Verify each on its own platform before publishing.
- **No release has been cut.** `origin` exists (`https://github.com/SShadowS/LethAL.git`, public) as of 2026-08-08, so there IS somewhere to upload to — but step 7 has never been run, so the upload half of this document is still unexercised.
