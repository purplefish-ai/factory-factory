import { expect, it, vi } from 'vitest';
import type { ToolInterceptor } from './types';

const register = vi.hoisted(() => vi.fn<(interceptor: ToolInterceptor) => void>());
vi.mock('./registry', () => ({
  interceptorRegistry: { register, start: vi.fn(), stop: vi.fn() },
}));

import { registerInterceptors } from './index';

it('lets only PR detection observe sub-agent tool calls, so their pushes never rename the workspace branch', () => {
  registerInterceptors();

  const interceptors = register.mock.calls.map(([interceptor]) => interceptor);
  expect(interceptors.map((interceptor) => interceptor.name)).toContain('branch-naming');
  expect(
    interceptors
      .filter((interceptor) => interceptor.observesSubagents)
      .map((interceptor) => interceptor.name)
  ).toEqual(['pr-detection']);
});
