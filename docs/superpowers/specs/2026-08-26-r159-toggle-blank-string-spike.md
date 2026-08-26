# R159 spike: `toggle-blank-string`, and the three numbers it took to size it

Written before the live half. §4's verdicts were fixed before the operator was registered anywhere.

## 1. This started as a refusal and the measurement reversed it, twice

R159 recorded `string_literal` as a REFUSAL candidate: most literals are labels, messages and error
text, so mutating them is noise. That was intuition about AL stated before anything was counted.
Counting it changed the answer twice.

| pass | number | what it was |
| --- | ---: | --- |
| raw kind count | **4,892** | literals inside procedure or trigger bodies. Includes declarative properties, message text and filter arguments — not a candidate |
| behavioural contexts only | **1,102** | comparison operands and assigned values: a value the program branches on or stores. This is the number the row was corrected to |
| minus the no-ops | **281** | because **821 of the 1,102 are ALREADY `''`**, and blanking a blank is a mutant that changes nothing |

A one-directional "replace with the empty string" operator claims 281 sites, not 1,102 — and the
81% it would drop is not noise, it is the single most common shape in the set.

**The fix is a second direction, and it is the larger one.** 714 of the 821 blanks are comparison
operands: `if X = ''`, the ordinary BC blank check. Making that literal NON-blank flips a check a
suite may never exercise with a blank value. Both directions claim all 1,102, 85x R13's bar.

An operator scoped from the kind count would have shipped covering a quarter of its own ground, and
nothing in a site count would have said so.

## 2. What it claims, and what it cedes

Claims a `string_literal` whose parent is a `comparison_expression` or an `assignment_statement`,
inside a procedure or trigger body. Blank becomes `'x'`; non-blank becomes `''`.

Cedes, by staying out of those parents rather than by naming them:

- **declarative properties** (6,953, 54.2%) — R135's ruling, R144 pins the refusal
- **call arguments** (2,147, 16.7%) — meaning depends on a callee this layer cannot resolve
- **filter arguments** (261, 2.0%) — `flip-filter-literal`'s, scoped narrowly on purpose
- **message and error text** (263, 2.0%) — changes what a user reads, not what the program does

The executable test is an ALLOW-list ("must be inside a procedure or trigger body"), which is the
lesson `flip-boolean-literal` paid for: a deny-list of declarative parents is only ever as complete as
the last person's memory.

**The stand-in is ONE character on purpose.** AL string types carry a length, and a replacement
longer than the target overflows at runtime — a kill that says nothing about the test. One character
fits every string type that can hold anything, so the mutation cannot overflow by construction.

## 3. Compile, both halves

- **Naive splice:** 7 of 7, on a probe carrying both directions, a `Text[1]` target and a `Code`
  target, on a baseline proven clean first.
- **Real emit path:** instrumented artifact compiles with **0 errors**, dispatch verified and printed.
- **Conformance: 6 cases, PASS**, including three refusals — property, message argument, filter
  argument.

One bug had to be caught here rather than reasoned away, and it is R120's hazard for the second time
this week: the first draft wrote `ALNodeKind.string_literal`, which is **`undefined`** — the enum key
is `text_literal` and its VALUE is `"string_literal"`. The predicate compared against undefined, the
operator claimed nothing, and it type-checked cleanly. The conformance suite caught it; a site census
would have reported zero and looked like a refusal.

## 4. Live half, pre-committed

7 fixture sites: `sandbox-data` 6, gift-card 1. `credit-limit`, `sandbox-app` and `sandbox-hang` have
none, so `itest:bcdev`, `itest:alrunner` and `itest:hang` cannot move.

| # | site | mutation | predicted | why |
| --- | --- | --- | --- | --- |
| S1 | `Data Commit Ops.CommitThenFail:36` | `Category := 'A'` -> `''` | **survived** | the commit tests assert the row EXISTS and that `Flagged` is set; `remove-assignment` measured the same three arms and found they never read the row's other fields |
| S2 | `CommitThenRun:50` | same | **survived** | same |
| S3 | `CommitThenRunValueForm:87` | same | **survived** | same |
| S4 | `Data Flag Ops.InsertTwiceWithKeyTrigger:88` | `KeyProbe."No." := ''` -> `'x'` | **killed** | the loop inserts twice. With a non-blank key the `OnInsert` generator never fires, so both rows carry the same key and the second insert dies on a duplicate. A PLATFORM-ARTIFACT kill: no test asserts anything about it |
| S5 | `Data Key Probe.OnInsert:36` | `if "No." = ''` -> `= 'x'` | **killed** | the same duplicate key reached from the other side — the generator stops firing for blank keys |
| S6 | `Data Main.OnValidate:22` | `if "No." = ''` -> `= 'x'` | **killed** | `asserterror DataMain.Validate("No.", '')` exists in the suite; mutated, the blank raises nothing and the `asserterror` fails |
| S7 | gift-card `Gift Card.OnValidate:18` | `if "Customer No." = ''` -> `= 'x'` | **survived** | no test validates a blank customer, and `Issue` always passes a real one, so neither the original nor the mutant ever raises |

