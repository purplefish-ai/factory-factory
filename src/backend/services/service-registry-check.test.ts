import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { infrastructureServiceRegistry } from './registry';
import { getInfrastructureServiceClassificationErrors } from './service-registry-check.helpers';

describe('check-service-registry root infrastructure classification', () => {
  let servicesRoot: string;

  beforeEach(() => {
    servicesRoot = mkdtempSync(path.join(tmpdir(), 'ff-service-registry-'));
    for (const { fileName } of Object.values(infrastructureServiceRegistry)) {
      writeFileSync(path.join(servicesRoot, fileName), 'export {};\n');
    }
  });

  afterEach(() => rmSync(servicesRoot, { recursive: true, force: true }));

  it('rejects a root service that is not explicitly registered as infrastructure', () => {
    writeFileSync(path.join(servicesRoot, 'unclassified.service.ts'), 'export {};\n');

    const errors = getInfrastructureServiceClassificationErrors(
      servicesRoot,
      infrastructureServiceRegistry
    );

    expect(errors).toContain(
      'unclassified.service.ts is a root service that is not registered as infrastructure. Move it into its owning service capsule or add an intentional entry to infrastructureServiceRegistry.'
    );
  });

  it('rejects an unclassified root service symlink', () => {
    const targetPath = path.join(servicesRoot, 'target.ts');
    writeFileSync(targetPath, 'export {};\n');
    symlinkSync(targetPath, path.join(servicesRoot, 'unclassified-link.service.ts'));

    const errors = getInfrastructureServiceClassificationErrors(
      servicesRoot,
      infrastructureServiceRegistry
    );

    expect(errors).toContain(
      'unclassified-link.service.ts is a root service that is not registered as infrastructure. Move it into its owning service capsule or add an intentional entry to infrastructureServiceRegistry.'
    );
  });

  it('reports the checked services root when a registered service is missing', () => {
    const missingRegistry = {
      'missing.service': { fileName: 'missing.service.ts' },
    };

    const errors = getInfrastructureServiceClassificationErrors(servicesRoot, missingRegistry);

    expect(errors).toContain(
      `Infrastructure service "missing.service" is registered but missing.service.ts does not exist in ${servicesRoot}.`
    );
  });
});
