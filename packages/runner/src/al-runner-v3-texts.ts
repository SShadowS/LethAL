/**
 * Leaf module (no imports), so `al-runner-v3-pins.ts` can read the hub text at load time without
 * joining the contract <-> backend import cycle (R719).
 *
 * R705 (owner ruling 2026-10-24): the oracle for HTTP-in-test behaviour is BC's TEST RUNNER HUB path
 * (VS Code, `bcdev_test_run`), not the web-service path. R706 measured the hub on bc1: this text, code
 * `HttpRequest:Security`. `refusal-row-shape` reads `gone` on exactly this text.
 */
export const BC_HTTP_HUB_TEXT =
  "There was an error while executing the HTTP request, the connecting endpoint violates security requirements. Make sure you are connecting to a valid endpoint.";
