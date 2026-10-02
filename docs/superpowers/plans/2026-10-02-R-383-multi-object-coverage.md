# R-383: admit multi-object files to al-runner coverage (short plan, r3)

r3 changes only the server procedure rule (Design 3) and its tests (Task 1), for review r2's
finding 7 (`H:/lethal-coord/reviews/R-383-plan/reject-r2.md`). Build note, 2026-10-02: the
orchestrator measured that the source build `v2.12.0-main.c39ad5de` passes `status()` and
`itest:alrunner` as it stands, so Task 0's re-probe on it goes ahead (no change to the version
check).

Roadmap: `docs/roadmap/R383.md`, section "Measured 2026-10-02".
- **Measured** on al-runner v2.12.0: upstream #3713 is gone on both the one-shot and the `--server`
  transports.
- **Not yet measured** on the upstream-main source build (`H:/al-runner-builds/c39ad5de`, which
  reports `v2.12.0-main.c39ad5de`).
- **Guard unchanged by this plan's commit.**

r2 answers review r1 (`H:/lethal-coord/reviews/R-383-plan/review-r1.md`, findings 1 to 5, as
ruled in `reject-r1.md`).

## What is true today (read)

- **The refusal is in two places:**
  - `alRunnerCoverageSupport` (`al-runner-coverage.ts:176`), called by the CLI guard
    (`cli.ts:2229-2230`) and by `itest:alrunner` (`al-runner.itest.ts:232-236`);
  - the index skip (`al-runner-coverage.ts:218-223`).
- **One object per file is assumed** by:
  - `byFile` and `objectForFile` (`:123`, `:276-288`);
  - the raw file-relative line passed to `lineMap.lookup` (Cobertura path, `:314`);
  - the raw line passed to `renamedMemberAt` (server path, `:369`). The server path also takes
    `scope`, a procedure NAME, as the procedure (`:348-385`).
- **`line-map.ts` stores spans object-relative** (`spansOf`, `:346-357`), using
  `baseLine = previousEndLine + 1` from `fileLineMapEntries` (`:558-591`).
- **BUG (review 1):** `fileLineMapEntries` advances `previousEndLine` only for objects with a
  coverage identity (`objectIdentityOf`, `:670-694`, skips enums, interfaces and permission sets).
  So a codeunit after an enum in the same file gets the WRONG base. This is latent today on bcdev,
  which uses the same entries for BC's object-relative lines.
- **bcdev passes BC's own object-relative lines** (`bcdev-backend.ts:1090`).
- **The `#if`-wrapped refusal (R298, pending R300) stays,** in the CLI guard and in the index skip.
  So does the existing refusal for an object after an object-holding `#if` wrapper
  (`line-map.ts:558-591`).
- **No frozen gate figure can move:** every al-runner leg uses single-object fixtures. Admitting a
  multi-object file mainly moves its UNREACHED mutants from `survived` to `no-coverage`
  (`selection.ts:431-570`).

## Design

1. **Partition on EVERY top-level object** (review 1).
   - `fileLineMapEntries` advances `previousEndLine` past every top-level declaration, indexed or
     not: enums, interfaces, permission sets, extensions and anything else.
   - It emits entries only for the indexed ones, as today.
   - This fixes the latent bcdev base for files where an unindexed object comes first.
   - The object-after-`#if`-wrapper refusal is kept unchanged.
2. **One transport-independent resolver** in `line-map.ts`:
   `resolveFileLine(entries, fileLine) -> { objectType, objectId, objectLine } | undefined`.
   - It SELECTS the object whose declaration-node FILE span contains `fileLine`.
   - It CONVERTS with the same `baseLine` that `spansOf` used: `objectLine = fileLine - baseLine + 1`.
   - It returns `undefined` for a line in a gap between objects, in an unindexed object, or in a
     refused object. A gap therefore yields NO coverage entry.
   - Keys are always the file path plus `(objectType, objectId)`, never a procedure name and never a
     bare id.
