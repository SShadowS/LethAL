import { homedir } from "node:os";

/**
 * R409: the user's home directory, read at CALL time on every platform. Every product default
 * under the home (al-runner's caches, the quarantine dir, the env-tool state dir, the VS Code
 * extensions dir) goes through this, never `os.homedir()` directly (a unit test enforces it).
 *
 * Why: on Windows Bun's `os.homedir()` reads USERPROFILE at call time, but on Linux it keeps the
 * value HOME had when the process started (measured on Bun 1.4.2: set HOME in-process, homedir()
 * still prints the old one; Node prints the new one). The unit-test preload hides the real home by
 * setting HOME in-process (R264), so without this a Linux test run reads the real home.
 */
export function homeDir(): string {
  if (process.platform === "win32") return homedir();
  const home = process.env.HOME;
  return home !== undefined && home !== "" ? home : homedir();
}
