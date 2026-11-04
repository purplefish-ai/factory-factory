// Decides where a URL the renderer tries to open or navigate to should go.
// URLs come from agent output, PRs, issues and other untrusted data, so only
// http(s) and mailto are ever handed to the operating system; `file:`,
// `javascript:`, `data:` and custom app schemes are refused.

export type NavigationDecision =
  // Same origin as the loaded app: stays in the app window.
  | { action: 'internal' }
  // Open in the system browser or mail client, using the normalized URL.
  | { action: 'external'; url: string }
  // Refuse: unparseable or not an allowlisted scheme.
  | { action: 'deny' };

const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const EXTERNAL_PROTOCOLS = new Set([...WEB_PROTOCOLS, 'mailto:']);

/**
 * Returns the origin of an app URL to compare navigations against, or null
 * when the URL is not an http(s) URL with a real origin.
 */
export function getAppOrigin(appUrl: string): string | null {
  if (!URL.canParse(appUrl)) {
    return null;
  }
  const parsed = new URL(appUrl);
  return WEB_PROTOCOLS.has(parsed.protocol) ? parsed.origin : null;
}

/**
 * Classifies a navigation target relative to the app origin (the backend URL
 * in production, the Vite dev server URL in development). Pass null while no
 * app URL is loaded, so nothing is treated as internal.
 */
export function classifyNavigation(url: string, appOrigin: string | null): NavigationDecision {
  if (!URL.canParse(url)) {
    return { action: 'deny' };
  }
  const parsed = new URL(url);
  if (appOrigin !== null && WEB_PROTOCOLS.has(parsed.protocol) && parsed.origin === appOrigin) {
    return { action: 'internal' };
  }
  if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return { action: 'external', url: parsed.href };
  }
  return { action: 'deny' };
}