3. **Both transports resolve by POSITION.**
   - **Cobertura:** each `<line>` is resolved through `resolveFileLine`, then the procedure comes
     from `lookup(type, id, objectLine)`.
   - **Server (r3, review finding 7).** The OBJECT always comes from position: the statement's
     `line` goes through `resolveFileLine`, never through `scope`. So two same-named procedures in
     two objects of one file cannot be confused. The PROCEDURE is then chosen in this order, and no
     statement with hits is ever dropped by it:
     1. **Renamed `#if` arms first:**
        `renamed = renamedMemberAt(type, id, objectLine, scope)`. If it is defined, it is the
        procedure. This is R318's existing rule, now given the resolved object and object line
        instead of the raw file line. It runs BEFORE any comparison, so a compiled-arm `scope` that
        differs from the span's name is never treated as a disagreement.
     2. **Lines `lookup` leaves unnamed on purpose** (triggers, and any other line where
        `lookup(type, id, objectLine)` is `undefined`): the entry is emitted exactly as today's
        single-object path does, with `procedure: scope` and the object. They are NEVER compared and
        never dropped, so trigger coverage keeps its object-level evidence.
     3. **A line two declarations share** (two `#if` arms of one member, R318's `r10`): `scope` is
        kept as today, because that may be the other member's statement. This is decided by the
        same shared-line test `renamedMemberAt` already uses, never by comparing names.
     4. **Otherwise** `named = lookup(type, id, objectLine)`. If `scope` matches it
        (case-insensitive), `named` is used. If it differs, POSITION WINS: `named` is the procedure,
        and one warning names the file, line, `scope` and `named`. The statement is kept, not
        dropped.

     In a single-object file, steps 1 to 3 give today's output exactly, and step 4 can differ only
     where `scope` and the span disagree. The tests below pin that this does
     not happen on the existing fixtures' shapes.
   - The transport supplies only a file and a file-relative line, so moving to another build changes
     nothing here if that build keeps the frame. Task 0 checks it.
4. **Guard change:** drop only the multi-object half, in `supported`, the CLI fallback and the
   index skip. `multiObjectFiles` stays as a reported list. The guard warning and R-387's advisory
   wording change to match.

## Tasks

0. **The build question** (review 5). The gates keep running on the global tool, v2.12.0, which
   `status()` accepts. The source build is NOT admitted by loosening the version check.
   - If `status()` accepts `v2.12.0-main.c39ad5de` as it stands (the orchestrator is measuring it),
     the probe from `R383.md` (S1 to S4, both transports) is re-run on it too, and every result names
     its build.
   - If `status()` refuses it, a pinned source build would need its own exact-string admission. That
     is out of scope here, and R-383's results stay v2.12.0-only.
   - Either way: if the frame or the result differs between builds, stop and report.
1. **Offline, TDD, every test red-checked.**
   - **Partition:**
     - an enum, an interface and a permission set each before a codeunit in one file: the
       codeunit's base is right;
     - a namespace or `using` header before the first object: base 1;
     - the object-after-`#if` refusal is still pinned.
   - **The resolver:**
     - two objects and three objects in one file;
     - a comment or blank gap between objects: `undefined`, and no coverage entry;
     - a second object's HEADER line (`codeunit 50101 X`, `{`, `var`) never resolves to a member of
       the first object, and never yields member evidence;
     - CRLF and BOM files (the parser's rows drive the spans): same answers as LF without a BOM.
   - **Both transport conversions, each fed the same multi-object source:**
     - **Cobertura:** a trimmed copy of the probe's `s1.xml`, plus synthetic ones built from it for
       CRLF, BOM and table/page extensions.
     - **Server:** a trimmed `server-two.json`, plus synthetic payloads for the same cases.
     - **Same name, two objects:** two procedures both named `Run` in two objects of ONE file. Their
       positions give different object ids and different covering sets.
     - **Same name, two files:** the same procedure name in two files.
     - **Same id, two kinds:** a codeunit and a table both numbered 50100. They give different keys.
     - **A disagreeing `scope`:** kept, with POSITION's procedure and the warning.
   - **Server path, r3** (review finding 7). Each case runs in a SINGLE-object file and in a
     MULTI-object file (the shape in the second object), and each is red-checked against an
     unconditional "drop when `scope` differs from `lookup`" comparison, which must turn it red:
     - **Trigger lines:** an `OnRun` or table-trigger statement with hits, where `lookup` is
       `undefined`. It is kept, with the object and `procedure: scope`, exactly as today's output.
     - **A renamed `#if` arm:** R318's `r3` and `r4` shapes, where the server names the compiled arm
       and the span carries another name. `renamedMemberAt` re-keys it before any comparison, so it
       is kept under the member's coverage name.
     - **A line two declarations share** (R318's `r10`, `OtherOnly`): it keeps `scope`, as today.
     - **A regression pin:** the existing single-object server tests pass unchanged.
   - **Guard:** multi-object files are admitted, and wrapped files are still refused, in both the CLI
     and the index.
   - **The existing refusal tests** change from "refused" to "admitted and mapped". Every
     wrapped-file assertion stays.
   - **Two independent red-checks** (review 2):
     - put the multi-object refusal back: the admission tests go red;
     - make the conversion off by one (`fileLine - baseLine` or `+ 2`): the exact `objectLine` and
       boundary tests go red.
2. **A pre-committed live check** (reviews 2 and 5).
   - **The fixture pair:** `fixtures/sandbox-multiobject` plus `-tests`.
     - One file holds codeunit A, then codeunit B.
     - B has two ADJACENT procedures, `Reached` and `Unreached`. `Reached`'s first statement sits on
       the line right after `Unreached`'s `end;`, or the other way round. Either way, a base one line
       off moves a covered statement into the wrong procedure.
     - A's procedures are unreached.
     - One single-object file is a control.
     - The tests reach only `B.Reached`, and the control.
   - **Predict first.** The per-mutant table (verdict, killing test, and the covering-test set per
     mutant) is predicted from the fixture source. It is committed as
     `docs/superpowers/specs/2026-10-02-r383-multiobject-precommitment.md` BEFORE any live run:
     - A's and `B.Unreached`'s mutants are `no-coverage`;
     - `B.Reached`'s are killed or survived, as its test decides;
     - the control is as its test decides.
   - **Then challenge it.** `bun run compile:fixtures`, then publish the pair on Cronus28 under a
     lease, then run bcdev, the authority, once. A bcdev difference from the prediction is REPORTED
     as a finding, not edited into the table.
   - **Then compare al-runner.** A new `itest:alrunner` leg runs one-shot and `--server` on v2.12.0.
     Both must equal the PREDICTED table per mutant, covering tests included, and must equal each
     other. Any disagreement goes to you, unedited.
   - **The baseline** is recorded once under R332, with the receipt.
3. **Prose.**
   - In the build: the `al-runner-coverage.ts` header and comments at `:147-148` and `:338-342`;
     `al-runner-backend.ts:286-288` and `:649-653`; `README.md:694-697`;
     `docs/using-lethal-from-an-agent.md:103-106`; `docs/directions-emea-2026-runbook.md:233-236`;
     `fixtures/README.md:1468-1469`; `R220.md` (110-117, 132-137); `R255.md` (16-17); R394.
   - `CLAUDE.md:41` goes to you as text (below).
4. **`authoritative` stays `false`.** Its other reasons stand (`al-runner-backend.ts:636-698`). Only
   the coverage reason is removed from its comment.

## CLAUDE.md:41, for the owner (unchanged from r1)

- **Cause, false on v2.12.0:** "because al-runner loses every object after the first in one
  (upstream #3713)".
- **Behaviour, true until this lands:** "a file declaring more than one object disables it for the
  whole run".
- **Suggested wording once this lands:** coverage is conditional because a `#if`-wrapped file
  disables it (R298, pending R300); #3713 is fixed upstream (measured on v2.12.0).

## Out of scope

- The R298 and R300 `#if` refusal.
- R394, turning coverage on by default.
- The `authoritative` flag.
- Admitting a pinned source build.
