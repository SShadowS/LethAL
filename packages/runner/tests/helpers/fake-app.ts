/**
 * Builds a minimal, valid ZIP buffer containing a single stored (uncompressed)
 * `SymbolReference.json` entry — just enough for `app-package.ts`'s zip reader to parse,
 * standing in for a real compiled `.app` package in tests without needing a real `alc.exe`
 * compile. Store (method 0) is used deliberately so no deflate is needed and CRC-32 is left
 * as 0 throughout: `extractZipEntry` never validates either.
 */
export function buildFakeApp(symbolReference: unknown): Buffer {
  const name = Buffer.from("SymbolReference.json", "utf8");
  const data = Buffer.from(JSON.stringify(symbolReference), "utf8");

  const localHeader = Buffer.alloc(30 + name.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(0, 8); // compression method: stored
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(0, 14); // crc32 (unchecked by the reader)
  localHeader.writeUInt32LE(data.length, 18); // compressed size
  localHeader.writeUInt32LE(data.length, 22); // uncompressed size
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra length
  name.copy(localHeader, 30);

  const localSection = Buffer.concat([localHeader, data]);

  const centralHeader = Buffer.alloc(46 + name.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8); // flags
  centralHeader.writeUInt16LE(0, 10); // compression method: stored
  centralHeader.writeUInt16LE(0, 12); // mod time
  centralHeader.writeUInt16LE(0, 14); // mod date
  centralHeader.writeUInt32LE(0, 16); // crc32
  centralHeader.writeUInt32LE(data.length, 20); // compressed size
  centralHeader.writeUInt32LE(data.length, 24); // uncompressed size
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt16LE(0, 30); // extra length
  centralHeader.writeUInt16LE(0, 32); // comment length
  centralHeader.writeUInt16LE(0, 34); // disk number start
  centralHeader.writeUInt16LE(0, 36); // internal attributes
  centralHeader.writeUInt32LE(0, 38); // external attributes
  centralHeader.writeUInt32LE(0, 42); // relative offset of local header
  name.copy(centralHeader, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(1, 8); // total entries this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralHeader.length, 12); // size of central directory
  eocd.writeUInt32LE(localSection.length, 16); // offset of start of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localSection, centralHeader, eocd]);
}
