import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const backupPath = join(process.cwd(), '.package.json.runtime-metadata-backup');
if (existsSync(backupPath)) {
  // Rename restores exact bytes atomically and keeps recovery available if it fails.
  renameSync(backupPath, join(process.cwd(), 'package.json'));
}
