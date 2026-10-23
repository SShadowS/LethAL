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
(R598).

**An out-of-use marker stops it (R669).** If `<coord>/machine/out-of-use/<server>.md` exists for any server
the run names, setup refuses the WHOLE run by name, in every mode, before it reads the login, takes a lease or
calls a server, and prints the marker. `scripts/bc-republish.ts` refuses the same way before its lease. The
clearing run sets `LETHAL_OUT_OF_USE_CLEARING=<server>` (that exact server only).
- **Set it on the one clearing command only, never `export` it.** Left set in a shell, it lets every later
  marker for that server through, and only the loud `!!!` line shows that it did.

Every BC itest refuses a marked bc1-bc3 the same way, in `printItestTarget`, BEFORE it prints its
`[itest target]` line, so a script that greps for that line finds nothing and fails closed. Only a gate
wrapper's own "in use" marker lets a gate through:
- the marker carries exactly one line `owner: <token>`, and the gate gets the same token in
  `LETHAL_OUT_OF_USE_OWNER`;
- the token is 32 lowercase hex, made fresh for each run (`openssl rand -hex 16`), and passed ONLY on the gate's
  command line (`LETHAL_OUT_OF_USE_OWNER=$T bun run itest:...`), never exported for the whole wrapper. A
  constant token is refused;
- a STOP marker must not carry the owner line, so the run's token cannot pass it.

A server other than bc1-bc3 has no marker and is never checked. A coord root whose `machine` directory does not
exist is an error, never "no marker": set `LETHAL_COORD_ROOT`.

For each server it:

1. reads the login from `/coord/secrets/bc-linux.env`, which only the owner writes;
2. takes the coord lease for the server, and releases it at the end;
3. fills, or reuses when it is already complete, the shared symbol cache for the server's BC build
   (below), then writes one gitignored `fixtures/<fixture>/lethal.config.<server>.json` per gate
   fixture, whose `packageCachePath` names that cache, and the paired
   `fixtures/<fixture>/.vscode/launch.<server>.json`;
