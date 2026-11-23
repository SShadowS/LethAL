# PR-361 pre-commitment (R1153 (b)): every serve keep entry is tested against a REAL al-runner line

Written 2026-11-23, before the build. Measured first (`/coord/handoff/PR-361/`: `mine.ts`, `select.ts`, `near.ts`,
`mined6.json`, `draft.json`). Names and numbers only; the fixture holds no DO, DC or Continia text.

## Why
R1153: 12 `PR56_KEPT` rows never matched. al-runner ends their texts with " (not pinned)", the PR-54 census normalised that
away, and the pin (`tests/pr56-measured-refusals.json`) held the same normalised texts. So the test passed for the wrong
reason. (b) is the guard: every keep entry is tested against a line al-runner really wrote.

## What "a real line" is (`mine.ts`)
- The `message` of a row object al-runner wrote: a JSON object with a string `message`, a `status` of pass, fail or error, and
  a `notRun` or `codeunit` key. That covers one-shot JSON, serve answers, census `serve.*.log` lines and `repros.json`
  candidates.
- Or PR-217's keepcheck kit's copy of one: `[entry id, test name, "status|message"]`, with the message copied verbatim.
- Nothing else: receipts, red-check logs and LethAL's own pins are never read as rows, so a pinned text cannot prove itself.
- **The scan:** every `.json`, `.ndjson` and `.log` file under `/coord/handoff` below 60 MB, skipping caches and source
  checkouts. It covered 33,813 files and found 2,347 distinct row messages.

## The measurement (`mined6.json`)
- **Of `V3_SERVE_SAFE_REFUSALS`'s 131 entries, 119 match at least one real row.**
- **12 match none, and they are exactly R1153's 12:** `geturl-company-characters`, `geturl-object-type-or-arguments`,
  `dotnet-copilot-platform-authorization`, `yaml-list-indent`, `yaml-null-or-number`, `yaml-blank-line-nested`,
  `yaml-flow-quoted-key`, `gotokey-statement-no-row`, `part-visible-other-shape`, `xmlport-import-header`,
  `asdecimal-text-control`, `page-no-record-onopenpage`.
- **Each of the 12 has a real near-miss row,** the one PR-244's `keepNearMiss` names it for. Each ends in " (not pinned)",
  which is R1153's cause, seen in real output.

## The fixture (`packages/runner/tests/pr361-keep-real-lines.json`)
- **`proven`:** for each of the 119, ONE real line (the shortest, preferring a source that ran an invented app over a corpus
  run), with `from`, the handoff path it came from.
- **`nearMiss`:** for each of the 12, its real near-miss line.
- **Names:** al-runner's words stay byte for byte. Only a value from a corpus run may be replaced by an invented one of the
  same shape. Today that is one: the 15-digit payment reference in `saveas-layout-statement`'s line, from a DO run, becomes
  `000000001234567` (its slot is `\d{15}`). The other lines carry BaseApp, Microsoft or invented-app names only; 4 came from
  a corpus run and carry no names at all.
- A guard test refuses `Continia`, `Document Output`, `Document Capture`, `CDO`, `CDC`, a 68xxx or 69xxx object number, and
  any 15-digit number other than `000000001234567` anywhere in the fixture.

## The test (`packages/runner/tests/pr361-keep-real-lines.test.ts`)
1. Every `proven` line matches its own entry.
2. **The entry sets are pinned exactly:** `proven`'s entries, plus the pinned `UNPROVEN` list (R1153's 12), are the whole
   of `V3_SERVE_SAFE_REFUSALS`, with no overlap.
   - A new entry with no real line goes red, since it is in neither list.
   - A dropped `proven` line goes red too.
3. Every `nearMiss` line matches NO entry, and `keepNearMiss` names its entry. When (a) widens one of the 12 with its own
   DO proof, this goes red. Then the line moves to `proven`, and the entry leaves `UNPROVEN`.
4. The names guard described above.
- Nothing in `src/` changes, and no entry is widened (that is (a)).

## Red checks
- Break one entry's anchor in `al-runner-server.ts` (for example `commit`'s literal): test 1 goes red.
- Remove one `proven` line: test 2 goes red, because its entry then belongs to neither list.
- Widen one of the 12 by adding ` \(not pinned\)` to its row: test 3 goes red.
- Put `Continia` into one line: test 4 goes red.

## Checks
VERIFY full (one at a time beside the timed run), Opus review, CI. 0 moves, since no source changes. The v3 gate is batched
with PR-360's when the box frees.
