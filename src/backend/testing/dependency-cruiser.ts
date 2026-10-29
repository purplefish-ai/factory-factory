import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cruise } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import configuration from '@/../.dependency-cruiser.cjs';

export function cruiseFixture(root: string) {
  // Resolve symlinks such as macOS /var before matching root-relative rules.
  const baseDir = realpathSync(root);
  return cruise(
    ['src'],
    {
      ...configuration.options,
      baseDir,
      ruleSet: configuration,
      validate: true,
      outputType: 'err',
    },
    {},
    { tsConfig: extractTSConfig(join(baseDir, 'tsconfig.json')) }
  );
}
