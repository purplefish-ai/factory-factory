import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getNodeRuntimeIssue } from './node-runtime';

// This side-effect module must be imported before the CLI's application imports.
// Read the published package metadata: .node-version is not shipped to users.
if (process.argv[2] === 'serve') {
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, 'package.json')) && root !== dirname(root)) {
    root = dirname(root);
  }
  const metadata = z
    .object({ engines: z.object({ node: z.string().regex(/^>=\d+\.\d+\.\d+$/) }) })
    .parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  const issue = getNodeRuntimeIssue(process.versions.node, metadata.engines.node);
  if (issue) {
    console.error(`\nCannot start Factory Factory:\n\n${issue}\n`);
    process.exit(1);
  }
}
