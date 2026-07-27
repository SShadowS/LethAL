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
`0.1.0-alpha.1`.

Workspace packages under `packages/` stay pinned at `0.0.0` and are never bumped. They are not
published and not independently consumable, so a version on them would be a number nobody reads and
six more places to forget to update. `scripts/build-binary.ts` reads the root version and stamps it
into each output filename; nothing else in the build consults a version field.

> The compiled binary has no `--version` flag, because it has no flag parsing for one — see
> [Known gaps](#known-gaps-in-the-distribution-path). The filename is currently the only place the
> version is visible to a user.

## Cutting a version

1. Update `version` in the root `package.json`.
2. Add the release's entry to [`CHANGELOG.md`](../CHANGELOG.md), Keep-a-Changelog style. Base it on
   the rows marked `done` in [`ROADMAP.md`](../ROADMAP.md) since the last release — each roadmap row
   carries the evidence, so the changelog can be specific instead of generic.
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
7. Tag and publish the artifacts.

> This repository has **no configured git remote** as of 2026-07-27 (`git remote -v` is empty), so
> step 7 has no destination yet and no release has been cut. Nothing below step 6 has been
> exercised.

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

- **No `--help`.** `parseCliConfig` uses `node:util`'s `parseArgs` in strict mode with no `help`
  option, so `lethal --help` exits 1 with `TypeError: Unknown option '--help'` and a stack trace.
  A bare `lethal` is better — `unknown subcommand: got none, expected one of: run, clear-quarantine,
  force-reset-lease` — but a first-time user's first command is the one that fails worst. Fixing it
  is a change to `packages/runner/src/cli.ts`.
- **No `--version`.** The version exists only in the filename.
- **Binaries are unsigned.** SmartScreen will warn on Windows, and macOS Gatekeeper will refuse the
  Darwin builds until they are notarised or the quarantine attribute is cleared.
- **The macOS and Linux builds have never been executed**, only built and format-checked, because
  this is a Windows machine. Verify each on its own platform before publishing.
- **No release host.** No git remote is configured, so there is nowhere to upload to yet.
