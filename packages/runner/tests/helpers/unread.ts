/**
 * R630: what a fake `fetchPublishedAppPackage` returns for a server that was ASKED and gave no
 * package. `UNREAD` is the plain stand-in; the two named ones are the causes the consumer tests
 * check each message names (bcdev's own texts for a 500 and a 404).
 */
export const UNREAD = { unread: "test: unread" } as const;
export const HTTP_500 = { unread: "HTTP 500 (a server error)" } as const;
export const HTTP_404 = {
  unread: "HTTP 404 (no such app on the server, or the dev-endpoint path is wrong)",
} as const;
/** The two causes every consumer test runs with. */
export const CAUSES = [HTTP_500, HTTP_404] as const;
