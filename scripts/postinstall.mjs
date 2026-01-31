#!/usr/bin/env node

/**
 * Postinstall script for factory-factory
 *
 * Handles:
 * 1. Prisma client generation (with explicit schema path for npm installs)
 * 2. node-pty spawn-helper permissions
 */

import { execSync } from 'node:child_process';
import { existsSync, chmodSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Generate Prisma client if schema exists
const schemaPath = join(projectRoot, 'prisma', 'schema.prisma');
if (existsSync(schemaPath)) {
	try {
		console.log('Generating Prisma client...');
		execSync(`npx prisma generate --schema="${schemaPath}"`, {
			stdio: 'inherit',
			cwd: projectRoot,
		});
	} catch (error) {
		console.error('Failed to generate Prisma client:', error.message);
		console.error(
			'You may need to run "npx prisma generate" manually after installation.',
		);
		// Don't fail the install - the CLI will show a better error at runtime
	}
}

// Fix node-pty spawn-helper permissions (Unix only)
if (process.platform !== 'win32') {
	try {
		const prebuildsDir = join(
			projectRoot,
			'node_modules',
			'node-pty',
			'prebuilds',
		);

		if (existsSync(prebuildsDir)) {
			// Find all spawn-helper files in prebuild directories
			for (const platform of readdirSync(prebuildsDir)) {
				const spawnHelper = join(prebuildsDir, platform, 'spawn-helper');
				if (existsSync(spawnHelper)) {
					try {
						chmodSync(spawnHelper, 0o755);
					} catch {
						// Ignore permission errors
					}
				}
			}
		}
	} catch {
		// Ignore if node-pty doesn't exist
	}
}
