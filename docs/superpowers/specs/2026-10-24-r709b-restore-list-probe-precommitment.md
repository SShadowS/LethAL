# R-709b pre-commitment (2026-10-24): BC's list of extensions it removed after a refused upgrade

Committed before any server call. Probe: `scripts/r709-probe/` (lethal/r709b; README there), built offline. Server:
bc2 (BC 28.4 W1), under lethal-preproc's lease. **Do not rebuild after this commit**: every alc build gets a fresh
header id.

| build | app (id) | version | sha256 |
|---|---|---|---|
| T1 | R709 Probe Target (9ff560dd-bcde-4128-8f36-d9eaf8110c4c) | 1.0.0.1 | 3a20bc9f2b87882105574ca26b5ca7fa12a0d14bc01272c4658e5bcf04d88edb |
| T2 | same, `Answer` removed | 1.0.0.2 | f29878ee8b6a547fec15a58d1bc4535284f3da4fa79b52c1409936f1dc9c9167 |
| D1 | R709 Probe Dep One (6a564aa8-4536-4653-98d2-2a9d762df994), calls T.Answer | 1.0.0.1 | 9a00e10cd1b66054ce913549cd3ae4fd9118e7f1245b37147e1e910177d6155b |
| D2 | R709 Probe Dep Two (e1042b90-751b-4790-b064-1731c55bb830), calls T.Answer | 1.0.0.1 | ca48d2724b65729ac243cfa54dafb62aff8ae0f0d7267df2f531247b2e223b89 |
| U1 | R709 Probe Target Solo (4ccbac7b-5f98-4140-8575-8110a8ddac49) | 1.0.0.1 | 3bf4743985ebaa4f05e564ef22dcb1ab93926c183b6548c2d735abaaa6fd7f28 |
| U2 | same, `Answer` removed | 1.0.0.2 | 64f0d4e39cb8267d99bda4572b9faa526288c96cb1c781314758f2e3995ff00e |
| E | R709 Probe Dep Solo (d296a165-7cc2-482b-b43a-3836b2f160f8), calls U.Answer | 1.0.0.1 | 40135e5c3a8cc4a68004474cbe814d170b99711e6779e385dbbe52922a59fb50 |

All the app ids are fresh: no installed-version record exists for them on bc2. Object ids are 93730-93759. There are
no tables.

## Question
BC refuses an upgrade that breaks installed dependents and "could not restore" (R709). What exactly does its 422 body
say about the extensions it removed: the exact wording, which names and versions appear, in what format, and with what
separator between entries? This is measured for TWO dependents (T2 over D1 and D2) and for ONE dependent (U2 over E).
R-707 measured the head of this text but cut the body at 500 characters.

## Steps (`drive.ts --all`, run once)
1. Publish T1, D1, D2 and read them back.
2. Call D1 and D2 (expect 200, value 1).
3. Publish T2: save the FULL body to `body-3.txt` (sha256, length), read the rows of T, D1, D2, and call D1 and D2.
4. Publish U1, then E, and read them back; call E (200, 1).
5. Publish U2: save the FULL body to `body-5.txt`, read the rows of U and E, and call E.

Then cleanup: uninstall and unpublish every remaining row of T, D1, D2, U and E, read back absent, and print what
remained. No response body is truncated anywhere.

## Readings, decided now
- **Valid run:** steps 1, 2 and 4 are as expected (installed 1.0.0.1, calls give 1), and steps 3 and 5 are each a
  refusal whose body holds "could not be restored". Otherwise there is no result: fix the probe, record an addendum
  before any re-run, and read nothing.
- **Expected,** from R-707's step 4: T is left with one row, 1.0.0.1, not installed; D1 and D2 have no rows; their
  calls answer 404. The same for U and E. A different post-state is recorded as a finding in its own right.
- **The list:** the substring of `body-3.txt` after "These extensions should be manually reinstalled" (or wherever BC
  names the removed apps), and the same for `body-5.txt`, are recorded verbatim in the measure note. The parser is
  built on exactly that format:
  - each entry's name and version as BC writes them;
  - the separator, from step 3 (two entries);
  - the one-entry form, from step 5.
  If BC names NO removed app in either body, the parser is not built: R709 closes with BC's verbatim text as the
  message, and that is said.
- **Order unknown:** if the two entries in step 3 come in an order that cannot be predicted (not D1 then D2, or
  differing between reads), the parser must not depend on order. Its tests then assert sets.

## Leftovers
bc2 keeps installed-version records for T and U at 1.0.0.2 until a restart (R605). Nothing is installed after
cleanup. Earlier leftovers on bc2: R623 (3543fecd…, 1.0.0.6), R707 (e390149d…, about 1.0.0.2), R702 (b0a9bc3f…,
1.0.0.1).
