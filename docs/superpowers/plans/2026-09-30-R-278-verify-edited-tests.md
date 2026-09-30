# R-278 (with R258): verify notices an edited test by a per-method source digest (short plan)

Closes R278 (an edited COVERING test is treated as old, so it skips the new-test checks) and R258
(an edited NON-covering test is never selected). Both come from one fact: `planVerify` decides
"new" by identity alone (`testKeyOf`, codeunit id plus method), never by the test's text.

**Scope boundary.** The code lane's R-360 is reworking verify's artifact loading now. This work
touches only test SELECTION (`planVerify` and what feeds it) and the recording of digests. It does
NOT touch `installedOf`, `loadInstalledArtifact` or `installedSelectorIds`.

## 1. The digest

`sha256` of one test method's own source text, cut from the tree-sitter parse of the tests' `.al`
files: from the first `attribute_item` in the run of attributes directly before the `procedure`
node (they are siblings in the parse, measured) to the end of the `procedure` node.

The attributes are INCLUDED. `[HandlerFunctions(...)]` and `[TransactionModel(...)]` change what a
test does, so editing one is a real edit. `[Test]` itself is always there, so it costs nothing.

A method declared in several `#if` arms is digested as all its declarations, joined in source
order. Any arm changing then changes the digest. No match at all throws, as testpage-scan does.

**Key:** codeunit id plus method name, method compared case-insensitively as AL does
(`${codeunitId}::${method.toLowerCase()}`). This is a new key used only for the digest lookup.
`testKeyOf` stays as it is.

The SOURCE text is deterministic: it is the bytes on disk. `alc`'s OUTPUT is not; C02-05's
dev-endpoint measurement (`docs/measurements/README.md`, "Dev endpoint: test-app read-back") had to
compile unchanged source twice precisely because the two packages already differed. That is why
the digest is of source, never of the package.

## 2. Normalization

Only two things: CRLF and lone CR become LF, and trailing spaces and tabs at line ends are dropped.
Both are invisible edits that editors and git make on their own.

Comments and other formatting are NOT normalized away. A comment edit is a real edit to the file,
and a normalizer that strips comments or collapses whitespace can be wrong about what is a comment
(R79 is this repo's own example). Over-normalizing can call an edited test unchanged, which is the
unsafe direction: that test then skips the new-test checks. Calling a comment-only edit "changed"
costs one extra double run, which is the safe direction.

## 3. Where it is recorded

A new nullable `runs.test_digests TEXT` column, added by the same additive `ALTER TABLE` loop R354
and R247 use. It holds JSON: `{ "<codeunitId>::<method lowercased>": "<sha256 hex>" }` for every
discovered test. The orchestrator computes it right after `discoverTests`, beside
`scanTestPageTests` and before the run row, and passes it to `createRun`. It is taken from the test
source the run read; that is the same assumption the covering-test names already rest on (the
test app on the server was built from the tests on disk).

**Old runs (NULL) are refused, not treated as changed.** `planVerify` throws the existing
`source-predates-verify` refusal, naming the run and saying to run `lethal run` again. Why:
"treat as changed" is safe but not useful. Every test would become a new test, and new tests are
added to EVERY survivor's request, so an old run would cost (all tests x all survivors) runs plus a
double unmutated run of the whole suite. The refusal is equally safe, costs nothing, reuses a reason
verify already has (so `VERIFY_REFUSALS` does not change), and matches the precedent a few lines
above it (baseline rows without a codeunit name refuse the same way).

## 4. Selection

In `planVerify`, one rule replaces the identity-only filter: a discovered test is "new" when it is
not in the source baseline by `testKeyOf`, OR its verify-time digest differs from the source run's
recorded digest (a missing recorded digest also counts as differing). Verify computes the current
digests from the same test-file read that `scanTestPageTests` already does.

- An edited COVERING test: it is already in its survivor's request; it now also lands in
  `plan.newTests`, so it gets `rerunOnUnmutated` (the double freshness-checked unmutated run) and a
  new-test state (the flakiness gate). `add` already de-duplicates.
- An edited NON-covering test: it is in `plan.newTests`, so it is added to every survivor's request
  and gets the same checks.
- An unchanged test: selected and checked exactly as today.

TestPage refusal is unchanged: an edited test that may open a TestPage is refused like a new one.

## 5. Cost and scope

One tree-sitter parse of the test app per run and per verify. `scanTestPageTests` already reads and
parses the same files in verify and in every authoritative (bcdev) run, so there the digest reuses
that read; an al-runner run does one extra read and parse. The column is about 90 bytes per test: 1,000 tests is about
90 KB on one run row.

**Known limit, filed rather than fixed.** The digest covers the test method only. An edit to a
helper procedure, a handler or a library codeunit the test CALLS leaves the digest unchanged. A
reachable-set digest (testpage-scan already walks call sites) would close it, at the cost of every
shared-helper edit turning many tests new. Implementation Task 1 files this as a roadmap item
(next free id checked across all worktrees) and names it in the agent reference's guidance section.

## 6. Tests (each red-checked: revert the change, see the named test go red, restore)

- digest: CRLF and LF versions of a method are equal; trailing whitespace is ignored; a comment
  edit inside the method changes the digest; an attribute edit changes it; an edit to a SIBLING
  method does not change it; method name case does not change the key.
- planVerify: an edited covering test is in `newTests` and in its request once (red: revert the
  digest clause, it drops out of `newTests`).
- planVerify: an edited non-covering test is in every request (red: same revert, it is absent).
- planVerify: an unchanged test is not in `newTests`.
- planVerify: a source run with `test_digests` NULL refuses `source-predates-verify` (red: remove
  the guard, it plans instead).
- store: the column round-trips, and an old database gains it as NULL.
- orchestrator: a run records a digest for every discovered test.

## 7. Live gate

None needed. The change is file reading and a selection rule; no BC behaviour is claimed.
`itest:verify-agreement` already drives verify's live path, and it should be run once at the end as
a check that nothing moved, not as a new gate.

## 8. Tasks

1. **Digest function.** A small `test-digest.ts` in `packages/runner/src` (parse, span, normalize,
   key), plus its unit tests. File the helper-edit limit as a roadmap item and regenerate the index.
2. **Record on the run.** `store.ts` (the column, `createRun`, the run read), `orchestrator.ts`
   (compute after discovery, pass to `createRun`), plus store and orchestrator tests.
3. **Select in verify.** `verify.ts` `planVerify` and its caller's `sourceBaseline` feed (add the
   recorded digests to what `planVerify` receives), plus the planVerify tests above. Then close
   R278 and R258 in `docs/roadmap/` and update the guidance in `docs/using-lethal-from-an-agent.md`.
