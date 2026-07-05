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

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'] as const;

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
 * The returned value is always taken from (or derived from) the trusted
 * allowlist — never the raw request header — so credentialed CORS responses
 * never carry user-controlled input in the origin header. Returns `undefined`
 * when the origin is not allowed.
 *
 * Loopback-equivalent hosts (localhost ↔ 127.0.0.1 ↔ [::1]) are matched by
 * building concrete origin variants from each trusted loopback origin and
 * returning the variant that equals the request origin, so the browser still
 * receives an exact match while the emitted value provably originates from the
 * allowlist.
 */
export function resolveAllowedOrigin(
  origin: string,
  allowedOrigins: readonly string[]
): string | undefined {
  const exactMatch = allowedOrigins.find((allowed) => allowed === origin);
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  if (!parseCanonicalLoopbackOrigin(origin)) {
    return undefined;
  }

  for (const allowedOrigin of allowedOrigins) {
    const parsedAllowedOrigin = parseCanonicalLoopbackOrigin(allowedOrigin);
    if (!parsedAllowedOrigin) {
      continue;
    }

    const effectivePort = getEffectivePort(parsedAllowedOrigin);
    const defaultPort = parsedAllowedOrigin.protocol === 'https:' ? '443' : '80';
    const portSuffix = effectivePort === defaultPort ? '' : `:${effectivePort}`;
    for (const hostname of LOOPBACK_HOSTNAMES) {
      const candidate = `${parsedAllowedOrigin.protocol}//${hostname}${portSuffix}`;
      if (candidate === origin) {
        return candidate;
      }
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
