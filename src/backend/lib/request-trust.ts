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

/**
 * Whether a configured bind host keeps the server on loopback. An unset host
 * binds loopback only (see `listenHttpServer`).
 */
export function isLoopbackBindHost(bindHost: string | undefined): boolean {
  if (bindHost === undefined) {
    return true;
  }
  const unbracketed =
    bindHost.startsWith('[') && bindHost.endsWith(']') ? bindHost.slice(1, -1) : bindHost;
  if (isLoopbackHostname(unbracketed) || isLoopbackRemoteAddress(unbracketed)) {
    return true;
  }
  // Compare the compressed form so spellings such as `0:0::1` count too. Zoned
  // addresses (`fe80::1%en0`) are not URL hosts and are never loopback.
  const urlHost = `http://[${unbracketed}]`;
  return isIP(unbracketed) === 6 && URL.canParse(urlHost) && new URL(urlHost).hostname === '[::1]';
}

function parseHostHeaderHostname(hostHeader: string): string | undefined {
  const candidate = `http://${hostHeader}`;
  if (!URL.canParse(candidate)) {
    return undefined;
  }
  const url = new URL(candidate);
  const isBareHost =
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !hostHeader.includes('/');
  return isBareHost ? url.hostname : undefined;
}

/**
 * DNS-rebinding guard for a loopback-bound server. A page whose own hostname
 * was rebound to 127.0.0.1 sends that hostname as `Host`, so only loopback
 * names and the hostnames of configured allowed origins (for example a
 * Tailscale or reverse-proxy origin that forwards its `Host`) are accepted.
 */
export function isHostHeaderAllowed(
  hostHeader: string,
  allowedOrigins: readonly string[]
): boolean {
  const hostname = parseHostHeaderHostname(hostHeader);
  if (hostname === undefined) {
    return false;
  }
  if (isLoopbackHostname(hostname)) {
    return true;
  }
  return allowedOrigins.some((allowedOrigin) => parseOrigin(allowedOrigin)?.hostname === hostname);
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

export function isOriginAllowed(
  origin: string,
  allowedOrigins: readonly string[],
  disableCorsChecks = false
): boolean {
  if (disableCorsChecks) {
    return true;
  }

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

/** Origin policy fields shared by every browser-facing check. */
export interface BrowserOriginPolicy {
  allowedOrigins: readonly string[];
  disableCorsChecks?: boolean;
  /** Set while the server is bound to loopback only; see `isBrowserOriginAllowed`. */
  allowOwnLoopbackOrigin?: boolean;
}

function isOwnLoopbackOrigin(origin: string, localPort: number | undefined): boolean {
  if (localPort === undefined) {
    return false;
  }
  const parsedOrigin = parseOrigin(origin);
  return (
    parsedOrigin !== undefined &&
    isCanonicalOriginUrl(origin, parsedOrigin) &&
    parsedOrigin.protocol === 'http:' &&
    isLoopbackHostname(parsedOrigin.hostname) &&
    getEffectivePort(parsedOrigin) === String(localPort)
  );
}

/**
 * The Origin rule for the CORS middleware, tRPC procedures and WebSocket
 * upgrades. Besides the configured origins, a loopback-bound server always
 * accepts its own page: an `http:` loopback origin on `localPort`, the local
 * port of the connection the request arrived on. That is the port the server
 * actually bound, so a fallback port no launcher configured keeps working,
 * while other ports, non-loopback hosts and non-loopback binds do not.
 */
export function isBrowserOriginAllowed(
  origin: string,
  policy: BrowserOriginPolicy,
  localPort: number | undefined
): boolean {
  return (
    isOriginAllowed(origin, policy.allowedOrigins, policy.disableCorsChecks) ||
    (policy.allowOwnLoopbackOrigin === true && isOwnLoopbackOrigin(origin, localPort))
  );
}
