# R-434 pre-commitment: can a server's full installed-app list be read safely, from AL?

Committed by lethal-bugs on 2026-10-23, before any lease or server call for R-434.

**What it covers.** The probe on `lethal/r434`, head `802d2a1b122b953e21c77ec718595597608b887b` (probe tree
`d4796d37ccefb430159b68a4eb12f7b72cadb8d3`):
- the app `scripts/r434-installed-probe/app` (one read-only web service);
- the driver `scripts/r434-installed-probe/drive.ts` (listed in `scripts/typecheck-excluded.json`);
- the lease wrapper `scripts/r434-installed-probe/run-probe.sh <server>`.

**Background:** R434 (`docs/roadmap/R434.md`), part 1; R433 (the unfiltered `extensions` list hangs BC 28.4 and
must never be issued); R-385's plan, limit L0.

## 0. Part 2 needs no server

R434's part 2 (run R-385's D2 installed check for non-Microsoft dependencies too) was done by R496 (F5, 47179723):
- `dependencyFingerprint` calls `checkInstalled` for EVERY extension it hashes, partner and transitive ones included;
- tests T5 and T6 in `orchestrator.test.ts` pin a staged partner dependency, served at 1.0.0.0 while 0.9.0.0 is
  installed, leaving the run unproven;
- the per-app read is guarded in `extensions-query-refusal.test.ts`.

This probe is about part 1 only.

## 1. The question

R434 part 1: an installed app outside the test app's dependency closure can change a test (a global subscriber, a
setup change). Nothing reads it today. To fold "what is installed" into the digest, LethAL needs the full installed
list, and the only list BC's automation API offers is the one R433 forbids. The source measured here is AL's own
`NAV App Installed App` table, read inside the server by a web-service codeunit: the shape a new LethAL Control
procedure would take.

1. Does an AL read of `NAV App Installed App` return the full list, and how fast (AL-side ms, HTTP ms)?
2. Is it stable: are three reads in a row the same list?
3. What is on each server: how many apps, from which publishers, and which apps change version from run to run (the
   gates' instrumented fixture targets mint a new version on every publish)?

**It changes no product code.** It adds one throwaway app, a driver, a wrapper, and (from the run)
`docs/measurements/r434/`.

## 2. The servers, the lease and the cost

- **The servers:** bc1, then bc2, then bc3. Each runs under its own coord lease, taken by `run-probe.sh <server>` and
  released before the next. The driver refuses (exit 2) unless `kraken coord holder <server>` names lane bugs. It
  makes no server call before that check.
- **Before leasing:** count the heavy jobs, and check each server is free with no out-of-use marker. The wrapper
  refuses a marked server.
- **The cost:** about 1 minute per server (publish, 3 reads, removal).
- **The login** is read inside the driver from the secret file and never printed.

## 3. The app (compiled offline 2026-10-23, before any lease)

- **Compiler:** alc 18.0.43.1464 (`$LETHAL_ALC_DIR`), against
  `/coord/cache/bc-symbols/bc3/28.0.54946.56477-6725e7bb/Microsoft_System.app`. bc1, bc2 and bc3 cache the same System
  build. Exit 0, no diagnostics.
- **Output:** the gitignored `scripts/r434-installed-probe/build/probe.app`, sha256
  `2c6a45ac3fdb9f5e27bdc511b90c4848d9170f743c01ea52580b8858fc0b1ef1`. The driver records the sha256 it publishes.
- **"LethAL R434 Installed Apps Probe"** (`4c1e8a37-9d52-4f0b-b6e3-2a7d58c19f64`), ids 92970-92979, no dependency:
  - codeunit 92970 `ListInstalled()`: every `NAV App Installed App` row as `id|publisher|name|version;`, behind a
    header `rows=<n> ms=<AL ms>`. It writes nothing.
  - codeunit 92971, an Install codeunit registering it as the web service `R434ProbeInstalled`.
- **The id check:** `git grep` finds no `9297x` object id, and the GUID and service name appear nowhere else.
  `/coord/handoff/*/probe` holds no `9297x`. The driver reads the app id absent (0 rows, a by-id read) before it
  publishes, or it fails without publishing.

## 4. The readings, per server

- LethAL Control's version and `serverGeneration`.
- The probe published and read back installed.
- Three `ListInstalled` calls, each with: the row count, the AL-side ms, the HTTP ms, and a fingerprint (sha256 of
  the sorted `id version` lines).
- The full list (id, publisher, name, version) and the count per publisher. Names, publishers, ids and versions are
  public facts about the apps, not source.
- A `HarnessVerifier.verify()` after the reads (the server still answers).
- The removal steps (uninstall 204, unpublish 204, 0 rows).

## 5. Predictions (stated before the run)

- **Every read answers** in under 1 s of HTTP and under 100 ms on the AL side.
- **Three reads per server give the same fingerprint.**
- **The list holds:**
  - the W1 Microsoft apps (tens of rows);
  - LethAL Control;
  - the gates' fixture apps (`LethAL Sandbox ...`, the tests apps, the credit-limit demo on bc1);
  - the probe itself;
  - on bc3 also the 5 Continia apps.
  - bc1 and bc2 have the same Microsoft set; bc3 adds Continia.
- **The fixture targets that gates publish instrumented carry minted versions** (`<major>.<minor>.<days>.<halfSeconds>`),
  so the list changes every time any gate runs on that server. Folding the raw list into a digest would therefore
  invalidate every project's verify on a shared server whenever any other project publishes. The ruling must weigh
  that.

## 6. How the readings feed the ruling (R434 part 1)

| Reading | Consequence |
|---|---|
| A read fails, times out, or the list is unstable across the three reads | AL is not a usable source. **Ruling: state the limit** (L0 stays, documented), with these numbers. |
| The reads are fast and stable | A source exists. The orchestrator rules between: (a) a new LethAL Control procedure, a control-app version bump that every gate server must take, re-proving every gate (R604), whose installed list, minus the app under test and its test app, is folded into every digest; and (b) stating the limit. The measured churn (§5's last point) and the control-bump cost go with the ruling request. |

## 7. The STOP rule

A call that does not answer within 60 s, or a server that stops answering HarnessInfo after the reads. Then: no
removal and no further server. The driver exits 5, and the wrapper keeps the coord lease and writes
`/coord/machine/out-of-use/<server>.md`. The release comes after the owner's restart and a clean
`bc-linux-setup.ts --server <server>`.

## 8. What stays on the server

The probe app is uninstalled and unpublished at the end (each HTTP 204, then 0 rows by id). Nothing else is written.
