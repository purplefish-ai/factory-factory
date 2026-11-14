import { createHash } from 'node:crypto';
import { z } from 'zod';
import { listSlackTargets } from '@/backend/services/agent-definition/resources/agent-source-queries';
import { agentSourceAccessor } from '@/backend/services/agent-definition/resources/agent-source.accessor';
import {
  type SlackSourceUnavailable,
  slackReady,
  slackUncleanExit,
  slackUnavailable,
} from '@/backend/services/agent-definition/resources/slack/slack-source-health';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentEventInput } from '@/shared/agent-runtime';
import { classifySlackEnvelope } from './slack-event-message';

const logger = createLogger('slack-event-source');
const CONNECT_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 5000;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 5 * 60_000;
const HEARTBEAT_MS = 60_000;

/** Socket Mode transport events the listener needs; the SDK wrapper lives in orchestration. */
export type SlackSocketHandlers = {
  /** Every `hello` frame, parsed but unvalidated. */
  onHello(message: unknown): void;
  /** Settles after the envelope is stored and acknowledged, or deliberately left unacknowledged. */
  onEnvelope(envelope: { type: string; body: unknown; ack(): Promise<void> }): Promise<void>;
  /** The socket closed without this listener asking it to. */
  onDisconnected(): void;
};
export type SlackSocket = { start(): Promise<unknown>; disconnect(): Promise<void> };
type SlackAppCredentials = {
  connectionId: string;
  workspaceId: string;
  appId: string;
  appToken: string;
};
type SlackEventSourcePorts = {
  createSocket(appToken: string, handlers: SlackSocketHandlers): SlackSocket;
  getAppCredentials(connectionId: string): Promise<SlackAppCredentials | null>;
  isEnabled(): boolean;
  ingestEvent(input: AgentEventInput): Promise<{ eventId: string; duplicate: boolean }>;
  connectTimeoutMs?: number;
};
type Link = {
  connectionId: string;
  workspaceId: string;
  appId: string;
  key: string;
  socket: SlackSocket | null;
  verified: boolean;
  closed: boolean;
  disconnecting: Promise<void> | null;
  heartbeatAt: number;
};
type Retry = { key: string; failures: number; until: number };
type Decision = { credentials: SlackAppCredentials } | { unavailable: SlackSourceUnavailable };

const helloSchema = z.object({
  type: z.literal('hello'),
  connection_info: z.object({ app_id: z.string().min(1) }),
});
const platformErrorSchema = z.object({ data: z.object({ error: z.string() }) });
const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'account_inactive',
  'team_disabled',
  'not_allowed_token_type',
]);

/**
 * Holds one Slack Socket Mode connection per eligible Slack connection. The
 * listener fails closed on identity: the socket's `hello` must name the stored
 * app, and every events_api envelope must carry the stored app and workspace.
 * A supported message is acknowledged only after its ledger insert commits.
 * Reconnection happens through `reconcileConnections`, run under jobRunner.
 */
export class SlackEventSource {
  private readonly links = new Map<string, Link>();
  private readonly retries = new Map<string, Retry>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private stopped = true;
  private recovered = false;

  constructor(private readonly ports: SlackEventSourcePorts) {}

  start() {
    this.stopped = false;
    this.recovered = false;
  }

  /** Closes every socket, drains envelopes in flight and records the interruption. */
  async stop() {
    this.stopped = true;
    const links = [...this.links.values()];
    this.links.clear();
    await Promise.all(links.map((link) => this.disconnect(link)));
    await Promise.allSettled([...this.inflight]);
    for (const link of links) {
      this.record(link.connectionId, {
        state: 'DISCONNECTED',
        reasonCode: 'SLACK_LISTENER_STOPPED',
        interrupted: true,
      });
    }
    await Promise.allSettled([...this.writes.values()]);
  }

  async reconcileConnections(signal: AbortSignal) {
    if (this.stopped || signal.aborted) {
      return;
    }
    if (!this.recovered) {
      const at = new Date();
      await agentSourceAccessor.writeSlackSources(null, (row) => slackUncleanExit(row, at));
      this.recovered = true;
    }
    const enabled = this.ports.isEnabled();
    const decisions = enabled ? await this.decide(signal) : new Map<string, Decision>();
    if (this.stopped || signal.aborted) {
      return;
    }
    for (const link of [...this.links.values()]) {
      if (!decisions.has(link.connectionId)) {
        await this.close(link, {
          state: 'DISCONNECTED',
          reasonCode: enabled ? 'SLACK_NOT_LISTENING' : 'SLACK_INTAKE_DISABLED',
          interrupted: false,
        });
      }
    }
    const opening: Promise<void>[] = [];
    for (const [connectionId, decision] of decisions) {
      const open = await this.apply(connectionId, decision);
      if (open) {
        opening.push(open);
      }
    }
    await Promise.all(opening);
    await Promise.allSettled([...this.writes.values()]);
  }

