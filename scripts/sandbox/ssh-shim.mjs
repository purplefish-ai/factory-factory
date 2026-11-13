#!/usr/bin/env node
// Stand-in for OpenSSH inside a dev sandbox (scripts/dev-sandbox.mjs). The
// launcher copies this file to <baseDir>/bin/ssh, first on the server's PATH and
// named by GIT_SSH_COMMAND, so every `ssh` call is recorded in
// <baseDir>/ssh-calls.log and nothing connects.
import { appendFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const baseDir = dirname(dirname(realpathSync(process.argv[1] ?? '')));
appendFileSync(join(baseDir, 'ssh-calls.log'), `${JSON.stringify(process.argv.slice(2))}\n`);
process.stderr.write('sandbox: ssh is disabled\n');
process.exit(1);
