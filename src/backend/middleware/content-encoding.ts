/** Content codings the backend serves, in server preference order. */
export const CONTENT_ENCODINGS = ['br', 'gzip'] as const;
export type ContentEncoding = (typeof CONTENT_ENCODINGS)[number];

/** File suffixes the build writes beside each precompressed asset. */
export const PRECOMPRESSED_SUFFIXES: Readonly<Record<ContentEncoding, string>> = {
  br: '.br',
  gzip: '.gz',
};

function parseQuality(parameters: string[]): number {
  for (const parameter of parameters) {
    const [name, value] = parameter.split('=').map((part) => part.trim());
    if (name?.toLowerCase() === 'q') {
      const quality = Number(value);
      return Number.isFinite(quality) ? quality : 0;
    }
  }
  return 1;
}

/**
 * Picks the best coding the client accepts from `available`. Unlike Express's
 * negotiation, ties go to server preference: browsers list gzip before br.
 */
export function selectContentEncoding(
  acceptEncoding: string | undefined,
  available: readonly ContentEncoding[] = CONTENT_ENCODINGS
): ContentEncoding | null {
  if (!acceptEncoding) {
    return null;
  }
  const qualities = new Map<string, number>();
  for (const entry of acceptEncoding.split(',')) {
    const [coding, ...parameters] = entry.split(';');
    const name = coding?.trim().toLowerCase();
    if (name) {
      qualities.set(name, parseQuality(parameters));
    }
  }
  let selected: ContentEncoding | null = null;
  let selectedQuality = 0;
  for (const encoding of CONTENT_ENCODINGS) {
    if (!available.includes(encoding)) {
      continue;
    }
    const quality = qualities.get(encoding) ?? qualities.get('*') ?? 0;
    if (quality > selectedQuality) {
      selected = encoding;
      selectedQuality = quality;
    }
  }
  return selected;
}
