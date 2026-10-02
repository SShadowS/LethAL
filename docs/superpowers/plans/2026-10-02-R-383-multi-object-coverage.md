# R-383: admit multi-object files to al-runner coverage (short plan)

Roadmap: `docs/roadmap/R383.md`, section "Measured 2026-10-02".
- **Measured** on al-runner v2.12.0: upstream #3713 is gone on both the one-shot and the `--server`
  transports.
- **Not yet measured** on the upstream-main source build (`H:/al-runner-builds/c39ad5de`). Task 0
  re-runs the probe there before anything is built.
- **Guard unchanged by this plan's commit:** nothing is built until this plan is approved.

## What is true today (read)

- **The refusal is in two places:**
  - `alRunnerCoverageSupport` (`al-runner-coverage.ts:176`), called by the CLI guard
    (`cli.ts:2229-2230`) and by `itest:alrunner` (`al-runner.itest.ts:232-236`);
  - the index skip in `buildAlRunnerCoverageIndex` (`al-runner-coverage.ts:218-223`).
- **One object per file is assumed** by:
  - `byFile` and `objectForFile` (`:123`, `:276-288`);
  - the raw file-relative line passed to `lineMap.lookup` (Cobertura path, `:314`);
  - the raw line passed to `lineMap.renamedMemberAt` (server path, `:369`).
- **Why that works today:** `line-map.ts` stores procedure spans OBJECT-relative
  (`spansOf`, `:346-357`, using `baseLine = previousEndLine + 1` from `fileLineMapEntries`,
  `:558-591`). For a single-object file the base line is 1, so file-relative and object-relative
  coincide. That is the only reason passing the raw line works.
- **bcdev already handles multi-object files,** because BC itself reports object-relative lines
  (`bcdev-backend.ts:1090`).
- **The `#if`-wrapped-file refusal is a separate question** (R298, pending R300). It is NOT touched.
- **No frozen gate figure can move.** Every al-runner leg uses single-object fixtures with no
  root-level `#if`. The only multi-object fixture file is `sandbox-coverage-probe`, which has no
  test app and no gate.

## Design (one mapping, transport-independent)

1. **One resolver.** A new pure function in `line-map.ts`, beside `fileLineMapEntries`:
   `resolveFileLine(entries, fileLine) -> { objectType, objectId, objectLine } | undefined`.
   - It picks the object whose FILE span (its declaration node's start and end rows) contains
     `fileLine`.
   - It returns `objectLine = fileLine - baseLine + 1`, using the SAME `baseLine` that `spansOf`
     used to store that object's spans.
   - Because it uses the identical base on both sides, the conversion is self-consistent whatever
     BC's own rule is. It does not depend on R58's BC measurements being right for al-runner.
   - A line outside every counted object, or inside an object the index refuses, returns
     `undefined`.
2. **Both transports call it.** `byFile` keeps the file's whole entry list instead of one object.
   The Cobertura path (`:314`) and the server path (`:369`) both resolve `(object, objectLine)`
   through the resolver before `lookup` and `renamedMemberAt`. The transport only supplies a file
   and a file-relative line, which both report today, so a move to another al-runner build changes
   nothing here if that build keeps the frame. Task 0 checks that.
3. **Partition by every top-level object.** The base line must count every top-level declaration,
   including the kinds `objectIdentityOf` does not count (enum, interface, permissionset). Otherwise
   a codeunit after an enum in the same file gets the wrong base. Task 1 checks what
   `fileLineMapEntries` does today, and pins it by test either way.
4. **Drop only the multi-object half of the guard,** in both places:
   - `supported` no longer depends on `multiObjectFiles`;
   - the CLI guard falls back on `#if`-wrapped files only;
   - `multiObjectFiles` is kept as a reported list, not a refusal.
   The guard's warning text and R-387's advisory change to match.

## Tasks

0. **Re-probe on the upstream-main build** (needs al-runner; ask for the go). Run the same S1 to S4
   shapes on `c39ad5de`, plus the R-387 `--server` path. Record the build in every line. If the
   frame or the result differs from v2.12.0, stop and report.
1. **Offline, TDD, every test red-checked:**
   - the resolver: two objects, three objects, an enum between two codeunits, a line in the gap
     between objects, a line in a refused object;
   - both transport paths: a multi-object Cobertura fixture and a server payload taken from the
     probe's own outputs (`s1.xml`, `server-two.json`, trimmed into test fixtures), each naming B's
     procedure for B's lines and A's for A's;
   - the guard: multi-object is admitted, wrapped is still refused;
   - the existing refusal tests change from "refused" to "admitted, and mapped to the right object".
     Every assertion that a wrapped file is refused stays.
2. **A pre-committed live check.**
   - Add a fixture pair, `fixtures/sandbox-multiobject` plus `-tests`: one file holding two
     codeunits, with a test that reaches only the SECOND, plus one single-object file as a control.
   - Pre-commit its per-mutant table BEFORE any live run:
     - the first object's mutants are `no-coverage`;
     - the second's are killed or survived, as their test decides;
     - the control is as its test decides.
   - Derive the table from `itest:bcdev`-style authority: run it once on Cronus28 under a lease,
     where bcdev's object-relative coverage is the reference. Then add an `itest:alrunner` leg for
     the pair on the one-shot and `--server` transports. Both must equal the pre-committed table per
     mutant, killing test included.
   - This is the only gate that would see a wrong base line. Every other leg is single-object.
3. **Prose** (in the same branch, except `CLAUDE.md`):
   - the `al-runner-coverage.ts` header and comments at `:147-148` and `:338-342`;
   - `al-runner-backend.ts:286-288` and `:649-653`;
   - `README.md:694-697`;
   - `docs/using-lethal-from-an-agent.md:103-106`;
   - `docs/directions-emea-2026-runbook.md:233-236`;
   - `fixtures/README.md:1468-1469`;
   - `R220.md` (110-117, 132-137) and `R255.md` (16-17);
   - R394's wording.
4. **`authoritative` stays `false`.** Its other reasons still stand: `Codeunit.Run` transaction
   scope, `--isolation codeunit`, and permissions or company context
   (`al-runner-backend.ts:636-698`). The coverage reason is removed from its comment.

## Prose that is false now (for the orchestrator; I do not edit CLAUDE.md)

- **`CLAUDE.md:41`:** "What keeps the flag false is that coverage is CONDITIONAL — a file declaring
  more than one object disables it for the whole run, because al-runner loses every object after
  the first in one (upstream #3713) — and a capability flag that depends on the project's file
  layout is not a capability."
  - **On v2.12.0 the cause is gone:** al-runner no longer loses those objects.
  - **The behaviour still holds until this plan lands:** LethAL's guard still disables coverage, so
    the "disables it for the whole run" half stays true.
  - **What stays conditional:** the `#if`-wrapped-file refusal (R298), so the "depends on file
    layout" argument still holds through that.
  - **Suggested wording, once the plan lands:** coverage is conditional because a `#if`-wrapped
    file disables it (R298, pending R300); #3713 is fixed upstream and no longer applies.
- **The other false passages** are listed in Task 3 and fixed in the build.

## Out of scope

- The `#if`-wrapped refusal (R298 and R300).
- Turning coverage on by default (R394, which this plan unblocks only in part).
- The `authoritative` flag.
