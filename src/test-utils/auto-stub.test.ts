import { describe, expect, it, vi } from 'vitest';
import { createAutoStub, withAutoStubs } from './auto-stub';
import { unsafeCoerce } from './unsafe-coerce';

type Shape = {
  configured: { read(): string };
  missing: { list(): Promise<string[]>; nested: { call(value: number): number } };
  factory: (name: string) => string;
};

describe('withAutoStubs', () => {
  it('keeps configured members and stubs the rest with stable, isolated mocks', async () => {
    const configured = { read: () => 'real' };
    const first = withAutoStubs<Shape>('first', { configured });
    const second = withAutoStubs<Shape>('second', { configured });

    expect(first.configured).toBe(configured);
    expect(first.missing).toBe(first.missing);
    expect(first.missing).not.toBe(second.missing);
    expect(await first.missing.list()).toBeUndefined();
    expect(first.factory('x')).toBeUndefined();
    expect(vi.isMockFunction(first.missing.list)).toBe(true);
    expect(first.missing.list).toHaveBeenCalledOnce();
    expect(second.missing.list).not.toHaveBeenCalled();
    vi.mocked(first.missing.nested.call).mockReturnValue(42);
    expect(first.missing.nested.call(1)).toBe(42);
  });

  it('copies only configured members when spread', () => {
    const stubbed = withAutoStubs<Shape>('spread', { configured: { read: () => 'real' } });
    expect(Object.keys({ ...stubbed })).toEqual(['configured']);
    expect(Object.keys(Object.assign({}, stubbed.missing))).toEqual([]);
  });

  it('never resolves promise, interop or serialization probes', async () => {
    const stubbed = withAutoStubs<Shape>('probes', {});
    expect('then' in stubbed).toBe(false);
    expect('default' in stubbed).toBe(false);
    expect('__esModule' in stubbed).toBe(false);
    expect(await Promise.resolve(stubbed)).toBe(stubbed);
    expect(JSON.stringify({ value: stubbed.missing })).toBe('{}');
  });

  it('lets a stub member be replaced and then spreads it', () => {
    const stub = unsafeCoerce<{ method: () => string }>(createAutoStub('assigned'));
    const method = () => 'configured';
    stub.method = method;
    expect(stub.method).toBe(method);
    expect({ ...stub }).toEqual({ method });
  });
});
