# R134 - `lethal.flip-filter-literal`: mutating inside a `SetFilter` string

Status: **DRAFT, AWAITING ADVERSARIAL REVIEW.** Written 2026-08-13 as Task B1 of
`docs/superpowers/plans/2026-08-12-r134-r136-operator-waves.md`. It opens Wave B, and, per this
task's brief, ratifies six of the brief's eight numbered proposals as written, elaborates two of
them into an unambiguous procedure without changing what they cover, and authors one of them (the
fixture arms table) from scratch, since the brief specified only what that table must contain, not
its content. The ratification log at the end (section 6) gives one line per proposal. Extends the
operator set defined in `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md` and
follows the shape of `docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md`, including that
document's rule that a per-mutant prediction table is pre-committed in a SEPARATE document before
the live run (a later task in this wave).

Every factual claim this document makes about the codebase was checked against the source named
next to it, not assumed from the brief or from the sibling spec. Every claim about how Business
Central's filter-expression language behaves at runtime is marked as REASONED (from documented AL
filter syntax) or MEASURED (from a live probe), because this repo does not let a platform-behaviour
claim pass as fact until one of those two words applies. Nothing in this document was measured
against a live container: this is a design task, and the brief that started it says other agents
are running live gates concurrently and this task must not touch a gate or `fixtures/`.

## 0. What this document assumes, and where each assumption comes from

**The population.** From `docs/roadmap/R134.md`, a census of a 658-file Continia Document Output
snapshot taken 2026-08-12: 288 `SetFilter` calls total, 95 carrying `<>`, about 134 carrying some
comparator (`<>` presumably counted inside that figure, so the non-`<>` comparators are roughly
134 minus 95, about 39. The roadmap's own wording does not say whether 134 includes the 95, and
this document reads it as inclusive because the alternative reading would leave 39 sites with a
comparator that names no comparator, which is a stranger census result), 43 carrying a `|`
alternative list, and 14 carrying a `..` range. No population is claimed for wildcards, `@`, `&`,
or a variable (non-literal) filter-text argument; none of those were censused and none is claimed
mutatable here.

**Today's coverage.** `negate-conditional` mutates `comparison_expression` nodes in AL source; a
`SetFilter` filter expression is a `text_literal` (string literal) argument, a different node kind
that no registered operator inspects. The only mutant a `SetFilter` site gets today is whole-call
deletion from Tier-1 `lethal.void-method-call`. Verified: `packages/builtin-tier2/src/index.ts`
lists eight Tier-2 operators (`removeTestField`, `removeSetRange`, `removeCalcFields`,
`swapModifyFlag`, `removeCommit`, `swapRecXRec`, `swapFindDirection`, `validateToAssign`), and a
search of `packages/builtin-tier2/src` and `packages/builtin-tier1/src` for the string `SetFilter`
returns nothing. `lethal.remove-setfilter` does not exist and is not proposed here either; R134's
row already refused it, reasoned below in section 5.

**The machinery this operator reuses, all already built and tested.** Receiver proof
(`claimsRecordMethod`, `packages/builtin-tier2/src/receiver.ts`), the shared callee-name-node
accessor (`calleeNameNode`, same file, added in Wave A for `swap-find-direction` and
`validate-to-assign`), exact-count argument access and top-level-comma counting
(`exactArguments`/`countArguments`, `packages/builtin-tier2/src/mutate-helpers.ts`), the
synthesized-after-node adapter (`synthesizeAfter`, same file), dedup identity
(`packages/schemata/src/dedup.ts`), and baseline identity
(`packages/runner/src/selection.ts`, unread in this pass but unchanged by anything below: this
operator adds a row to the same table, it does not touch how the table is keyed).

**Verified directly for this document, because the sibling spec's costliest lesson was that a
premise treated as obvious can be the one that is wrong:**

- `packages/operator-sdk/src/build.ts`'s `textLiteral` builder encodes an AL string literal as
  `` '${value.replace(/'/g, "''")}' ``. That is the ENCODE half (embedded `'` becomes `''`,
  outer quotes added). No DECODE (unescape `''` back to `'`, strip outer quotes) exists anywhere
  in `packages/` today: a repo-wide search for `unquote`/`unescape`/a second `replace(/'/g, ...)`
  found only this one occurrence. This operator has to write both directions itself, and the
  re-encode direction must call the identical transform `build.ts` uses rather than a
  hand-rolled equivalent, so the two never drift apart.
- `packages/engine/src/ast/hash.ts`'s `astSubtreeHash`, read in full. An `identifier` node's TEXT
  is replaced by a scope-relative index built fresh per hash call (`(identifier #0)`,
  `(identifier #1)`, ...), so two different identifier spellings in structurally identical
  positions hash identically. This is the mechanism the trio spec's section 4 used to explain
  why `Probe.Insert(true)` and `Probe.Delete(true)` collapse into one baseline key. A
  `text_literal` node, by contrast, is matched by `isLiteral()` and hashed as
  `` `(${node.kind} ${node.text})` ``: its TEXT participates VERBATIM, uncanonicalised. The
  same is true, by a different code path, of any named leaf node with no named children
  (`node.namedChildren.length === 0`), which is how a `quoted_identifier` field name like
  `"No."` also hashes on its literal text rather than being anonymised. `quoted_identifier` is
  not `ALNodeKind.identifier`, confirmed against `packages/builtin-tier2/src/receiver.ts`'s own
  `isIdentifierLike`, which needs a second branch for exactly this reason.
- `packages/schemata/src/dedup.ts`'s `identityOf` keys on
  `` `${spec.before.kind}:${spec.before.startIndex}:${spec.before.endIndex}:${spec.after.text}` ``.
  Read `void-method-call` (`packages/builtin-tier1/src/void-method-call.ts`) and `remove-setrange`
  (`packages/builtin-tier2/src/remove-setrange.ts`) side by side: both set `before: node` where
  `node` is the SAME `procedure_call` AST node for a shared call site, and both set
  `after: synthesizeAfter(node, "")`, identical `before.kind`/`startIndex`/`endIndex`, identical
  empty `after.text`, hence one shared identity, hence Tier 2 wins the collision. This operator's
  `after.text` is never empty (a splice, described in section 2), so at every `SetFilter` site
  this operator claims, its identity differs from `void-method-call`'s by `after.text` alone and
  the two mutants coexist. This is the SAME mechanism the trio spec measured for its three
  operators, not a new one, and the two sibling AL files above are what confirm it directly rather
  than by inference from that spec's prose.
