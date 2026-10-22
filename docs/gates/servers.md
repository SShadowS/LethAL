# BC gate servers

The BC gates run on the three BC on Linux servers, `bc1`, `bc2` and `bc3` (R589). CLAUDE.md
§"Integration tests" holds the rules for using them. This page holds the details.

## The servers

They are BC 28.4 on server1 (`192.168.2.157`), reachable from the kraken container. Localization is
W1, so the company is `CRONUS International Ltd.` (not the DK `CRONUS Danmark A/S` that Cronus28
had). Tenant `default`, instance `BC`, Basic authentication.

| server | OData | dev endpoint | API |
|---|---|---|---|
| `bc1` | 7048 | 7049 | 7052 |
| `bc2` | 7148 | 7149 | 7152 |
| `bc3` | 7248 | 7249 | 7252 |

There is no BcContainerHelper and no Windows Docker context there: everything goes over the dev
endpoint.

## Setting a server up

`bun scripts/bc-linux-setup.ts --server bc1|bc2|bc3|all` (add `--dry-run` to see the plan). It takes the lease in
your lane: `--lane <lane>` if given, else your kraken agent identity (`KRAKEN_AGENT`); with neither it refuses
(R598). For each
server it:

1. reads the login from `/coord/secrets/bc-linux.env`, which only the owner writes;
2. writes one gitignored `fixtures/<fixture>/lethal.config.<server>.json` per gate fixture, and the
   paired `fixtures/<fixture>/.vscode/launch.<server>.json`;
3. takes the coord lease for the server, and releases it at the end;
4. publishes its pinned LethAL Control build (`CONTROL_APP`, checked against `CONTROL_SHA256`;
   after a control-app bump, update both first), then every app a BC gate needs (`PUBLISH_PLAN`:
   `sandbox-probes`, each gate's fixture pair with the target before its tests, and
   `sandbox-harden-answers`), in Dev scope over the dev endpoint, skipping an app the server already
   holds at the same or a higher version;
5. runs `lethal doctor` on every config it wrote.

The databases are in memory. A container restart or a server1 reboot resets each server to a fresh
CRONUS with no LethAL app on it. The script is idempotent, so re-running it is the fix.

The setup compares versions, not contents (R599). `scripts/bc-republish.ts` fixes that, and every
one of its modes works only under a coord lease in your own lane (`--lane <lane> --token-dir <dir>`,
both required):
- `republish --server bcN [--mint <target>]... <fixture>...` replaces a stale build. It compiles
  first, then REFUSES before removing anything if the server holds a planned app above the version
  it would publish (R605: BC refuses the lower publish after an unpublish, which would leave the
  app off the server). Otherwise it uninstalls and unpublishes (dependents first, adding any fixture
  that depends on a named app), publishes (targets first) and reads back each app's version and
  sha256, stopping at the first failure and naming every app left off. A target that a gate left at
  a minted version can only go back at a newer minted version (`--mint`).
- `control --server bcN` moves LethAL Control up to the pinned build (`CONTROL_APP`,
  `CONTROL_SHA256`) as an upgrade over the dev endpoint, never removing it, and reads it back.
- `alpackages --server bcN <tests fixture>...` fills a tests fixture's gitignored `.alpackages`
  from that server, which `itest:testapp`, `:verify`, `:verify-scale` and `:agreement` need.

## How a gate reads a server

- `LETHAL_ITEST_CONFIG=lethal.config.<x>.json` selects the config file in one of the four fixture
  directories the setup script writes (`sandbox-app`, `sandbox-data`, `sandbox-hang`,
  `sandbox-harden`). Each gate reads one of them; its page says which. `itest:bcdev-names` and
  `itest:bcdev-wrapped` read `sandbox-app`'s (`CONNECTION_DIR` in each itest). Without the variable,
  a gate reads `lethal.config.local.json`, which names the parked Cronus28, so always set it.
- `lethal.config.<x>.json` requires `.vscode/launch.<x>.json` naming the same server. The itest
  refuses otherwise.
- The itests take the ports from the config: OData from `bcdev.baseUrl`, API from
  `bcdev.apiBaseUrl`, dev from `bcdev.port` (R591, folded into R589). A config with none keeps
  7048 and 7049.
- Every gate prints its target as its first line:
  `[itest target] config=<file> server=<host>:<dev port> odata=<url> api=<url>`.

## Proof that the gates reproduce here

**Proof is per server** (orchestrator ruling, 2026-10-21). A gate runs on a server only after its
frozen figures have reproduced per mutant on THAT server, under the current fixture builds; any
difference is a BLOCK. A proof on `bc1` does not admit `bc2`: the servers can differ in app builds
and in what else is installed (`bc3` carries the Continia stack). Admitting a new (gate, server)
pair is one ordinary run of the gate there; add the pair to this table when it passes.

