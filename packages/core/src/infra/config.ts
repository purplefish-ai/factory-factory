/** Service timing/limit constants needed by core domain services */
export interface CoreServiceConfig {
  /** Ratchet polling interval in ms (default: 60000) */
  ratchetIntervalMs: number;
  /** Max concurrent ratchet checks (default: 3) */
  ratchetConcurrency: number;
  /** Max fixer sessions per workspace (default: 5) */
  maxFixerSessions: number;
  /** CI notification cooldown in ms (default: 300000) */
  ciNotificationCooldownMs: number;
  /** Session idle timeout in ms */
  sessionIdleTimeoutMs: number;
}
