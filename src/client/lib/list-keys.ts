/**
 * Keep keys stable across reordering for distinct identities.
 * Duplicate identities are distinguished by occurrence, so their keys depend on
 * their relative order. Use unique identities when individual rows must retain state.
 */
export function withOccurrenceKeys<T>(
  items: readonly T[],
  getIdentity: (item: T) => string
): Array<{ item: T; key: string }> {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const identity = getIdentity(item);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { item, key: JSON.stringify([identity, occurrence]) };
  });
}