  /** Brings one connection toward its decision; returns a connection attempt when one starts. */
  private async apply(connectionId: string, decision: Decision) {
    const link = this.links.get(connectionId);
    if ('unavailable' in decision) {
      if (link) {
        await this.close(link);
      }
      this.record(connectionId, decision.unavailable);
      return null;
    }
    const key = credentialKey(decision.credentials);
    if (link?.key === key) {
      this.heartbeat(link);
      return null;
    }
    if (link) {
      await this.close(link, {
        state: 'DISCONNECTED',
        reasonCode: 'SLACK_CREDENTIALS_CHANGED',
        interrupted: true,
      });
    }
    const retry = this.retries.get(connectionId);
    if (retry?.key === key && retry.until > Date.now()) {
      return null;
    }
    return this.open(decision.credentials, key);
  }

  private async decide(signal: AbortSignal) {
    const decisions = new Map<string, Decision>();
    for (const { connectionId } of await listSlackTargets()) {
      if (signal.aborted) {
        break;
      }
      decisions.set(connectionId, await this.credentialDecision(connectionId));
    }
    rejectSharedApps(decisions);
    return decisions;
  }

  private async credentialDecision(connectionId: string): Promise<Decision> {
    try {
      const credentials = await this.ports.getAppCredentials(connectionId);
      return credentials
        ? { credentials }
        : {
            unavailable: {
              state: 'DISCONNECTED',
              reasonCode: 'SLACK_APP_TOKEN_MISSING',
              interrupted: false,
            },
          };
    } catch {
      return {
        unavailable: {
          state: 'ERROR',
          reasonCode: 'SLACK_CREDENTIALS_UNAVAILABLE',
          interrupted: true,
        },
      };
    }
  }

