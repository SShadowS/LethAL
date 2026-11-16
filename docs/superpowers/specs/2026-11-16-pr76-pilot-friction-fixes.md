# PR-76 pre-commitment: the DO pilot's friction fixes (R1079, R1080, and R1078's census log names)

Coord PR-76 (2026-11-16).

## R1079: "nothing to mutate in the selected lines" gets its own exit code, 8

**Today.** When `--lines` or `--changed-since` keeps no deployable mutation site, the orchestrator throws a plain `Error`
("the line filter ... kept no deployable mutation site ..."). The CLI exits 1. A pull request that changes no mutable line
therefore fails CI as if LethAL had broken.

**Change.**
- The orchestrator throws a typed `NoMutableLinesError`, which extends `Error` directly (CLAUDE.md convention). Its message
  stays the same.
- `lethal run` exits **8** for it, named `NO_MUTABLE_LINES_EXIT_CODE`. Codes 5 and 6 are verify's and 7 is the time budget's,
  so 8 is free.
- Exit 8 covers only this refusal. Exit 1 still covers every other error, and exit 4 (every mutant errored) stays a failure.
- The refusal itself stays: no report is written, so a CI never reads a score for nothing. The stderr line is unchanged, and
  the `--json` envelope names the class.
- `--dry-run` is not changed: it refuses nothing and only lists.

**Docs.** The CLI usage's exit-code table, `docs/using-lethal-from-an-agent.md` §"Exit codes" (checked by
`agent-contract.test.ts`), and `docs/ci/` (README table, and both templates map 8 to a pass with one line saying why). The
workaround text in docs/ci goes away.

**Red both ways.** A test that a line filter keeping nothing exits 8, and a test that another error still exits 1. Each is
reverted to show red.

## R1080: the export help says what works, plus an HTML page writer

**Measured** (2026-11-16, from the registry and the published bundle):
- `mutation-testing-elements@3.9.0` has no `bin`, so `npx mutation-testing-elements` is not a command.
- Its browser bundle is `dist/mutation-test-elements.js` (238,114 bytes; sha384
  `/dXYuoYRvO6rJ0FNtdKR+Hmq5iGrkkSDpc/TGgbSoReog26ZqhLhpSt4l+0Wwew2`).
- The bundle defines `<mutation-test-report-app>`, which takes the JSON as its `report` property (or fetches it from `src`).

**Change.**
- A new `lethal export --format mutation-elements-html` writes one self-contained page: the same JSON as `mutation-elements`,
  inlined as the element's `report`. The `<` characters are escaped, so the JSON can never close the script.
- The page loads the bundle from jsDelivr, pinned to 3.9.0, with that `integrity` hash and `crossorigin`. LethAL ships and
  downloads nothing: the viewer's browser fetches the bundle.
- `--help` and the console text no longer name `npx mutation-testing-elements`. They name the two formats and say the HTML
  page needs network access to jsDelivr when it is opened.
- The page carries the AL source, as the JSON does, so the same privacy note applies.
- docs/ci: both templates add the HTML export. The Azure one publishes it with `PublishMutationReport@1`.

**Not measured, and said so in the docs:**
- Whether the page renders in a browser: no headless browser is installed in this container. The orchestrator is asked for
  one, per the owner's rule; no stand-in is built.
- Whether Azure DevOps' report tab loads a script from a CDN: its tab content policy is not measured here.
- Tests pin the page's structure (the pinned URL and hash, the element, the escaping, and the JSON round-tripping from the
  page) but not its rendering.

## R1078's open item: keep-census log names

`keep-census.ts` names each class's log by its class text, cut to 60 characters, so two classes can share a file. PR-74 lost
two raw logs that way. **Change:** the name gets the class's index (`<index>-<text cut>`). A test shows that two classes whose
texts share 60 leading characters get two files; with the index removed, that test is red.

## Predictions
- P1: no existing test's expectation moves, except the exit-code tables and the export help text.
- P2: the v3 gate is untouched by these paths and passes on the final head.

## Addendum 1 (2026-11-16, after the Opus build review)

These changes were made after review and before any live step. The text above is left as it was committed.
- **Exit 8 is narrower than written above (review M1).** Lines whose sites LethAL REFUSED are not "nothing to mutate":
  hang-capable sites, a file that cannot carry the selector, or a file left out for an undecided `#if`. Those lines give a plain
  error, exit 1, which names what was refused. Otherwise CI would pass code nobody measured.
- **`--dry-run` exits 8 too (review L1).** The premise above, "it refuses nothing", was wrong: a dry run builds the same
  mutation set with the lines.
- **With `--operator` or `--exclude-operator`, an earlier check can still exit 1** on a pull request with no site (review L2).
  This is documented, not moved.
- **Azure (review H1, H2).** The task is `PublishMutationReport@2`, not `@1`: the task's own task.json on its repository's master
  says Major 2. It runs only when the HTML page was written, because on exit 8 there is no report and the task would fail with
  "No reports found".
- **The `--json` part of the stderr/envelope claim:** `lethal run` does not take `--json`. The envelope code
  `NO_MUTABLE_LINES` is set on the error and tested through `cliError`, for any caller that renders an envelope.
