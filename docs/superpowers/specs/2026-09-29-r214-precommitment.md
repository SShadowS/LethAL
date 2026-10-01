# R-214 pre-commitment: per-mutant sites per build, before any product code

Plan: `docs/superpowers/plans/2026-09-29-R-214-symbol-aware-site-enumeration.md` (Decisions 6 and 7).
Made at `48973f1864c18a802abd3db8188ee46d7496d90a` (branch `lethal/lane-preproc`, master merged),
2026-09-30, on master's engine: nothing of the fix exists yet. This file and everything it names
were committed ALONE, and a difference found later is a finding, never an edit.

`$P` = `H:/lethal-scratch/R-214/plan` (the r1 tools), `$Q` = `H:/lethal-scratch/R-214/plan-r2`
(the r2 tools), `$O` = `H:/lethal-scratch/R-214/corpus`. The committed files need nothing on `H:`.

## What is pre-committed

1. A site that starts in a compiled-out arm is gone.
2. An undecided file (Decision 2's refusals) has no site; it is counted under `preproc-undecided`.
3. Inside a statement-level ACTIVE arm, a statement is a statement (the arm is lifted).
4. Everything else is master's enumeration, row for row and byte for byte, key and attributes included.
5. The prediction runs master only (`pp.ts` + `r214-capture.ts` + `predict.ts`), shares no code
   with the product's arm evaluator, and is checked against a second independent view, the full
   twin (the text alc compiles), by `presence.ts`.

## Symbols

The measured table is the plan's "alc's precedence, measured" (49 rows, alc 18.0.41.45789,
`$Q/prec/battery.txt`, `battery2.txt`), and the grammar is the one written under it:

```text
condition := or ;  or := and ("or" and)* ;  and := unary ("and" unary)* ;
unary := "not" unary | primary ;  primary := "(" or ")" | "true" | "false" | symbol
symbol := [A-Za-z_][A-Za-z0-9_]*  (case-sensitive; keywords and/or/not/true/false case-insensitive)
```

`$Q/pp.ts --self-test` over both batteries: **99 rows, 0 bad** (`$Q/out/self-test.txt`). Every
row alc compiled agrees on the built arm; every rejected row Decision 2 models is refused; row 21
(`#if and`) is refused as `unparsed-condition`; row 49 (directive text in a block comment) is
refused as `marker-mismatch`.

**Named exceptions (ruling T1-c, 2026-09-30).** Three alc-REJECTED rows are not refused, because
Decision 2 (the more specific text) does not model them: row 34 (`#endif A`, `endif-text`) and row
46 (`#define` after the first token: `def-mid`, `def-after-object`). A project containing them
cannot build, so no mutant of it is ever scored. (Row 35, a directive after code, is refused
incidentally as `unbalanced`.)

## Repros

