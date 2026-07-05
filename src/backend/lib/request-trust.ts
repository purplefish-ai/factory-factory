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
  const canonicalOrigin =
    url.origin === origin ||
    (url.protocol === 'http:' && origin === `${url.origin}:80`) ||
    (url.protocol === 'https:' && origin === `${url.origin}:443`);

  return (
    canonicalOrigin &&
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

/**
 * Parses `value` and returns its URL only when it is a canonical origin string
 * whose host is a loopback hostname (localhost / 127.x / ::1). Returns
 * `undefined` otherwise.
 */
function parseCanonicalLoopbackOrigin(value: string): URL | undefined {
  const parsed = parseOrigin(value);
  if (parsed && isCanonicalOriginUrl(value, parsed) && isLoopbackHostname(parsed.hostname)) {
    return parsed;
  }
  return undefined;
}

/**
 * Resolves the `Access-Control-Allow-Origin` value to echo for a request origin.
 *
 * Returns `undefined` when the origin is not allowed.
 *
 * For exact allowlist matches the allowlist value is returned verbatim. For
 * loopback-equivalent origins (localhost / 127.x / ::1) any hostname in the
 * loopback range that matches an allowlist entry by protocol and port is
 * accepted, and the validated request origin is returned so the browser
 * receives an exact match. The origin is safe to echo because
 * `parseCanonicalLoopbackOrigin` has already confirmed it is a canonical
 * loopback URL, not arbitrary user input.
 */
export function resolveAllowedOrigin(
  origin: string,
  allowedOrigins: readonly string[]
): string | undefined {
  const exactMatch = allowedOrigins.find((allowed) => allowed === origin);
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  const parsedRequestOrigin = parseCanonicalLoopbackOrigin(origin);
  if (!parsedRequestOrigin) {
    return undefined;
  }

  for (const allowedOrigin of allowedOrigins) {
    const parsedAllowedOrigin = parseCanonicalLoopbackOrigin(allowedOrigin);
    if (!parsedAllowedOrigin) {
      continue;
    }

    if (
      parsedRequestOrigin.protocol === parsedAllowedOrigin.protocol &&
      getEffectivePort(parsedRequestOrigin) === getEffectivePort(parsedAllowedOrigin)
    ) {
      // origin is validated as a canonical loopback URL — safe to echo back.
      return origin;
    }
  }

  return undefined;
}

export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  const parsedOrigin = parseCanonicalLoopbackOrigin(origin);
  if (!parsedOrigin) {
    return false;
  }

  return allowedOrigins.some((allowedOrigin) => {
    const parsedAllowedOrigin = parseCanonicalLoopbackOrigin(allowedOrigin);
    if (!parsedAllowedOrigin) {
      return false;
    }

    return (
      parsedOrigin.protocol === parsedAllowedOrigin.protocol &&
      getEffectivePort(parsedOrigin) === getEffectivePort(parsedAllowedOrigin)
    );
  });
}
