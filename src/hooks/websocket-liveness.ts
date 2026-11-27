/**
 * Application-level liveness for one open WebSocket.
 *
 * A half-open connection (laptop sleep, a network change, a stopped server)
 * reads as open until TCP gives up, which can take minutes. The client sends
 * a ping every `LIVENESS_PING_INTERVAL_MS` and declares the connection dead
 * when nothing at all arrives within `LIVENESS_REPLY_TIMEOUT_MS` of a ping.
 * Any inbound frame counts as a reply, so a busy connection whose pong waits
 * behind a large replay is not mistaken for a dead one. A stalled server is
 * detected within interval + timeout, eight seconds at worst.
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
  /** Called once when a ping went unanswered. */
  onDead: () => void;
}

export class ConnectionLiveness {
  private readonly sendPing: (id: number) => boolean;
  private readonly onDead: () => void;
  private running = false;
  private nextPingId = 0;
  private cancelTimer: (() => void) | null = null;
  private awaitingReply = false;

  constructor(options: ConnectionLivenessOptions) {
    this.sendPing = options.sendPing;
    this.onDead = options.onDead;
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
    this.clearTimer();
  }

  /** Any inbound frame proves the connection is alive. */
  frameReceived(): void {
    if (!(this.running && this.awaitingReply)) {
      return;
    }
    this.awaitingReply = false;
    this.scheduleNextPing();
  }

  /** Pings now, for example when the tab is shown again or the network changed. */
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

  private ping(): void {
    this.clearTimer();
    if (!this.running || isDocumentHidden()) {
      return;
    }
    const id = this.nextPingId;
    this.nextPingId += 1;
    if (!this.sendPing(id)) {
      // The socket is closing; its close event takes over.
      return;
    }
    this.awaitingReply = true;
    this.cancelTimer = setTrustedTimeout(() => {
      this.cancelTimer = null;
      if (!(this.running && this.awaitingReply) || isDocumentHidden()) {
        return;
      }
      this.stop();
      this.onDead();
    }, LIVENESS_REPLY_TIMEOUT_MS);
  }
}