- The pre-existing `SetFilter` call in `fixtures/sandbox-data`. A search for `SetFilter` under
  `fixtures/sandbox-data` finds exactly one hit, in `DataOps.Codeunit.al`'s
  `CountIgnoringMainFilter`:

  ```
  Related.SetFilter("Main No.", '%1', MainNo);
  Related.SetRange("Main No.");
  ```

  Section 3 classifies this site's shape and states its predicted verdict under this design.
- The current fixture's free object ids. `fixtures/sandbox-data/src` currently declares codeunits
  up to 79316 and tables up to 79331 (Wave A's `Data Flag Ops`/`Data Find Ops`/`Data Validate Ops`
  at 79314-79316 and `Data Trigger Probe`/`Data Key Probe` at 79330-79331 have already landed).
  Codeunit 79317 is free. Section 3 uses it as a placeholder id for Task B6 to confirm or move.
- `packages/operator-sdk/src/conformance.ts`, read in full, to confirm the brief's R137 claim
  rather than take it on faith: `runConformance` only ever pops entries off `expectedRemaining` and
  fails when that list is non-empty at the end (`expectedRemaining.length > 0`). Nothing in the
  function inspects `produced` for entries that were not expected. A `conformanceTests` case with
  `expectedSpecs: []` therefore passes no matter what the operator emits, which is exactly R137's
  point and exactly why every refusal this operator claims gets a unit test asserting an empty
  spec list, never a `conformanceTests` case with an empty expectation.
- Whether `claimsRecordMethod` already claims `"SetFilter"` anywhere. A search of
  `packages/builtin-tier2/src` and `packages/builtin-tier1/src` for the string `SetFilter` (already
  cited above) confirms it is claimed by NOTHING today. This operator is therefore the first to put
  `SetFilter` on `claimsRecordMethod`'s shadowing-guard surface, which by the trio spec's own rule
  (section 2.5 there) means it needs its own project-wide shadowing refusal test. The fixture's
  existing shadowing negative in `Data Ops.RunUserDefinedBuiltins`/`ShadowedBuiltins` covers
  `SetLoadFields`, `TestField` and `SetRange`, never `SetFilter`.

**What this document could NOT verify by reading source, and says so rather than asserting it as
fact.** Two claims about AL's filter-expression LANGUAGE (not about this repo's code) are load
bearing for parts of this design and are stated as REASONED, from the documented behaviour of AL's
filter syntax, not MEASURED against a running container in this session:

1. A bare atom (`Rec.SetFilter(F, '5')`) and an explicitly `=`-prefixed atom
   (`Rec.SetFilter(F, '=5')`) select the identical row set. This is standard, long-standing AL
   filter syntax (equality is the default relation when no comparator token is present), but it
   is reasoned here, not measured. Section 2.4 names the probe that would settle it if ever in
   doubt: seed known rows, apply both forms, compare `Count()`.
2. `..X` matches every row with a value less than or equal to X, and `X..` matches every row with
   a value greater than or equal to X, both bounds inclusive, and each an open (one-sided) range.
   Also reasoned, not measured. The same kind of probe would settle it: seed a row exactly at the
   bound and confirm it is matched by both `..X` and `X..`.

Both are ordinary, textbook AL filter syntax and neither is expected to be wrong. They are flagged
because the trio spec's own precommitment document had a directly analogous premise (that BC does
not normalise a reversed `SetRange(Field, High, Low)` range) that turned out to be correctly
predicted, but only after being explicitly flagged as reasoned-not-measured rather than silently
assumed. A second premise in that same document that WAS silently assumed (`Record.Init()`
resetting a key already used for a prior insert) is exactly the one that broke a fixture baseline.
The lesson taken here is procedural: name every reasoned platform claim before code is written
against it, not just the ones that turn out to matter.

## 1. What a live run can settle, and what it cannot

| claim | status | who can settle it |
|---|---|---|
| (a) a flipped comparator, a shifted boundary, a flipped open range or a dropped alternative can change which rows a filter selects | tautological for all four rules; not a thing to measure | nobody needs to |
| (b) the operator claims exactly the sites section 2 says it claims, refuses exactly the sites section 2 says it refuses, emits an artifact that compiles, is attributed to a covering test, produces both a killed and a survived verdict for at least the two most populous rules, and coexists with `void-method-call` under dedup | falsifiable, and the point of the fixture in section 3 | `itest:tables`, live (a later task in this wave) |
| (c) real suites notice these mutants at a rate that justifies shipping the operator | unmeasurable at fixture scale | a real-project run, the same instrument the trio spec named for its own operators |

Claim (b) carries the risk, for the same reason the trio spec gave: the platform sits between the
mutation and the verdict, and a mutation inside a STRING cannot be proven safe by reading the AST
alone: the string still has to be re-parsed as AL source once spliced in, and the resulting filter
still has to be evaluated by BC against real rows. A later task in this wave (the fixture's own
precommitment document) must pre-commit a per-mutant verdict table before that live run, in the
same form the trio spec's precommitment document used, so a contradicted prediction is written up
as a finding rather than quietly reconciled.

## 2. The operator: `lethal.flip-filter-literal`

Name, tier and version as proposed: `lethal.flip-filter-literal`, tier 2, version 1.0.0. Ratified
as written (proposal 1): the naming pattern matches the other Tier-2 operators
(`swap-find-direction`, `validate-to-assign`, `remove-setrange`), and nothing about the design below
gives a reason to depart from it.

### 2.1 What it targets

A `procedure_call` node where all of the following hold:

1. `claimsRecordMethod(node, ctx, "SetFilter")`, the same receiver proof, case-insensitivity and
   project-declared-procedure shadowing refusal every other Tier-2 operator in this product uses.
2. `countArguments(node) >= 2`: at least a field argument and a filter-text argument. `SetFilter`
   with fewer than two arguments does not parse as this shape and is out of scope by construction.
