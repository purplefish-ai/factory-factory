// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readStorageItem, writeStorageItem } from '@/client/lib/browser-storage';
import { type PersistedStateOptions, usePersistedState } from './use-persisted-state';

const KEY = 'persisted-state-test';
const CountSchema = z.number().int().nonnegative();

interface ProbeProps {
  storageKey?: string | null;
  options?: PersistedStateOptions<number>;
  onRender?: (
    value: number,
    setValue: (next: number | ((previous: number) => number)) => void
  ) => void;
}

function Counter({ storageKey = KEY, options, onRender }: ProbeProps) {
  const [count, setCount] = usePersistedState(storageKey, CountSchema, 0, options);
  onRender?.(count, setCount);
  return (
    <button type="button" onClick={() => setCount((previous) => previous + 1)}>
      {count}
    </button>
  );
}

const ItemSchema = z.object({ id: z.string() });
type Item = z.infer<typeof ItemSchema>;

function encodeItem(item: Item): string {
  if (item.id === 'reject') {
    throw new Error('invalid');
  }
  return JSON.stringify({ id: item.id });
}

function ItemProbe({ onRender }: { onRender: (value: Item, set: (next: Item) => void) => void }) {
  const [value, setValue] = usePersistedState(
    'item',
    ItemSchema,
    { id: 'none' },
    {
      encode: encodeItem,
    }
  );
  onRender(value, setValue);
  return null;
}

const NullableSchema = z.boolean().nullable();
const OptionalSchema = z.undefined();
const FormatSchema = z.union([z.number(), z.string()]);

function NullableProbe({ onRender }: { onRender: (value: boolean | null) => void }) {
  const [value] = usePersistedState('nullable', NullableSchema, true);
  onRender(value);
  return null;
}

function OptionalProbe({ onSetter }: { onSetter: (set: (next: undefined) => void) => void }) {
  const [, setValue] = usePersistedState('optional', OptionalSchema, undefined);
  onSetter(setValue);
  return null;
}

function FormatProbe({
  format,
  onRender,
}: {
  format: 'json' | 'text';
  onRender: (value: number | string) => void;
}) {
  const [value] = usePersistedState(KEY, FormatSchema, 0, { format });
  onRender(value);
  return null;
}

