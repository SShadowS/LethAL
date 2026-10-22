# The talk laptop (R663b)

How to run the Directions EMEA demo on server1 (`tll-laptop`) itself: network off, from a plain
clone of LethAL, with no kraken container and no `/coord`. bc-demo runs on the same machine, so
everything talks to `http://localhost` on ports 7348 (OData), 7349 (dev) and 7352 (API).

Both scripts have a **laptop mode**, chosen only by the flag `--laptop`. Without the flag they behave
exactly as in the kraken container. With it they read nothing under `/coord`: the login, the symbol
cache, the pinned control app and bc-dev-mcp all live in the checkout, in files git ignores. Each
missing piece is refused by name, with the step that fixes it.

Every command below runs from the checkout's root. Do the first three while the laptop still has a
network.

## 1. Clone

```bash
git clone https://github.com/SShadowS/LethAL.git lethal && cd lethal && git checkout <the picked commit>
```

## 2. Install (once)

```bash
bun install
git clone https://github.com/SShadowS/bc-dev-mcp .lethal-cache/bc-dev-mcp && (cd .lethal-cache/bc-dev-mcp && git checkout 8371d0b && bun install && bun run build)
code --install-extension ms-dynamics-smb.al
```

- **bc-dev-mcp** is the tool LethAL runs tests through. It runs on `node` (18 or newer). Commit
  `8371d0b` is the one the gates run. Another location works too: set `LETHAL_BC_DEV_MCP` to it.
- **alc and altool** (the AL compiler and publisher) come from the AL Language extension. Without
  VS Code, unzip the extension's VSIX anywhere and set `LETHAL_ALC_DIR` to its `extension/bin/linux`
  folder. Setup writes the paths it found into the demo config, so `lethal run` uses the same ones.
- **The native AL parser** (`packages/engine/vendor/native/lethal-parser.linux-x64.node`) is not in
  git. Build it with `bun scripts/build-native-parser.ts` (needs Rust and LLVM clang 23.1.2), or
  `mkdir -p packages/engine/vendor/native` and copy the file built in the kraken container at the
  SAME commit into that folder (a clone does not have the folder).
- **The pinned LethAL Control build** goes in `.lethal-cache/control/`. Copy the file that
  `CONTROL_APP` in `scripts/bc-linux-setup.ts` names (it is in the coord folder) there, keeping its
  file name. Setup checks its sha256 (`CONTROL_SHA256`) and refuses any other build; when the file
  is missing, its refusal prints the exact path it wants.
- **The login.** Write `.lethal-demo.env` in the checkout's root, holding exactly two lines,
  `BC_DEV_USER=...` and `BC_DEV_PASSWORD=...` (the same BCRUNNER login as bc1-bc3). Or set the
  environment variables `BC_DEV_USER` and `BC_DEV_PASSWORD`; they win over the file. The script
  checks that git ignores the file before it reads it. Never commit it: this repository is public.

## 3. Set up (this is also the reset)

```bash
bun scripts/bc-demo-setup.ts --laptop
```

It probes bc-demo, fills the symbol cache `.lethal-cache/bc-symbols/` from bc-demo itself (nothing
comes from the internet), writes `examples/gift-card/lethal.config.demo.json`, publishes LethAL
Control, gift-card and its tests (only what is not already there), and runs `lethal doctor`. The
last line is `ok` or the failure. A second run publishes nothing.

## 4. Re-freeze (once, on the picked commit)

```bash
bun scripts/gift-card-refreeze.ts --laptop
```

Three runs that must agree mutant for mutant, then the re-frozen stage and the runbook's figures.
See the runbook's "Re-freezing the stage". It writes into `docs/campaign/2026-08-16-gift-card/`;
review the diff before you commit anything.

## 5. Explain

```bash
bun packages/runner/src/cli.ts explain docs/campaign/2026-08-16-gift-card/rehearsal.report.json --top 10
```

## After a reboot

bc-demo's database is in memory, so a reboot empties it. Start bc-demo if it is not running
(`cd ~/bclan && docker compose -p bc-demo --env-file bc-demo.env up -d`), then run step 3 again.
Right after bc-demo starts, setup can fail with `HTTP 503` on the extensions filter, because BC is
still warming up: wait a minute and run it again. It publishes nothing until every app is decided.

## Testing it from the container

The container simulates the laptop by pointing laptop mode at server1's address:
`LETHAL_DEMO_HOST=http://192.168.2.157`. Record of the simulation: `/coord/handoff/R-663b/live.md`.
