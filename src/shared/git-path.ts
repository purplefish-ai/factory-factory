/** Decode Git's C-quoted paths, including octal UTF-8 bytes. */
export function decodeGitPath(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) {
    return path;
  }
  const escapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    t: '\t',
    n: '\n',
    v: '\v',
    f: '\f',
    r: '\r',
    '"': '"',
    '\\': '\\',
  };
  return path
    .slice(1, -1)
    .replace(/(?:\\[0-7]{3})+|\\([abtnvfr"\\])/g, (match, escapeCode: string | undefined) => {
      if (escapeCode) {
        return escapes[escapeCode] ?? match;
      }
      const bytes = match.match(/[0-7]{3}/g) ?? [];
      try {
        return new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(
          Uint8Array.from(bytes, (byte) => Number.parseInt(byte, 8))
        );
      } catch {
        // Git paths can contain arbitrary bytes. Retain their octal spelling
        // rather than replacing bytes or guessing a legacy character encoding.
        return match;
      }
    });
}
