# Upstream repros (R-996)

Every invented repro LethAL filed upstream at aldevtools/BusinessCentral.AL.Runner, as one regression set. Each folder is one
AL app with test codeunits and no corpus source text. `manifest.json` names, per repro, its issue, where BC's result comes from
(`bcEvidence`: measured on BC, or inferred from the issue), what to re-run when it flips (`rerun`: projects, roadmap items) and
BC's result per test (`tests`).

`bun scripts/upstream-repros.ts --candidate <al-runner> [--current <al-runner>]` runs every repro on both builds and reports per
test: `flipped` (now matches BC: re-run what it names), `regressed` (matched BC on current, not now: a finding), `still-differs`,
`still-matches`, or `error` (the repro did not run). The daily update (`al-runner-v3-update.ts`, `gateOne`) runs it for every new
candidate and logs the report; it never decides the gate.

Adding a repro: a folder `u<issue>-<topic>` with `app.json` (its own app id) and `src/`, an entry in `manifest.json`, then
`bun scripts/upstream-repros.ts --candidate /work/tools/al-runner-v3/current/al-runner` to see it run. A repro must run with
`al-runner test --bc-version 28 <folder>` alone (no package cache), as these do. A repro of several apps (an install order) keeps
each app in a subfolder and lists them, in the order `al-runner test` takes them, in the entry's `apps` (R-997: `u8056-install-order`).
A repro that needs an al-runner flag names it in the entry's `args`, a list of strings put before its apps (PR-05: `u8028-no-client`).

## Coverage (PR-05, R1013)

Seven entries added while settling the refusal ledger, one per issue, biggest first: #7775, #8028, #7934, #7586, #7850, #8117
(new), and #7778 as a guard behind a fixed ledger state. The set now holds 89 tests. Not here, with the reason in R1013: #7415 (added since, PR-13) and
#8002 (not filed by LethAL), #8001 (needs an assembly folder from a BC service), #7837 (a pin request; BC's result unknown).

## Coverage (PR-13)

#7415 is now in, as `u7415-platform-no-provider` (5 tests; with PR-03's `u7994-u7995-evaluate`, 96 in all): LethAL commented on it with a sweep of every platform table
(`scripts/refusal-family.ts` family `platform-table-read`), and its refusal is the largest open group in the refusal ledger.

## Coverage (PR-16)

Two entries from family `permission-denial` (99 tests in all): `u7854-system-table-denial` (a system-table read under a set that
does not grant it, under `asserterror`) and `u8032-permission-rows` (a read of Permission under a set that grants it, refused
through Permissions Mock's own `table * = X` grant). Both depend on Microsoft's Permissions Mock, as `u8038-published-app` does.

## Coverage (PR-17)

`u8028-run-request-page` (100 tests in all), from family `no-client`: `Report.RunRequestPage` with a RequestPageHandler bound,
run with `--no-client` like `u8028-no-client`.

## Coverage (PR-26 to PR-28)

39 entries, 134 tests in all.
- `u7586-geturl-forms` (PR-26, family `get-url`): three GetUrl forms; BC's answer is measured.
- `u8013-*` (PR-28): one entry per cause of #8013, six in all: ReadFromYaml shapes, a Company Triggers subscriber's writes,
  Find('=<>') with no match, a file named by a Guid, a SQL counter stored in a field, and an XmlPort's Unbound text element.
  BC's answers are inferred.
- `u8152-number-sequence-next` (PR-28, from family `number-sequence`, #8002): BC keeps Next across a rollback and undoes Restart,
  Delete and Insert. Measured.
- `u8154-noclient-handlers` (PR-28): under `--no-client` the bound UI handlers are never called. BC calls them in a web-service
  session. Measured; run with `--no-client`.

## Coverage (PR-31)

144 tests in all (with `u7837-table-connection` and `u7924-dotnet-exception`, which landed alongside). PR-17's BC check (lethal-bugs, bc2, 2026-11-15, `/coord/handoff/PR-17/bc-check/runs/`, `ws-run/`) measured
the families' cells on BC:
- Now measured, expectation unchanged: `u7760-untouched-handle`, `u8036-dotnet-no-object`, `u7415-platform-no-provider`,
  `u7854-system-table-denial`, `u8032-permission-rows`; `u8028-no-client` partly (CurrentClientType answers; "never Windows" is
  still inferred).
- **Flipped expectation:** `u8028-run-request-page` now expects a FAIL. In a session without a client BC fails
  `Report.RunRequestPage`, handler or not ("The report request page cannot be used in background or server sessions.").
  PR-17's inferred pass holds only in a client session.
- New: `u8157-xml-asxmlnode` (#8157: `XmlElement.AsXmlNode()` on an untouched element passes on BC) and `u8158-session-read`
  (#8158: a Session read under Permissions Mock fails on BC in a web-service session; run with `--no-client`).

## Coverage (PR-57)

`u8181-tablemetadata-relation` (179 tests in all): a field whose `TableRelation` targets `Table Metadata` is refused when validated
("relation target `Table Metadata.ID` is not declared in the workspace"); a direct read of `Table Metadata` runs. It is the refusal
that stops every Base Application test on al-runner v3 today (System Initialization Impl.InitCompany at company open), so when it
flips, PR-57's step 2 (a BaseApp baseline) can run. BC's results are inferred, not measured on a server.

## Coverage (R-997)

In the set (13 repros, 44 tests, about 50 s for both builds): #7811, #7812, #7818, #7819, #7853, #7854, #7922, #8006, #8027,
#8032 (two apps), #8036 (its nine named tests), #8038, #8056. These are the issues the open roadmap items cite as their own finding.
BC's result is measured only for #8006's values; every other expectation is inferred from its issue, and `bcEvidence` says so.
#7853 is closed and passes now: it stays as a guard.

Not in the set yet: issues an open item cites as related, without a repro of their own here: #7832, #7834, #7924, #7934, #7964
(R995, R946; some of their cases are tests in `u8036-refusals` that the manifest does not compare). Not in the set on purpose:
`/coord/handoff/R-982/repro-tenantset` (no open issue) and `/coord/handoff/R-985/repro2` (#7760, which no open item cites).

`u7853-system-grant` borrows Microsoft's Guided Experience app id, name and publisher, because the System package grants its
internals to that identity. It is a local al-runner repro only: never publish it to a BC server.
