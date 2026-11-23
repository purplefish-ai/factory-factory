import { describe, expect, it } from 'vitest';
import { ChatImageStore } from './chat-image-store';

const image = (data: string) => ({
  mediaType: 'image/png' as const,
  data,
  size: Buffer.from(data, 'base64').length,
});

describe('ChatImageStore', () => {
  it('returns what was put under its id', () => {
    const store = new ChatImageStore();
    store.put('a', image('AAAA'));
    expect(store.get('a')).toEqual(image('AAAA'));
    expect(store.get('b')).toBeUndefined();
  });

  it('evicts the least recently used images beyond its character budget', () => {
    const store = new ChatImageStore({ maxChars: 8 });
    store.put('a', image('AAAA'));
    store.put('b', image('BBBB'));
    // Reading `a` makes `b` the oldest.
    store.get('a');
    store.put('c', image('CCCC'));
    expect(store.get('a')).toBeDefined();
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')).toBeDefined();
  });

  it('keeps the newest image even when it alone exceeds the budget', () => {
    const store = new ChatImageStore({ maxChars: 4 });
    store.put('a', image('AAAA'));
    store.put('big', image('BBBBBBBB'));
    expect(store.get('a')).toBeUndefined();
    expect(store.get('big')).toBeDefined();
  });

  it('counts a repeated put once', () => {
    const store = new ChatImageStore({ maxChars: 8 });
    store.put('a', image('AAAA'));
    store.put('a', image('AAAA'));
    store.put('b', image('BBBB'));
    expect(store.get('a')).toBeDefined();
    expect(store.get('b')).toBeDefined();
  });
});
