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
4. publishes LethAL Control, then each gate's fixture pair (target before tests), in Dev scope over
   the dev endpoint, skipping an app the server already holds at the same or a higher version;
5. runs `lethal doctor` on every config it wrote.

The databases are in memory. A container restart or a server1 reboot resets each server to a fresh
CRONUS with no LethAL app on it. The script is idempotent, so re-running it is the fix.

## How a gate reads a server

- `LETHAL_ITEST_CONFIG=lethal.config.<x>.json` selects the config file in the gate's own fixture
  directory. Without it, a gate reads `lethal.config.local.json`, which pointed at Cronus28.
- `lethal.config.<x>.json` requires `.vscode/launch.<x>.json` naming the same server. The itest
  refuses otherwise.
- The itests take the ports from the config: OData from `bcdev.baseUrl`, API from
  `bcdev.apiBaseUrl`, dev from `bcdev.port` (R591, folded into R589). A config with none keeps
  7048 and 7049.
- Every gate prints its target as its first line:
  `[itest target] config=<file> server=<host>:<dev port> odata=<url> api=<url>`.

## Proof that the gates reproduce here

A gate's frozen figures must reproduce per mutant on a server before that server is used for it.
On 2026-10-21 (R-583, `/coord/handoff/R-583/gates.md`), each of these passed, per mutant equal to
its baseline or frozen table, on the server named:

| gate | server |
|---|---|
| `itest:bcdev` | `bc1`, `bc2` and `bc3` (R589), and `bc1` again under R-583's code |
| `itest:tables` | `bc1` |
| `itest:chunked` | `bc2` |
| `itest:hang` | `bc3` (master's code), `bc2` (R-583's code) |
| `itest:harden` | `bc2` |
| `itest:agreement` | `bc2` |
| `itest:bcdev-wrapped` | `bc1` |
| `itest:bcdev-names` | `bc1` |
| `itest:verify-scale` | `bc2` (master's code), `bc1` (R-583's code) |
| `itest:stale-publish`, `itest:testapp`, `itest:lease` | `bc1` |

Not proven there: `itest:verify` (blocked by stale gap pins, R595, not a server difference) and
`itest:envtool` (host-only). `itest:alrunner` needs no BC server.

## Other servers

- **Cronus28 is parked** (owner, 2026-10-21). It became unreachable from the kraken container that
  day, at a new address. Its figures from before stay as history.
- **Cronus284 is CentralGauge's, not LethAL's** (owner, 2026-10-21). LethAL used it from
  2026-09-26 to 2026-10-20; those measurements stay as history. Never lease, publish to or clean up
  there. Cronus281, Cronus282 and Cronus283 are CentralGauge's too.
