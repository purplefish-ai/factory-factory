import { describe, expect, it } from 'vitest';
import type { WebSocketMessage } from '@/lib/chat-protocol';
import { CachedMetadataStore } from './chat-cached-metadata';

function slash(digest?: string): WebSocketMessage {
  return {
    type: 'session_delta',
    data: {
      type: 'slash_commands',
      slashCommands: [{ name: digest ?? 'plain', description: 'Command' }],
      ...(digest ? { digest } : {}),
    },
  };
}

function acknowledgement(digest: string): WebSocketMessage {
  return {
    type: 'session_delta',
    data: { type: 'cached_metadata', deltaType: 'slash_commands', digest },
  };
}

describe('CachedMetadataStore', () => {
  it('keeps only digested deltas, evicting the least recently used beyond its capacity', () => {
    const store = new CachedMetadataStore(2);
    store.accept(slash(), null);
    store.accept(slash('v1:a'), null);
    store.accept(slash('v1:b'), null);
    expect(store.offer().offer).toEqual({ digests: ['v1:a', 'v1:b'] });
    // Using an entry refreshes it, so the next insertion evicts the other one.
    store.accept(acknowledgement('v1:a'), store.offer());
    store.accept(slash('v1:c'), null);
    expect(store.offer().offer).toEqual({ digests: ['v1:a', 'v1:c'] });
  });

  it('resolves acknowledgements against what the connection offered, even after eviction', () => {
    const store = new CachedMetadataStore(1);
    store.accept(slash('v1:a'), null);
    const offered = store.offer();
    store.accept(slash('v1:b'), null);
    expect(store.accept(acknowledgement('v1:a'), offered)).toEqual(slash('v1:a'));
    expect(store.accept(acknowledgement('v1:b'), offered)).toBeNull();
  });

  it('does not resolve a digest offered for another delta type', () => {
    const store = new CachedMetadataStore();
    store.accept(slash('v1:a'), null);
    expect(
      store.accept(
        {
          type: 'session_delta',
          data: { type: 'cached_metadata', deltaType: 'config_options_update', digest: 'v1:a' },
        },
        store.offer()
      )
    ).toBeNull();
  });

  it('offers nothing while empty', () => {
    expect(new CachedMetadataStore().offer().offer).toBeUndefined();
  });
});