3. The SECOND argument (in declaration order) is a plain string literal, `ALNodeKind.text_literal`.
   A `SetFilter(F, MyFilterVar, V)` call, whose filter text is a variable, is invisible to a
   static operator and is refused (section 5).
4. The mini-parser described in section 2.2, run against that literal's unquoted content, finds at
   least one rule in the section 2.3 ladder that applies. An unrecognised or unhandled shape
   produces no mutant, never a guessed one. This is the refuse-by-default posture proposal 3
   named, and it is the reason `targets()` and `generate()` must share one helper rather than each
   re-deriving "does this site have a mutation," the same pattern `swap-find-direction`'s
   `claimedDirection()` and `validate-to-assign`'s `validateArguments()` already use. Call the
   shared helper `plannedFilterMutation(node, ctx)`; it returns `null` for anything guard 1-3
   refuses AND for anything the mini-parser refuses, or a small plan value (which rule fired, the
   mutated literal content) that `generate()` uses to build the spec. `targets()` therefore returns
   true only when `generate()` is guaranteed to produce exactly one spec, the same guarantee
   `validate-to-assign` gives, and the reason a `targets()` that returned true on a site
   `generate()` then refused would be a correctness bug, not a cosmetic mismatch.

**Guard 3's argument-access mechanics, since `SetFilter`'s total argument count varies with how
many `%N` placeholders the filter text uses (unlike `validate-to-assign`'s fixed two-argument
shape).** Call `countArguments(node)` to get the call's actual argument count N, then call
`exactArguments(node, N)` to get the validated list, then read index 1 (the second argument). This
is not a hardcoded index read of the kind amendment 1 in the trio spec closed off. `exactArguments`
still checks BOTH the top-level comma count and the comment-filtered named-child count against N
before returning anything, so a pragma or pre-processor region sitting inside the parentheses still
makes the accessor return `null` and the whole site refuse, exactly the safety property amendment 1
established. The difference from `validate-to-assign` is only that N is looked up per call instead
of being the compile-time constant 2.

### 2.2 The mini-parser: `packages/builtin-tier2/src/filter-expression.ts`

Ratified as a refuse-by-default parser (proposal 3), with its refusal surface made concrete below:
proposal 3 states the rule ("anything unclassifiable refuses the site") but not every shape that
falls under it, and an adversarial reader needs the concrete list to know the rule is real rather
than aspirational.

**Step 1: unquote.** The literal's own `.text` includes its delimiting quotes, the same way every
other literal node's `.text` in this codebase does (confirmed against `remove-setrange.ts`'s own
conformance test, whose `beforeText` for `SetRange("No.", 'A')` includes the quotes verbatim).
Strip the leading and trailing `'`, then replace every `''` with a single `'`. This is the exact
inverse of `build.ts`'s `textLiteral` encoder. If the text does not start and end with `'`, that is
a caller-contract violation (guard 1-3 already established this node is a `text_literal`, and a
`text_literal` always carries its delimiters) — throw rather than silently proceed on malformed
input, per this repo's convention that a caller-contract violation is a throw, not a refusal.

**Step 2: the cheap character refusal.** Refuse the WHOLE site if the unquoted content contains any
of `* ? @ ( ) ' &`, checked on the UNESCAPED content (after step 1, not on the raw doubled-quote AL
source) so the check is about the filter's semantic content and not about how AL happens to encode
an embedded quote. Ratified from proposal 3, with the reasoning made explicit per character,
because "anything unrecognised refuses" is not the same claim as "here is why each of these specific
characters is unrecognised," and the adversarial reviewer this document is written for should not
have to reconstruct that reasoning themselves:

- `*` and `?` are AL's filter wildcard characters. Mutating a comparator inside a wildcard pattern
  has no defined meaning under any of the four rules in section 2.3, so refuse rather than guess.
- `@` is AL's case-insensitive-match prefix. It changes the MATCHING semantics of whatever follows
  it in a way none of the four rules account for.
- `(` and `)` are not part of any of the four recognised shapes (comparator, range, atom, `|`
  alternative list). A parenthesised or grouped sub-expression is a shape this parser does not
  model.
- `'`, after step 1's unescaping, signals that the FILTER-EXPRESSION language's OWN quoting
  mechanism may be in play — AL's filter syntax lets an atom be wrapped in a second, inner layer of
  single quotes to escape characters (such as `|` or `..`) that would otherwise be read as filter
  syntax, a layer distinct from the AL SOURCE string-literal quoting step 1 already undid. This
  parser does not implement that second layer, so any embedded quote forces a refusal rather than a
  guess at which characters sit inside it versus outside it — splitting on `|` inside such a quoted
  atom would be wrong, since a `|` there is a literal character, not an alternative separator.
- `&` is AL's filter AND-combinator. Not one of the four recognised shapes.

This document has NOT verified the exact grammar of AL's filter-expression language against
Microsoft's documentation or a live probe — the character list above is reasoned from general
knowledge of AL filter syntax, the same status section 0 already gave the bare-atom-equals-`=`
claim and the range-inclusivity claim. If review turns up a character this list should also refuse,
adding it only widens the refusal surface (the safe direction) and costs no re-key, because a wider
refusal changes nothing about sites this operator already claims.

**Step 3: split into alternatives.** Split the (already-refused-if-necessary) content on
top-level `|`. There is no nesting to worry about after step 2's refusal — none of the characters
that could create nested structure (`(`, `)`, `'`) survive step 2. Refuse the whole site if any
resulting alternative is empty (`||`, a leading or trailing `|`) — an empty alternative is not a
shape any of the four rules can act on.

**Step 4: classify each alternative.** Every alternative must classify into exactly one of four
shapes, tried in this order, or the WHOLE SITE refuses — classification is all-or-nothing across
every alternative in one site, not a per-alternative partial refusal, because proposal 3 already
requires refusing "the whole site" rather than mutating around an unparseable part:

1. **Comparator**: the alternative starts with one of `<>`, `<=`, `>=`, `<`, `>`, `=` (checked
   longest-match first so `<=` is not misread as `<` followed by garbage), and everything after
   that token is itself a valid ATOM by rule 4 below. `<>1..5` is NOT a comparator (the remainder
   `1..5` is not a valid atom, since it contains `..`), falls through every later rule too, and the
   whole site refuses.
