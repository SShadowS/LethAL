# PR-10: what edge-5a58a0f16's flips free — results

Pre-commitment `precommit.md` (f0a3f8a9). Every run below is on al-runner edge-5a58a0f16 (configs pinned; each report's
`runnerBuild` read). LethAL master 177b1b49. Evidence: `/coord/handoff/PR-10/` (`<key>/compare.txt`, `run-*.log`,
`ledger-all.txt`). Reports are not committed: they carry AL source.

## Freed tests (#8038)

**Guided Experience** (reference R-985/guided, edge-847b1fa5a, where 84 of 104 tests were refused):
- **Triage:** 76 of 104 green, 13 refused.
- **Discovery** found the files the 84 freed tests cover. **Scoring** compared 1,948 mutants, all of them in both runs.
- **Allowed moves: 405** (296 no-coverage -> killed, 109 survived -> killed).
- **BLOCKs**, each explained:
  - **No-coverage -> survived, 413:** every one is now covered by a freed test, which reaches the code and kills nothing (as PR-06's
    project 15).
  - **Survived -> error, 6:** the freed tests now reach these mutants, and under mutation they meet a refusal. That is #8038 again in
    `GetExtensionLogo` (3), and a Rename of Guided Experience Item primary-key shape (3, NEW). The reference's "survived" was
    measured without those tests, which were refused there at baseline, so no kill was lost. The error is a measurement gap, and
    the ledger counts it.
  - **Survived -> no-coverage, 18:** `GuidedExperienceItem.Table.al` OnValidate, lines 38-61. This is PR-06's trigger-attribution
    shape.
    - Ground truth (`guided/none/`, coverage "none" on those lines, edge-5a58a0f16): 18 scored, 18 survived, 0 killed.
    - The 13 distinct moved keys (18 with hash twins) all survived, so no kill was lost.

**Extension Management** (R-982 #31): **not freed.**
- The triage shows all 8 tests still refused on 5a58a0f16.
- 4 tests meet #8038's FlowField denial on NAV App Extra (2000000157). The flipped repro passes, so these take another path.
  Commented upstream (#8038, not reduced).
- 4 tests meet another permission denial (2000000201, "made by the runtime for a page, report, xmlport or validation").
- No covered file, so nothing was scored.

## Freed error mutants

| key | reference (build) | freed | moved to | still error |
|---|---|---|---|---|
| dv Digital Vouchers | PR-06 pinned 982-9 (a184cfc79) | 2 (#7586) | killed 2 | 0 |
| sa Statistical Accounts | R-902/sa (3096bf68) | 2 (#7586) | killed 2 | 0 |
| email Email | R-975/email.fresh (736fc7677) | 5 (#8036) | killed 2 | 3 |
| saft SAF-T | R-958/saft (c8fe56e05) | 3 (#7760) | – | 3 |

None of the reference's other mutants on those lines moved (no BLOCK).

**Still error, reduced and filed:**
- **Email's 3 (#8036):** `RecordRef.Open(0)` does not raise on 5a58a0f16, so the next `ReadPermission` is refused. An empty Email
  Related Record's "Table Id" is 0. `Open` of a missing table id does raise.
  - Invented repro: regression entry `u8036-open-zero`.
  - Comment on #8036 (6892946955).
- **SAF-T's 3 (#7760):** `AddFirst` on an unassigned XmlElement is still refused. The members 5a58a0f16 fixed are `InnerXml`,
  `SetAttribute` and `GetChildElements`.
  - Invented repro: regression entry `u7760-addfirst`.
  - Comment on #7760 (6892957812).

## Not re-run
- VAT Group Management has no GetTable sighting: its tests stop at #8028 first.
- The CopyStream row has no sighting at all.
- #8006 (1753 dates) is a wrong-verdict class, left to PR-15.

## Predictions, scored
1. Guided Experience: most freed tests run, and it gains. **Held** (76 of 104 green; 405 to killed).
2. Extension Management gains. **Missed**: its tests are still refused (above).
3. All 12 freed error mutants leave `error`. **Missed for 6** (Email 3, SAF-T 3): the flips miss those corpus shapes. Reduced and
   filed.
4. No BLOCK outside PR-06's attribution shape. **Missed**: 413 no-coverage -> survived (new coverage from the freed tests) and 6
   survived -> error (refusals under mutation). Both are explained above, and neither is a lost kill.

## Ledger
`refusal-ledger.ts --run` over all seven PR-10 stores (triage and scoring) found **3 NEW causes**, all in Guided Experience:
- a permission denial on a page control over an unreadable FlowField (15 tests);
- a list over a temporary source after OnOpenPage moved its key (1 test);
- the Rename primary-key shape (3 mutants).

They are added `unexamined`. PR-06's withheld SaveAs key is added too, now that the normaliser masks its message (5fddfb6d).