function mount(element: React.ReactNode) {
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(element));
  return {
    host,
    texts: () => [...host.querySelectorAll('button')].map((button) => button.textContent),
    click: (index = 0) => flushSync(() => host.querySelectorAll('button')[index]?.click()),
    rerender: (next: React.ReactNode) => flushSync(() => root.render(next)),
    unmount: () => flushSync(() => root.unmount()),
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePersistedState', () => {
  it('reads and validates the stored value on the first render without writing', () => {
    localStorage.setItem(KEY, '3');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const renders: number[] = [];
    const view = mount(<Counter onRender={(value) => renders.push(value)} />);
    expect(renders[0]).toBe(3);
    expect(setItem).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([
    ['missing', null],
    ['unparsable', '{'],
    ['rejected by the schema', '-1'],
  ])('falls back when the stored value is %s', (_label, raw) => {
    if (raw !== null) {
      localStorage.setItem(KEY, raw);
    }
    const view = mount(<Counter />);
    expect(view.texts()).toEqual(['0']);
    view.unmount();
  });

  it('writes through the setter and keeps the value across remounts', () => {
    const first = mount(<Counter />);
    first.click();
    first.click();
    expect(first.texts()).toEqual(['2']);
    expect(localStorage.getItem(KEY)).toBe('2');
    first.unmount();
    const second = mount(<Counter />);
    expect(second.texts()).toEqual(['2']);
    second.unmount();
  });

  it('stores an explicit choice equal to the fallback', () => {
    let set: ((next: number) => void) | undefined;
    const view = mount(<Counter onRender={(_value, setValue) => (set = setValue)} />);
    flushSync(() => set?.(0));
    expect(localStorage.getItem(KEY)).toBe('0');
    view.unmount();
  });

  it('stores an explicit value over another tab write it has not followed', () => {
    let set: ((next: number) => void) | undefined;
    const view = mount(<Counter onRender={(_value, setValue) => (set = setValue)} />);
    localStorage.setItem(KEY, '5');
    flushSync(() => set?.(0));
    expect(localStorage.getItem(KEY)).toBe('0');
    view.unmount();
  });

  it('skips an updater that returns its input', () => {
    let set: ((next: (previous: number) => number) => void) | undefined;
    const view = mount(<Counter onRender={(_value, setValue) => (set = setValue)} />);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    flushSync(() => set?.((previous) => previous));
    expect(setItem).not.toHaveBeenCalled();
    view.unmount();
  });

  it('restores a stored null that the schema accepts', () => {
    localStorage.setItem('nullable', 'null');
    let current: boolean | null | undefined;
    const view = mount(<NullableProbe onRender={(value) => (current = value)} />);
    expect(current).toBeNull();
    view.unmount();
  });

  it('does not store values that do not encode to a string', () => {
    let set: ((next: undefined) => void) | undefined;
    const view = mount(<OptionalProbe onSetter={(setter) => (set = setter)} />);
    flushSync(() => set?.(undefined));
    expect(localStorage.getItem('optional')).toBeNull();
    view.unmount();
  });

  it('decodes again when the format changes', () => {
    localStorage.setItem(KEY, '7');
    let current: unknown;
    const view = mount(<FormatProbe format="json" onRender={(value) => (current = value)} />);
    expect(current).toBe(7);
    view.rerender(<FormatProbe format="text" onRender={(value) => (current = value)} />);
    expect(current).toBe('7');
    view.unmount();
  });

  it('keeps the setter stable across renders', () => {
    const setters = new Set<unknown>();
    const view = mount(<Counter onRender={(_value, setValue) => setters.add(setValue)} />);
    view.click();
    view.click();
    expect(setters.size).toBe(1);
    view.unmount();
  });

  it('keeps updating in memory when storage is unavailable or full', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const view = mount(
      <>
        <Counter />
        <Counter />
      </>
    );
    expect(view.texts()).toEqual(['0', '0']);
    view.click();
    expect(view.texts()).toEqual(['1', '1']);
    view.unmount();
  });

  it('survives the localStorage property itself throwing', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    const view = mount(<Counter />);
    view.click();
    expect(view.texts()).toEqual(['1']);
    view.unmount();
  });

  it('shares one key between consumers and isolates other keys', () => {
    const view = mount(
      <>
        <Counter />
        <Counter />
        <Counter storageKey="other" />
      </>
    );
    view.click(1);
    expect(view.texts()).toEqual(['1', '1', '0']);
    view.unmount();
  });

  it('updates consumers when a module writes the key', () => {
    const view = mount(<Counter />);
    flushSync(() => writeStorageItem(KEY, '7'));
    expect(view.texts()).toEqual(['7']);
    view.unmount();
  });

  it('follows other tabs only when cross-tab sync is enabled', () => {
    const view = mount(
      <>
        <Counter options={{ crossTab: true }} />
        <Counter storageKey="local-only" />
      </>
    );
    localStorage.setItem(KEY, '5');
    localStorage.setItem('local-only', '5');
    flushSync(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'unrelated', storageArea: localStorage })
      );
    });
    expect(view.texts()).toEqual(['0', '0']);
    flushSync(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, storageArea: localStorage }));
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'local-only', storageArea: localStorage })
      );
    });
    expect(view.texts()).toEqual(['5', '0']);
    // An event for another storage area does not re-read local storage.
    localStorage.setItem(KEY, '6');
    flushSync(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, storageArea: sessionStorage }));
    });
    expect(view.texts()).toEqual(['5', '0']);
    localStorage.clear();
    flushSync(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
    });
    expect(view.texts()).toEqual(['0', '0']);
    view.unmount();
  });

  it('stops listening for other tabs after unmounting', () => {
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const view = mount(<Counter options={{ crossTab: true }} />);
    view.unmount();
    expect(removeListener).toHaveBeenCalledWith('storage', expect.any(Function));
  });

  it('stores text values and session storage when asked', () => {
    const view = mount(<Counter options={{ format: 'text', area: 'session' }} />);
    view.click();
    expect(sessionStorage.getItem(KEY)).toBe('1');
    expect(localStorage.getItem(KEY)).toBeNull();
    view.unmount();
  });

  it('reads a new key when the key changes', () => {
    localStorage.setItem('a', '1');
    localStorage.setItem('b', '2');
    const view = mount(<Counter storageKey="a" />);
    expect(view.texts()).toEqual(['1']);
    view.rerender(<Counter storageKey="b" />);
    expect(view.texts()).toEqual(['2']);
    view.click();
    expect(localStorage.getItem('a')).toBe('1');
    expect(localStorage.getItem('b')).toBe('3');
    view.unmount();
  });

  it('keeps state in memory for a null key', () => {
    const view = mount(<Counter storageKey={null} />);
    view.click();
    expect(view.texts()).toEqual(['1']);
    expect(localStorage.length).toBe(0);
    view.unmount();
  });

  it('keeps the exact object it stored and ignores values the encoder rejects', () => {
    const live = { id: 'a', live: () => undefined };
    let current: unknown;
    let set: ((next: Item) => void) | undefined;
    const view = mount(
      <ItemProbe
        onRender={(value, setValue) => {
          current = value;
          set = setValue;
        }}
      />
    );
    flushSync(() => set?.(live));
    expect(current).toBe(live);
    expect(localStorage.getItem('item')).toBe('{"id":"a"}');
    flushSync(() => set?.({ id: 'reject' }));
    expect(current).toBe(live);
    view.unmount();
  });

  it('drops cached values once the last consumer unmounts', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const view = mount(<Counter />);
    view.click();
    expect(readStorageItem(KEY)).toBe('1');
    view.unmount();
    expect(readStorageItem(KEY)).toBeNull();
  });
});