2. **Range**: the alternative contains exactly one occurrence of `..`, is not already classified as
   a comparator (a range never carries a leading comparator token), and each non-empty side of the
   `..` is itself a valid atom. Both sides non-empty is a CLOSED range (`X..Y`); exactly one side
   empty is an OPEN range (`..X` or `X..`); both sides empty (`..` alone) refuses.
3. **Atom**: the entire alternative, with no comparator token and no `..`, matches exactly one of
   two shapes: a PLACEHOLDER, `%` followed by one or more digits and nothing else (`%1`, `%12`), or
   a BARE TOKEN containing no `%` character at all. An alternative containing a `%` that is not a
   clean, whole-alternative placeholder — `50%`, `%A`, `%1x` — matches neither shape and is
   unclassifiable, refusing the whole site. This closes a gap the brief's proposal did not name: a
   stray `%` inside ordinary filter content is unlikely in the census's real data, but the refuse-
   by-default posture means an operator that did not check for it would silently misparse rather
   than refuse.
4. Anything not matching 1-3 is unclassifiable. Refuse the whole site.

A closed range (`X..Y`) is a RECOGNISED shape at this step — it classifies successfully — but no
rule in section 2.3's ladder targets it. That is a distinct outcome from "unclassifiable," worth
keeping conceptually separate: a site whose only classifiable content is a closed range produces no
mutant because the LADDER finds nothing to do, not because the PARSER gave up. Section 5 records
this as a named deferral, and section 3's arm H is the fixture's proof that the deferral is real.

### 2.3 The mutation ladder: one mutant per site

Ratified as four rules (proposal 4), with the ORDER justified below. The brief listed the rules
but not why this order, and "the set is right" is a weaker claim than "the order is right," since
a filter can contain alternatives matching more than one rule shape at once and the order is what
decides which one gets mutated.

Evaluate the four rules in this fixed order. At each rule, scan every alternative left to right; if
any alternative matches that rule's shape, mutate the FIRST (leftmost) one that does and stop:
later rules are never tried once an earlier one has fired. If no alternative matches any of the
four rules, the site refuses.

1. **Negation flip.** An alternative classified as a comparator whose token is `<>`: rewrite to
   `=`, keeping the atom after it unchanged. `'<>%1'` becomes `'=%1'`.
2. **Boundary shift.** An alternative classified as a comparator whose token is one of `<`, `<=`,
   `>`, `>=`: rewrite to its paired counterpart (`< <-> <=`, `> <-> >=`), keeping the atom
   unchanged. This is the one house-shape pattern this operator shares with `swap-find-direction`:
   a small table of `[claimed, replacement]` pairs, tried in order, exactly like that operator's
   `DIRECTIONS` array, so the mapping cannot drift from what gets emitted.
3. **Open-range flip.** An alternative classified as an OPEN range: `..X` becomes `X..` and `X..`
   becomes `..X`. A CLOSED range never matches this rule: it is a different classification
   (section 2.2 step 4), not merely an unhandled case of this one.
4. **Drop a placeholder-free alternative.** Only when the site has two or more alternatives. Drop
   the first alternative (scanning left to right) that classifies as an atom with no `%` — a bare
   token, never a placeholder. `'ABC|%1'` becomes `'%1'`; `'%1|ABC'` also becomes `'%1'`, because
   "first" means the first ONE FOUND matching the predicate, not the literal first alternative in
   the list regardless of shape. This reading is the one that makes the rule's own placeholder-
   arity guarantee (section 2.4) hold no matter which position the qualifying alternative sits in,
   and it is stated explicitly here because the brief's wording ("drop the first alternative
   containing NO % placeholder") is ambiguous between the two readings and only one of them is
   safe.

**Why this order, not just this set.**

- Negation flip first: it is the single largest sub-population by the census (95 of 288 sites), and
  it is also the most semantically total change of the four: it inverts the ENTIRE truth table for
  the atom's value, where a boundary shift only misclassifies rows exactly at one point and a
  dropped alternative only removes one disjunct from a larger set. Putting the highest-population,
  highest-severity rule first means that when a filter happens to contain shapes matching more than
  one rule, the mutation chosen is the one most likely to be caught by an ordinary assertion, not
  the narrowest one available.
- Boundary shift second: the remaining comparator population (roughly 39 sites by the reading in
  section 0), and still a single-token rewrite like rule 1, so it is grouped with it ahead of the
  two structurally different rules.
- Open-range flip third: a smaller, rarer population (up to 14 sites carry any `..`, and only the
  open-range subset of those qualifies; closed ranges are deferred). Still a single-token-class
  rewrite (the `..` token's position moves, nothing else does), so it stays ahead of the
  structurally different rule 4.
- Drop-alternative last: this is the one rule that removes a whole alternative rather than rewriting
  a token, so it is structurally the most disruptive of the four, and it applies only under a
  narrower precondition (two or more alternatives, at least one placeholder-free) than the other
  three. Placing the least surgical, narrowest-precondition rule last means a filter that ALSO
  contains a comparator or range shape gets the more surgical mutation instead of having a whole
  alternative deleted out from under it.

### 2.4 Placeholder integrity: a hard invariant, asserted in code

Ratified as proposed (proposal 5): the multiset of `%N` tokens in the mutated literal content must
equal the multiset in the original. By construction, none of the four rules can violate this on its
own: rules 1-3 rewrite only the comparator or range TOKEN, leaving the atom (placeholder or bare
token) byte-for-byte unchanged, and rule 4 is restricted to dropping an alternative that carries NO
placeholder at all, so it removes zero placeholder tokens by definition. The assertion is therefore
a backstop against a bug in this reasoning or in the classifier, not a case expected to ever fire,
and that is exactly why this repo's convention is to throw rather than silently accept a mismatch: a
caller-contract violation here would be a bug in THIS operator's own code, not a shape to refuse.

Contract: a function (living in `filter-expression.ts` alongside the parser, exported so a unit
test can call it directly, mirroring how `mutate-helpers.ts` exports each of its pieces
individually) that extracts every `%` followed by one or more digits from a string as a sorted
list, compares the before and after lists for exact equality including multiplicity, and throws a
descriptive error naming both lists if they differ. `generate()` calls it immediately before
returning the spec.

**On the "'=%1' versus bare-atom '%1'" question, per the task's decision list.** AL filter syntax
treats a bare atom and an explicitly `=`-prefixed atom as selecting the same rows (section 0,
reasoned, not measured). Given that equivalence, this operator emits the explicit `=%1` form rather
than dropping to a bare `%1`, for three reasons, none of which changes behaviour: readability of the
emitted mutant in a report (`'<>%1'` to `'=%1'` visibly names the flip; `'<>%1'` to `'%1'` reads as
though the comparator vanished, inviting confusion with rule 4's alternative-dropping output, which
also removes syntax without any comparator token surviving); consistency of rule 1's shape with rule
2's (both keep a leading comparator token and change only which one); and zero cost, since the two
forms are asserted behaviourally identical, so there is no correctness reason to prefer the shorter
spelling. If a live run ever needed to settle this rather than reason about it, the probe named in
section 0 would do it directly.

### 2.5 Re-encoding

Ratified as proposed (proposal 6): re-escape `'` to `''` and re-wrap in outer quotes when splicing
the mutated content back into AL source, and do it by calling the identical transform
`packages/operator-sdk/src/build.ts`'s `textLiteral` uses (`` value.replace(/'/g, "''") ``) rather
than a second, hand-written escaper. One escaping rule, shared, so the encode and decode halves of
this operator can never drift from each other or from the rest of the product's own AL emission.

