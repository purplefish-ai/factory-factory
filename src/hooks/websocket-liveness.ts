/**
 * Application-level liveness for one open WebSocket.
 *
 * A half-open connection (laptop sleep, a network change, a stopped server)
 * reads as open until TCP gives up, which can take minutes. The client sends
 * a ping every `LIVENESS_PING_INTERVAL_MS`; any inbound frame counts as the
 * reply, so a pong waiting behind a large replay or a deflate job is not
 * mistaken for silence. Two thresholds, measured from an unanswered ping:
 *
 * - `LIVENESS_REPLY_TIMEOUT_MS` only changes what the user sees: the
 *   connection is reported unresponsive, so a stalled server shows in the
 *   banner within interval + timeout, eight seconds at worst. The socket stays
 *   open; a late reply clears the report with no reconnect and no replay.
 * - `LIVENESS_ABANDON_AFTER_MS` abandons the socket. A server that is merely
 *   slow (a busy event loop on an overloaded machine) is the common case, and
 *   tearing down every channel would add replays and baselines to its load.
 *   The server's own protocol heartbeat (30 s, `server.ts`) tolerates a silent
 *   browser for at least that long, so the client gives a silent server the
 *   same 30 s before it treats the connection as dead.
 *
 * Hidden tabs: browsers throttle background timers to once a second or once a
 * minute and may freeze them, so a deadline measured there says more about
 * the browser than about the connection. Pinging pauses while the document is
 * hidden and resumes with an immediate ping when it is visible again. A
 * deadline that fires much later than it was set for (a suspended machine or
 * page) is re-armed rather than trusted, so a queued reply can still arrive.
 */

export const LIVENESS_PING_INTERVAL_MS = 4000;
export const LIVENESS_REPLY_TIMEOUT_MS = 4000;
export const LIVENESS_ABANDON_AFTER_MS = 30_000;
/** A timer this late ran in a suspended or throttled page; its verdict is not trusted. */
export const LATE_TIMER_TOLERANCE_MS = 1000;

export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * `setTimeout` that ignores a late firing: when the callback runs more than
 * `LATE_TIMER_TOLERANCE_MS` after it was due, the page was suspended and the
 * timer is re-armed for its full duration instead. Returns a cancel function.
 */
export function setTrustedTimeout(callback: () => void, delayMs: number): () => void {
  let handle: ReturnType<typeof setTimeout>;
  const arm = () => {
    const dueAt = Date.now() + delayMs;
    handle = setTimeout(() => {
      if (Date.now() - dueAt > LATE_TIMER_TOLERANCE_MS) {
        arm();
        return;
      }
      callback();
    }, delayMs);
  };
  arm();
  return () => clearTimeout(handle);
}

export interface ConnectionLivenessOptions {
  /** Sends one ping frame; returns false when the socket cannot send. */
  sendPing: (id: number) => boolean;
  /** A ping went unanswered for `LIVENESS_REPLY_TIMEOUT_MS`; the socket stays open. */
  onUnresponsive: () => void;
  /** A frame arrived after `onUnresponsive`. */
  onResponsive: () => void;
  /** Called once when a ping went unanswered for `LIVENESS_ABANDON_AFTER_MS`. */
  onDead: () => void;
}

export class ConnectionLiveness {
  private readonly options: ConnectionLivenessOptions;
  private running = false;
  private nextPingId = 0;
  private cancelTimer: (() => void) | null = null;
  private awaitingReply = false;
  private unresponsive = false;

  constructor(options: ConnectionLivenessOptions) {
    this.options = options;
  }

  /** Starts pinging; call once the server has said it answers pings. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextPing();
  }

  stop(): void {
    this.running = false;
    this.awaitingReply = false;
    this.unresponsive = false;
    this.clearTimer();
  }

  /** Whether a ping is overdue: the connection is open but silent. */
  isUnresponsive(): boolean {
    return this.unresponsive;
  }

  /** Any inbound frame proves the connection is alive. */
  frameReceived(): void {
    if (!this.running) {
      return;
    }
    if (this.unresponsive) {
      this.unresponsive = false;
      this.options.onResponsive();
    }
    if (this.awaitingReply) {
      this.awaitingReply = false;
      this.scheduleNextPing();
    }
  }

  /** Pings now, for example when the network changed. */
  checkNow(): void {
    if (!this.running) {
      return;
    }
    if (isDocumentHidden()) {
      this.pause();
      return;
    }
    if (!this.awaitingReply) {
      this.ping();
    }
  }

  /** Pauses while hidden; pings at once when visible again. */
  visibilityChanged(): void {
    if (!this.running) {
      return;
    }
    if (isDocumentHidden()) {
      this.pause();
      return;
    }
    if (this.cancelTimer === null) {
      this.ping();
    }
  }

  // An unresponsive report stands while hidden; the ping on return settles it.
  private pause(): void {
    this.awaitingReply = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private scheduleNextPing(): void {
    this.clearTimer();
    if (isDocumentHidden()) {
      return;
    }
    // A late ping timer only means the ping goes out late, so it needs no guard.
    const handle = setTimeout(() => this.ping(), LIVENESS_PING_INTERVAL_MS);
    this.cancelTimer = () => clearTimeout(handle);
  }

  private stillWaiting(): boolean {
    return this.running && this.awaitingReply && !isDocumentHidden();
  }

  private ping(): void {
    this.clearTimer();
    if (!this.running || isDocumentHidden()) {
      return;
    }
    const id = this.nextPingId;
    this.nextPingId += 1;
    if (!this.options.sendPing(id)) {
      // The socket is closing; its close event takes over.
      return;
    }
    this.awaitingReply = true;
    this.cancelTimer = setTrustedTimeout(() => {
      this.cancelTimer = null;
      if (!this.stillWaiting()) {
        return;
      }
      if (!this.unresponsive) {
        this.unresponsive = true;
        this.options.onUnresponsive();
      }
      this.cancelTimer = setTrustedTimeout(() => {
        this.cancelTimer = null;
        if (!this.stillWaiting()) {
          return;
        }
        this.stop();
        this.options.onDead();
      }, LIVENESS_ABANDON_AFTER_MS - LIVENESS_REPLY_TIMEOUT_MS);
    }, LIVENESS_REPLY_TIMEOUT_MS);
  }
}
