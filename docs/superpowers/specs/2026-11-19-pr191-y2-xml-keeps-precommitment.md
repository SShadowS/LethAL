# PR-191: y2's XML refusal texts on the serve keep-list (pre-commitment)

Status: r1 (0e295901), committed to master before the family, the census and any keep-list change; amendment 1 (§0), committed
before any keep-list change (coord PR-191, lethal-bugs, 2026-11-19).
Evidence: `/coord/handoff/PR-163/y2.run.events.ndjson` and `doy2.sqlite` (read-only), and `/coord/handoff/PR-191/`
(`families.md`, `attrib.txt`, `others.txt`, `do-state.md`, `census2/`). Roadmap: R1092.

## 0. Amendment 1 (the opus spec-adversary's review of r1, 2026-11-19: not safe as specified; the fixes need no redesign)
Order, stated plainly: the family was built and a first census (`census/`) ran in parallel with the review. That census used
the kit's reader only and is NOT evidence for any keep. The cells and readers below were then built from the review, and
`census2/` ran on them before this amendment was committed. No keep entry exists yet.
- **HIGH-1: the census reader could not see three state kinds** the deep cells model: a manual subscriber binding that
  outlives the request, the deep cell's SingleInstance codeunit, and XML state in the engine. **Fix, built:** a family may add
  `readers` to the kit's `Observe` (compared on the kept daemon, the control and fresh daemons). `y2-xml` has three: raise the
  event the deep cells' subscriber binds and report whether it ran; report the SingleInstance global; build, query and write a
  small XmlDocument and report the text. Sensitivity: inside one test the readers see a bound subscriber (`ev=1`) and a set
  SingleInstance value (`sv=left`); after a passing test that leaves either behind, the next test's readers see the control
  (v3 resets both per test, even inside one request). A family without readers is unchanged (unit-tested).
- **MED-1: M36794/M36795's shape was misread.** `CDO Xml Node List.ItemOf` takes the target wrapper **by var**; both mutants
  skip its setter, so the target wrapper's **global** XmlNode is never set, and a later wrapper procedure uses it. **Fix,
  built:** a cell with that shape (`UnassignedNodeByVar`). The by-value copy cell stays as a second refuser.
- **MED-2: the deep cells add DO's other deep state:** `Commit()` after the writes, and an OutStream write into a Blob field.
- **MED-3: one text, several builtins.** Two more cells: an unassigned XmlNode as the 2nd argument of a multi-content
  `XmlElement.Add` (it gives the **XML-content** text, not the unassigned-node one, and joins that class), and `WriteTo` on an
  unassigned XmlNode with an OutStream open (it **fails** with an engine error and does not refuse; the cell is dropped, since a
  plain failure never reaches the keep-list). Other builtins that can give these texts are not measured; P4 is what would catch
  them, and the entry comments say so (as PR-159 L4 did).
- **Cell findings:** a two-argument `SetAttribute` on an unassigned element FAILS in the cell (an engine error on the attribute
  collection) where DO's M36708 rows refused; the cell uses the three-argument form, which refuses. `AsXmlElement` on the
  by-value copy fails rather than refuses; `IsXmlText` refuses. P4 checks M36708's own rows on DO.
- **LOW-1: the XML-name slot departs from PR-159 L2** (values by name, no open pattern): DO's names hold random test data, so
  naming values cannot keep the next run. The slot is bounded (`{1,2000}`, the longest y2 name plus about 50%) and its ends and
  character classes are each measured. A longer DO name closes (the safe direction); P3 names such closes.
- **LOW-2:** a cascade row carries the XML name inside its brackets, and `SAFE_TAIL` refuses words such as `panic` or `timeout`
  in any case, which random base64 can contain. Such a close is the safe direction; P3 names it and does not count it as a miss.
- **LOW-3: what follows a P4 failure:** if a fresh daemon gives the y2 verdict and the kept daemon did not, that text's keep is
  withdrawn before the window is accepted.
- **LOW-4:** the v3 gate shows only that nothing else moved; it is not evidence for the keeps.
- **Count fix:** 13 of M36754's 16 "XML name" rows are XML-name refusals; 3 are cascade rows that quote it.
- **census2** (`keep-census.ts --family y2-xml --refusers 7`, edge-4ebfe7913, with the three readers): 18 refusing cells,
  12 classes, **all CLEAN**: unassigned XmlNode (3 refusers: by var, by value, after children), unassigned XmlElement (2), XML
  content (3: plain, second Add argument, deep), XmlAttributeCollection (1), and the eight XML names (`+`, `1abc`,
  `image/jpeg`, `application/pdf`, 16, 76 (plain and deep), 1,336 and 2,000 characters).

## 1. The measurement (y2, a fresh DO run on 196afaf7, edge-4ebfe7913)
- **The restarts:** 82 daemon closes, 59 after a refusal and 23 after a timeout. The 59 after-refusal warm-ups (each paired
  with the close before it on its lane) took 2,551.0 s of compile and 2,841.1 s of wall time (`families.ts`).
- **The XML family is the largest:** 30 of the 59 closes, 1,179.9 s of warm-up compile (1,306.3 s of wall).

| text (after `NotRun: out-of-scope: `) | closes | warm-up compile | mutants (y2 store) |
|---|---:|---:|---|
| `use of an unassigned XmlNode` | 12 | 475.4 s | M36741, M36794, M36795 |
| ``XML name `<name>` (only plain names without a prefix are pinned)`` | 6 | 259.8 s | M36754 |
| `XmlNode as XML content (only XML nodes and text are pinned)` | 6 | 226.1 s | M36703 |
| `use of an unassigned XmlElement` | 4 | 135.8 s | M36708, M36714 |
| `XmlAttributeCollection method on something else` | 2 | 82.8 s | M36716 |

