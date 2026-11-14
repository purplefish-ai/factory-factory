import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { collectAgentMetrics, type MetricsOptions, run } from './agent-metrics/collect';
import { renderReports } from './agent-metrics/render';

// Measures how agent-driven development is going: CI and pull request outcomes
// from `gh`, and guidance, churn and test-structure sizes from the tree. The
// pure functions in `agent-metrics/` take parsed data so tests need no network
// or checkout.

const usage = 'Usage: pnpm metrics:agents [--prs <count>] [--json] [--json-file <path>]';
const defaultPullRequestCount = 300;

const pullRequestCountSchema = z.coerce.number().int().positive();
const jsonFileSchema = z.string().min(1).regex(/^[^-]/);

export function parseMetricsArgs(args: readonly string[]): MetricsOptions {
  const options: MetricsOptions = {
    pullRequests: defaultPullRequestCount,
    json: false,
    jsonFile: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--json-file') {
      const parsed = jsonFileSchema.safeParse(args[index + 1]);
      if (!parsed.success) {
        throw new Error(`--json-file needs a path that does not begin with "-".\n${usage}`);
      }
      options.jsonFile = parsed.data;
      index += 1;
    } else if (arg === '--prs') {
      const parsed = pullRequestCountSchema.safeParse(args[index + 1]);
      if (!parsed.success) {
        throw new Error(`--prs needs a positive integer.\n${usage}`);
      }
      options.pullRequests = parsed.data;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage}`);
    }
  }
  return options;
}

function main() {
  const options = parseMetricsArgs(process.argv.slice(2));
  const root = run('git', ['rev-parse', '--show-toplevel'], process.cwd()).trim();
  const { stdout, file } = renderReports(collectAgentMetrics(root, options), options);
  if (options.jsonFile !== null && file !== null) {
    writeFileSync(options.jsonFile, file);
  }
  process.stdout.write(stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `Agent metrics failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
