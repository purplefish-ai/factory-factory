#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifestPath = resolve(process.argv[2] ?? 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const dependencies = manifest.dependencies ?? {};
const dependencyNames = [
  '@prisma/adapter-better-sqlite3',
  '@prisma/client',
  'prisma',
];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const versions = dependencyNames.map((name) => {
  const version = dependencies[name];
  if (typeof version !== 'string' || !exactVersion.test(version)) {
    throw new Error(
      `${name} must be pinned exactly in dependencies, got ${String(version)}`
    );
  }
  return version;
});

if (new Set(versions).size !== 1) {
  throw new Error(
    `Prisma versions must match: ${dependencyNames
      .map((name, index) => `${name}=${versions[index]}`)
      .join(', ')}`
  );
}

process.stdout.write(`Prisma dependencies are pinned to ${versions[0]}.\n`);
