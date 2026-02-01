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
// This handles both local node_modules and npx cache installations
if (process.platform !== 'win32') {
	/**
	 * Fix spawn-helper permissions in a given prebuilds directory
	 */
	function fixSpawnHelperPermissions(prebuildsDir) {
		if (!existsSync(prebuildsDir)) {
			return false;
		}

		let fixed = false;
		for (const platform of readdirSync(prebuildsDir)) {
			const spawnHelper = join(prebuildsDir, platform, 'spawn-helper');
			if (existsSync(spawnHelper)) {
				try {
					chmodSync(spawnHelper, 0o755);
					fixed = true;
				} catch {
					// Ignore permission errors
				}
			}
		}
		return fixed;
	}

	// 1. Fix in local node_modules (standard install)
	try {
		const localPrebuilds = join(
			projectRoot,
			'node_modules',
			'node-pty',
			'prebuilds',
		);
		fixSpawnHelperPermissions(localPrebuilds);
	} catch {
		// Ignore if node-pty doesn't exist locally
	}

	// 2. Fix in the directory where this script is running from (npx case)
	// When run via npx, the module is in a different location
	try {
		// Walk up from __dirname to find node_modules/node-pty
		let searchDir = __dirname;
		for (let i = 0; i < 10; i++) {
			const candidate = join(searchDir, 'node_modules', 'node-pty', 'prebuilds');
			if (existsSync(candidate)) {
				fixSpawnHelperPermissions(candidate);
				break;
			}
			const parent = dirname(searchDir);
			if (parent === searchDir) break;
			searchDir = parent;
		}
	} catch {
		// Ignore errors
	}
}
