/**
 * Loopback services that must never be shared even when they speak HTTP: a
 * shared port forwards blind cross-site requests from any page that can reach
 * it, and these accept destructive ones.
 */
const SERVICE_PORTS: ReadonlySet<number> = new Set([
  2375, // Docker API
  2376, // Docker API (TLS)
  3306, // MySQL
  5432, // PostgreSQL
  5555, // Prisma Studio
  6379, // Redis
  9200, // Elasticsearch
  9300, // Elasticsearch transport
  11_211, // memcached
  27_017, // MongoDB
  27_018, // MongoDB shard
]);

const MIN_SHAREABLE_PORT = 1024;
const MAX_PORT = 65_535;

/** Run-script allocation skips these so a dev server never lands on one. */
export function isReservedServicePort(port: number): boolean {
  return SERVICE_PORTS.has(port);
}

export type PortRefusal = 'PRIVILEGED' | 'FACTORY_FACTORY' | 'SERVICE';

/** Parses a canonical decimal port (no sign, leading zero, or whitespace). */
export function parseSharePort(raw: string): number | null {
  if (!/^[1-9]\d{0,4}$/.test(raw)) {
    return null;
  }
  const port = Number(raw);
  return port <= MAX_PORT ? port : null;
}

export function getPortRefusal(
  port: number,
  factoryFactoryPorts: readonly (number | null)[]
): PortRefusal | null {
  if (port < MIN_SHAREABLE_PORT) {
    return 'PRIVILEGED';
  }
  if (factoryFactoryPorts.includes(port)) {
    return 'FACTORY_FACTORY';
  }
  return isReservedServicePort(port) ? 'SERVICE' : null;
}
