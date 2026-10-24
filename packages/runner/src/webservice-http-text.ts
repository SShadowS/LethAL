/**
 * R713 — naming the web-service HTTP text where a baseline test failed with it.
 *
 * LethAL runs tests through BC's web-service path. For a blocked HTTP call that path writes
 * `BC_HTTP_INTERNAL_TEXT`; BC's test runner hub (VS Code, a user's CI) writes another text for the
 * same call (R706, R712). A test that asserts the hub text fails here and passes in the user's CI.
 *
 * This is a note only. It never decides a verdict: a test red at baseline is already dropped from
 * the green set by outcome, and nothing here changes that.
 */
import { BC_HTTP_INTERNAL_TEXT } from "./al-runner-v3-contract";

export const WEBSERVICE_HTTP_DIAGNOSIS = [
  `this test failed at baseline with the web-service HTTP error text ('${BC_HTTP_INTERNAL_TEXT}').`,
  "LethAL runs tests through the web-service path; VS Code, the test runner hub and your CI report",
  "'the connecting endpoint violates security requirements' for the same call (R706, R712).",
  "A test that asserts the second text fails here and passes in your CI.",
  "It is dropped from the green set, so mutants it would kill may read survived or unscored.",
  "No verdict was changed (R713).",
].join(" ");

/**
 * The diagnosis when `failureText` holds the web-service HTTP text, else `undefined`.
 *
 * A substring match, not equality: an Assert failure wraps the text, and `failureMessage` carries a
 * call stack after the first line.
 */
export function describeWebServiceHttpText(failureText: string | undefined): string | undefined {
  if (failureText === undefined) return undefined;
  return failureText.includes(BC_HTTP_INTERNAL_TEXT) ? WEBSERVICE_HTTP_DIAGNOSIS : undefined;
}