This table is the record. It lists the pairs exactly as the autonomy runbook
(`docs/superpowers/runbooks/autonomy/README.md`, "Proof is PER SERVER") does. Each pair below
PASSED on 2026-10-21 under the runtime-17 fixtures, per mutant equal to its baseline or frozen table
where the gate has mutants, with no baseline re-recorded. The control column is the LethAL Control
version the server held during that proof, read by `lethal doctor`'s `control-version` check before
each server's queue. A proof holds only for the control version it ran under, because control
builds take different paths in some gates.

**As of 2026-10-22, every BC gate is proven on every bc server under the LethAL Control build master
requires** (the build `extensions/lethal-control/app.json` and `CONTROL_SHA256` in
`scripts/bc-linux-setup.ts` pin): 14 gates on each of bc1, bc2 and bc3, 42 pairs. R618's `itest:lend`
was added on 2026-10-22 and passed on all three. The rest of this paragraph is R-604's history. bc2 was moved to
that build first, measured 2026-10-21 by `bc-republish.ts control` as an upgrade with nothing removed,
read back with the pinned sha256 (`/coord/handoff/R-604/control-bc2.log`), and its 13 gates were
re-proven after it. bc1's 9 gates proven earlier under the older build were re-proven too. On bc1
and bc3 the same tool, run after the proofs, read the resident control package back by sha256 and
found it equal to `CONTROL_SHA256`, so it published nothing (`/coord/handoff/R-604/control-bc1.log`,
`/coord/handoff/R-604/control-bc3.log`): all three servers hold the pinned bytes, not only the
pinned version that `lethal doctor` reports. Re-prove a server's gates whenever its control build or
fixture apps change.

