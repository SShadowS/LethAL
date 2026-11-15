# PR-03 pre-commitment: al-runner v3 against BC, test by test, on six small BC.History modules

Lane lethal-bugs, coord PR-03 (process review item 4), 2026-11-15. Committed before any publish to a BC server.
Owner's standing approval (kraken q-20261114T210729-30bf7112): small BC.History app+test pairs on bc2 or bc3, scratch ids, under
the lease throughout, unpublished after every run.

## What runs where

- **al-runner v3:** `current` edge-5a58a0f16 (master b80421ae), each module's source and test project as in BC.History
  (sources 28.6), configs and stores in `/coord/handoff/PR-03/` (`v3.<m>.json`, `<m>.sqlite`, `<m>.v3.events.ndjson`).
- **BC:** BC 28.4 W1 on bc2 (or bc3), one lease held throughout. On BC 28 every System Application module lives inside the
  one "System Application" app, so the module itself is NOT published: publishing its source would clash with System
  Application's objects (the R709/R841 hazard). Only a renumbered copy of each TEST app is published, depending on System
  Application and Library Assert alone, objects in the scratch range 91500-91589, publisher "LethAL Scratch", a new app id
  (`/coord/handoff/PR-03/bc/<m>-test/`, `compile.md`; each compiled clean offline against the server's symbols, so none uses
  module internals). Tests run by codeunit on the server's own module. Each app is unpublished after its run; `lethal doctor`
  before the lease is released.
- Baseline only. A mutant sample on BC would need a renumbered copy of the MODULE in its own namespace: not in this round.

## The modules and the v3 baseline (measured 2026-11-15 on edge-5a58a0f16)

| module | test codeunits (scratch id) | tests | v3 |
|---|---|---|---|
| Date-Time Dialog | Date-Time Dialog Test (91500) | 4 | 4 pass |
| Filter Tokens | Filter Tokens Test (91510) | 5 | 5 pass |
| Secrets | In Memory Secret Provider Test (91520), App Key Vault Secret Pro. Test (91521) | 6 | 6 pass |
| Base64 Convert | Base64 Convert Test (91550) | 13 | 13 pass |
| Document Sharing | Document Sharing Test (91560) | 17 | 17 pass |
| Json | Json Test (91530) | 18 | 16 pass; TestGetBoolPropertyValueFromJObjectByName error, TestGetEnumPropertyValueFromJObjectByName fail |

## Predictions

1. Every test of the five all-green modules passes on BC: v3 and BC equal per test (63 tests).
2. Json: all 18 pass on BC (Microsoft ships them passing), so its two non-passing v3 tests are v3 differences.
3. Any other difference is decided by BC's answer. Before calling one an al-runner defect, compare the module's 28.4 and 28.6
   sources (the server runs 28.4, v3 ran 28.6) for the code the test reaches; a version difference is recorded, not filed.

## What follows from a difference

Each difference decided against v3: an invented repro (no BC.History text), an upstream issue at
aldevtools/BusinessCentral.AL.Runner, a roadmap item, a regression-set entry, and the cause in the refusal ledger if it is a
refusal. Start/End UTC lines in `/coord/handoff/PR-03/result.md` measure the cost.
