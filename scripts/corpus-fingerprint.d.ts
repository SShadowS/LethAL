#!/usr/bin/env bun
/** The `.al` files an instrument parses, project-relative with forward slashes, sorted. */
export declare function corpusEntries(corpusDir: string): Promise<string[]>;
export interface CorpusFingerprint {
    /** Number of `.al` files hashed, i.e. the number an instrument on this filter parses. */
    readonly files: number;
    /** SHA-256 over every file's relative path and bytes, in sorted path order. */
    readonly sha256: string;
}
/**
 * Deterministic and path-order-insensitive: the same tree at two paths gives the same hash, and a
 * one-byte change in any parsed file changes it. Paths are hashed as well as contents, so a file
 * moved without change is a different corpus, which is the right answer for an instrument that
 * reports per-file figures.
 */
export declare function fingerprintCorpus(corpusDir: string): Promise<CorpusFingerprint>;
/** The one-line form every corpus-taking instrument prints first. */
export declare function describeFingerprint(corpusDir: string, fp: CorpusFingerprint): string;
//# sourceMappingURL=corpus-fingerprint.d.ts.map