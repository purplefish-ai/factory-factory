#!/usr/bin/env node
// Stand-in for the GitHub CLI inside a dev sandbox (scripts/dev-sandbox.mjs).
// The launcher copies this file to <baseDir>/bin/gh, first on the server's PATH,
// so every `gh` call is recorded in <baseDir>/gh-calls.log and nothing runs.
import { appendFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const baseDir = dirname(dirname(realpathSync(process.argv[1] ?? '')));
appendFileSync(join(baseDir, 'gh-calls.log'), `${JSON.stringify(process.argv.slice(2))}\n`);
process.stderr.write('sandbox: gh is disabled\n');
process.exit(1);
