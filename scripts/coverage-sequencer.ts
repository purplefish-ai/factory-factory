import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { balanceTests, parseHistory } from '../.github/coverage-merge/timings';

export function testId(root: string, project: string, moduleId: string): string {
  return `${project}:${path.relative(root, moduleId).replaceAll('\\', '/')}`;
}

export async function readDurationHistory(
  filePath: string,
  warn: (message: string) => void
): Promise<Record<string, number>> {
  try {
    return parseHistory(await readFile(filePath, 'utf8'));
  } catch (error) {
    // History is an optional optimization. An unexpected read failure stays
    // observable without aborting a complete deterministic test assignment.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      warn(
        `[coverage] Cannot read duration history; using deterministic estimates: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {};
  }
}

export default class CoverageSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (shard?.count !== 2) {
      throw new Error('Coverage CI requires exactly two shards');
    }
    const history = await readDurationHistory(
      path.join(root, '.vitest/timings-history.json'),
      (message) => this.ctx.logger.warn(message)
    );
    const id = (file: TestSpecification) => testId(root, file.project.name, file.moduleId);
    const all = files.map(id);
    const assignments = balanceTests(all, history);
    const known = all.filter((key) => history[key] !== undefined).length;
    this.ctx.logger.log(
      `[coverage] Shard ${shard.index}/2: ${known}/${all.length} files have measured durations`
    );
    const assigned = assignments[shard.index === 1 ? 0 : 1];
    const selected = new Set(assigned);
    await mkdir(path.join(root, '.vitest/results'), { recursive: true });
    await writeFile(
      path.join(root, `.vitest/results/plan-${shard.index}.json`),
      JSON.stringify({ all, assigned })
    );
    return files.filter((file) => selected.has(id(file)));
  }
}