### 2.6 Emission: a splice, not a rebuild

**Amendment to how the brief's proposal 2 is read.** "`before` is the whole call node; `after` is
the call text with the literal's span spliced" already says splice rather than rebuild, and this
section makes the mechanics explicit because `validate-to-assign` (the other rewrite operator in
this product) is a REBUILD, and the two must not be confused: `validate-to-assign` reconstructs its
output text from its own parts (receiver prefix, field text, ` := `, value text), and that is why it
documents dropping trivia BETWEEN its arguments. This operator does not reconstruct anything. It
takes the call node's own `.text` verbatim, computes the filter-text argument node's span relative
to the call node's start (the exact pattern `swap-find-direction`'s `replaceNameSpan` already uses
for the method-name span), and replaces only that span with the newly quoted, mutated literal text.
Every other character in the call, the receiver, the method name's own casing, the field argument,
any later value arguments, any comment sitting between arguments, passes through unchanged. Guard
the splice exactly as `replaceNameSpan` does: if the argument node's span does not fall inside the
call node's own text, return no mutant rather than producing corrupted AL. This should be
impossible for a genuine descendant, and is guarded rather than assumed for the same reason every
other splice in this product is.

`before: node` (the whole `procedure_call`), `after: synthesizeAfter(node, splicedText)`,
`parentContext`: this operator only ever claims a call in statement position, since `SetFilter`'s
return value (a `Boolean`, whether the filter changed something evaluable) is not the shape this
design reasons about being read from an expression context — so `parentContext` is the literal
`"statement-position"`, the same precedent `remove-setrange` and `validate-to-assign` use for a
guard that already established it, rather than the computed hint `swap-find-direction` needs
because THAT operator claims expression-position sites too. Whether restricting to statement
position is itself the right call, given `swap-find-direction` and `swap-modify-flag` both claim
expression-position sites: `SetFilter`'s own return value is a Boolean flag (something changed),
which is a real but rarely-consumed signal in real AL, and this design does not have a measured
population for how often a `SetFilter` call sits in expression position. Restricting to statement
position is the safe direction (missing a site costs this operator's signal, `void-method-call`
still covers it) and is recorded here as a scope decision rather than an oversight, parallel to how
the trio spec recorded `validate-to-assign`'s own un-braced-then-branch cost.

### 2.7 Dedup and baseline identity

**Dedup coexistence, verified against source (section 0), not asserted from the sibling spec's
prose.** `after.text` is never empty for this operator (a splice of a non-empty literal is never
empty text, since the mutated literal always carries at least its own quotes), so at every site
this operator claims, its identity differs from `void-method-call`'s identity (which has empty
`after.text`) by that field alone, and both mutants survive dedup. This is proposal 2's claim,
confirmed rather than repeated: the two operators' `before` nodes are the SAME AST node for a
shared call site (both set `before: node`), so `before.kind`/`startIndex`/`endIndex` are identical
between them and `after.text` is the only field that can differ, which it always does here. This
operator also never claims a `SetRange` call (its target predicate names `SetFilter` specifically),
so it cannot collide with `remove-setrange` at all; the two operators have disjoint target method
names.

