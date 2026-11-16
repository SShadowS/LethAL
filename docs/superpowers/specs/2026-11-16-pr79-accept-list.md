# PR-79 pre-commitment: the accept list for survivors on the changed lines (threshold option 3, part 2), and R1081

Coord PR-79 (2026-11-16). Owner ruling q-20261116T134341-645f4a0f, part 2 of option 3 (PR-77 built part 1, R1084).

## A deviation from the ruling's wording, and its measured reason (read this first)

The task said to anchor the accept list by **extending R443's proof rules** (the equivalence marks' matcher). **This design
does not.** It leaves R443 and `lethal.equivalent.json` untouched and gives the accept list its own file and its own anchor.
The owner can object here. The reasons, from a spec-adversary review of an R443-based draft, measured where it could be:

1. **Measured: on a `--changed-since` run, R443's marks cannot reach most survivors.**
   - The line filter records each site it drops by its COARSE tuple (`astHash|operator|major`, with no file, object or
     procedure).
   - The report then withholds from every mark any mutant sharing such a tuple, before R443's rules run (`carryHidden`,
     `carryOff`).
   - A probe counted the deployed sites that share their coarse tuple with a site on another line. Each of those is withheld
     on a pull request that touches only its own line:
     - the private DO copy: 33,207 of 45,021 (73.8%);
     - gift-card: 17 of 65 (26%).
   - So an R443-based accept list would fail for about three in four survivors in CI. `--fail-on-survivors` would exit 9 on
     reviewed survivors forever.
   - Probe: `scratchpad pr79-probe/probe.ts`, output in `/coord/handoff/PR-79/probe.md`.
2. **From the code: R443's key does not change when a line is rewritten in place.**
   - `astHash` numbers local identifiers by the order they first appear (`serializeCanonical`).
   - So `x > 0` → `y > 0`, swapped operands, and `(x > 0) and Override` keep the mutant's key.
   - An accepted survivor whose line a PR rewrote would stay accepted. That breaks the ruling's "a changed site re-opens", and
     `threshold-options.md`'s own analysis.

Making R443 fit would mean changing its hide to twin-site precision: the matcher, the stream's numbering facts and
`lethal explain`'s `fileSingleton`. It would still need a text anchor for (2), and it would touch every equivalence mark.
This design needs neither.

## How the accept list is used (it decides the anchor)

On a `--changed-since` run, every survivor listed sits on a line the pull request changed. So the workflow is **within one
pull request**:
1. CI lists a survivor.
2. A developer reviews it, decides it is acceptable, and commits an entry in the same pull request.
3. The re-run (same diff against the base) matches the entry, and the survivor is accepted.

Later pull requests list that survivor only if they change its lines again, and then the entry must not match: the change
needs a new review.

## The file: `lethal.accepted.json` in the `--project` folder

```json
{ "accepted": [ {
    "file": "src/Posting.Codeunit.al",
    "tuple": "<astHash>|<object>|<procedure>|<operator>|<major>",
    "lineInProcedure": 5, "column": 12,
    "siteText": "<sha256 hex>",
    "procedureText": "<sha256 hex>",
    "preprocessorSymbols": [],
    "reason": "why this survivor is acceptable",
    "acceptedBy": "optional", "acceptedOn": "optional" } ] }
```
- `tuple` is `identityTupleOf`: the identity without the ordinal.
- **The site's place inside its procedure (review 2, H1).** `lineInProcedure` is the site's first line minus the member's first
  line, where the member starts at its first attribute (see `procedureText`). For a two-piece span (an attribute run split by
  `#if`), place is measured from the start of the last piece (review 3, L-b). `column` is the site's start offset within its
  trimmed first line. While `procedureText` matches, both are fixed, so they tell apart twins with identical lines in one
  procedure.
- `siteText` is the sha256 of the site's source lines, from the first to the last line of the span.
- `procedureText` (review 2, M1) is the sha256 of the enclosing member's span widened to its attributes. That is the range
  R474's `memberSpanText` hashes, so an added `[TryFunction]`, `[CommitBehavior]` or `[ErrorBehavior]`, or a changed
  `[EventSubscriber]` binding, changes it. For a trigger inside a field, action, control or part, the parent declaration's
  first line is prepended, so a trigger body moved to another field or action changes it too. **(Review 3, M-b, which
  replaces that sentence.)** For any trigger, the header text up to `{` of EVERY enclosing declaration between the trigger and
  the object is prepended, whatever its kind: field, action, control, part, report or query `dataitem`, XMLport
  `tableelement`/`fieldelement`/`textelement`, `modify(...)`, and the rest. Each header is trimmed per line, so a wrapped header
  is taken whole, not by its first line.
- **How the text is cut (review 2, L1).** Each hash is over lines split on `\n` only, as `lineStartsOf` does. The source is
  decoded with `decodeSource`, BOM kept. Each line is trimmed of leading and trailing whitespace, which drops `\r`, tabs and the
  BOM, and the lines are joined with `\n`.
