# Pre-commitment: re-running `do rung1` after R175's fix, on Cronus28

Written and committed BEFORE the run. Nothing above the OUTCOME line is edited afterwards.
Machine-checkable half: `scripts/r175-rung1-rerun-compare.ts`, whose constants are this document.

## 1. What is owed

[[R175]] ends with a prediction and no measurement: after `41daa29` the fenced path no longer widens
a local's coverage to object level, so `do rung1`'s 87 widened survivors must leave `survived`, and
the score must move from 25/132 to about 25/45. The row says it is *not closable as a documented
limit* until a re-run shows both. The hosted environment the campaign ran on (`f5f11bf2`) is
deleted, so the re-run is on a local BC 28.4 DK container, Cronus28, which nothing else targets.

## 2. Why the comparison is by position, not by identity key

`rung1.baseline.json` is keyed on `astSubtreeHash`, and [[R166]] (2026-08-19) changed every hash.
So `campaign compare` cannot be used and no rung1 key will match today's. The source is unchanged:
`U:/Git/do-lethal/Cloud` fingerprints `9a8e8831449208cc48bdbc8f04ae1db42d6050ca67bd7487350f48cc6b933962`
today ([[R187]]), the same content the campaign measured (the worktree is at `5f2a71d3`, the
campaign branch's commit). A mutant is therefore matched by `startIndex|operatorName|operatorMajor`,
which is unique in both reports and does not depend on the hash. The END offset is deliberately not
used: `empty-block`'s span end moved by one character since rung1, and matching on it would
misreport 31 relabelled mutants as 31 removed plus 31 added.

## 3. The mutant set is not rung1's 148, and the difference was measured offline first

The run restricts itself to rung1's ten operators with `--operator`, since sixteen more have shipped
since 2026-08-03 and a full run would answer a different question. Even so, `generateMutationSet` on
the same file with those ten returns **155** specs today against rung1's 148:

- **4 removed**, all `negate-conditional` on an `until X.Next() = 0` loop exit: **M0013, M0040,
  M0089, M0102**. That is [[R164]]'s hazard refusal (a negated loop exit is a hang), and M0013 is the
  very mutant that stranded rung1 for 181 s and scored `timeout-killed`. So the timeout branch of
  rung1's gate no longer exists.
- **11 added**: seven `void-method-call` sites (bare local calls, `Window.Open`, a `SetFilter`, a
  one-argument `SetRange`), two `remove-setrange`, one `empty-block` at an un-braced branch
  ([[R161]]). Pinned by start offset in the script. **Their verdicts are NOT predicted**: they are
  operator growth, not R175, and the script prints them as unpredicted.
- **144 shared.** Every R175 claim is evaluated on these.

## 4. The shared 144, partitioned from rung1's own report and pre-committed per class

| class (from rung1's fields) | count | rung1 verdict | predicted verdict |
| --- | ---: | --- | --- |
| killed, `exact` | **25** | killed | **killed**, same killing test |
| survived, `exact` | **19** | survived | **survived** |
| survived, `object`, in a trigger (`OnRun`, fallback 1) | **1** | survived | **survived** |
| survived, `object`, in a procedure: **the widened ones** | **85** (87 minus M0089, M0102) | survived | **`no-coverage`** |
| no-coverage (public `CreateOrSendAutStatements`) | **14** (15 minus M0040) | no-coverage | **no-coverage** |

Any shared mutant whose verdict differs from its class's prediction refutes this document. A killed
mutant reporting a different killing test is printed and must be explained, but is not by itself a
refutation: it is the test-order question, not the attribution question.

**Score on the shared 144: 25 / (25 + 20) = 0.5556.** R175 wrote "about 25/45"; that is exactly it.
The whole-run score will differ by whatever the 11 unpredicted additions do and is reported, not
predicted.

## 5. The mechanism claim, stated so that it can be wrong

R175 predicts the widened mutants become *mostly* `unplaceable`. Reading `coverageFilter`, that
cannot be "mostly" here: `unplaceable` is set per OBJECT (`byObjectNamingGap` keyed on the object),
and this run has one object. So `unplaceableCount` is one of exactly two values:

- **0**: every line rung1's coverage could not name was inside `OnRun`, which `line-map.ts` now
  classifies as a trigger rather than a naming gap. Then the 85 are plain `no-coverage`.
- **99**: the object has a genuine naming gap (a covered line inside no procedure and no trigger),
  and every uncovered non-trigger mutant in it, the 85 widened plus the 14 already no-coverage, is
  reported `unplaceable`, and `unplaceableMutants` lists exactly those 99.

Any other value is a finding about `isNamingGap`, not about R175's verdict claim, and refutes this
document. I do not know which of the two it will be, and that is the point of running it: the
count is the first live measurement of the non-zero branch on real code, which no gate fixture can
provoke.

## 6. Preconditions, which are not claims about R175

- `baselineGreen` true, **56** baseline tests under `--tests-only "Src/AutomaticDocuments/**"`,
  **0** failing. A red baseline on the local container would make the run a measurement of the
  container, not of the fix, and the comparison stops there.
- The test app is compiled WITHOUT `CDOAutStatementFeatureTests.Codeunit.al`, the 24 tests rung3's
  agent wrote. They live in the same directory the glob admits, and with them present this would be
  a re-run of `rung3.independent-confirm` (147 exact, 1 object) and R175's claim would be untestable.
- Corpus fingerprint printed before the run and equal to §2's.
- Same scope as rung1: `--only "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al"`,
  `--stop-hung-sessions`, alc 17.0.29 ([[R43]]), selector ids 6175466 to 6175468.

## 7. What refuses this run

- Any precondition in §6 failing.
- The removed set not being exactly the four named, or the added set not being exactly the eleven
  pinned keys. Either means the operator set drifted in a way not measured offline.
- Any of the 144 shared mutants moving off its class's predicted verdict. In particular a single
  widened mutant still `survived` means the fenced widening is not off.
- `unplaceableCount` outside {0, 99}.

## 8. What is NOT being done

- No re-recording of `rung1.baseline.json`: it is the campaign's record and stays.
- The 11 added mutants are not judged. If one of them is interesting it gets its own row.
- No `coverageMode: "none"` cross-product. That is the ground truth for scoring the 85 properly and
  is a different, longer run; this one measures what the DEFAULT path now says.

---

## OUTCOME
