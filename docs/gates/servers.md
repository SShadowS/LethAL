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

`bun scripts/bc-linux-setup.ts --server bc1|bc2|bc3|all` (add `--dry-run` to see the plan). For each
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
(`docs/superpowers/runbooks/autonomy/README.md`, "Proof is PER SERVER") does. Each passed on
2026-10-21 under R-583's runtime-17 fixtures (`/coord/handoff/R-583/gates.md`), per mutant equal to
its baseline or frozen table where the gate has mutants:

| server | gates proven on it |
|---|---|
| `bc1` | `itest:bcdev`, `itest:bcdev-wrapped`, `itest:bcdev-names`, `itest:tables`, `itest:verify` (R-595, `/coord/handoff/R-595/itest-verify-bc1-e2e-PASS.log`), `itest:verify-scale`, `itest:stale-publish`, `itest:testapp`, `itest:lease` |
| `bc2` | `itest:chunked`, `itest:hang`, `itest:harden`, `itest:agreement` (R-583's code only) |
| `bc3` | none under the current fixtures. `itest:bcdev` and `itest:hang` passed there on the pre-runtime-17 fixtures only, and it now carries the R594 CDO oracle. Run `bc-linux-setup.ts --server bc3` and re-prove a gate there before using it for that gate. The setup compares versions, not contents (R599): before a bc3 proof for `itest:bcdev` or the names gates, first republish `Sandbox App`, `Sandbox Names` and `Sandbox Names Tests` (and `Sandbox Hang` for any gate but `itest:hang`) through the automation API (uninstall, then the bound `Microsoft.NAV.unpublish` action, then publish) |

`itest:stale-publish` and `itest:lease` have no per-mutant figures; they passed their own checks.
`itest:envtool` is host-only and not proven on any bc server. `itest:alrunner` and
`itest:growth` need no BC server.

Earlier proofs not in the table: `itest:verify-scale` also passed on `bc2` under master's code before
R-583 merged, and `itest:bcdev` passed on all three servers in R589, before the runtime-17
fixtures.

## Other servers

- **Cronus28 is parked** (owner, 2026-10-21). It became unreachable from the kraken container that
  day, at a new address. Its figures from before stay as history.
- **Cronus284 is CentralGauge's, not LethAL's** (owner, 2026-10-21). LethAL used it from
  2026-09-26 to 2026-10-20; those measurements stay as history. Never lease, publish to or clean up
  there. Cronus281, Cronus282 and Cronus283 are CentralGauge's too.