Under `packages/runner/tests/fixtures/r214/<name>/` (each `app.json` runtime 16, no dependency;
`symbol-sets.json`). All compile un-instrumented under every set: **31 builds, errors=0 each**
(`$P/alc-plain.sh`; ruling T1-e, 2026-09-30: 31 is correct, the brief's 32 was a miscount).

Each expected file is `packages/runner/tests/fixtures/r214/expected/<name>.<set index>.txt`, in
the capture's format (header `raw N deployed M skippedFiles K`, forward-slash paths). Set index,
not symbols, names the file: `FOO` and `Foo` collide on a case-insensitive file system.

| expected file | set | header | SHA-256 |
| --- | --- | --- | --- |
| fixture-sandbox-symbols.0 | `[]` | raw 9 deployed 9 skippedFiles 0 | 671e116b2e1c5a04bee345bbd1dbe1afc947f0bb033ce876a816debe31a4448f |
| fixture-sandbox-symbols.1 | `[LETHALA]` | raw 9 deployed 9 skippedFiles 0 | 33836a57e92df8a53c7ba64df531b053e823b8f6ccff30b1be8de319e66a0470 |
| fixture-sandbox-symbols.2 | `[LETHALB]` | raw 9 deployed 9 skippedFiles 0 | a642a05e8092e86d3c3e5b3a7d8b6b9a7a4a1f884d7297fcf4295da996a7520d |
| p-r214.0 | `[]` | raw 6 deployed 6 skippedFiles 0 | 14fb40fc705e13709f8135455db971d81e88f3f7935ec4b1a5e4490216351a14 |
| p-r214.1 | `[CLEAN25]` | raw 5 deployed 5 skippedFiles 0 | 85dc9c1d15aedc45c9f359c56533f72f3b29206b11319234be51f5e281298d34 |
| p-r285.0 | `[]` | raw 3 deployed 3 skippedFiles 0 | 162f90ebcc0274373f293ffff46f64cecf34c813f944176b35617515bdbb080f |
| p-r285.1 | `[FASTPATH]` | raw 7 deployed 7 skippedFiles 0 | 63c671337aa0ea2745b3ada7d41349d720d9057ef4b6285371cec969b2119f47 |
| p-r306.0 | `[]` | raw 6 deployed 6 skippedFiles 0 | 1019704d0b22f7627f60a59892e006f3cb059938b00da4ab24d34b4375d49766 |
| p-r306.1 | `[SYM]` | raw 4 deployed 4 skippedFiles 0 | 8012d599eccef85cc918f94f618bcb2ef95a999ed674f9dfef42defe8d36462b |
| p-r306b.0 | `[]` | raw 7 deployed 7 skippedFiles 0 | 01e2a5093aae12bc5fc79b4140ffb038a12d8a3e75efb9b8e7d32446edde382a |
| p-r306b.1 | `[SYM]` | raw 6 deployed 6 skippedFiles 0 | 918f5bf72c004b1ef0a5eeee5eadeffd4e757a8ad27f8b5e7f1eaed307123098 |
| p5-elif-nested.0 | `[]` | raw 6 deployed 6 skippedFiles 0 | 51c2dad0539f172b4a4d75510fa9a7fc7d9f98e5122d66d77c090b5ec918b5d6 |
| p5-elif-nested.1 | `[A]` | raw 6 deployed 6 skippedFiles 0 | dd0f3ec28b513275b6640ec19fbcd3b00fbc01fe5f36575178bc9cf4b97e65ef |
| p5-elif-nested.2 | `[B]` | raw 5 deployed 5 skippedFiles 0 | ac61660b8ab0eb03f818d6a5bdb8c38f1c796ba37b4a061716b8ee3ab3c85d10 |
| p5-elif-nested.3 | `[A,B]` | raw 6 deployed 6 skippedFiles 0 | 729b3279b03fb04e41b81a84a3ee739368317f04601cb49ac81e05423d1cd64f |
| p6-define.0 | `[]` | raw 2 deployed 2 skippedFiles 0 | fe1c2f63f69aaaf7bbfcc6d6bbfa60d7c4cb3455be5bd838e4dc8bc7f0e508d2 |
| p6-define.1 | `[DROPSYM]` | raw 2 deployed 2 skippedFiles 0 | fe1c2f63f69aaaf7bbfcc6d6bbfa60d7c4cb3455be5bd838e4dc8bc7f0e508d2 |
| p7-appjson.0 | `[]` | raw 2 deployed 2 skippedFiles 0 | d08609c891c81475799067ad5846ddc3cc78c2ba1ab18ea3d857205f2215e998 |
| p8-slot.0 | `[]` | raw 5 deployed 5 skippedFiles 0 | ecb9f135a9242afce8b37541439aae618482de3de5d4723581279305e4094773 |
| p8-slot.1 | `[SLOTSYM]` | raw 4 deployed 4 skippedFiles 0 | 020ae9b77f9a11683a58db051064c77c7857a5d3731224af02394c812d7056e8 |
| p9-precedence.0 | `[]` | raw 5 deployed 5 skippedFiles 0 | 6dd61b122a1e233a5e04cdd405fec00f07c999ff175509f054a66dd7bf9938b2 |
| p9-precedence.1 | `[UA]` | raw 7 deployed 7 skippedFiles 0 | d4d16badefe3af6182f6a5b59dab4404af8f2cf56d8a39b0980b2c608d839ca7 |
| p9-precedence.2 | `[UB]` | raw 4 deployed 4 skippedFiles 0 | d15f3086e401f03535c6ee1baa1577620dabecd174fe912a8905981c254459b7 |
| p9-precedence.3 | `[UA,UB]` | raw 7 deployed 7 skippedFiles 0 | d4d16badefe3af6182f6a5b59dab4404af8f2cf56d8a39b0980b2c608d839ca7 |
| p9-precedence.4 | `[UB,UC]` | raw 6 deployed 6 skippedFiles 0 | 2b3ee1008a297d7c2282d0a08c31d0de07ce170766fb59a173e398fdac2d5fdb |
| p10-case.0 | `[]` | raw 3 deployed 3 skippedFiles 0 | c0fa29b496c1bd2f5ef8427f1bcaae5296669fc97aa42ea006bd4e806b687bd4 |
| p10-case.1 | `[FOO]` | raw 3 deployed 3 skippedFiles 0 | c0fa29b496c1bd2f5ef8427f1bcaae5296669fc97aa42ea006bd4e806b687bd4 |
| p10-case.2 | `[Foo]` | raw 2 deployed 2 skippedFiles 0 | a067539ad93fd49282b0357d1390270d303ea1259b4af61386f79bd10de0ac65 |
| p11-tier2.0 | `[]` | raw 10 deployed 9 skippedFiles 0 | 6ac7eeb06985420ab4c3983f717ce6d5c113defc3112e8c7d726f9cd5c27590b |
| p11-tier2.1 | `[T2SYM]` | raw 9 deployed 7 skippedFiles 0 | 87bff9ca1bfa36f552cd95f206764a43fb6ef1f39f5b4bb7b32773092fa4bfde |
| p12-refused.0 | `[]` | raw 3 deployed 3 skippedFiles 0 | 514db849b996142d52b2712ca3a6e4ded945556ac6c6d8cdef91ba6a8bf9be97 |
| p12-refused.1 | `[R12SYM]` | raw 2 deployed 2 skippedFiles 0 | c5e8945e9671a8d3e8e10e31bc4c129bcba5edc057fb8ce412fece9cddefd900 |
| p13-exclusions.0 | `[]` | raw 11 deployed 11 skippedFiles 0 | 04fab7d969f421c8d6500573ef1bd9b5193f8d32b2a79fa00409f8b45757f246 |
| p13-exclusions.1 | `[P13SYM]` | raw 5 deployed 5 skippedFiles 0 | cf60a685ed1f5dc499859e8e278821213f08982829db75d3f893c863cbc8b3b6 |

Totals and changes equal r1's plan-time table for every r1 repro. Everywhere: `approxKeys 0`,
`UNCLASSIFIED 0`, `EXTRA 0`. `undecidedFiles` is 1 for `p12-refused` in both sets
(`src/Refused.Codeunit.al`, `marker-mismatch (2 directive lines, 0 markers)`) and 0 elsewhere.
Key moves (`$P/keymoves.ts`): `p-r214 [CLEAN25]` L22 `void-method-call` ordinal 0 to 1; `p-r285 []`
L19 and L22 `void-method-call` 1 to 0; `sandbox-symbols [] ` L17 pair 2 to 0; `[LETHALB]` L15
pair 1 to 0.

**The `p11-tier2` ruling (plan r1, applied by hand):** in both `p11-tier2` files, L10
`lethal.remove-commit` has `plat=-` (master printed `plat=write-txn-codeunit-run`). After Task 5
the bare in-arm `Codeunit.Run(50013);` is a statement position in both builds.

**alc proof** (`$Q/prove.sh`, `$Q/poison.ts`): every `dropped` poison COMPILES (34 of 34) and every
`control` is REJECTED with `AL0118 ... 'R214POISON'` (34 of 34). Ruling T1-b (2026-09-30): the
poison proof covers only compiled-out drops; a refused file's rows are compiled by alc by design
and are counted instead (`p12-refused`: `preproc-undecided 3` in both sets).

**Exclusions by reason** (full-twin rows master does not produce; the rules are under "Presence"):

| repro, set | reason | rows |
| --- | --- | --- |
| p-r214 `[]` | dup-arm-typing | L11 `swap-additive` |
| p-r285 `[]`, `[FASTPATH]` | split-case-body | L18 `empty-block` |
| p8-slot `[]` | slot | L9 `void-method-call` (the active arm's `Helper(X + 1)`) |
| p8-slot `[SLOTSYM]` | slot | L7 `void-method-call` (`Helper(X)`) |
| p13 `[]` | R287-C7 (3) | ElseTail L9 `empty-block`, L11 and L12 `remove-assignment` |
| p13 `[]` | R304 (4) | SplitBlock L6 `empty-block`, L6 `negate-guard`, L8 `remove-assignment`, L9 `void-method-call` |
| p13 `[]` | R343 (1) | Wrapped L6 `swap-additive` |
| p13 `[]` | split-if-operators (2) | ElseTail L6 `empty-block`, L6 `negate-guard` |
| p13 `[P13SYM]` | R287-C7 (2) | ElseTail L11, L12 `remove-assignment` |
| p13 `[P13SYM]` | R304 (2) | SplitBlock L8 `remove-assignment`, L9 `void-method-call` |

## Presence (the rules, after rulings T1-a, T1-f, T1-g and the orchestrator's ruling)

`$Q/presence.ts` joins each decided directive file's expected rows and full-twin rows on
`(file, start, end, operator)`. A full-twin row with no expected row is classified by the smallest
directive node of the ORIGINAL parse containing its start (`preproc_open`, `preproc_close`,
markers and `preproc_split_begin` count as parts of their parent):

| reason | rule |
| --- | --- |
| R339 | any `ERROR` ancestor |
| R305 | `preproc_split_declaration` |
| R287-C7 | `preproc_fragmented_else_tail` |
| R304 | `preproc_split_if_then_begin*`, `preproc_split_if_begin_asymmetric` |
| R343 | a directive node whose parent is the file root (a wrapped object) |
| slot | `preproc_conditional_statement` not in a statement list |
| dup-arm-typing (T1-a) | `preproc_conditional` + a semantic operator |
| cond-var-typing (T1-g) | `preproc_conditional_var` + a semantic operator |
| split-case-body (T1-a) | `preproc_split_case_extended` + `empty-block` |
| split-if-operators (T1-a) | `preproc_split_if_statement` / `_else_statement` + `empty-block` or `negate-guard` |
| split-call-statement (T1-g) | `preproc_split_call_statement` + `void-method-call` |
| `displaced-by:<reason>` (T1-g) | an EXPECTED-only row whose span is nested in (or equal to) a classified full-twin-only row |
| unbuildable-under-set (T1-f) | per FILE: its full twin has more ERROR/MISSING nodes than the original; the file is not joined, stays in the byte-exact capture, and is counted |

A "semantic operator" is one whose `requiresSemantic` is non-empty (read from the sources):
`flip-boolean-literal`, `remove-assignment`, `return-value`, `shift-integer`, `swap-additive`,
`swap-call-arguments`, and the ten Tier-2 operators `flip-filter-literal`, `remove-calcfields`,
`remove-commit`, `remove-setrange`, `remove-testfield`, `swap-enum-member`, `swap-find-direction`,
`swap-modify-flag`, `swap-rec-xrec`, `validate-to-assign`.

**The STOP covers only operators whose `requiresSemantic` is empty** (the orchestrator's ruling):
anything of theirs still unclassified is `UNCLASSIFIED`, an expected-only row is `EXTRA`, and
either above 0 is a finding. A semantic operator's unmatched row is `typing-unmatched` (twin only)
or `typing-expected-only`; those rows are pinned by the byte-exact expected capture and the
listing, and their counts per operator are pinned below. They are R364.

## Gate fixtures

No directive in any of them (`grep -rlE '^\s*#\s*(if|define|undef)'` empty), so each expected
capture IS its BEFORE capture, byte for byte (`bun scripts/r214-capture.ts <dir>`; hashes by
`scripts/probe-fixture-hashes.ts` in `$Q/cap/gate/`):

| fixture | header | capture SHA-256 |
| --- | --- | --- |
| fixtures/sandbox-app | raw 19 deployed 19 skippedFiles 0 | 6c98d08faf03ef4f647c1816b0cc3be1f3e2f2e868f0d67ad1492890e920de5e |
| fixtures/sandbox-data | raw 407 deployed 387 skippedFiles 1 | aff0aa296c3907bf272a87603a160e6e1f082f078e792610f901a68728b77fe5 |
| fixtures/sandbox-hang | raw 40 deployed 40 skippedFiles 0 | 04a63d72291449020e3011772c050a6e45a31ebc6af5a5c5ede355703a8bfea0 |
| fixtures/sandbox-harden | raw 22 deployed 21 skippedFiles 0 | 912c9ee78158162e9289494e99e67f6da18bcd5339b47fc58f489006bb7c7aee |
| fixtures/sandbox-coverage-probe | raw 86 deployed 80 skippedFiles 0 | 05be38caab42e00ed59f75bc6fc444b5d73cecd28d125081b1b1f54f4e89627c |
| examples/gift-card | raw 64 deployed 60 skippedFiles 0 | 7576579fe42d42950f155c0b14191ecb4cc78f759899c97d0e8b729510c8b3e8 |
| examples/credit-limit | raw 46 deployed 42 skippedFiles 0 | eedafcf22e6a775db19c1f56e0147bb6e7e78be8f5454dd5f5cabd488c278c3e |

`fixtures/sandbox-symbols`: BEFORE `raw 13 deployed 13 skippedFiles 0`; expected 9 / 9 / 9 per
set (the table above).

## R321, new tables (Decision 7)

After the fix each build has 9 mutants. `K` = killed by `Symbol Tests.RateSmall`, `S` = survived,
no killing test. Codes follow the dry run's order: M0001 to M0007 as before, then M0008 / M0009
are the build's own arm pair. The in-arm pair's grain becomes `statement`.

| line | operator | `[LETHALA]` | `[LETHALB]` | `[]` (`#else`, no gate leg) |
| ---: | --- | --- | --- | --- |
| 8 | `empty-block` | K | K | K |
| 9 | `remove-assignment` | K | S | S |
| 9 | `shift-integer` | K | S | S |
| 10 | `remove-assignment` | S | K | S |
| 10 | `shift-integer` | S | K | S |
| 11 | `remove-assignment` | S | S | K |
| 11 | `shift-integer` | S | S | K |
| 13 | `return-value` | K | (none) | (none) |
| 13 | `swap-additive` | K | (none) | (none) |
| 15 | `return-value` | (none) | K | (none) |
| 15 | `swap-additive` | (none) | K | (none) |
| 17 | `return-value` | (none) | (none) | K |
| 17 | `swap-additive` | (none) | (none) | K |
| | **killed / survived / no-coverage** | **5 / 4 / 0 over 9** | **5 / 4 / 0 over 9** | **5 / 4 / 0 over 9** |

**Red-checks, re-predicted.** (a) Dropping the daemon's `--define` (`AlRunnerServer.start`):
LethAL still generates the configured arm, the daemon compiles `#else`, and both server legs print
L8 K, L9 S S, L10 S S, L11 K K, the arm pair S S: 3 killed / 6 survived, failing the four named
equality assertions. (b) Dropping `buildAlRunnerArgv`'s `--define`: the one-shot leg prints the
same 3 / 6 and fails `R321 one-shot [<set>]: per-mutant verdicts differ from the pre-committed
table (...)`; six failures in all. Both are also caught by the count.

### The baseline diff, by key

Read from the committed baselines (`packages/runner/itest/al-runner.symbols-lethala.baseline.json`
and `-lethalb`) on 2026-09-30:

- `SA` = `78d263bdf45458172865b270cf8c37ce220abae7feec90e4dd915b0eabc69b89|Symbol Logic|Rate|lethal.swap-additive|1`
- `RV` = `c9159b460433d7e0187b40a3e9f1c6b24fa17f5d81145d1a4f5e81e464586890|Symbol Logic|Rate|lethal.return-value|1`

(The plan's SA key text was a corrupt splice; this is the key both baselines carry, ruling P2.)
The old engine gave the three arm pairs ordinals 0 (L13), 1 (L15) and 2 (L17): `SA`, `SA|1`,
`SA|2`, and the same for `RV`. After R214 each build keeps only its own pair, at ordinal 0.

| baseline | keys removed | keys whose row changes | keys unchanged |
| --- | --- | --- | --- |
| `al-runner.symbols-lethala.baseline.json` (13 to 9 rows) | `SA\|1`, `SA\|2`, `RV\|1`, `RV\|2` | none (`SA`, `RV`: killed / `RateSmall` before and after) | 9, verdict and killing test identical |
| `al-runner.symbols-lethalb.baseline.json` (13 to 9 rows) | `SA\|1`, `SA\|2`, `RV\|1`, `RV\|2` | `SA` and `RV`: `survived` / `null` becomes `killed` / `RateSmall` (the key that named the compiled-out L13 now names the built L15) | 7, verdict and killing test identical |

Any other added, removed or changed key is a STOP.

## Corpora

Sets (Decision 6): `S0 = []`, `S1` = every `CLEAN*` symbol the corpus's conditions name. Roots:
dc `U:/Git/DC/Cloud` (effective set 0 includes its `app.json`'s `BC20` to `BC27`); sysapp
`U:/Git/BC.History/System Application`; bcf `U:/Git/BC.History/BusinessFoundation`; baseapp
`U:/Git/BC.History/BaseApp`. Run sequentially, one corpus at a time, BaseApp alone.

| corpus.set | BEFORE | expected | removed | added | approxKeys | attrDiffs | undecided | key moves |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dc.0 | raw 102654 deployed 97196 skippedFiles 0 | raw 102633 deployed 97175 skippedFiles 0 | 97 | 76 | 0 | 0 | 0 | 1 |
| dc.1 | | raw 101947 deployed 96489 skippedFiles 0 | 764 | 57 | 0 | 0 | 0 | 72 |
| sysapp.0 | raw 77298 deployed 75839 skippedFiles 7 | raw 77301 deployed 75842 skippedFiles 7 | 36 | 39 | 0 | 0 | 0 | 0 |
| sysapp.1 | | raw 76406 deployed 74952 skippedFiles 7 | 887 | 0 | 0 | 0 | 0 | 31 |
| bcf.0 | raw 3639 deployed 3573 skippedFiles 0 | raw 3639 deployed 3573 skippedFiles 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| bcf.1 | | raw 3584 deployed 3520 skippedFiles 0 | 53 | 0 | 0 | 0 | 0 | 0 |
| baseapp.0 | raw 1775922 deployed 1688278 skippedFiles 73 | raw 1776269 deployed 1688626 skippedFiles 73 | 282 | 630 | 0 | 1 | 0 | 2 |
| baseapp.1 | | raw 1761609 deployed 1674059 skippedFiles 73 | 14243 | 24 | 0 | 1 | 0 | 240 |

`pp.ts` exited 0 everywhere; no capture crashed. **UNCLASSIFIED 0 and EXTRA 0 in all 8 sets.**

**Exclusions by reason:**

| corpus.set | exclusions |
| --- | --- |
| dc.0 | R304 4, R343 9, cond-var-typing 3, dup-arm-typing 29, split-call-statement 2, typing-unmatched 48, displaced-by:R343 4, displaced-by:dup-arm-typing 2, displaced-by:typing-unmatched 45 |
| dc.1 | unbuildable-under-set 5 files, typing-unmatched 5, displaced-by:typing-unmatched 5 |
| sysapp.0 | R343 55, dup-arm-typing 5, displaced-by:R343 1 |
| sysapp.1 | none |
| bcf.0 | R343 2, dup-arm-typing 5, displaced-by:R343 2 |
| bcf.1 | none |
| baseapp.0 | R287-C7 4, R343 392, cond-var-typing 72, dup-arm-typing 745, split-if-operators 2, typing-unmatched 3, displaced-by:R343 131, displaced-by:cond-var-typing 14, displaced-by:dup-arm-typing 284 |
| baseapp.1 | R287-C7 3, typing-unmatched 1 |

The five `unbuildable-under-set` files (dc.1): `.dependencies/DC/Codeunit/CDCContiniaConfigMgt.Codeunit.al`,
`.dependencies/DC/Codeunit/CDCPurchApprovalEMail.Codeunit.al`, `.dependencies/DC/Page/CDCReqAppvlReasonCmt.Page.al`,
`Modules/Approvals/Codeunits/CDCApprovalForwardSubscr.Codeunit.al`, `Modules/Approvals/Codeunits/CDCApprovalManagement.Codeunit.al` (R370).

**Typing differences by operator** (semantic operators; twin-only / expected-only rows):

| corpus.set | counts |
| --- | --- |
| dc.0 | flip-boolean-literal 0/6, flip-filter-literal 3/0, remove-assignment 2/0, remove-calcfields 2/0, remove-setrange 42/0, remove-testfield 1/0, swap-additive 2/0, swap-call-arguments 33/0, swap-modify-flag 6/0 |
| dc.1 | remove-setrange 5/0 |
| sysapp.0 | remove-calcfields 1/0, swap-call-arguments 59/0 |
| bcf.0 | remove-setrange 2/0, swap-additive 3/0, swap-call-arguments 2/0 |
| baseapp.0 | flip-boolean-literal 0/74, flip-filter-literal 14/0, remove-assignment 2/0, remove-calcfields 22/0, remove-setrange 277/0, remove-testfield 56/0, swap-additive 168/0, swap-call-arguments 363/0, swap-enum-member 2/0, swap-find-direction 84/0, swap-modify-flag 97/0, validate-to-assign 130/0 |
| baseapp.1 | remove-assignment 2/0, swap-enum-member 2/0 |
| sysapp.1, bcf.1 | none |

**ATTR rulings (Step 8).** Two rows, one shape: `Source/Base Application/Manufacturing/Inventory/Requisition/MfgCarryOutAction.Codeunit.al`
L737 (baseapp.0) and L742 (baseapp.1) `lethal.negate-guard`, master `grain=unplaced`, lift twin
`grain=statement`. The site's `if` sits in a `preproc_conditional_statement` that is itself the
THEN-branch of another `if`: a slot position (Decision 1), which the product does not lift, so the
product reads the original tree as master does. **Ruling: master's `grain=unplaced` stands**; the
expected capture already carries it (`predict.ts` keeps the BEFORE row's attributes).

### Listing files

Under `docs/superpowers/specs/r214-corpus/`. Each `files.tsv` has one line per file with at least
one expected row (path, row count, SHA-256 of its rows); each `rows.tsv.gz` has the expected rows
of every directive file, one `EXCLUDED <reason>` row per classification above and one
`INACTIVE <file> <startLine>-<endLine>` row per inactive range. **Ruling T1-h (2026-09-30):**
BaseApp's `rows.tsv.gz` holds the full rows only of MEMBERS (procedure, trigger, split procedure)
that hold a directive line (`--directive-members-only`); every other BaseApp row is pinned by its
file's digest and count in `files.tsv`. dc, sysapp and bcf keep full rows. Total `rows.tsv.gz`
size **2,798,409 bytes** (ceiling 20,000,000; it was 24,964,917 before T1-h).

| file | SHA-256 |
| --- | --- |
| dc.0.files.tsv | 491fb9f5aca87d99f3f813568cf04f3a0e1fa3fd0fc2cf9ec8851909b682af28 |
| dc.0.rows.tsv.gz | e24f965455da5d74ea7809dee71a623d617e18d850d2b9b1ba8f49bf1c736477 |
| dc.1.files.tsv | bde64ef59924d4759cd6d012110e2d35d05e27c0990e3e3186832aa2c1bfd419 |
| dc.1.rows.tsv.gz | ca3e2568093b3781c24dd14db1a51ed69d960c5cf6f0dfcb2d274397483ecab0 |
| sysapp.0.files.tsv | 2297d716197a83e208a9fa8d679ed33f37994431e0eeb80779a0f3ade1c45de4 |
| sysapp.0.rows.tsv.gz | a30294d14745b920574c22c6dfe6e3fa9ff90a3e6f9189c82949f87ac910ed06 |
| sysapp.1.files.tsv | 5a1afe9f0c57a6b795d5aba432c7f688f726b3f5b5e9411f0633aab30ec993d3 |
| sysapp.1.rows.tsv.gz | 3fa7e51f5faf845c7bd1029e788724685938c4f724019d349ab1d9b1c1de24dd |
| bcf.0.files.tsv | c1b9bf9bc639c619eda481dc012924ace022bd072f26375cb98ccb7b965a259a |
| bcf.0.rows.tsv.gz | 3b17526f7848cf955eea91c8b38101595b888e872143bb96e79da01618b53d4c |
| bcf.1.files.tsv | 9d41a556505c15b1db771b88cd35fb37fa853df7a23b1dda23bf01bd83d6ee3c |
| bcf.1.rows.tsv.gz | c290cf6abbee8f2fce0203d6a62ed648c4e00fc5394bb15012183f54a284e1f9 |
| baseapp.0.files.tsv | 9a1ed3648814a3d05aa186015af12f64dc8fc65f6071932fcdbc8f4fb88710f6 |
| baseapp.0.rows.tsv.gz | 34d559b572b36766e68a65dce89ac91cdeccf8684b67d8a634336195d936ede4 |
| baseapp.1.files.tsv | 5e53afb634c2bfe3ae78df5b6f91d8af661bd133ca035b21153f07584decae62 |
| baseapp.1.rows.tsv.gz | f7111489fecb187d5978c087f10e3252d69d8bb987afb689c826bebe8a654bbc |

Corpus identity (each file's header): dc `hashTargetSource(root, [])` =
`bfd5f11c8a92b254b08ecd2b90887e1cde5d611581ece6cdab92bb2f34c0ffe7`, git
`5d1bf414225459aff9e447158b139c6d1702bcc7`. The three BC.History roots have no `app.json`, which
`hashTargetSource` requires, so (ruling T1-j) the header records `hashSourceSnapshot` over the
`.al` files alone, labelled `hashSourceSnapshot(al-only,no-app.json)`: sysapp
`67b9aca60c4205f0326d643b3d27008e76bb38680ca59981d9ded23fbde2a1a8`, bcf
`26f4f2ea0a46870a6a0c5593883419f71efd2e33369d3853cdac73084e29a55d`, baseapp
`a74072635ef6ebeb3c4a1195de7ab2e29b985bb25eee6bc0ece0c9918f98b29a`; git
`4d61fc58bc55dd0acb78f8b9b6ea54109b960785` for all three.

**Leak check (ruling T1-i, 2026-09-30).** Over all committed `rows.tsv.gz`: whole-word,
case-insensitive `\bbegin\b` **0**, `:=` **0**, `exit\(` **0**. The brief's substring grep
`begin|:=|exit\(` counted **280** on the untrimmed listing and **36** on the committed one; every
hit is an identifier (a procedure or key name containing "Begin", e.g.
`GLAcctBalanceAtDateInBeginnigBalance`), which is publishable.

## Memory

Master's peak per corpus and set, `bun scripts/r214-capture.ts <root> --symbols <set>`, stdout to
`/dev/null`, in its own run, nothing else heavy running (`maxRSS_KB` from
`process.resourceUsage().maxRSS`):

| corpus | set 0 | set 1 |
| --- | ---: | ---: |
| dc | 1176336 | 1109400 |
| sysapp | 949932 | 958476 |
| bcf | 313728 | 300936 |
| baseapp | 15931300 | 15968956 |

BaseApp's peak is **about 15.9 GB**, measured. The plan's reference figure of a 480 MB BaseApp
capture (R-323) was wrong for this tool on this engine. **Gate (Task 9):** every after-change peak
is at most 110% of the figure above for the same corpus and set, measured with the SAME command in
its own run; a crash or a breach is a STOP.

## Identity scheme

The scheme this pre-commitment was made on: **`S` = 4** (`packages/schemata/src/project.ts:109`),
as committed in `packages/runner/tests/fixtures/r214/before/scheme.json`
(`{ "identityScheme": 4, "engineCommit": "48973f1864c18a802abd3db8188ee46d7496d90a" }`). The next
scheme, numbered by the scheme-race rule (Decision 4, master's value plus one), is **5**, unless
master's value moves first.

Measured key moves: the repro list under "Repros", and per corpus the `moves` column above
(`$O/keymoves-<c>-<i>.txt`).

**The old-engine record Task 8 uses** is `packages/runner/tests/fixtures/r214/before/fixture-sandbox-symbols.txt`
(SHA-256 `c392d9cd6beb261c66bbcfc52075d1c89df006bc16a4b49877a225fd2ed20cb1`), master's own capture,
header `raw 13 deployed 13 skippedFiles 0`. Its L13 `return-value` row carries key
`c9159b460433d7e0187b40a3e9f1c6b24fa17f5d81145d1a4f5e81e464586890|Symbol Logic|Rate|lethal.return-value|1`,
no ordinal, which the frozen `[LETHALB]` baseline scores `survived` (both greps print 1).

HEAD moved three times during the session (the controller merging master). `git diff
94add2cb fa2a2d57` touches no file under `packages/engine`, `packages/schemata/src`,
`packages/builtin-tier1` or `packages/builtin-tier2`. At the final HEAD every repro BEFORE capture,
every expected file, every presence result and every gate-fixture capture was re-made and is
byte-identical.

## What would count as a finding

- any capture not byte-identical to its expected file;
- any listing mismatch (files.tsv or rows.tsv.gz);
- `UNCLASSIFIED` or `EXTRA` above 0 after the change (operators with an empty `requiresSemantic`);
- a change in the typing counts per operator above, or in any exclusion count by reason;
- any verdict or killing test off Decision 7's table;
- any R321 baseline key diff other than the pre-committed one;
- any gate-fixture byte that moves;
- a peak above 110% of the "Memory" table;
- a crash;
- a red-check that is red anywhere else, or not red.

## Dated decisions (2026-09-30)

- **P2** (controller): the plan's Decision 7 SA key was a splice; the key is the baselines' own.
- **P4** (controller): master's scheme is 4, not 3; the next is 5.
- **T1-a** (controller): three named reasons, `dup-arm-typing`, `split-case-body`,
  `split-if-operators`, each a structural rule; `preproc_split_begin` is part of its parent.
- **T1-b** (controller): the poison proof covers only compiled-out drops; a refused file's rows are
  counted as `preproc-undecided`.
- **T1-c** (controller): self-test rows 34 and 46 are named exceptions (Decision 2 is the more
  specific text).
- **T1-d** (controller): `predict.ts` drops every row of an undecided file (SHA-256 below).
- **T1-e** (controller): 31 builds.
- **Orchestrator answer `q-20260930T062258-5a3574ac`**: the presence STOP covers only operators
  with an empty `requiresSemantic`; typed and Tier-2 differences are counted per operator and pinned,
  and filed as ONE roadmap item (R364) with three repros and an alc check.
- **T1-f** (controller): `unbuildable-under-set` per file; S1 stays as planned.
- **T1-g** (controller): `displaced-by:<reason>`, `split-call-statement`, `cond-var-typing`.
- **T1-h** (controller): BaseApp's rows listing holds only members that hold a directive.
- **T1-i** (controller): the leak check is whole-word `\bbegin\b` plus `:=` plus `exit\(`, all 0.
- **T1-j** (controller): `hashSourceSnapshot` over `.al` files for roots without `app.json`.

Roadmap items filed from this pre-commitment, each in its own commit before this one: R364 (typing,
`009468f2`), R365 to R370 (`48973f18`).

**R364's alc check:** three hand-written repros (a split header, a `var` line in an arm, a member
duplicated across arms), each master mutant applied alone and compiled under `[]` and `[RSYM]`:
12 mutant builds, 12 compile. No master mutant of that shape fails to compile; the typed operator
declines instead.

## Tools

| tool | SHA-256 |
| --- | --- |
| `scripts/r214-capture.ts` (committed) | 6543cfadabc48d64e846e03e1b90289907dbb778f2dde65d37c5a18496621c14 |
| `$P/sites.ts` (r1, the capture's origin) | 6f95c8b15cdfd57520e51ac584d76b88484aa9a5ae596b723470b9c8acf72fcd |
| `$P/keymoves.ts` | 92d3bdf4160dab40d0d7ad31d461adff01c47a76f5323c5a80818a3cd37c0f0c |
| `$P/alc-plain.sh` | d8b1a11c4070a60f0308378d74a5621a98d012034f2f6c4dfbd412bbe3e8f5a6 |
| `$Q/pp.ts` | ea1212e9a03da9db9e7f4f763bc9378c2657f731827534a9a599a1a01a71d932 |
| `$Q/predict.ts` (T1-d) | debc47d6448f10095cb6f6db73f43f6edb29421013081d772c9dd10b90afcaf9 |
| `$Q/presence.ts` | a87e1f27c5d7f69bbd6a3e0eae610a3e313f2e46d6105b379a9c5894694bf0dc |
| `$Q/poison.ts` (T1-b) | 8451ecc513b7fa4480be22fa31ee38799c00cf5286b8ab882ac8368012f0833f |
| `$Q/before.sh` | e0db0237f447d479bc35b10953f6e539ac43b8d385b5937bcb7ef2a1a0a030b0 |
| `$Q/run-predict.sh` | 4481fdb41c7300972255e5a5dba0d5c87ded4d3006b8aad74fd5e171a6d1972e |
| `$Q/prove.sh` | 89e288f8a7655bd9a48b152486dedfe0d54ead9ba2b4ef0927925e3495bad96c |
| `$Q/step4.sh` | a2205c04e35615d1be4db94aeabe0737992af512539d180700c049fa627cde4f |
| `$Q/step6.sh` | 4019c7955ac1d6c73900531a4da4934d5474494885820d6b445c6281b8272384 |
| `$Q/step7.sh` | a356fd9aa9874b60aec55443122650a1814cc08e98b4b1a1dafa0374f5127523 |
| `$Q/step9.sh` | 88b34651b68bcb2a505d99bbccb6826c3d5d50d0f3d99ea12a18041da87e1b71 |
| `$Q/twin-errors.ts` (diagnosis) | fbd72272cf1fa69b41c09cebaf640bdf72f9b3a798023d07184a34e47bb66d9c |
| `$Q/shapes.ts` (diagnosis) | 93d02e37116da7430d415b52a75683314cf772260f8ce61cab574262a36b4db2 |
| `H:/lethal-scratch/R-214/typing-repros/mut-compile.ts` (R364) | 3568cecd3a0bc36da00248bb7a5037eea2806e232e23b8b906e51fc4a19bd730 |

The r1 tools `$P/pp.ts`, `predict.ts`, `poison.ts`, `run-predict.sh`, `before.sh`, `prove.sh`
matched their r1 prefixes (`b012da98`, `8a56b31a`, `ab3f70cf`, `174d89d2`, `50dc5da1`, `a1e78e2c`)
and were superseded by the `$Q` copies above.

## Clarifications (2026-10-01)

Added after the final whole-branch review. Nothing above is changed; this section corrects one
claim and makes the corpus check re-runnable from the repo.

**(a) "The committed files need nothing on `H:`" was wrong as written.** The listing files and
expected captures are committed, but two of the tools that produced them, `$Q/pp.ts` and
`$Q/presence.ts`, existed only on `H:` and were pinned by SHA-256 alone. The accurate statement:

- **Checking** the committed listings needs nothing on `H:`: their SHA-256 is in the table under
  "Listing files", and their rows and per-file digests are plain text (`files.tsv`, gzipped
  `rows.tsv`) that a product capture of the corpus root can be diffed against. The corpus roots
  themselves are on `U:`.
- **Regenerating** them needs the `$Q` tools, pinned by SHA-256 in "Tools". `pp.ts` and
  `presence.ts` are now committed as `scripts/r214/pp.ts` and `scripts/r214/presence.ts`,
  byte for byte, with the pinned SHA-256 (`ea1212e9...a71d932` and `a87e1f27...4bf0dc`, checked
  2026-10-01). They are NOT edited, so they still import the engine by the absolute path
  `H:/LethAL-wt/lane-preproc/packages/engine/src/...`; on another checkout, change that prefix in a
  copy and expect the copy's SHA-256 to differ. `$Q/predict.ts` and `$P/keymoves.ts` are still only
  on `H:`. `scripts/r214-capture.ts` has moved since its pinned SHA-256: the pinned bytes are
  `git show 3ed7be4b:scripts/r214-capture.ts`, and later commits (including this review's R-307
  guard) changed it.

**(b) The exact commands**, from `$Q/step7.sh` (capture, per corpus) and `$Q/step9.sh` (listing),
with `$Q/pp.ts` and `$Q/presence.ts` replaced by their committed copies. Run from the repo root,
one corpus at a time, BaseApp alone. `R=H:/LethAL-wt/lane-preproc`, `P=H:/lethal-scratch/R-214/plan`,
`Q=H:/lethal-scratch/R-214/plan-r2`, `O=H:/lethal-scratch/R-214/corpus`.

| c | root | S1 (`s1`, comma-separated) |
| --- | --- | --- |
| dc | `U:/Git/DC/Cloud` | `CLEAN27,CLEAN28` |
| sysapp | `U:/Git/BC.History/System Application` | `CLEAN26,CLEAN27,CLEAN28,CLEANSCHEMA27,CLEANSCHEMA29,CLEANSCHEMA31` |
| bcf | `U:/Git/BC.History/BusinessFoundation` | `CLEAN27,CLEAN28,CLEANSCHEMA27` |
| baseapp | `U:/Git/BC.History/BaseApp` | `CLEAN26,CLEAN27,CLEAN28,CLEAN29,CLEANSCHEMA25,CLEANSCHEMA26,CLEANSCHEMA27,CLEANSCHEMA28,CLEANSCHEMA29,CLEANSCHEMA30,CLEANSCHEMA31` |

Capture, for one corpus (`step7.sh <c> <root> <s1>`; set 0 is `""`, set 1 is `s1`; dc's
`app.json` adds `BC20` to `BC27` to both):

```bash
mkdir -p "$O" "$R/docs/superpowers/specs/r214-corpus"
for i in 0 1; do s=$([ $i = 0 ] && echo "" || echo "$s1")
  rm -rf "$O/twin-$c-$i" "$O/full-$c-$i"
  bun "$R/scripts/r214/pp.ts" "$root" "$s" "$O/twin-$c-$i" "$O/regions-$c-$i.json" --full "$O/full-$c-$i"
  if [ $i = 0 ]; then
    bun "$R/scripts/r214-capture.ts" "$root" --raw-out "$O/before-$c.raw" --raw-files "$O/regions-$c-0.json" > "$O/before-$c.txt" 2> "$O/before-$c.err"
  fi
  bun "$R/scripts/r214-capture.ts" "$O/twin-$c-$i" --raw-out "$O/twin-$c-$i.raw" --raw-files "$O/regions-$c-$i.json" > "$O/twin-$c-$i.txt" 2> "$O/twin-$c-$i.err"
  bun "$R/scripts/r214-capture.ts" "$O/full-$c-$i" > "$O/full-$c-$i.txt" 2> "$O/full-$c-$i.err"
  bun "$Q/predict.ts" "$O/before-$c.txt" "$O/twin-$c-$i.txt" "$O/regions-$c-$i.json" "$O/before-$c.raw" "$O/twin-$c-$i.raw" > "$O/expect-$c-$i.txt" 2> "$O/predict-$c-$i.log"
  bun "$R/scripts/r214/presence.ts" "$O/expect-$c-$i.txt" "$O/full-$c-$i.txt" "$O/regions-$c-$i.json" "$root" "$O/full-$c-$i" > "$O/presence-$c-$i.txt"
  bun "$P/keymoves.ts" "$O/before-$c.txt" "$O/expect-$c-$i.txt" > "$O/keymoves-$c-$i.txt"
  bun "$R/scripts/r214-capture.ts" "$root" --symbols "$s" > /dev/null 2> "$O/master-peak-$c-$i.err"
done
```

Listing, for one corpus and set (`step9.sh`), with the BaseApp flag (Ruling T1-h):

```bash
D="$R/docs/superpowers/specs/r214-corpus"
extra=(); [ "$c" = baseapp ] && extra=(--directive-members-only)
bun scripts/r214-capture.ts --listing "$D" --label "$c.$i" --from-expected "$O/expect-$c-$i.txt" --presence "$O/presence-$c-$i.txt" --regions "$O/regions-$c-$i.json" --root "$root" "${extra[@]}"
sha256sum "$D"/*
```

## Amendment (2026-10-01): BaseApp set 1 skippedFiles

This amendment was written AFTER Task 9 measured the number. It is an explained correction, not a prediction. Orchestrator question q-20261001T150342, approved 2026-10-01.

What changed. The "Corpora" table above gives the baseapp.1 capture header as `raw 1761609 deployed 1674059 skippedFiles 73`. The measured header is `raw 1761609 deployed 1674059 skippedFiles 67`. The raw and deployed totals, every row, the listings and the counts all match. Only `skippedFiles` differs.

Cause. Six files of a skipped kind (query, xmlport, report extension) have their WHOLE object inside `#if not CLEAN27`. Under baseapp set 1 that code is compiled out. These files no longer count as skipped. Each is now reported as a `compiled-out` row, with the same per-file site count that master reported as skipped. 73 - 6 = 67. All six are under `Source/Base Application/`:

| file | sites |
| --- | ---: |
| `Inventory/RoleCenters/MyItems.Query.al` | 2 |
| `Manufacturing/Inventory/Planning/MfgPlanningAvailability.ReportExt.al` | 76 |
| `Sales/Peppol/SalesCreditMemoPEPPOL20.XmlPort.al` | 301 |
| `Sales/Peppol/SalesCreditMemoPEPPOL21.XmlPort.al` | 359 |
| `Sales/Peppol/SalesInvoicePEPPOL20.XmlPort.al` | 344 |
| `Sales/Peppol/SalesInvoicePEPPOL21.XmlPort.al` | 352 |

The six counts sum to 1434. Their `kinds` string reads "no object declaration (root is source_file)" (R308's string), because the object declaration sits inside the inactive `#if`.

Why it was not predicted. `predict.ts` copied master's header line and does not model skipped files.

Scope. Every other expectation in this spec is unchanged, including baseapp.0 at `skippedFiles 73`. Task 9 measured them all as equal.