- `preprocessorSymbols` (review 2, L2) is the build's effective symbol set, as the marks file pins it (R214). An entry applies
  only to a build with exactly this set. In the file, absent means `[]`. A REPORT with no `buildSymbols` matches no entry at
  all: it is refused, never read as `[]` (review 3, L-e). The set includes al-runner's predefined symbols, so an entry printed
  by a v3 run does not match a bcdev run (the safe direction).
- `reason` is required, non-empty, and not the placeholder.
- **Parsing is strict.** Malformed JSON, a missing field, bad hex, a negative `lineInProcedure` or `column`, the placeholder
  reason, or two entries with the same anchor (every field but `reason` and the optional ones) each stops the run by name
  (review 3, L-d). The file is read and parsed when the run STARTS, not after
  it (review 2, L3), and never loads 4 of 5 entries. Paths use `/`.

**Where a developer gets an entry (review 2, M2).** `lethal run` prints a ready entry under each counted survivor in the
section, with the reason placeholder. A survivor that is ambiguous this run (another row has the same anchor) gets "cannot be
accepted: ambiguous" instead of an entry, so nobody pastes an entry that can never match (review 3, L-c). CI therefore hands the developer the exact entry, computed from the source the run
measured. `lethal explain` is NOT changed, so a developer's checkout (another commit, or CRLF from `autocrlf`) can never
produce a mismatched entry.

## The mechanism (review 3, M-a)

Nothing is added to the report. The anchor fields are computed in `runFromCli`, which holds the run's source snapshot:
1. Before the session starts, `runFromCli` reads and validates `lethal.accepted.json`.
2. After the report is built, it re-parses each file it needs from the snapshot (`source`) with `parseAL`. Files are mapped as
   `readKeyOf` maps them.
3. It finds each row's enclosing member by the `enclosingMemberOf` rule. It computes the attribute-widened start with
   `attributeRun(member, false, member.endIndex, true)`, and the chain of enclosing declarations.
4. It **refuses loudly** when the parsed member's unwidened start and end lines differ from the row's
   `procedureStartLine`/`procedureEndLine`. That means it found another member, and a silent mismatch would print an entry
   nothing can match.
5. `runFromCli` returns the accept result beside the report. The section printer and `runExitCode` both take that one result
   as an argument.

## Matching (computed once at the end of `lethal run`, from the run's own source snapshot; the report is not changed)

- **The text comes from the snapshot the run parsed, never from disk** (review 2, M2).
- **Per-row checks.** Each row is checked as `gapSourceOf` checks it: the offsets lie inside the text, and the row's
  `originalText` equals the clipped slice.
- **Empty and missing spans.** A row whose procedure span is absent (`procedureStartLine`), lies outside the file, or gives an
  empty slice gets NO entry, and no entry can accept it. It is named in the section.
- **Empty never matches empty.**

An entry accepts a counted survivor when all of these hold:
- file (compared case-insensitively, as `spanTouches` compares it; review 2, L5), tuple, `lineInProcedure`, `column`,
  `siteText`, `procedureText` and `preprocessorSymbols` are all equal;
- **exactly one row of this run, of any verdict,** matches all of them (review 2, H1). Two or more are refused as "ambiguous".

The one computed result feeds both the section and the exit code, so the two cannot disagree (review 2, L3).

**Equivalence marks do NOT take survivors out of the counted list** (review 2, H2). That is PR-77's rule, unchanged. R443's
key survives a rewrite in place (`x > 0` → `y > 0`), so letting `readerMark` exempt a survivor would reopen exactly the hole
this design closes. A team that wants an equivalent mutant out of CI adds an accept entry for it.

**What re-opens an accepted survivor, while its line is in the run:**
- any edit to its own lines (`siteText`);
- any edit elsewhere in its procedure, or to its attributes (`procedureText`);
- a move to another procedure, object or file, or of a trigger body to another field or action (tuple, file, `procedureText`);
- another preprocessor symbol set.

A pure line shift caused by edits outside the member keeps the entry.

**The known limits: accepted risks, stated.**
- **Edits outside the member.** An accepted survivor whose member is unchanged, but whose meaning changed through an edit in a
  callee, a global, a table trigger or an event subscriber elsewhere, stays accepted. Re-opening on any edit in the file or the
  project was considered. Within the workflow above it would re-open entries on unrelated fixes made in the same pull request
  after the review. The list would then be unusable, and teams would stop using it. The member is the widest anchor that stays
  stable through one pull request's review.
- **After merge.** A later pull request that edits only another line of the procedure does not list the site again, because
  its line is not in that diff. So the entry is not re-checked then. It is re-checked the next time the site's own line changes.
- `app.json` is not part of the anchor.

All three are recorded in the docs.

## Reporting (the section's new parts)

- **accepted:** survivors an entry accepted, each with the entry's reason. They never count toward `--fail-on-survivors`. A
  survivor both accepted and v3-caveated is listed as accepted.
- **Precedence (review 3, M-c).** Each entry gets exactly ONE label. An entry that matched a row gets that row's label only:
  accepted, killed, or not measured. The two labels below apply only to entries that matched no row.