- **Attribution** (`attrib.ts`, `test_results` of the store): all rows holding these texts belong to the 8 mutants above, all in
  DO's XML wrapper codeunits (`CDO Xml Node`, `CDO Xml Node List`, `CDO Xml Management`). Each mutant's other refused rows are
  the cascade text (`an earlier test of this codeunit was refused while it ran (...)`), which is kept today (`cascade`).
  So with these five texts kept, **every refused row of the 8 mutants is kept** (`others.txt`).
- **The XML names y2 met** (M36754, `swap-call-arguments` makes an inner text the element name): 0 to 1,336 characters, only
  letters, digits, `+`, `/` and `=` (base64 of a blob, a MIME type such as `image/jpeg`, `application/pdf`). The empty name is
  kept already (PR-56's `xml-name-empty`). The base64 names hold random test data, so naming each value cannot keep the next run.
- **DO's state at the refusals** (`do-state.md`; checked against the mutants' lines in DO):
  - the wrapper codeunits are not SingleInstance; each holds its XML object in a global, and callers hold the wrapper as a local;
  - no refusing statement is in a `[TryFunction]` or under `Codeunit.Run`; no refusing test has a TestPage or handler functions;
  - `ItemOf`/`SelectSingleNode` pass the target wrapper by value (a reference: the callee writes the caller's instance);
  - call depth 2 to 4 (68882, 68883, 68907, 68975: AutoRollback, real blob rows written, no Commit); 6 to 7 for 68859 and 69006
    (AutoCommit, setup rows and a posted document inserted, an OutStream written to a blob, 2 or 3 bound manual subscribers,
    and in 69006 a SingleInstance codeunit set before the call). The deep tests reach the XML-name and XML-content texts.

## 2. The change (built after this commit)
1. **A family `y2-xml`** in `scripts/refusal-family.ts`, invented AL, with a non-SingleInstance wrapper codeunit holding a global
   `XmlNode`, called through 2 to 4 procedures from the test, after the census kit's standard writes:
   - unassigned XmlNode: `IsXmlText` on a never-assigned local child (M36741's shape); and the same value copied into another
     wrapper instance passed by value, then used there (M36794/M36795's shape);
   - unassigned XmlElement: `SetAttribute` and `HasAttributes` on a never-assigned element (M36708, M36714);
   - XmlNode as XML content: `XmlDocument.Add` of a never-assigned XmlNode (M36703);
   - XmlAttributeCollection: `Get` on a never-assigned collection (M36716);
   - XML name: `XmlElement.Create` with a name the slot is to cover, one cell each: length 1 (`+`), a name that starts with a
     digit, `image/jpeg`, `application/pdf`, 16 characters ending in `=`, 76 with `+` and `=`, 1,336 and 2,000 of the base64
     alphabet;
   - **deep cells** for the two texts the deep tests reach (XML content, XML name 76): the same call at depth 6 with a bound
     manual subscriber and a SingleInstance codeunit set before it.
2. **The census:** `keep-census.ts --family y2-xml --refusers 7` on edge-4ebfe7913, under `heavy-slot.sh`.
3. **Keep only CLEAN classes:**
   - the four fixed texts exactly, each its own entry;
   - the XML name text with one slot `XMLNAME` = `[A-Za-z0-9+/=]{1,2000}`, only if every XML-name cell is CLEAN; if any is
     not, the slot shrinks to the CLEAN shapes, or the text is not kept, and PR-191 says which.
4. **Tests:** a pinned test per kept text; near misses: a reworded text, a text plus a tail, a name with a character outside the
   slot (`-`, a space, `.`), a name of 2,001 characters, a row that is not `notRun`.
5. **Red checks both ways:** each entry removed turns its test red; the slot opened (`[^`]*`) turns the near-miss test red; the
   length bound removed turns the 2,001 test red.

## 3. Predictions
- **P1:** every `y2-xml` cell refuses with its exact text, and every class is CLEAN with at least the plain and the deep refuser
  where both exist. A class that is not CLEAN is not kept, and PR-191 says which.
- **P2 (y2's own events and store):** the keeps cover 30 of y2's 59 refusal closes, 1,179.9 s of warm-up compile. Upper bound:
  a close event names one text, and a request in which another mutant's unkept text also refused still closes.
- **P3 (the next DO window on a head with this change):** 0 closes on a kept text; any close on an XML text not kept is named.
- **P4 (the next DO window, by full site key with y2):** the 8 mutants keep their y2 verdicts and refused-test sets; each kept
  text is seen at least once and followed by no close; every mutant scored on that lane after such a kept refusal, up to the
  lane's next close, keeps its y2 verdict. Any difference is re-run on a fresh daemon before the window is accepted.
- **The gates:** the al-runner-v3 gate on the final head shows that nothing else moved (no gate fixture produces these texts).

## 4. The next families (y2, by warm-up compile)
RunRequestPage parameters (6, 274.5 s; held since PR-133); SaveAs with a layout (5, 267.1 s; held since PR-133); ordering of
U+516C (4, 214.2 s); an error whose text is not pinned (3, 176.1 s); conversion of Code to Integer (2, 81.8 s); placeholder PDF
(2, 80.1 s); a list that lost its only row (2, 73.5 s); an earlier test did not pass (2, 70.5 s); three single closes (133.4 s).