**Baseline distinguishability — the question the task brief specifically raised, checked against
`packages/engine/src/ast/hash.ts` rather than assumed.** The trio spec's operators (`swap-find-
direction`, `validate-to-assign`) collapse several fixture arms into one baseline key, because their
mutation changes only an IDENTIFIER (a method name), and `astSubtreeHash` canonicalises every
identifier's text to a scope-relative index — so two sites differing only in which method name they
call can hash identically. This operator's mutation changes a STRING LITERAL's content, and
`astSubtreeHash` hashes a `text_literal` node's TEXT VERBATIM (confirmed in section 0). The `before`
node hashed for the baseline key is the ORIGINAL, UNMUTATED call — its filter-text literal carries
whatever the real AL source wrote, not this operator's output — so two different `SetFilter` sites
will hash to different `astHash` values whenever their ORIGINAL filter-literal text differs, even if
every identifier around that literal (the receiver, the field argument if it is a bare identifier,
the value argument) would otherwise canonicalise to an identical pattern. Since a real `SetFilter`
call's filter text is, by construction, the part of the call that encodes what makes that site
meaningfully different from another `SetFilter` call, two genuinely distinct fixture arms are
expected to carry distinct filter text and therefore distinct hashes — this operator's mutants are
expected to be MORE distinguishable in the frozen baseline than the trio's were, not less.

This is not a guarantee, and this document does not claim it as one. Two sites COULD still collapse
if they carried byte-identical filter-literal text AND every surrounding identifier canonicalised to
the same pattern (same argument count, same relative declaration order). The mitigation is cheap and
belongs to the fixture task rather than to this operator's code: **every arm in section 3 must use a
distinct filter-literal string**, which every arm below already does, incidentally, because each
one is built to demonstrate a different rule or a different mechanism. If Task B6 or B7 ever needs
two arms sharing one rule's shape, this constraint is the reason to still vary the literal text (a
different field name embedded in a decoy token, a different bound value) between them.

## 3. The fixture arms

All new arms live in `fixtures/sandbox-data`, reusing `table 79302 "Data Related"`: no new table.
That table already exists for `Data Ops.CountForMain`, already has an Integer primary key
(`"Entry No."`) and a `Code[20]` field (`"Main No."`) suited to every shape this operator's four
rules need, and `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al` already carries idempotent
seeding helpers for it (`AddRelated(EntryNo, MainNo, AmountValue)`, `ClearRelated(MainNo)`, both
read in full for this document). Reusing them means Task B6 adds one codeunit and zero new
tables: the same "minimal fixture growth" principle the trio spec's rule 3 (section 3.3 there)
applied to its own arms, applied here to avoid the schema growth entirely rather than merely
minimising it.

**Placeholder id, to be confirmed or moved by Task B6**: `codeunit 79317 "Data Filter Ops"`. 79317
is free against the fixture's current inventory (verified in section 0; the highest codeunit id in
use today is 79316).

**What follows is a design table, not a precommitment.** Exact literal spellings, exact seeded
values and exact procedure names are Task B6's to finalise; what this table fixes is the SHAPE of
each arm, the RULE or refusal it exercises, the MECHANISM that produces its predicted verdict, and
why that mechanism is not an accident of the data. Task B7 is where a per-mutant table gets
pre-committed against the actual AL, the way the trio spec's sibling precommitment document did.

### 3.1 The arms

| arm | shape | rule / mechanism exercised | predicted verdict |
|---|---|---|---|
| **A** | `CountExcluding(MainNo)`: `Related.SetFilter("Main No.", '<>%1', MainNo); exit(Related.Count());`. Test seeds rows split across two `Main No.` groups of DIFFERENT sizes (for example one row tagged `'T-NEGA'`, two rows tagged `'T-NEGB'`) and calls with `MainNo = 'T-NEGA'`, asserting the count of the OTHER group | rule 1 (negation flip), KILL | Baseline counts the non-`'T-NEGA'` rows (2). The flip to `'=%1'` counts the `'T-NEGA'` rows instead (1). Different counts, assertion fires. **KILLED** |
| **B** | `AnyExcluding(MainNo)`: same call, `exit(Related.Count() > 0);`. Test seeds at least one row in each of the two groups and asserts only that the excluded-group count is non-zero | rule 1, weak-assertion SURVIVOR | Baseline: count(!=MainNo) > 0 is true. Flip to `=`: count(==MainNo) is also > 0 by construction (at least one row was seeded in that group too). An existence-only assertion cannot see which group was counted. **SURVIVED**, and this is the arm that proves the operator's kill signal actually depends on the assertion looking at a VALUE, not merely existence — the same discrimination class `swap-find-direction`'s arm F and `validate-to-assign`'s arm H each demonstrated for their own operators |
| **C** | `CountBelowThreshold(Threshold)`: `Related.SetFilter("Entry No.", '<%1', Threshold); exit(Related.Count());`. Test seeds rows at three consecutive `Entry No.` values including one AT the threshold (for example entries N, N+1, N+2, called with `Threshold = N+2`), asserting the count strictly below it | rule 2 (boundary shift), KILL | Baseline `<N+2` matches entries N and N+1 (2). Shifted to `<=N+2`, it also matches N+2 (3). Different counts. **KILLED**, and specifically because a row sits exactly AT the boundary — the mechanism this arm exists to demonstrate |
| **D** | `CountBelowThresholdSparse(Threshold)`: identical shape, but the test seeds rows with a GAP at the threshold (for example entries N and N+2 only, no N+1, called with `Threshold = N+1`) | rule 2, equivalence SURVIVOR | Baseline `<N+1` matches only N (1). Shifted to `<=N+1` also matches only N, since no row sits at N+1. Identical counts. **SURVIVED** — the boundary-shift analogue of `swap-find-direction`'s "equivalent whenever the filtered set holds zero or one row" class: here the mutant is equivalent whenever no row sits exactly at the shifted boundary, independent of how much data exists elsewhere |
| **E** | `CountUpToBound(Bound)`: `Related.SetFilter("Entry No.", '..%1', Bound); exit(Related.Count());`. Test seeds rows only AT and BELOW the bound (for example entries N-1, N, called with `Bound = N`), none above it | rule 3 (open-range flip), KILL | Baseline `..N` matches both seeded rows (2, reasoned per section 0's range-inclusivity claim). Flipped to `N..`, only the row at N still matches (1, since N-1 < N). Different counts. **KILLED** |
| **F** | (no dedicated arm; recorded as a note rather than a fixture procedure, to avoid adding a fourth near-duplicate procedure for a class already demonstrated twice) The same equivalence class arm D demonstrates for rule 2 applies to rule 3 whenever a seeded set has no row exactly at the pivot, or exactly one row (which satisfies both `..X` and `X..` at once). Task B6 may add a dedicated arm for this if the adversarial review wants live proof of the range case specifically rather than an inference from arm D's boundary case | rule 3, equivalence class (documented, not separately fixtured) | not applicable — no mutant scored under this row |
| **G** | `CountDecoyOrTarget(MainNo)`: `Related.SetFilter("Main No.", 'T-DECOY|%1', MainNo); exit(Related.Count());`. Test seeds rows in a `'T-DECOY'` group and a separate group tagged by the passed-in `MainNo` (for example two `'T-DECOY'` rows and three rows tagged `'T-DROP'`, called with `MainNo = 'T-DROP'`) | rule 4 (drop placeholder-free alternative), KILL | Baseline matches `'T-DECOY'` OR `MainNo` rows (2 + 3 = 5). Dropping the placeholder-free `'T-DECOY'` alternative leaves only `'%1'`, matching just the `MainNo` rows (3). Different counts. **KILLED**, and the arm that shows WHY the rule's placeholder-free restriction is what keeps the call's own argument list untouched: `'T-DECOY'` was never backed by a call argument, so removing it from the filter text requires no change anywhere else in the call |
| **H** | `CountInRange(LowBound, HighBound)`: `Related.SetFilter("Entry No.", '%1..%2', LowBound, HighBound); exit(Related.Count());`, covered by a test that seeds rows and asserts a count exactly the way arm C or E would | REFUSAL negative — closed range, deferred (section 5, item 1) | `flip-filter-literal` must emit NOTHING here: the alternative classifies successfully as a closed range (section 2.2 step 4), but no rule in the section 2.3 ladder targets a closed range, so the site refuses by ladder exhaustion rather than by classification failure. The site keeps only `void-method-call`'s deletion mutant, whose verdict this design does not predict without seeing the actual seeded counts. **Expected collateral worth naming in advance**: `LowBound` and `HighBound`, as written, are two bare-identifier parameters of the SAME declared type (`Integer`), which is exactly the shape Tier-1 `lethal.swap-call-arguments` claims (verified against `packages/builtin-tier1/src/swap-call-arguments.ts`'s own predicate: two bare identifiers, same declared type, differing text). Task B7's census may therefore show a THIRD mutant at this span (the argument swap), coexisting with the deletion the same way it coexists at every `SetRange` site the trio spec's collateral section named. That would not be a defect; it would be the same mechanism operating on a new site |

**The pre-existing site, classified rather than left implicit** (task requirement, proposal 8):
`Data Ops.CountIgnoringMainFilter`'s `Related.SetFilter("Main No.", '%1', MainNo);`. Unquoted
content is `%1`: one alternative, no `|`, classified as an ATOM (a bare placeholder, section 2.2
step 4). No rule in the ladder matches a lone placeholder atom: rule 1 needs a `<>` token, rule 2
needs a boundary token, rule 3 needs a `..`, and rule 4 needs two or more alternatives. This site
therefore REFUSES under this design, for the same reason arm H refuses: the ladder finds nothing to
do, not because the parser could not classify the content. `void-method-call`'s existing mutant at
this call and the frozen verdict it already carries are unaffected. This operator contributes
nothing here, which is itself a small, free confirmation that a genuinely un-mutatable shape stays
un-mutated rather than being guessed at.

### 3.2 Rules the arms should obey, carried forward from the trio spec's own fixture rules

- **Coverage filtering isolates arms** (trio spec section 3.3, rule 1): each arm's covering test
  must seed its own rows; none may depend on rows another arm's test happens to insert.
- **Seeding stays idempotent** (same section, rule 6), matching `AddRelated`'s own existing
  behaviour (`Get` then `Delete(false)` then re-`Insert(false)`), for residue-from-an-aborted-run
  safety rather than because BC commits between tests: R32 already measured that platform test
  isolation rolls writes back between tests, and the existing helper already carries a comment
  saying so.
- **Setup calls use non-claimable spellings.** `AddRelated`'s own `Delete(false)`/`Insert(false)`
  are already the non-claimable forms; nothing about this operator's arms needs to add any new
  setup statement that a registered operator would claim.
- **Every arm's asserted value should be non-zero**, for the same reason the trio spec's rule 2
  gave: `lethal.return-value` rewrites a non-zero `exit(Integer)` to `exit(0)` and deliberately
  skips a site that already returns 0, so an arm whose assertion happens to be 0 has an unkillable
  `return-value` collateral for reasons unrelated to this operator.
- **Reserve distinct filter-literal text per arm**, per section 2.7's baseline-distinguishability
  discussion — already true of every arm above by construction, since each demonstrates a
  different rule or mechanism, but worth stating as a rule for whichever arm Task B6 adds beyond
  this table (including a possible dedicated arm F).

## 4. What the live run may and may not conclude

**May conclude**, if every pre-committed verdict in Task B7's document matches what the gate
measures:

- the operator claims exactly the `SetFilter` shapes section 2 describes and refuses exactly the
  shapes section 5 lists, including the pre-existing bare-placeholder site and the deferred closed
  range;
- each of the four ladder rules produces a mutant that compiles, is attributed to its covering
  test, and scores correctly: at minimum, rules 1 and 2 are proven in BOTH a killed and a survived
  form (arms A/B and C/D), which is the discrimination evidence, not merely a kill count;
- the Tier-2 rewrite coexists with the Tier-1 deletion at every claimed span, the same coexistence
  mechanism the trio spec measured for its own three operators;
- the placeholder-arity invariant never throws across the whole fixture (a throw anywhere would be
  a bug in this operator's own code, not a fixture finding);
- this operator's mutants are distinguishable in the frozen baseline per site, as section 2.7
  reasons they should be, PROVIDED every arm's filter-literal text stays distinct as designed.

**May not conclude, and no report or roadmap wording from this wave may imply otherwise:**

- any rate on real code. The census in section 0 counts syntactic sites, not killable ones, and no
  fixture measurement turns one into the other.
- anything about wildcards, `@`, `&`, the filter DSL's own quoting layer, or a non-literal filter-
  text argument, all refused, all with unmeasured real-code populations.
- anything settling the two REASONED (not measured) platform claims in section 0, the bare-atom-
  equals-explicit-`=` equivalence and the inclusive, one-sided nature of an open range, unless an
  arm's own verdict happens to contradict one of them, in which case that contradiction is the
  finding, written up rather than absorbed, exactly as the trio spec's precommitment amendment did
  for its own two contradicted premises.
- anything about closed-range mutation. Arm H proves the REFUSAL holds; it says nothing about
  whether closed ranges are worth mutating some other way later.
- anything about equivalence RATES for the boundary-shift or negation-flip classes. Arms B and D
  each demonstrate ONE deliberate equivalent survivor; neither measures how often that class occurs
  on real code.
- anything about the assertion screen's discriminating power on this fixture, which the trio spec
  already established measures as `vacuous` here and which this wave's arms (all raising through
  bare `Error(...)`, matching the existing suite's convention) do not change.

## 5. Refusals and deferrals, recorded

| item | decision | reason |
|---|---|---|
| closed-range mutation (`X..Y`, both bounds present) | **deferred** | bound-swap semantics on a DESCENDING closed range (would `X..Y` flipped to `Y..X` mean anything, or would it need normalising) is exactly the kind of platform question this document will not answer by reasoning alone, given the trio spec's own experience with an unflagged range-normalisation premise. Deferred rather than guessed at; arm H is the fixture's live proof that the deferral holds |
| wildcard (`*`, `?`), case-insensitive (`@`), AND-combinator (`&`), and the filter DSL's own quoting (`'`) | **refused** | none of the four ladder rules has defined meaning inside these shapes, and this parser does not model any of them (section 2.2). Refused by the cheap character check, before classification even runs |
| a non-literal second argument (`SetFilter(F, MyFilterVar, V)`) | **refused** | a variable filter string is invisible to static mutation; guard 3 in section 2.1 refuses it directly |
| `lethal.remove-setfilter` (a Tier-2 twin of `void-method-call` deleting the whole `SetFilter` call) | **refused, already decided in R134's row** | `void-method-call` already emits the identical deletion at every such site; a Tier-2 twin would add a name and no information, the same reasoning that closed R11/R13 |
| a stray `%` not forming a clean, whole-alternative placeholder (`50%`, `%A`, `%1x`) | **refused** | falls out of "anything unclassifiable refuses" (proposal 3) but named explicitly here (section 2.2 step 4) rather than left for an implementer to discover, since a bare `%`-scan without this check would misparse rather than refuse |
| an empty alternative (`||`, a leading or trailing `|`), or an empty range (`..` alone) | **refused** | neither is a shape any of the four rules can act on; both are named explicitly in section 2.2 |
| a filter with 2+ alternatives where every alternative carries a placeholder (`'%1|%2'`) | **no mutant, ladder exhaustion, not a parser refusal** | rule 4 requires a PLACEHOLDER-FREE alternative to drop; none exists here, and rules 1-3 do not match either (no comparator, no `..`) — recorded separately from the true refusals above because the site classifies successfully at every step |
| the bare-atom `SetFilter(F, '%1', V)` shape (the pre-existing fixture site, and any real-code site shaped like it) | **no mutant, ladder exhaustion** | a lone atom with no comparator, no range and no second alternative matches none of the four rules, by construction (section 3.1) |

