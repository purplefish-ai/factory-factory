import { vi } from 'vitest';
import { unsafeCoerce } from './unsafe-coerce';

/**
 * Typed test doubles that fill in whatever a test did not configure.
 *
 * `withAutoStubs(label, explicit)` returns `explicit` with every missing
 * string property resolved to an auto-stub. An auto-stub is a `vi.fn()` that
 * returns `undefined`, whose own missing properties are auto-stubs too, so
 * `stub.list()`, `stub.nested.call()` and `vi.mocked(stub.method)` all work.
 * Each property resolves to the same stub every time it is read, and stubs
 * are never shared between two `withAutoStubs` objects.
 *
 * Only explicit properties are own keys: spreading or `Object.assign`-ing an
 * auto-stubbed object copies what was configured, not the stubs.
 */

/** Never stubbed: promise detection, module interop and serialization probe these. */
const RESERVED = new Set(['then', 'default', '__esModule', 'toJSON']);

function isStubbable(target: object, key: string | symbol): key is string {
  return typeof key === 'string' && !RESERVED.has(key) && !(key in target);
}

function stubFor(stubs: Map<string, unknown>, path: string, key: string): unknown {
  if (!stubs.has(key)) {
    stubs.set(key, createAutoStub(`${path}.${key}`));
  }
  return stubs.get(key);
}

/**
 * A callable `vi.fn()` named `path` whose missing properties are auto-stubs.
 *
 * The proxy wraps a bare function rather than the mock itself, so a spread
 * copies no mock internals. The mock's own API (`mock`, `mockReturnValue`, ...)
 * is forwarded; inherited `Function.prototype` names such as `call` or `bind`
 * are stubbed like any other member, since services may define them.
 */
export function createAutoStub(path: string): unknown {
  const fn = vi.fn().mockName(path);
  const children = new Map<string, unknown>();
  const assigned = new Set<string>();
  /** Members a stub may own: any string that is not part of the mock's API. */
  const isMember = (key: string | symbol): key is string =>
    typeof key === 'string' && !Object.hasOwn(fn, key);
  // A constructible shell: every call and construction is forwarded to `fn`.
  const shell = function autoStub() {
    return undefined;
  };
  return new Proxy(shell, {
    apply: (_target, thisArg, args) => Reflect.apply(fn, thisArg, args),
    construct: (_target, args) => Reflect.construct(fn, args),
    get: (_target, key) => {
      if (!isMember(key) || (RESERVED.has(key) && !children.has(key))) {
        return Reflect.get(fn, key);
      }
      return stubFor(children, path, key);
    },
    set: (_target, key, value) => {
      if (!isMember(key)) {
        return Reflect.set(fn, key, value);
      }
      children.set(key, value);
      assigned.add(key);
      return true;
    },
    has: (_target, key) => (isMember(key) ? assigned.has(key) : key in fn),
    // Only assigned members, plus the non-configurable `prototype` the Proxy
    // invariants require.
    ownKeys: (target) => [
      ...Reflect.ownKeys(target).filter(
        (key) => Reflect.getOwnPropertyDescriptor(target, key)?.configurable === false
      ),
      ...assigned,
    ],
    getOwnPropertyDescriptor: (target, key) =>
      typeof key === 'string' && assigned.has(key)
        ? { value: children.get(key), writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, key),
  });
}

/** `explicit`, with every member it does not define resolved to an auto-stub. */
export function withAutoStubs<T extends object>(label: string, explicit: Partial<T>): T {
  const stubs = new Map<string, unknown>();
  return unsafeCoerce<T>(
    new Proxy(explicit, {
      get: (target, key, receiver) =>
        isStubbable(target, key) ? stubFor(stubs, label, key) : Reflect.get(target, key, receiver),
      has: (target, key) => key in target || (typeof key === 'string' && !RESERVED.has(key)),
    })
  );
}
