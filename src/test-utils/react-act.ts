import { act } from 'react';
import { flushSync } from 'react-dom';

/** Keep explicit synchronous commits inside React's test update boundary. */
export function actFlushSync(callback: () => void): void {
  act(() => flushSync(callback));
}

/** Poll after allowing timers and their React updates to settle within act. */
export async function waitForReact(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = performance.now() + 1000;
  while (true) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      await assertion();
      return;
    } catch (error) {
      if (performance.now() >= deadline) {
        throw error;
      }
    }
  }
}
