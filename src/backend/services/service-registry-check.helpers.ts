import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

type InfrastructureServiceRegistry = Record<string, { fileName: string }>;

export function getInfrastructureServiceClassificationErrors(
  servicesRoot: string,
  infrastructureServiceRegistry: InfrastructureServiceRegistry
): string[] {
  const errors: string[] = [];
  const infrastructureServiceNames = new Set(Object.keys(infrastructureServiceRegistry));
  const rootServiceFileNames = new Set(
    readdirSync(servicesRoot, { withFileTypes: true })
      .filter(
        (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.service.ts')
      )
      .map((entry) => entry.name)
  );

  for (const fileName of rootServiceFileNames) {
    const serviceName = fileName.replace(/\.ts$/u, '');
    if (!infrastructureServiceNames.has(serviceName)) {
      errors.push(
        `${fileName} is a root service that is not registered as infrastructure. Move it into its owning service capsule or add an intentional entry to infrastructureServiceRegistry.`
      );
    }
  }

  for (const [serviceName, definition] of Object.entries(infrastructureServiceRegistry)) {
    if (!existsSync(path.join(servicesRoot, definition.fileName))) {
      errors.push(
        `Infrastructure service "${serviceName}" is registered but ${definition.fileName} does not exist in src/backend/services.`
      );
    }
  }

  return errors;
}
