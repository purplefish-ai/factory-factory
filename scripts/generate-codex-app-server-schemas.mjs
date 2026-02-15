#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const OUTPUT_ROOT = resolve('src/backend/domains/session/acp/codex-app-server-adapter/schemas');
const TS_OUT = resolve(OUTPUT_ROOT, 'ts');
const JSON_SCHEMA_OUT = resolve(OUTPUT_ROOT, 'json-schema');

function run(command, args) {
  execFileSync(command, args, {
    stdio: 'inherit',
  });
}

function main() {
  rmSync(TS_OUT, { recursive: true, force: true });
  rmSync(JSON_SCHEMA_OUT, { recursive: true, force: true });
  mkdirSync(TS_OUT, { recursive: true });
  mkdirSync(JSON_SCHEMA_OUT, { recursive: true });

  run('codex', ['app-server', 'generate-ts', '--out', TS_OUT]);
  run('codex', ['app-server', 'generate-json-schema', '--out', JSON_SCHEMA_OUT]);

  process.stdout.write(`Generated Codex app-server schemas under ${OUTPUT_ROOT}\n`);
}

main();
