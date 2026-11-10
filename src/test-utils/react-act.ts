import { act } from 'react';
import { flushSync } from 'react-dom';

/** Keep explicit synchronous commits inside React's test update boundary. */
export function actFlushSync(callback: () => void): void {
  act(() => flushSync(callback));
}

/**
 * Runs `rounds` zero-delay timer turns inside act, so React Query and React
 * settle. React Query delivers cache changes to observers on its own
 * `setTimeout(0)`, which async act alone (microtasks and one `setImmediate`)
 * does not wait for; a turn queued after that timer lets it through.
 */
export async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * Retries `check` after each zero-delay turn, up to 20, instead of polling
 * wall-clock time. Use it for state rendered from the React Query cache when the
 * cache changes after an async chain (for example a mutation's callbacks): its
 * notification timer is then queued after any timer the test starts alongside.
 */
export async function waitForCheck(check: () => void) {
  for (let round = 1; ; round++) {
    await settle(1);
    try {
      check();
      return;
    } catch (error) {
      if (round >= 20) {
        throw error;
      }
    }
  }
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
