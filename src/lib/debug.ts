/**
 * Debug utility for frontend logging.
 *
 * Provides a centralized way to log debug information in development.
 * All logging is disabled unless explicitly enabled via the DEBUG flag.
 */

type LogFn = (...args: unknown[]) => void;

interface DebugLogger {
  log: LogFn;
  group: (label: string) => void;
  groupEnd: () => void;
}

/**
 * Create a debug logger that only logs when the flag is enabled.
 * All logging is a no-op when disabled to avoid any runtime overhead.
 */
export function createDebugLogger(enabled: boolean): DebugLogger {
  if (!enabled) {
    const noop = () => {
      // Intentional no-op when debug logging is disabled
    };
    return {
      log: noop,
      group: noop,
      groupEnd: noop,
    };
  }

  return {
    log: (...args: unknown[]) => console.log(...args),
    group: (label: string) => console.group(label),
    groupEnd: () => console.groupEnd(),
  };
}
