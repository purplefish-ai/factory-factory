import { describe, expect, it } from 'vitest';
import type { ServerInstance } from '@/backend/types/server-instance';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createServerInstanceService } from './server-instance.service';

describe('serverInstanceService', () => {
  it('factory creates isolated instances', () => {
    const serviceA = createServerInstanceService();
    const serviceB = createServerInstanceService();

    const serverA = unsafeCoerce<ServerInstance>({ getPort: () => 1111 });
    const serverB = unsafeCoerce<ServerInstance>({ getPort: () => 2222 });

    serviceA.setInstance(serverA);
    serviceB.setInstance(serverB);

    expect(serviceA.getPort()).toBe(1111);
    expect(serviceB.getPort()).toBe(2222);
    expect(serviceA.getInstance()).toBe(serverA);
    expect(serviceB.getInstance()).toBe(serverB);
  });
});
