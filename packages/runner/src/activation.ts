export type FetchFn = typeof fetch;

export interface ActivationConfig {
  readonly baseUrl: string;
  readonly company: string;
  readonly username: string;
  readonly password: string;
  // Verified against a real BC server (2026-07-18): OData Basic-auth calls without a `tenant`
  // query param fail with a generic 401 "user could not be authenticated or authorized" even
  // for a valid username/password — including on this container, which only has one tenant
  // ("default"). Adding `?tenant=default` (or whatever the real tenant is) turns the same
  // request into a 200. bc-dev-mcp's dev-service connection doesn't need this (it defaults
  // to "default" internally for OnPrem — see resolveConnection in bc-dev-mcp), but raw OData
  // calls apparently do.
  readonly tenant?: string;
  // Observed directly against a real BC server (2026-07-18): the OData/web-service pipeline
  // can wedge and stop answering ANY request (even unrelated ones, like a plain entity read)
  // for an extended period, with no HTTP response ever arriving — `fetch()` has no default
  // timeout, so every BC client built from this config bounds its call with this many ms
  // (R506: the headers AND the body) rather than hanging the whole session forever.
  readonly timeoutMs?: number;
}
