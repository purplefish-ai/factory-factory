const SAFE_METHODS = new Set(['GET', 'HEAD']);

export type TunnelOriginDecision =
  | { allowed: true; upstreamOrigin: string | undefined }
  | { allowed: false; status: 403 | 503; message: string };

/**
 * Origin rule for requests the password proxy has already authenticated.
 *
 * The backend only allows its own loopback origin, never the tunnel's, so the
 * proxy decides instead: a request may change state or open a WebSocket only
 * when its `Origin` is exactly the tunnel's public origin. It is then
 * forwarded with the backend's own origin, so the backend sees a same-origin
 * request. Anything else is refused here: other sites (including other
 * trycloudflare tunnels and a page on the user's own `localhost`), `null`
 * origins, and state-changing requests or upgrades that omit `Origin`, which
 * browsers always send for those. Bodiless reads without an `Origin` (page
 * loads, same-origin `GET` fetches) pass unchanged. Until cloudflared reports
 * the tunnel URL, nothing carrying an `Origin` can match.
 */
export function decideTunnelOrigin(params: {
  method: string | undefined;
  origin: string | undefined;
  isUpgrade: boolean;
  tunnelOrigin: string | null;
  backendOrigin: string;
}): TunnelOriginDecision {
  const { origin, tunnelOrigin } = params;
  if (origin === undefined) {
    if (params.isUpgrade || !SAFE_METHODS.has(params.method ?? '')) {
      return { allowed: false, status: 403, message: 'Missing Origin header.' };
    }
    return { allowed: true, upstreamOrigin: undefined };
  }
  if (tunnelOrigin === null) {
    return { allowed: false, status: 503, message: 'The tunnel is still starting.' };
  }
  if (origin !== tunnelOrigin) {
    return { allowed: false, status: 403, message: 'Requests from this origin are not allowed.' };
  }
  return { allowed: true, upstreamOrigin: params.backendOrigin };
}

/** The origin of the URL cloudflared printed, e.g. `https://words.trycloudflare.com`. */
export function toTunnelOrigin(publicUrl: string): string {
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:') {
    throw new Error(`Unexpected tunnel URL: ${publicUrl}`);
  }
  return url.origin;
}
