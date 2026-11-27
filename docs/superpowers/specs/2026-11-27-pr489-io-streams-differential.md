# PR-489: I/O as a generated BC differential (streams, encodings, Blob, Base64, XMLport) — pre-commitment r1

lethal-code, 2026-11-27. Written before code. Method: PR-487's and PR-488's (`scripts/refusal-family.ts`).

## Checked first, so nothing is filed twice
- **R1010** (untouched handles), **R995** and **R1088**.
- **Open upstream issues** these cells could meet: #8091 (UTF-16 JSON through a UTF-8 stream), #7996 (Base64
  InsertLineBreaks), #7760 (uncreated streams), #8257, #8088, #8358 and #8952 (XMLport import/export), #8448.
- A cell that lands in one of these is recorded as "known", never re-filed.
- Cells for uncreated streams are left out (R1010 covers them).

## Family `io-streams`
- **Where:** appended after `numbers-text` (BC-check number 31).
- **Dependency:** System Application (Temp Blob, Base64 Convert), as ZIP_BLOB has.
- **Support objects:**
  - a Blob table;
  - an item table, and an XMLport over it in Xml and in VariableText;
  - a helper that reads a stream to the end (lines joined by `|`) and that lists a stream's first bytes as numbers.
- **Writes:** every cell writes its own key range, never DeleteAll; XMLport exports filter to that range.
- **Groups:**
  - **WriteText/ReadText:** line breaks; the length argument; `Write` vs `WriteText`; binary `Write`/`Read` of an
    Integer; what ReadText returns.
  - **TextEncoding:** UTF8, UTF16, Windows and MSDos: the Blob's length and its first bytes for ASCII and for `æ`, so
    the byte-order mark shows; reading back with the same encoding and with another one.
    - Windows and MSDos with a non-ASCII letter depend on the OS code page, so those cells are
      `depends: "locale"` (Linux BC, not filed unless Windows BC agrees).
  - **EOS:** a new Blob; after the last line; between lines; ReadText at EOS.
  - **Blob fields:** Length and HasValue without and with CalcFields after a Get; Clear; Modify of a Blob.
  - **CopyStream:** whole; with a byte count; from an empty stream; between two Temp Blobs.
  - **Temp Blob:** length, HasValue, round trip.
  - **Base64 Convert:** ToBase64 and FromBase64 of ASCII and of `æ` (UTF8); invalid Base64; ToBase64 of a stream.
  - **XMLport:**
    - Export over an OutStream (Xml and VariableText) of two rows; the XML declaration's encoding;
    - Import of two rows from an InStream; import of malformed XML (the error).

## Runs, compare, filing
- al-runner `current`, then a leased bc1-bc3, cleaned up after; doctor before and after; released only when healthy.
- `--join` per cell.
- One upstream issue per NEW class where al-runner differs. Locale/code-page cells and text-only differences no AL
  test can observe are not filed.
- An R item records the tally.

## Tests
- Place and id; the cell count; distinct names.
- Every key range distinct; no real-table DeleteAll.
- Exactly the code-page cells are locale.
- The pinned app hash.
- A red check for each guard.
