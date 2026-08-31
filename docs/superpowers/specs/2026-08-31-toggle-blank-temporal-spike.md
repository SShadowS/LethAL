# Spike: `toggle-blank-temporal`, the first candidate admitted under the amended R13 bar

Written before any operator code. Nothing below is edited afterwards; an OUTCOME section is appended.

## 0. Why this candidate and not another

[[R181]]'s ruling landed on [[R013]] on 2026-08-31: canonical minimal edit, three admission grounds,
floor of 36 marginal SITES on the reference corpus `do-rel2/Cloud`, with a 36-to-44 band treated as
undecided because the floor moves that far across corpora.

Temporal was chosen over `subscript_expression` (53) for one reason: **its margin makes it robust to
the rule being wrong again.** That rule was corrected twice on the day it was written, once by me and
once by review. At 96 marginal it clears every floor measured on every corpus tried, so a fourth
correction to the floor does not change its verdict. `datetime_literal` alone (44) sits inside the
undecided band and is deliberately not built separately.

## 1. Sizing, in three passes, because the first two were wrong

`toggle-blank-string`'s own doc comment records that measuring it took three passes "each of which
changed the answer". The same happened here, and the same trap: a raw node-kind count is not a
claimable count.

| pass | count | what it is |
| --- | ---: | --- |
| raw kind count in procedure/trigger bodies | **125** | `date_literal` 69 + `datetime_literal` 44 + `time_literal` 12. [[R159]]'s figure, and the one the R13 re-pricing quoted |
| in a BEHAVIOURAL parent | **96** | comparison operand (50) or assigned value (46). The claimable count |
| of those, blank | **92** | `0D` / `0T` / `0DT`. Only 4 are non-blank |

Dropped, with the reason `toggle-blank-string` already gives for the same shapes: 27 in
`argument_list`, where the literal's meaning depends on a callee this layer cannot resolve; 1 in
`exit_statement`; 1 in `additive_expression`.

**96 against a floor of 36 is 2.7x, and clears the 44 upper end of the band too.**

## 2. The shape the corpus forced: a blank TOGGLE, not a date shift

The obvious temporal operator shifts a date by a day, the `conditional-boundary` analogue. **The
corpus refuses it: 92 of the 96 claimable literals are blank.** A shift operator would have had four
sites.

| kind | blank form | count (raw) | non-blank |
| --- | --- | ---: | ---: |
| `date_literal` | `0D` | 65 of 69 | 4 |
| `datetime_literal` | `0DT` | 44 of 44 | **0** |
| `time_literal` | `0T` | 6 of 12 | 6 |

`0D` is AL's blank date and `if Rec."Due Date" = 0D then` is the idiomatic "is it set" check, so the
mutation that matters is blank against not-blank. This is `toggle-blank-string` one type family over,
and it is modelled on it deliberately, including its `BEHAVIOURAL_PARENTS` set.

**`datetime_literal` is 44 of 44 blank because AL has no non-blank DateTime literal.** Non-blank
DateTimes are constructed, not written. That is why the datetime arm emits a call rather than a
literal, which is the one part of this design that needed proving rather than reading.

## 3. Replacements, COMPILE-PROVEN rather than assumed

`alc` 18.0.40.47373, exit 0, **zero errors and zero warnings**, on a probe carrying every replacement
in both positions it will actually be emitted in (assignment, and as an `=` comparison operand):

| original | mutated |
| --- | --- |
| `0D` | `17530101D` |
| `0T` | `000001T` |
| `0DT` | `CREATEDATETIME(17530101D, 000001T)` |
| any non-blank date | `0D` |
| any non-blank time | `0T` |

The datetime arm was the risk: `CREATEDATETIME(17530101D, 000001T)` compiles in assignment position
AND inside `if DT = ... then`, both verified. Had it not, the arm would have needed redesigning
before a line of operator code existed.

Chosen values, and why these: `17530101D` and `000001T` are unmistakably non-blank while being the
least plausible real business values in the file, so a reader meeting one in a diff cannot mistake it
for domain data. `toggle-blank-string`'s reasoning about overflow does not transfer — a Date has no
length to overflow — so the constraint here is legibility rather than safety.

## 4. No gate exercises this, and that is a build condition

**Measured: ZERO temporal literals in every fixture and example this repo owns.** `sandbox-data` 0,
`sandbox-app` 0, `sandbox-hang` 0, `gift-card` 0, `credit-limit` 0.

This is exactly [[R171]]'s situation, where `remove-not`'s corrected cession added zero sites on every
fixture and the row records that landing it alone "would have been a change no gate exercises". R171's
answer was a fixture arm, and it is the answer here.

So the build is: operator, conformance tests, registry, generated tables, **a new fixture arm**, a
pre-commitment of its verdicts, and one live `itest:tables` run. The live run is the billed step and
is not started without the pre-commitment committed first.

## 5. What would refuse this candidate

- The claimable count falling below 36 on re-measurement. It is 96; the raw 125 is not the number.
- Any replacement failing to compile in either position. Proven clean, so this is closed.
- The fixture arm's mutants coming back with verdicts that contradict the pre-commitment written
  before the run.
- A shipped operator turning out to claim these spans at canonical minimal edit grain. Measured
  overlap is 0: no shipped operator touches a temporal literal, and `shift-integer` claims `integer`,
  which these are not.

## 6. Deliberately out of scope

- **Shifting a date by a day.** Four sites. Refused on the same measurement that chose the toggle.
- **`datetime_literal` as its own operator.** 44 sites lands inside R13's 36-to-44 undecided band. It
  is claimed here only as part of one temporal operator, which is how it was priced at 96.
- **Constructing a semantically meaningful non-blank DateTime.** `CREATEDATETIME` with fixed
  arguments is enough to be not-blank, which is the whole question the mutation asks.
