/**
 * Loopback links point at the host running Factory Factory. Under
 * `ff tailscale`, `/proxy/<port>` shares that port on the same machine name.
 */
export function isLoopbackHostname(rawHostname: string): boolean {
  // `localhost.` is the fully qualified spelling of the same name.
  const hostname = rawHostname.toLowerCase().replace(/\.$/, '');
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

export interface PortShareLink {
  href: string;
  port: number;
}

/** Maps `http://127.0.0.1:6173/x?y#z` to `/proxy/6173/x?y#z`; other links return null. */
export function toPortShareLink(href: string): PortShareLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // The forwarder speaks plain HTTP to the upstream server.
  if (url.protocol !== 'http:' || !url.port || !isLoopbackHostname(url.hostname)) {
    return null;
  }
  return {
    href: `/proxy/${url.port}${url.pathname}${url.search}${url.hash}`,
    port: Number(url.port),
  };
}