## 6. Ratification log against the brief's eight numbered proposals

| proposal | decision | what this document adds |
|---|---|---|
| 1. name `lethal.flip-filter-literal`, tier 2, version 1.0.0 | **ratified as written** | nothing |
| 2. target predicate: `SetFilter`, `countArguments >= 2`, second argument a plain string literal; `before` the whole call, `after` the call text spliced | **ratified, mechanics specified** | the variable-position argument access pattern (`countArguments` then `exactArguments(node, thatCount)`, since `validate-to-assign`'s fixed-index pattern does not apply to an argument count that varies with placeholder count), and the splice-not-rebuild distinction from `validate-to-assign` made explicit (section 2.6) |
| 3. refuse-by-default mini-parser: unquote, refuse-char list, alternative split, four-way classification | **ratified, elaborated into an unambiguous procedure** | per-character reasoning for the refuse list; the stray-mid-token-`%` refusal; the empty-alternative and empty-range refusals; the explicit statement that classification is all-or-nothing across a whole site; the explicit statement that a closed range classifies successfully but is unhandled by the ladder, a different outcome from "unclassifiable" |
| 4. one mutant per site, fixed precedence ladder | **ratified, order justified, one ambiguity resolved** | the reasoning for the order (population and severity for rules 1-2, structural surgicalness for rules 3-4); the resolution of "first alternative containing NO % placeholder" to mean "first one FOUND matching the predicate," not "the literal first alternative, if it qualifies" — the brief's wording admits both readings and only one keeps the placeholder-arity guarantee correct regardless of position |
| 5. placeholder-arity invariant, asserted with a throw | **ratified as written** | the exact contract (sorted multiset equality, exported for direct unit testing) and the observation that none of the four rules can violate it by construction, which is why the assertion is a backstop rather than a case expected to fire |
| 6. re-encoding mirrors the operator-sdk's `textLiteral` escape | **ratified as written** | confirmation, against `build.ts`, of the exact transform to mirror, and the reason to call it rather than re-derive it (no drift between encode and decode) |
| 7. refusals recorded: closed range, wildcard/`@`/`&`, non-literal argument, `remove-setfilter` | **ratified, list extended** | two refusal cases this document's own classification work surfaced (stray mid-token `%`, empty alternative/range) that the brief's proposal implied under "anything unclassifiable" but did not name; the ladder-exhaustion cases (all-placeholder alternatives, the bare-atom shape) recorded as a DIFFERENT kind of "no mutant" from a true parser refusal |
| 8. fixture arms table, including a refusal negative and the pre-existing site's classification | **authored from scratch** | the brief specified only what this table must contain, not its content. This document supplies eight arms (A-H, with F recorded as a documented equivalence class rather than a ninth near-duplicate procedure) covering all four ladder rules with at least one kill each and a discriminating survivor for the two most populous rules, one refusal negative (arm H, the closed range named in item 7), and the classification of the pre-existing `CountIgnoringMainFilter` site, all built on the EXISTING `Data Related` table and its existing seeding helpers rather than new schema |

## 7. Order of work, for the tasks after this one

This document produces no code and touches no fixture. The tasks that follow it in this wave
(already tracked): an adversarial review of this spec; the mini-parser built test-first against the
classification rules in section 2.2; the operator itself built against sections 2.1, 2.3-2.7; an
independent red-check pass over every guard, the same discipline the trio spec's own section 2.5
required (each of the four ladder rules, the placeholder-arity invariant, and the new `SetFilter`
shadowing-refusal test this operator's `claimsRecordMethod` use requires); the fixture growth in
section 3, landed together with the operator in one freeze per the trio spec's own reasoning
(landing fixture and operator separately moves the frozen counts twice for no reason); a census and
a separate per-mutant precommitment document, in the shape of the trio spec's own precommitment
document, before any live gate touches this operator; the live re-record; and a close-out that
updates `docs/roadmap/R134.md`'s status and regenerates `ROADMAP.md`.

A differing verdict against Task B7's precommitment is a BLOCK, never "close enough", the same
rule every prior wave in this project has used.