Derived: `sandbox-data` **3 killed / 3 survived**, gift-card **0 / 1 / 0**.

**S4 and S5 are the rows to read afterwards**, not for their verdict but for HOW they die. Both kill
through a duplicate primary key with nothing asserted — the shape R138 tagged for
`swap-modify-flag`'s `Insert`. This operator declares no `PlatformKillMechanism`, following
`remove-assignment`'s precedent from the same week: changing a written VALUE is ordinary changed
behaviour, and R121's assertion screen is what tells a reader such a kill carried no assertion. If
the screen does not flag them, that ruling needs revisiting before this ships.

---

## OUTCOME, appended after the runs. Nothing above is edited.

**Six of seven matched.**

```
sandbox-data (Cronus283), narrowed to this operator
  M0001 DataCommitOps:36    survived
  M0002 DataCommitOps:50    survived
  M0003 DataCommitOps:87    survived
  M0004 DataFlagOps:88      killed   DoubleInsertWithoutKeyTriggerRaises
  M0005 DataKeyProbe:36     killed   DoubleInsertWithoutKeyTriggerRaises
  M0006 DataMain:22         killed   BlankNoValidateFails
  3 killed / 3 survived / 0 no-coverage

gift-card (Cronus281)
  M0001 GiftCard.Table:18   killed   IssueRequiresCustomer
```

S1-S6 landed exactly as predicted, including both duplicate-key mechanisms reached from opposite
sides and the `asserterror` kill on `Data Main`'s blank guard.

### The miss, and it is the same mistake as the last build's

S7 was predicted **survived** on the grounds that no test validates a blank customer. It is
**killed by `IssueRequiresCustomer`** — a test that does exactly that.

I grepped the suite for `CustomerRequiredErr` and for `Validate("Customer No.`, found neither, and
concluded nothing exercised the guard. The test drives it through `Issue`, so it names neither
string. Two builds ago the same reasoning missed `IssueCreatesCard` asserting the issued date.

The rule that would have caught both: **when predicting "no test covers this", grep for the
BEHAVIOUR, not for the identifier.** A test's name is written in the language of the domain, not in
the language of the code it happens to touch — and `IssueRequiresCustomer` says exactly what it does.

### The platform-kill question, deliberately left open before the run

S4 and S5 both die on a duplicate primary key with nothing asserted, and the operator declares no
`PlatformKillMechanism` on `remove-assignment`'s precedent. §4 said that if R121's screen failed to
flag them, the ruling would need revisiting.

The screen reported **`vacuous`, 3 of 3 flagged** — it flagged the honest `asserterror` kill on
`Data Main` alongside the two duplicate-key ones, and separated nothing. That is NOT a finding about
this operator: `sandbox-data`'s suite raises through bare `Error(...)`, so the rule has no assertion
prefix to find, exactly as R132 documents. The question the spike asked cannot be answered on this
fixture, and saying so is the honest result rather than reading `vacuous` as a pass.

Answering it needs the twin-pair treatment R132 built for precisely this: a site whose covering test
raises through `Library Assert`, beside one that raises bare. That belongs in the build, as a fixture
arm, not in the spike.

## Recommendation

**Build it**, with one condition attached rather than deferred: the build must add a `sandbox-data`
arm that puts a duplicate-key kill beside an assertion-raised one, so R121's screen is measured on
this operator rather than assumed. Everything else is settled — 1,102 sites, both compile halves,
6 conformance cases, and 6 of 7 live verdicts predicted.

Landing cost is small: `itest:tables` +6, gift-card +1, and `credit-limit`, `sandbox-app` and
`sandbox-hang` have no sites at all.
