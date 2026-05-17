#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const SNAPSHOT_PATH = resolve(
  'src/backend/services/session/service/acp/codex-app-server-adapter/schema-snapshots/app-server-methods.snapshot.json'
);

const SCHEMA_FILES = ['ClientRequest.ts', 'ServerRequest.ts', 'ClientNotification.ts'];

function isStrictCheck() {
  return process.env.CI === 'true' || process.env.CODEX_SCHEMA_CHECK === 'strict';
}

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commandErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function skipLocalCheck(reason) {
  process.stderr.write(`${reason}\n`);
  process.stderr.write(
    [
      'Skipping Codex app-server schema drift check locally.',
      'CI installs the pinned Codex CLI and enforces this check.\n',
    ].join(' ')
  );
  process.stderr.write(
    [
      'To enforce it locally, install the pinned @openai/codex version',
      'and run CODEX_SCHEMA_CHECK=strict pnpm check:codex-schema.\n',
    ].join(' ')
  );
}

function extractMethods(source) {
  const methods = new Set();
  const pattern = /"method"\s*:\s*"([^"]+)"/g;
  let match;
  while (true) {
    match = pattern.exec(source);
    if (!match) {
      break;
    }
    methods.add(match[1]);
  }
  return [...methods].sort((a, b) => a.localeCompare(b));
}

function diffArrays(current, expected) {
  const currentSet = new Set(current);
  const expectedSet = new Set(expected);
  const added = current.filter((value) => !expectedSet.has(value));
  const removed = expected.filter((value) => !currentSet.has(value));
  return { added, removed };
}

function buildSchemaSnapshot(outputDir, codexCliVersion) {
  const files = {};
  const allMethods = new Set();
  for (const filename of SCHEMA_FILES) {
    const fullPath = join(outputDir, filename);
    const methods = extractMethods(readFileSync(fullPath, 'utf8'));
    files[filename] = methods;
    for (const method of methods) {
      allMethods.add(method);
    }
  }

  return {
    codexCliVersion,
    files,
    allMethods: [...allMethods].sort((a, b) => a.localeCompare(b)),
  };
}

function printDrift(current, expected) {
  const versionChanged = current.codexCliVersion !== expected.codexCliVersion;
  if (versionChanged) {
    // eslint-disable-next-line no-console
    console.error(
      `codex-cli version changed: expected ${expected.codexCliVersion}, got ${current.codexCliVersion}`
    );
  }

  for (const filename of SCHEMA_FILES) {
    const diff = diffArrays(current.files[filename] ?? [], expected.files[filename] ?? []);
    if (diff.added.length === 0 && diff.removed.length === 0) {
      continue;
    }
    // eslint-disable-next-line no-console
    console.error(`drift in ${filename}`);
    if (diff.added.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`  added: ${diff.added.join(', ')}`);
    }
    if (diff.removed.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`  removed: ${diff.removed.join(', ')}`);
    }
  }

  const allDiff = diffArrays(current.allMethods, expected.allMethods);
  if (allDiff.added.length > 0 || allDiff.removed.length > 0) {
    // eslint-disable-next-line no-console
    console.error('aggregate method drift');
    if (allDiff.added.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`  added: ${allDiff.added.join(', ')}`);
    }
    if (allDiff.removed.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`  removed: ${allDiff.removed.join(', ')}`);
    }
  }
}

function main() {
  const updateSnapshot = process.argv.includes('--update');
  const expectedSnapshot = updateSnapshot
    ? undefined
    : JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));

  let codexVersion;
  try {
    codexVersion = runCommand('codex', ['--version']);
  } catch (error) {
    const message = `failed to run codex --version: ${commandErrorMessage(error)}`;
    if (updateSnapshot || isStrictCheck()) {
      throw new Error(message);
    }
    skipLocalCheck(message);
    return;
  }

  if (
    !updateSnapshot &&
    expectedSnapshot?.codexCliVersion &&
    codexVersion !== expectedSnapshot.codexCliVersion
  ) {
    const message = `codex-cli version changed: expected ${expectedSnapshot.codexCliVersion}, got ${codexVersion}`;
    if (isStrictCheck()) {
      throw new Error(message);
    }
    skipLocalCheck(message);
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'codex-ts-schema-'));
  try {
    runCommand('codex', ['app-server', 'generate-ts', '--out', tempRoot]);
    const currentSnapshot = buildSchemaSnapshot(tempRoot, codexVersion);

    if (updateSnapshot) {
      writeFileSync(`${SNAPSHOT_PATH}`, `${JSON.stringify(currentSnapshot, null, 2)}\n`, 'utf8');
      // eslint-disable-next-line no-console
      console.log(`updated snapshot: ${SNAPSHOT_PATH}`);
      return;
    }

    const identical = JSON.stringify(currentSnapshot) === JSON.stringify(expectedSnapshot);
    if (identical) {
      // eslint-disable-next-line no-console
      console.log('codex app-server schema snapshot is up to date');
      return;
    }

    printDrift(currentSnapshot, expectedSnapshot);
    throw new Error(
      `codex app-server schema drift detected. Run: node scripts/check-codex-schema-drift.mjs --update`
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