- **re-opened** (review 2, M3; review 3, M-c): an UNMATCHED entry is called re-opened when this run has a row with the same file
  and the same tuple (by its full scope, the parent-declaration prefix included), and that row's texts or place differ. It is
  printed with the file and the instruction "re-review the survivor". A specific fresh entry is named as the replacement only
  when its tuple is equal to the entry's; otherwise none is named.
- **identity changed** (review 2, L4; review 3, M-c): an UNMATCHED entry whose file, place and both texts match a row with the
  same `operatorName`, but whose `astHash` or operator major differs. The message says LethAL's identity for the site changed,
  not the code. A row of another operator at the same site never triggers it.
- **ambiguous:** refused entries, as above.
- **Not in this run:** every other entry gets one summary line: "N entries match no site of this run (not on a changed line,
  or moved or renamed); not checked" (review 3, L-a). This covers entries in unchanged files and entries in changed files whose site is not on a
  changed line. They are not called stale, and there is no instruction (review 1, M3; review 2, M3). "The run's changed
  files" means the files of the report's `lines.ranges`, compared case-insensitively. A file with only deletions has no range.
- **Killed or not measured** (adversary M4): an entry whose site's row exists with a verdict other than surviving, worded by
  verdict:
  - `killed` or `timeout-killed`: "a test now kills it; remove the entry";
  - `no-coverage` or `error`: "not measured this run; keep the entry".
- **No file** (adversary L7): when the counted list is not empty and `lethal.accepted.json` is absent, print one line naming the
  exact path it was looked for at.

Exit 9 counts only the counted list: the PR-77 rule with accepted survivors taken out. Re-opened, ambiguous and not-checked
entries never change the exit code by themselves; the survivors they do not accept count on their own.

## R1081
`assertBcVersionMatchesPackages` catches only `ENOENT` from reading `packagesDir`. It refuses by naming the setting
(`alRunnerV3.packagesDir`), the path, and the fix: fetch the Microsoft symbols into that folder, as docs/first-week.md shows,
and set `bcVersion` to the version printed. `EACCES`, `ENOTDIR` and other errors keep their own text. The existing "System
Application not found" refusal gets the same fix line only when nothing in the folder was unreadable; otherwise its
Ready-to-Run list is the cause (adversary L6). `lethal doctor` and `lethal run` both get it through the shared check.

## Tests, red both ways
- An entry matching every field on exactly one row: accepted, not counted, exit 0 with the flag. Red: with the acceptance
  removed, it counts.
- Each anchor field changed in turn: the site's line edited, another line of the procedure edited, an attribute added, another
  file, another procedure, a trigger body moved to another field, another symbol set, another place. Each re-opens or reads
  not-in-run, and counts. Red: with that field's comparison removed, it stays accepted.
- `x > 0` → `y > 0` on the site's line (same astHash): re-opened. This pins review 1's HIGH 1.
- A line shift from an edit outside the member: still accepted.
- **Twins (review 2, H1).** Two identical lines in one procedure, site A accepted. The test app changes so that A is killed and
  B survives: the entry does NOT accept B, and B counts. Twins at different places can each be accepted by their own entry.
- **A survivor with a `readerMark` on a changed line is still counted** (review 2, H2).
- A row with no procedure span gets no entry and cannot be accepted. An empty slice never matches empty.
- An entry in a changed file whose site is not in the run: not-in-run, not "re-opened" (review 2, M3).
- **Review 3:**
  - One move test per trigger kind: a dataitem `OnAfterGetRecord`, an XMLport element trigger, a `modify(...)` trigger, and
    a field trigger with a wrapped header. Each re-opens or reads not-in-run.
  - An accepted entry with another changed site in the same procedure stays "accepted", with one label.
  - Field A's accepted `OnValidate` while field B's is edited: A is not "re-opened", and B's fresh entry is never named for A.
  - A negate-conditional entry whose row was killed, beside a surviving conditional-boundary row at the same site: labelled
    killed, never "identity changed".
  - A refusal when the re-parsed member's lines disagree with the row's.
  - A report with no `buildSymbols` accepts nothing.
  - A duplicate anchor with different reasons is refused.
  - An ambiguous survivor prints "cannot be accepted" instead of an entry.
- Killed versus no-coverage wording, and the identity-changed wording.
- No file: the path line is printed.
- **Review 1's HIGH 2 regression:** on a line-narrowed report whose survivor's coarse tuple is in `carryHidden.tuples`, the
  entry still accepts it. The test must be built with that hide present, so it cannot pass for the wrong reason.
- Parse refusals: a missing field, the placeholder reason, bad hex, a negative place, an identical duplicate. A malformed file
  stops the run BEFORE it starts.
- The printed ready entry, pasted back with a reason, is accepted on the re-run (a round trip).
- R1081: a missing folder gives the named error; `EACCES` keeps its own; the not-found fix line is absent when the folder had
  unreadable entries.

## Predictions
- P1: R443, `lethal.equivalent.json`, `lethal explain`, the report schema and every sample report are unchanged.
- P2: the v3 gate passes on the final head.