| server | gate | LethAL Control | proof (log) |
|---|---|---|---|
| `bc1` | `itest:bcdev` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-bcdev.c23.log` |
| `bc1` | `itest:bcdev-wrapped` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-bcdev-wrapped.c23.log` |
| `bc1` | `itest:bcdev-names` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-bcdev-names.c23.log` |
| `bc1` | `itest:tables` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-tables.c23.log` |
| `bc1` | `itest:verify` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-verify.c23.log` |
| `bc1` | `itest:verify-scale` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-verify-scale.c23.log` |
| `bc1` | `itest:stale-publish` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-stale-publish.c23.log` |
| `bc1` | `itest:testapp` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-testapp.c23.log` |
| `bc1` | `itest:lease` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-lease.c23.log` |
| `bc1` | `itest:chunked` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-chunked.log` |
| `bc1` | `itest:hang` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-hang.log` |
| `bc1` | `itest:harden` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-harden.log` |
| `bc1` | `itest:agreement` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc1-agreement.log` |
| `bc2` | `itest:bcdev` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-bcdev.c23.log` |
| `bc2` | `itest:bcdev-wrapped` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-bcdev-wrapped.c23.log` |
| `bc2` | `itest:bcdev-names` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-bcdev-names.c23.log` |
| `bc2` | `itest:tables` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-tables.c23.log` |
| `bc2` | `itest:verify` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-verify.c23.log` |
| `bc2` | `itest:verify-scale` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-verify-scale.c23.log` |
| `bc2` | `itest:stale-publish` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-stale-publish.c23.log` |
| `bc2` | `itest:testapp` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-testapp.c23.log` |
| `bc2` | `itest:lease` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-lease.c23.log` |
| `bc2` | `itest:chunked` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-chunked.c23.log` |
| `bc2` | `itest:hang` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-hang.c23.log` |
| `bc2` | `itest:harden` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-harden.c23.log` |
| `bc2` | `itest:agreement` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc2-agreement.c23.log` |
| `bc3` | `itest:hang` | 1.0.0.23 | R-604 (re-proven after the republish), `/coord/handoff/R-604/bc3-hang.log` |
| `bc3` | `itest:bcdev` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-bcdev.log` |
| `bc3` | `itest:bcdev-wrapped` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-bcdev-wrapped.log` |
| `bc3` | `itest:bcdev-names` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-bcdev-names.log` |
| `bc3` | `itest:tables` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-tables.log` |
| `bc3` | `itest:verify` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-verify.log` |
| `bc3` | `itest:verify-scale` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-verify-scale.log` |
| `bc3` | `itest:stale-publish` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-stale-publish.log` |
| `bc3` | `itest:testapp` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-testapp.log` |
| `bc3` | `itest:lease` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-lease.log` |
| `bc3` | `itest:chunked` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-chunked.log` |
| `bc3` | `itest:harden` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-harden.log` |
| `bc3` | `itest:agreement` | 1.0.0.23 | R-604, `/coord/handoff/R-604/bc3-agreement.log` |
| `bc1` | `itest:lend` | 1.0.0.23 | R618, 2026-10-22, `/coord/handoff/R-618/lend-bc1-run2.log` (run 1 BLOCKED at R2, see docs/gates/lend.md) |
| `bc2` | `itest:lend` | 1.0.0.23 | R618, 2026-10-22, `/coord/handoff/R-618/lend-bc2.log` |
| `bc3` | `itest:lend` | 1.0.0.23 | R618, 2026-10-22, `/coord/handoff/R-618/lend-bc3.log` |

**R582's run (2026-10-22, build 7a8ff82c, LethAL Control 1.0.0.23).** R582 switched R577's "a kill
must reproduce" rule on for bcdev, which moved some counters. Each of the 13 BC gates ran ONCE, on
the one server below, and passed per mutant with every kill re-run and reproduced
(`docs/superpowers/specs/2026-10-22-r582-bcdev-kill-reproduction-precommitment.md`, r3a 8cbae6d1).
Only these 13 pairs are proven under the new counters; the other 26 pairs in the table were not
re-run. Each moved figure was measured on its gate's server only: tables `groupedCalls` 414 and
chunked 42 / 62 on bc3, hang 46 / 40 / 6 on bc2. Logs are `/coord/handoff/R-582/gate/<server>/<gate>.log`.

| server | gates under R582 |
|---|---|
| `bc1` | `itest:verify-scale`, `itest:bcdev`, `itest:bcdev-names`, `itest:verify`, `itest:testapp` |
| `bc2` | `itest:hang`, `itest:harden` (second run; the first was BLOCKED on a pre-commitment counting error, r3a), `itest:agreement`, `itest:bcdev-wrapped`, `itest:stale-publish`, `itest:lease` |
| `bc3` | `itest:tables`, `itest:chunked` |

`itest:stale-publish` and `itest:lease` have no per-mutant figures; they passed their own checks.
`itest:envtool` is host-only and not proven on any bc server. `itest:alrunner` and
`itest:growth` need no BC server.

**bc3's fixture apps (R599, R605).** R-604's pre-commitment predicted that bc3's four stale apps
(`Sandbox App`, `Sandbox Hang`, `Sandbox Names`, `Sandbox Names Tests`) would end up resident at
their app.json versions after uninstall, the bound `Microsoft.NAV.unpublish` action, and a publish.
**That prediction FAILED.** The removal worked (`Sandbox Tests` and `Sandbox Hang Tests` had to come
off too, as dependents), but the dev endpoint then refused `Sandbox App` 1.0.0.2 with HTTP 422,
because a gate had left it at the minted 1.0.20747.27757 (R605; `/coord/handoff/R-604/republish-bc3.log`).
R-604 stopped on bc3 and reported it. The restore that followed was NOT the plan: it was done under
the orchestrator's ruling (a) of 2026-10-21 (`/coord/handoff/R-604/rulings.md`). Under that ruling,
the three targets went back at versions minted by `reserveAppVersion` (`--mint`), the three test
apps at their app.json versions, each read back by version and sha256 (`republish-bc3-restore.log`).
`itest:hang` was re-proven first, and the rest followed only after it passed. No bc3 result differed
from bc1's or bc2's, so nothing there is a Continia-stack difference.

Earlier proofs not in the table: `itest:verify-scale` also passed on `bc2` under master's code before
R-583 merged, and `itest:bcdev` passed on all three servers in R589, before the runtime-17
fixtures. bc3's earlier `itest:hang` proof (R-389, `/coord/handoff/R-389/bc-live/hang-bc3.log`) is
replaced by R-604's, made after the republish.

Superseded by the table, and kept as history, because they ran under the older control build,
1.0.0.22 (measured 2026-10-21): R-583 phase 2's proofs on bc1 (bcdev, bcdev-wrapped, bcdev-names,
tables, verify-scale, stale-publish, testapp, lease) and on bc2 (chunked, hang, harden, agreement),
in `/coord/handoff/R-583/gates/p2-<gate>-<server>.log`; R-595's bc1 `itest:verify`
(`/coord/handoff/R-595/itest-verify-bc1-e2e-PASS.log`, control not recorded); and R-604's first
bc2 round (bcdev, bcdev-wrapped, bcdev-names, tables, verify, verify-scale, stale-publish,
testapp, lease), in `/coord/handoff/R-604/bc2-<gate>.log`. Every one of them passed. For bc2
`itest:agreement`, R-583's earlier run of master's code was NOT REPRODUCED (an ordering deviation,
`p2-master-agreement-bc2.log`), and the orchestrator accepted the R-583-code PASS in its place
(`/coord/handoff/R-583/gates.md`).

## Other servers

- **Cronus28 is parked** (owner, 2026-10-21). It became unreachable from the kraken container that
  day, at a new address. Its figures from before stay as history.
- **Cronus284 is CentralGauge's, not LethAL's** (owner, 2026-10-21). LethAL used it from
  2026-09-26 to 2026-10-20; those measurements stay as history. Never lease, publish to or clean up
  there. Cronus281, Cronus282 and Cronus283 are CentralGauge's too.
