import { useLayoutEffect } from 'react';

/**
 * Calls `onCommit` after every commit, before passive effects run. Render it
 * after the component under test to observe what each commit showed, so a
 * value that an effect corrects one commit later is still caught.
 */
export function CommitProbe({ onCommit }: { onCommit: () => void }) {
  useLayoutEffect(() => {
    onCommit();
  });
  return null;
}
