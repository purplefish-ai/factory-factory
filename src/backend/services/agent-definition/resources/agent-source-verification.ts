/** Shared live/indexed verification guards; positions are canonical capture offsets. */
export function invalidSkippedIdentity(position: number | undefined, verifiedCount: number) {
  const offset = position ?? -1;
  return offset > verifiedCount || (verifiedCount > 0 && offset < 0);
}

export function hasUnknownVerificationPrefix(
  ids: string[],
  anchor: number,
  isKnown: (id: string) => boolean
) {
  const prefix = anchor < 0 ? ids : ids.slice(0, anchor);
  return prefix.some((id) => !isKnown(id));
}
