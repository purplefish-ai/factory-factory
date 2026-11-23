import type { SessionDeltaEvent, WebSocketMessage } from '@/lib/chat-protocol';
import { logProtocolError } from '@/lib/debug';
import type {
  CachedMetadataDeltaType,
  CachedMetadataOffer,
} from '@/shared/acp-protocol/protocol/cached-metadata';

type CachedDelta = Extract<SessionDeltaEvent, { type: CachedMetadataDeltaType }>;
type Acknowledgement = Extract<SessionDeltaEvent, { type: 'cached_metadata' }>;

/** Enough for a few sessions' slash commands and config options, about 60 KB each. */
const MAX_CACHED_METADATA = 8;

/** The metadata one connection offered; acknowledgements on it resolve only here. */
export class OfferedMetadata {
  constructor(private readonly entries: ReadonlyMap<string, CachedDelta>) {}

  /** The `load_session` field, or undefined when nothing is held. */
  get offer(): CachedMetadataOffer | undefined {
    return this.entries.size > 0 ? { digests: [...this.entries.keys()] } : undefined;
  }

  resolve(acknowledgement: Acknowledgement): CachedDelta | undefined {
    const entry = this.entries.get(acknowledgement.digest);
    return entry?.type === acknowledgement.deltaType ? entry : undefined;
  }
}

/**
 * Digested slash command and config option deltas this tab received, kept in
 * memory across sessions and connections and evicted least recently used.
 */
export class CachedMetadataStore {
  private readonly entries = new Map<string, CachedDelta>();

  constructor(private readonly capacity = MAX_CACHED_METADATA) {}

  remember(event: CachedDelta): void {
    if (!event.digest) {
      return;
    }
    this.entries.delete(event.digest);
    this.entries.set(event.digest, event);
    for (const digest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) {
        break;
      }
      this.entries.delete(digest);
    }
  }

  /** Copy the held entries, so eviction cannot remove what a connection offered. */
  offer(): OfferedMetadata {
    return new OfferedMetadata(new Map(this.entries));
  }

  /**
   * Remember a digested delta, and replace an acknowledgement with the cached
   * delta it stands for. Returns null for an acknowledgement nothing offered
   * on this connection matches, which only a server fault can produce.
   */
  accept(message: WebSocketMessage, offered: OfferedMetadata | null): WebSocketMessage | null {
    if (message.type !== 'session_delta') {
      return message;
    }
    const event = message.data;
    if (event.type === 'slash_commands' || event.type === 'config_options_update') {
      this.remember(event);
      return message;
    }
    if (event.type !== 'cached_metadata') {
      return message;
    }
    const cached = offered?.resolve(event);
    if (!cached) {
      logProtocolError('[chat] Dropped metadata acknowledgement that matches nothing offered', {
        deltaType: event.deltaType,
        digest: event.digest,
      });
      return null;
    }
    this.remember(cached);
    return { type: 'session_delta', data: cached };
  }
}

/** One store per tab, shared by every chat connection in it. */
export const chatCachedMetadata = new CachedMetadataStore();
