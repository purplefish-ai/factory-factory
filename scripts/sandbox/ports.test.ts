import { describe, expect, it } from 'vitest';
import { parseBackendPort, parsePortFile } from './ports.mjs';

describe('ports', () => {
  it('reads the ports the server reports', () => {
    expect(parseBackendPort('  ✓ Backend\nBACKEND_PORT:4011\n')).toBe(4011);
    expect(parseBackendPort('BACKEND_PORT:4011')).toBeNull();
    expect(parseBackendPort('xBACKEND_PORT:4011\n')).toBeNull();
    expect(parseBackendPort('BACKEND_PORT:99999\n')).toBeNull();
    expect(parsePortFile('3007\n')).toBe(3007);
    expect(parsePortFile('')).toBeNull();
    expect(parsePortFile('30x')).toBeNull();
  });
});
