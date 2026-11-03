import { describe, expect, it } from 'vitest';
import { getPortRefusal, parseSharePort } from './port-share-policy';

describe('parseSharePort', () => {
  it.each([
    ['6173', 6173],
    ['65535', 65_535],
    ['1', 1],
  ])('accepts %s', (raw, port) => {
    expect(parseSharePort(raw)).toBe(port);
  });

  it.each(['0', '06173', '65536', '+80', ' 80', '80a', '', '1e3'])('rejects %j', (raw) => {
    expect(parseSharePort(raw)).toBeNull();
  });
});

describe('getPortRefusal', () => {
  it('refuses system, Factory Factory, and infrastructure ports', () => {
    expect(getPortRefusal(80, [])).toBe('PRIVILEGED');
    expect(getPortRefusal(3001, [3001, 443])).toBe('FACTORY_FACTORY');
    expect(getPortRefusal(2375, [])).toBe('SERVICE');
    expect(getPortRefusal(5432, [])).toBe('SERVICE');
  });

  it('allows ordinary dev server ports', () => {
    expect(getPortRefusal(6173, [3001, null])).toBeNull();
    expect(getPortRefusal(5173, [])).toBeNull();
  });
});
