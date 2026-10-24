/**
 * R727: a run asks `dependentCount` once for the TARGET app, before the first publish, besides the
 * closed-world guard's asks for the TESTS app. Tests that count or script the guard's asks wrap
 * their fake in this, so the target's ask answers 0 and is neither counted nor scripted.
 */
export const ignoreTargetAsk =
  (targetId: string, fn: (appId: string) => Promise<number>) =>
  (appId: string): Promise<number> =>
    appId === targetId ? Promise.resolve(0) : fn(appId);
