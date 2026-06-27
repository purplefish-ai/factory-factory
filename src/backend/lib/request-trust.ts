import { isIP } from 'node:net';

function normalizeAddress(address: string | undefined): string | undefined {
  return address?.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return undefined;
  }

  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return undefined;
    }
    value = (value << 8) + octet;
  }

  return value >>> 0;
}

function isIpv4AddressInCidr(address: string, cidr: string): boolean {
  const [rangeAddress, prefixLengthRaw] = cidr.trim().split('/');
  if (!rangeAddress || isIP(rangeAddress) !== 4) {
    return false;
  }

  const prefixLength = prefixLengthRaw === undefined ? 32 : Number.parseInt(prefixLengthRaw, 10);
  if (
    !Number.isInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > 32 ||
    (prefixLengthRaw !== undefined && String(prefixLength) !== prefixLengthRaw)
  ) {
    return false;
  }

  const addressInt = ipv4ToInt(address);
  const rangeInt = ipv4ToInt(rangeAddress);
  if (addressInt === undefined || rangeInt === undefined) {
    return false;
  }

  const mask = prefixLength === 0 ? 0 : (0xff_ff_ff_ff << (32 - prefixLength)) >>> 0;
  return (addressInt & mask) === (rangeInt & mask);
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  const normalized = normalizeAddress(remoteAddress);
  if (!normalized) {
    return false;
  }

  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }

  return isIP(normalized) === 4 && normalized.startsWith('127.');
}

export function isTrustedLocalAddress(
  remoteAddress: string | undefined,
  trustedLocalCidrs: readonly string[] = []
): boolean {
  const normalized = normalizeAddress(remoteAddress);
  if (!normalized) {
    return false;
  }

  if (isLoopbackRemoteAddress(normalized)) {
    return true;
  }

  if (isIP(normalized) !== 4) {
    return false;
  }

  return trustedLocalCidrs.some((cidr) => isIpv4AddressInCidr(normalized, cidr));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') {
    return true;
  }

  return isIP(normalized) === 4 && normalized.startsWith('127.');
}

function parseOrigin(origin: string): URL | undefined {
  try {
    return new URL(origin);
  } catch {
    return undefined;
  }
}

function isCanonicalOriginUrl(origin: string, url: URL): boolean {
  return (
    url.origin === origin &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  );
}

function getEffectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }

  return url.protocol === 'https:' ? '443' : '80';
}

export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  const parsedOrigin = parseOrigin(origin);
  if (
    !(
      parsedOrigin &&
      isCanonicalOriginUrl(origin, parsedOrigin) &&
      isLoopbackHostname(parsedOrigin.hostname)
    )
  ) {
    return false;
  }

  return allowedOrigins.some((allowedOrigin) => {
    const parsedAllowedOrigin = parseOrigin(allowedOrigin);
    if (
      !(
        parsedAllowedOrigin &&
        isCanonicalOriginUrl(allowedOrigin, parsedAllowedOrigin) &&
        isLoopbackHostname(parsedAllowedOrigin.hostname)
      )
    ) {
      return false;
    }

    return (
      parsedOrigin.protocol === parsedAllowedOrigin.protocol &&
      getEffectivePort(parsedOrigin) === getEffectivePort(parsedAllowedOrigin)
    );
  });
}
