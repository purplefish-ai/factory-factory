import { readFileSync, writeFileSync } from 'node:fs';
import { validateReports } from './timings.ts';

const reports = [1, 2].map((shard) =>
  JSON.parse(readFileSync(`.vitest/results/timings-${shard}.json`, 'utf8'))
);
const durations = validateReports(reports);
writeFileSync('.vitest/timings-history.json', JSON.stringify({ version: 1, durations }));
process.stdout.write(`Validated both shards: ${Object.keys(durations).length} unique test files\n`);
