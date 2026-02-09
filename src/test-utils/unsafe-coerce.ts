export function unsafeCoerce<T>(value: unknown): T {
  return value as T;
}
