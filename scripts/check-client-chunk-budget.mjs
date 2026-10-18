import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Keep the startup module and deferred file-rendering modules independently bounded.
// Uncompressed bytes track parse/compile work rather than compression changes.
const budgets = [
  [/^index-.*\.js$/, 650_000],
  [/^file-viewer-.*\.js$/, 20_000],
  [/^diff-highlight\.worker-.*\.js$/, 300_000],
];
const directory = 'dist/client/assets';
const files = readdirSync(directory);
for (const [pattern, limit] of budgets) {
  const matching = files.filter((file) => pattern.test(file));
  if (matching.length !== 1) {
    throw new Error(`Expected exactly one ${pattern} chunk; found ${matching.length}`);
  }
  for (const file of matching) {
    const size = statSync(join(directory, file)).size;
    if (size > limit) {
      throw new Error(`${file}: ${size} bytes exceeds the ${limit} byte budget`);
    }
    console.log(`${file}: ${size}/${limit} bytes`);
  }
}
