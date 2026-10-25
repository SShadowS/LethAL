/**
 * R727: a run used to ask `dependentCount` for the TARGET app before the first publish, besides the
 * closed-world guard's asks for the TESTS app. Since R733 the target's read is `installedDependents`
 * (another backend method), so no target ask reaches `dependentCount`. Tests that count or script
 * the guard's asks still wrap their fake in this: it answers 0 for the target id, so a regression
 * that sent the target ask back to `dependentCount` would be neither counted nor scripted.
 */
export const ignoreTargetAsk =
  (targetId: string, fn: (appId: string) => Promise<number>) =>
  (appId: string): Promise<number> =>
    appId === targetId ? Promise.resolve(0) : fn(appId);
