import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

function directoryFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
}

const [argument, archive] = process.argv.slice(2);
const files =
  argument === '--tarball'
    ? execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter((file) => file.startsWith('package/dist/') && !file.endsWith('/'))
        .map((file) => file.slice('package/dist/'.length))
    : directoryFiles(argument ?? 'dist');
if (files.length === 0) {
  throw new Error('No production files found in artifact');
}
const forbidden = files.filter(
  (file) =>
    file.startsWith('scripts/') ||
    /(?:^|\/)(?:testing|test-utils|fixtures|__tests__)(?:\/|$)/.test(file) ||
    /\.(?:test|spec)(?:\.|-)/.test(file)
);
if (forbidden.length > 0) {
  throw new Error(`Development artifacts in production output:\n${forbidden.join('\n')}`);
}
console.log(`Production artifact check passed (${files.length} files inspected)`);
