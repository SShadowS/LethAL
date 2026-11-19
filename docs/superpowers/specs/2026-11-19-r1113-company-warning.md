# R1113: warn before a BC run about tests that create or delete companies; reword PR-197's HTTP line — spec-light, for the orchestrator's decision

lethal-preproc, 2026-11-19 (coord PR-200's follow-up). No code yet.
- **Evidence:** R1113's "The probe, measured" section.
  - bc4: a test that commits a company creation (T3) drew an unprompted HTTP 400 and then 401 on every web-service call with
    LethAL's login (`/coord/handoff/PR-200/bc4/result.md`).
  - bc1-bc3: `Company.Insert` fails at once, because SQL lacks Full-Text Search.
  - DO's three hung tests reach no HttpClient send through explicit calls.

## 1. Measured on DO before writing (test tree `/coord/handoff/PR-67/do-test-new`, names only)
- **The test-app objects that write the Company table** (a `Record Company` variable with `.Insert(`, `.Delete(` or
  `.Rename(`):
  - `CDO Data Upgrade Tests`;
  - `CDO ABS Setup Tests`;
  - `CDO ABS Auth Settings Tests`;
  - the library `CDO Library - Setup` (`CreateOtherCompanyWithSetup`).
- **Test codeunits that write a company, directly or through that library: 4 of 113.**
  - The three above, plus `CDO Azure Blob Folder Tests`, through the library.
  - **All three codeunits whose tests hung DO baselines are among the four.**
  - PR-197's HTTP line names 113 of 113.

## 2. Proposal
1. **A new pre-run line, BC backends only** (bcdev and envtool; and `--dry-run` over the whole suite, as PR-197's is):
   - **Which codeunits:** the selected test codeunits that write the Company table (`Insert`, `Delete` or `Rename` on a
     `Record Company`, `Record 2000000006`) in their own object, or in a test-app codeunit they call. The call is one hop,
     through a codeunit variable or a bare call, read by parse in the test app only.
   - **Commit:** whether the writing procedure, or the test that reaches it, also calls `Commit()` is shown per codeunit.
     That is the shape that broke bc4.
   - **The text:** `company writes: N of M selected test codeunit(s) create, delete or rename a company (directly or through
     <library>). On BC 29 a test that commits a company creation made the server refuse every later web-service call (R1113);
     where SQL has no Full-Text Search (bc1-bc3), Company.Insert fails at once. Leave them out with --exclude-test, or run
     on a server you can restart.` Then the names, each with the path (`via CDO Library - Setup.CreateOtherCompanyWithSetup`)
     and `commits` where it does.
   - **A warning only.** It never refuses and never touches a verdict. It travels on `tests-discovered` beside
     `httpPolicy`, as `companyWrites`.
2. **Reword PR-197's HTTP line:** drop "(R1113)" from "a slow or unreachable host can stall the baseline (R1113)".
   - R1113's hangs are no longer attributed to HTTP. The line's fact stands on its own: PR-176 measured that a test with no
     blocking policy really calls out on BC.
   - The new text: "a slow or unreachable host can stall the baseline".
3. **R1134 stays held** (done in the roadmap). The HTTP ranking would name the Azure codeunits for the wrong reason.
4. **Not proposed:** refusing company-writing tests by default.
   - The evidence is one probe step on one server: a quarantine and a 401, not a reproduced DO hang.
   - T4 (DO's exact shape) and the repetitions are still pending bc4's restart. A refusal would also drop real tests on
     servers where company creation works.
   - **Revisit after T4.** If T4 hangs or breaks the tier as T3 did, a default `--exclude-test` for such tests on BC 29, with
     a flag to keep them, is the next step.

## 2a. Amendment 1 (2026-11-19, after T4): option (3), with a recommendation. FOR THE ORCHESTRATOR'S RULING.
- **The new evidence** (R1113, master bdb328d5): T4, DO's exact shape, broke bc4 like T3 did, on its first run.
  - The baseline test passed. The 400 came at a kill confirmation in the mutant phase, after the committing test had run
    repeatedly, and then every web-service call was 401.
  - PR-199 showed that outbound HTTP fails fast on bc4, so HTTP cannot have hung DO there.
  - **Company writes in tests are the measured cause on BC 29.**
- **The unit is the METHOD, not the codeunit.** Excluding the 4 codeunits would drop every test in them.
  - By a text reader over DO's test app (`/coord/handoff/PR-200/company-methods.ts`, `.tsv`; names only), **16 test methods
    write a company, directly or through `CreateOtherCompanyWithSetup`:** Folder 12, ABS Auth 2, ABS Setup 1, Data Upgrade 1.
    That is out of about 1,979 tests.
  - **All three hung tests are among the 16.**
- **The rule must be "writes a company", not "writes and commits":** only 2 of the 16 commit visibly, and two of the three
  hung tests (the Folder and Upgrade ones) do not. T4 also broke only after repeated runs in one tier. A commit-only rule
  would have missed two of the three.
- **Recommendation: (3a).** On BC backends (bcdev, envtool), a default run LEAVES OUT every selected test method that writes
  the Company table, directly or one hop through a test-app procedure.
  - Left out by name, recorded in `excludedTests` with the reason `company-write` (the same path as `--exclude-test`: R745's
    records, the baseline narrowed and said so).
  - **The opt-in:** `--keep-company-tests`, for a server the user can restart.
  - **The line:** the warning of §2 item 1 becomes the notice of what was left out and why, with the opt-in named.
  - **The cost on DO:** 16 of about 1,979 tests; mutants covered only by those tests lose those killers. The report says so,
    as for `--exclude-test`.
  - **All BC versions, not only 29:** LethAL cannot rely on knowing the server's version before the run. Where `Company.Insert`
    fails at once (bc1-bc3), leaving the tests out loses nothing: they would fail anyway.
  - al-runner v3 is unaffected: it opens no BC tier.
- **The alternative (3b): warn only** (§2 as ruled), and leave the exclusion to the user. It loses no test by default. But a
  user who misses the line loses a whole server (two restarts measured) and the run, which is R1113's original harm.
- **The detection in the build is the parser's**, not this text reader. The pre-committed DO figure is 16 methods, the three
  hung ones included; any difference is explained before it lands.

## 3. Tests, if built (red-checked both ways)
- **Detection, on parsed AL:**
  - a direct write;
  - a write through a library codeunit one hop away;
  - `Commit` shown;
  - a `Record Company` that is only read (Get, FindSet) is NOT listed;
  - a write two hops away is not listed. That limit is said in the line's help text.
- **The line:** listed names and paths; nothing printed when none; BC backends only (an al-runner v3 run prints nothing).
- **PR-197's line** no longer cites R1113.

## 4. Pre-committed figure for DO (offline, a dry run over DO's suite)
4 of 113 codeunits listed: the three named in §1 plus `CDO Azure Blob Folder Tests` via `CDO Library - Setup`. Commit is
shown for those whose writing path commits, as the parse finds it.