  private async open(credentials: SlackAppCredentials, key: string) {
    if (this.stopped) {
      return;
    }
    const link: Link = {
      connectionId: credentials.connectionId,
      workspaceId: credentials.workspaceId,
      appId: credentials.appId,
      key,
      socket: null,
      verified: false,
      closed: false,
      disconnecting: null,
      heartbeatAt: 0,
    };
    this.links.set(link.connectionId, link);
    const socket = this.ports.createSocket(credentials.appToken, {
      onHello: (message) => this.onHello(link, message),
      onEnvelope: (envelope) => this.track(this.onEnvelope(link, envelope)),
      onDisconnected: () => this.onDisconnected(link),
    });
    link.socket = socket;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(
        () => resolve('TIMEOUT'),
        this.ports.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
      );
    });
    try {
      const result = await Promise.race([socket.start(), timeout]);
      if (result === 'TIMEOUT' && !link.closed) {
        await this.fail(link, 'SLACK_CONNECT_TIMEOUT');
      }
    } catch (error) {
      if (!link.closed) {
        await this.fail(link, startFailureReason(error));
      }
    } finally {
      clearTimeout(timer);
    }
    if (link.closed) {
      await this.disconnect(link);
    }
  }

  private onHello(link: Link, message: unknown) {
    if (link.closed || link.verified || this.links.get(link.connectionId) !== link) {
      return;
    }
    const hello = helloSchema.safeParse(message);
    if (!hello.success || hello.data.connection_info.app_id !== link.appId) {
      void this.reject(link, 'SLACK_APP_MISMATCH');
      return;
    }
    link.verified = true;
    link.heartbeatAt = Date.now();
    this.retries.delete(link.connectionId);
    this.enqueue(link.connectionId, () => this.writeReady(link.connectionId));
  }

  private async onEnvelope(
    link: Link,
    envelope: { type: string; body: unknown; ack(): Promise<void> }
  ) {
    // An unverified, replaced or closed socket leaves the envelope for Slack to redeliver.
    if (link.closed || !link.verified || this.stopped) {
      return;
    }
    const decision = classifySlackEnvelope(link, envelope, new Date());
    if (decision.kind === 'REJECT') {
      await this.reject(link, decision.reason);
      await this.writes.get(link.connectionId);
      return;
    }
    if (decision.kind === 'IGNORE') {
      if (decision.reason === 'INVALID_PAYLOAD') {
        logger.warn('Ignored a malformed Slack event.', { reason: decision.reason });
      }
      await acknowledge(envelope);
      return;
    }
    try {
      const [target] = await listSlackTargets(link.connectionId);
      if (target?.channelIds.includes(decision.channelId)) {
        await this.ports.ingestEvent(decision.event);
      }
    } catch {
      logger.warn('Could not store a Slack event; it stays unacknowledged for redelivery.', {
        reason: 'SLACK_EVENT_STORE_FAILED',
      });
      return;
    }
    await acknowledge(envelope);
  }

  private onDisconnected(link: Link) {
    if (link.closed) {
      return;
    }
    if (!link.verified) {
      void this.fail(link, 'SLACK_CONNECT_FAILED');
      return;
    }
    link.closed = true;
    this.forget(link);
    this.record(link.connectionId, {
      state: 'DISCONNECTED',
      reasonCode: 'SLACK_DISCONNECTED',
      interrupted: true,
    });
  }

  /** Identity failures stop listening until the stored credentials change. */
  private async reject(link: Link, reasonCode: string) {
    if (link.closed) {
      return;
    }
    this.retries.set(link.connectionId, {
      key: link.key,
      failures: Number.POSITIVE_INFINITY,
      until: Number.POSITIVE_INFINITY,
    });
    logger.warn('Slack listener identity check failed; listening stopped.', { reason: reasonCode });
    await this.close(link, { state: 'ERROR', reasonCode, interrupted: true });
  }

  private async fail(link: Link, reasonCode: string) {
    const previous = this.retries.get(link.connectionId);
    const failures = previous?.key === link.key ? previous.failures + 1 : 1;
    this.retries.set(link.connectionId, {
      key: link.key,
      failures,
      until: Date.now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS),
    });
    logger.warn('Slack listener could not connect.', { reason: reasonCode });
    await this.close(link, { state: 'ERROR', reasonCode, interrupted: true });
  }

  private async close(link: Link, change?: SlackSourceUnavailable) {
    link.closed = true;
    this.forget(link);
    await this.disconnect(link);
    if (change) {
      this.record(link.connectionId, change);
    }
  }

  private forget(link: Link) {
    if (this.links.get(link.connectionId) === link) {
      this.links.delete(link.connectionId);
    }
  }

  private disconnect(link: Link) {
    link.closed = true;
    const socket = link.socket;
    if (!socket) {
      return Promise.resolve();
    }
    link.disconnecting ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        socket.disconnect().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DISCONNECT_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    })();
    return link.disconnecting;
  }

  private heartbeat(link: Link) {
    if (link.verified && Date.now() - link.heartbeatAt >= HEARTBEAT_MS) {
      link.heartbeatAt = Date.now();
      this.enqueue(link.connectionId, () => this.writeReady(link.connectionId));
    }
  }

  private record(connectionId: string, change: SlackSourceUnavailable) {
    const at = new Date();
    this.enqueue(connectionId, () =>
      agentSourceAccessor.writeSlackSources(connectionId, (row) =>
        slackUnavailable(row, change, at)
      )
    );
  }

  private writeReady(connectionId: string) {
    const at = new Date();
    return agentSourceAccessor.writeSlackSources(connectionId, (row) => slackReady(row, at));
  }

  /** Health writes for one connection apply in the order the listener observed them. */
  private enqueue(connectionId: string, write: () => Promise<void>) {
    const next = (this.writes.get(connectionId) ?? Promise.resolve()).then(write).catch(() => {
      logger.warn('Could not record Slack source health.', {
        reason: 'SLACK_HEALTH_WRITE_FAILED',
      });
    });
    this.writes.set(connectionId, next);
    void next.finally(() => {
      if (this.writes.get(connectionId) === next) {
        this.writes.delete(connectionId);
      }
    });
  }

  private track(work: Promise<void>) {
    this.inflight.add(work);
    return work.finally(() => this.inflight.delete(work));
  }
}

/**
 * Socket Mode spreads an app's events across its open connections, so two
 * connections on one app would each receive the other's events.
 */
function rejectSharedApps(decisions: Map<string, Decision>) {
  const byApp = new Map<string, string[]>();
  for (const [connectionId, decision] of decisions) {
    if ('credentials' in decision) {
      const ids = byApp.get(decision.credentials.appId) ?? [];
      byApp.set(decision.credentials.appId, [...ids, connectionId]);
    }
  }
  for (const ids of byApp.values()) {
    for (const connectionId of ids.length > 1 ? ids : []) {
      decisions.set(connectionId, {
        unavailable: { state: 'ERROR', reasonCode: 'SLACK_APP_SHARED', interrupted: true },
      });
    }
  }
}

async function acknowledge(envelope: { ack(): Promise<void> }) {
  try {
    await envelope.ack();
  } catch {
    // The socket closed first; Slack redelivers and the duplicate insert acknowledges it.
  }
}

function credentialKey(credentials: SlackAppCredentials) {
  return createHash('sha256')
    .update(
      [
        credentials.connectionId,
        credentials.workspaceId,
        credentials.appId,
        credentials.appToken,
      ].join('\0')
    )
    .digest('hex');
}

function startFailureReason(error: unknown) {
  const platform = platformErrorSchema.safeParse(error);
  return platform.success && AUTH_ERRORS.has(platform.data.data.error)
    ? 'SLACK_AUTH_FAILED'
    : 'SLACK_CONNECT_FAILED';
}