4. decides every app by its CONTENT, then acts (R599). It compiles every app a BC gate needs
   (`PUBLISH_PLAN`: `sandbox-probes`, each gate's fixture pair, and `sandbox-harden-answers`; a test
   app against the LOCAL build of its target), reads what the server holds for each (the
   `dev/packages` download and the automation API's extension rows) and prints one decision per app,
   with the rows it saw. Only if NOTHING was refused does it publish, in Dev scope over the dev
   endpoint: its pinned LethAL Control build first (`CONTROL_APP`, checked against
   `CONTROL_SHA256`; after a control-app bump, update both first), then the Continia apps with
   `--with-continia`, then each target before its dependents. Each published app is read back by
   version, raw sha256 and content digest, with exactly one installed row. One refusal anywhere
   means nothing is published. An app that was skipped or kept is NOT read again after the act
   pass (for example a test app whose target was just upgraded): `lethal doctor` is the only later
   check on it;
5. runs `lethal doctor` on every config it wrote.

`--predict` runs the decide half only: it takes the lease, fills the shared symbol cache if it is
empty (a read from the server into the write-once cache), compiles and prints every decision, and
writes no config or launch file, publishes nothing and runs no doctor. `--with-continia` splits the
same way: its reads (P1 and each Continia app's resident version) are in the decide half, its
publishes in the act half.

**How an app is compared.** alc builds are NOT byte-reproducible: two compiles of one source differ
in a random per-compile id in the package header (it is the automation API's `packageId`) and in the
build timestamp in `NavxManifest.xml` (`/coord/handoff/R-599/measure.md`, F2). So the raw sha256 of a
fresh build never equals the server's, and the setup compares a NORMALISED content digest instead:
sha256 over every zip entry, sorted by name, with that timestamp removed (`contentDigest` in
`scripts/bc-app-content.ts`). An app with navigation (a page with `UsageCategory`, a report or page
extension's action changes) varies in one more entry, `navigation.xml`: alc writes a random
`ControlGUID` per action, and lists a parent's self-closing `<ActionChange/>` children and its
self-closing `<Actions xsi:type="ActionDefinition"/>` children in no fixed order (measured over 5
compiles of all 26 fixture, example and control apps, `/coord/handoff/R-599/nondeterminism-5x-all.log`).
So inside `navigation.xml` ONLY, every `ControlGUID` value is blanked and each run of those two sibling
kinds is put in a canonical order (every element kept, duplicates included); nothing else in it, and
nothing in any other entry, is touched. With that, every one of the 26 apps compiles to one digest. It
refuses, rather than guesses, a package with no or two timestamps, no manifest, no entries or a
duplicate entry. The decision, in order:

| what the server holds | decision |
|---|---|
| nothing, and no extension row | `publish new` |
| anything but exactly one installed row at the downloaded package's version, or a package that cannot be digested | `refuse content-unknown` (the owner) |
| the same digest | `skip` |
| a lower version | `publish upgrade` (nothing removed) |
| the same version, other content, a target with an installed fixture dependent | `refuse same-version-target` (not measured; R623) |
| the same version, other content, otherwise | `publish in place` |
| a higher version, a target a gate deploys itself (`gateDeploys`) whose resident build is instrumented | `kept` (setup only; R605 ruling (a)) |
| a higher version, anything else | `refuse above-build` |

"Nothing" means the dev endpoint answered 404: `residentPackage` in `scripts/bc-app-content.ts` reads only a
404 as absent, and any other failed answer stops the run (R624; bc3 measured 404 for an app it cannot hold,
`/coord/handoff/R-624/live/0-absent-status.log`).

A `publish in place` line names the zip entries that differ and both compiler versions, so a stale
SOURCE (`src/...` differs) is told apart from another compiler (only `NavxManifest.xml`,
`SymbolReference.json` or `DocComments.xml` differ). LethAL Control goes through the row check and
then `controlAction` on raw sha256: a higher or a same-version other-bytes control is now refused by
name (setup used to skip it). Two act-half failures print their remedy: BC's 422 "newer version ...
was already installed" (R605's installed-version record: `bc-republish.ts republish --mint
<fixture>`), and a test app refused after its target was kept as a minted build (run the target's
gate or `--mint` it, then re-run setup).

**A worktree that only needs the configs** runs `bun scripts/bc-linux-setup.ts --write-config-only --server
bc1|bc2|bc3|all`. It reads the secret file and writes the same configs and launch files, with NO server
call and NO lease. It refuses by name when the secret file or one of its two keys is missing, and never
prints the login. It reads the symbol cache's own marker to say, by name, whether the cache is filled for
that server: `symbol cache for bcN: <dir> (build <b>, <n> files ...; verified ...); server build not
checked (config-only)`, or `symbol cache empty for bcN: run setup --server bcN once`, in which case the
run fails and never claims gate-ready. It never asks the server which build it runs: with more than one
verified dir it takes the newest by its marker's `writtenAt`, and every line it prints says so.

### The shared symbol cache

A gate's instrumented compile reads `bcdev.packageCachePath`, and nothing on the bcdev path downloads
into it: `BcDevMcpBackend` compiles against R552's private copy of it plus `CONTROL_APP`, and its
plain-check compile reads it directly. So the configs must name a FILLED cache. It is
`/coord/cache/bc-symbols/<server>/<build>-<hash8>/`, shared by every worktree, where `<build>` is the
version of the `Microsoft System` package the server serves and `<hash8>` is a short hash of the set of
package names the dir holds, so a new Microsoft dependency on the same build gets a new dir. Measured: alc compiles a fixture against a read-only
cache (dir 0555, files 0444) with no error (`/coord/handoff/R-599/symcache/alc-readonly-cache.log`).

- **Microsoft packages only.** The dir is keyed by the BC build alone, so anything else in it would be
  served stale for good after it changed: R-553 found a leftover `lethal-control.app` in bc1's old
  per-worktree cache. A package enters only when its NavxManifest (not its file name) says publisher
  `Microsoft`, and the verifier refuses a dir that holds anything else. LethAL Control comes from
  `CONTROL_APP` and its pinned sha256 (R552's copy adds it), a test app's target symbol from that
  compile's own private cache, Continia from cdo's own package dir.
- **Write-once.** A fill downloads into a temp dir beside the build dirs, writes `cache-complete.json`
  (server, build, time, file count, and per package its id, name, publisher, version and sha256),
  makes it read-only, and only then renames it into place, so a crash can never leave a writable
  complete dir. The completed dir is never modified or deleted. A fill that finds the dir complete uses
  it (it downloads `System` only, to learn the build); one that finds it incomplete refuses by name and
  leaves it alone. Two fills racing: the second rename fails, and the loser verifies the winner's dir.
  The verifier also checks that `System`'s own version is the marker's build, accepts regular files
  only (a symlink is refused), and never throws: an unreadable dir is listed as unverified.
- **A new BC build gets a new dir.** Old dirs stay; nothing prunes them yet. A leftover
  `/coord/cache/bc-symbols/<server>/.tmp-*` dir is a fill that died part-way; it is never used, and it
  is safe to delete when no setup is running.
- What it holds: `System` plus every Microsoft dependency of a `PUBLISH_PLAN` target (today `System`
  alone). A dependent's own symbols are not put there.

The databases are in memory. A container restart or a server1 reboot resets each server to a fresh
CRONUS with no LethAL app on it. The script is idempotent, so re-running it is the fix.

`scripts/bc-republish.ts` publishes named fixtures on their own. Every one of its modes works only
under a coord lease in your own lane (`--lane <lane> --token-dir <dir>`, both required):
- `republish --server bcN [--predict] [--mint <target>]... <fixture>...` compiles the named apps,
  then decides each by the same table as the setup (in `republish` mode, so nothing is ever
  `kept`: a target above its build is refused with the remedy `--mint <fixture>`), and publishes
  only if nothing was refused, reading each back by version, raw sha256 and digest. Installed
  dependents are looked up over EVERY fixture, named or not, so a same-version target under an
  installed test app is refused here too. It prints each app's rows before and after. `--predict`
  stops after the decisions. Three changes from before R599: (1) an app with unchanged content is
  SKIPPED (it was always removed and published again); (2) `--mint` is an upgrade with nothing
  removed (it removed first, and a dependent was added and cycled); (3) the refusal before
  publishing is the decision table, not a version check over a removal plan. Nothing is ever
  uninstalled or unpublished; R-604's logs stay the evidence for the old removal path.
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
| `bc3` | `itest:tables`, `itest:chunked`, `itest:bcdev-names` (R-599's live check, after the in-place publish of Sandbox Names Tests and back: run 1 on build 42c7dc7b and run 2 on d89d6eb4, each 36 / 0 / 0 with every kill reproduced by 2 killer rows; `/coord/handoff/R-599/live/6-gate.log`, `live/run2/6-gate.log`) |

`itest:stale-publish` and `itest:lease` have no per-mutant figures; they passed their own checks.
`itest:envtool` is host-only and not proven on any bc server. `itest:alrunner-v3` and
`itest:growth` need no BC server. (`itest:alrunner`, the .NET al-runner's gate, was retired by R654.)

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

## bc-demo: not a gate server (R663)

`bc-demo` is a fourth BC on Linux instance on server1 that belongs to the Directions EMEA talk. It
uses the next port block after bc3: OData 7348, dev 7349, API 7352. It is in no lease pool and no
allocation, no gate runs on it, and `bc-linux-setup.ts` refuses `--server bc-demo` (`all` means bc1-bc3
only). `scripts/bc-demo-setup.test.ts` fails if it ever enters `SERVERS`, the lease path or an itest.

`bun scripts/bc-demo-setup.ts [--dry-run]` sets it up, and is also the demo reset after a server1
reboot. It takes no lease. It refuses if `/coord/machine/allocation.json` lists bc-demo, probes the
dev port once without a login, and when nothing answers prints the owner steps (start the instance,
open the ports) and exits 2. Otherwise it reads the login from `/coord/secrets/bc-demo.env` if that
exists, else from `/coord/secrets/bc-linux.env`; fills or reuses the symbol cache
`/coord/cache/bc-symbols/bc-demo/` from bc-demo itself; writes the gitignored
`examples/gift-card/lethal.config.demo.json`; publishes LethAL Control (`CONTROL_APP`), gift-card
and gift-card-tests, decided by content as above; and runs `lethal doctor`. Nothing comes from the
internet, so it works with the network off. Measured on 2026-10-22 it was not up
(`/coord/handoff/R-663/measure.md`).

With `--laptop` (R663b) it runs on server1 itself with no `/coord`: localhost (or
`LETHAL_DEMO_HOST`), the login from `.lethal-demo.env` or the environment, and the cache, control
app and bc-dev-mcp under the checkout's `.lethal-cache/`. See [talk-laptop.md](../talk-laptop.md).

## Other servers

- **Cronus28 is parked** (owner, 2026-10-21). It became unreachable from the kraken container that
  day, at a new address. Its figures from before stay as history.
- **Cronus284 is CentralGauge's, not LethAL's** (owner, 2026-10-21). LethAL used it from
  2026-09-26 to 2026-10-20; those measurements stay as history. Never lease, publish to or clean up
  there. Cronus281, Cronus282 and Cronus283 are CentralGauge's too.
