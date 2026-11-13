# R-953 pre-commitment: R-950's eight possibly-false Cryptography survivors, then BC.History batch 8 on al-runner edge-c8fe56e05

Committed before any run, 2026-11-13. Coord task R-953. Evidence goes to `/coord/handoff/R-953/`. No BC.History source text is
committed: app, test and procedure names and counts only.

## Part 1: the eight Cryptography Management survivors

M1190, M1191, M1200, M1201, M1259, M1262, M1322, M1323 (signed-XML key setup removed) survived on edge-42af5d384 and are refused on
edge-c8fe56e05 (`SignedXml.ComputeSignature` raises `CryptographicException`, "the text AL would see is not pinned"). Each is decided
from its covering tests: BC kills it when a covering test fails on BC (the exception escapes or an assertion fails). Run per mutant
on both builds (a mutated copy, never committed). Expected: BC kills them (a signature cannot be computed without a key), so they
were false survivors on the old build; where the new build refuses and the test does NOT read the error text, that is a lost kill
for upstream (a follow-up to #7924, with an invented repro). A test that reads the text: the refusal is right.

## Part 2: batch 8

Of R-927's buildable System Application modules not run in R-913..R-950, with many tests and features earlier batches covered less
(`/coord/handoff/R-953/select.ts`):

| key | module | [Test] | deployed (dry run) | hang-refused |
|---|---|---|---|---|
| aadum | Azure AD User Management | 24 | 672 | 1 |
| featkey | Feature Key | 19 | 522 | 5 |
| json | Json | 18 | 317 | 5 |
| regex | Regex | 18 | 344 | 0 |
| transl | Translation | 18 | 189 | 2 |
| privacy | Privacy Notice | 16 | 465 | 0 |
| wsmgmt | Web Service Management | 16 | 521 | 15 |
| sftp | SFTP Client | 14 | 254 | 0 |

- **LethAL:** lane-preproc at current master (f2e135bd or later), named in each run's first line; defaults as master ships them
  (R954's mutant stop, R963's own durations).
- **al-runner:** `current`, edge-c8fe56e05, named in each run's first line. **Environment:** `onprem` (R938), as R-940.
- **Packages:** the eight modules' closure built with R-927's driver (`pool-build/`, class `other`), put in the shared cache as
  `bch-sysapp-pool-batch8` before cleanup. Probing path the Windows BC 28.4 service folder.
- **Runs:** the full mutant set, one `--time-budget 3600` window each, one at a time in one heavy slot (retry on exit 75 only), the
  memory rule (memory.current + 16 GiB < 28 GiB) before each start.

**Nothing is pre-committed about verdicts.** Reported per app (as R-940): transport, executed and decided per hour, daemon closes by
reason, refusals by cause, baseline reds by cause, a false-kill sample. Every al-runner refusal or difference gets an invented repro
and an upstream issue unless one exists; every LethAL gap a roadmap item.
