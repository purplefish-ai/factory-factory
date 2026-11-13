import { describe, expect, it } from 'vitest';
import { checkReportedPorts, parseBackendPort, parsePortFile } from './ports.mjs';

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

  it('retries when the server reports a port other than the one requested', () => {
    const requested = { frontend: 5001, backend: 5002 };
    expect(checkReportedPorts(requested, { frontend: null, backend: null })).toEqual({
      status: 'waiting',
    });
    expect(checkReportedPorts(requested, { frontend: null, backend: 5002 })).toEqual({
      status: 'waiting',
    });
    expect(checkReportedPorts(requested, { frontend: 5001, backend: 5002 })).toEqual({
      status: 'ready',
    });
    // The backend fell back to another port: Vite would proxy to whatever holds 5002.
    expect(checkReportedPorts(requested, { frontend: null, backend: 5003 })).toEqual({
      status: 'mismatch',
      message: 'requested backend port 5002 but the server reported 5003',
    });
    expect(checkReportedPorts(requested, { frontend: 5009, backend: 5002 })).toEqual({
      status: 'mismatch',
      message: 'requested frontend port 5001 but the server reported 5009',
    });
  });
});
