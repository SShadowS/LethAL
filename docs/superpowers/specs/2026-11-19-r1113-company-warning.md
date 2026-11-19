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
